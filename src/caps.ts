// Spend caps. One append-only ledger per network (spend-base.jsonl, spend-base-sepolia.jsonl) in the ledger folder.
// The cap check and the reservation are one step, under a lock file that every process using the folder respects:
// read the ledger, check both caps, append the reservation and fsync it, all while holding the lock. So two host
// processes (Desktop and Code, or two Code sessions) can't both pass the day cap. A payment is counted when reserved,
// before it is signed, and never given back. If the ledger can't be read or synced to disk, nothing is paid.
// This process also keeps its own reservations in memory and counts whichever total is higher, and it notices if the
// ledger it wrote to is removed, replaced or truncated (then it pays nothing more until restarted): deleting or
// emptying the file never gives this process's spend back to the caps. The ledger must be a plain file, never a link.
import { randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { join } from "node:path";
import type { NetworkName } from "./config.js";

/** A lock older than this is abandoned: the lock is only ever held for a few synchronous file operations. */
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 3_000;
/** Windows has no O_NOFOLLOW; there the lstat check alone refuses a link. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export interface SpendState {
  sessionAtomic: bigint;
  dayAtomic: bigint;
  sessionCap: bigint;
  dayCap: bigint;
  /** UTC day, YYYY-MM-DD. */
  day: string;
}

export type ReserveResult =
  | { ok: true; id: string; state: SpendState }
  | { ok: false; reason: "session_cap" | "day_cap"; state: SpendState }
  | { ok: false; reason: "ledger" | "busy" | "tampered"; state: null };

export interface LedgerOptions {
  /** Null: no usable ledger folder (a rejected setting, or no settings). Nothing is read or written; nothing is paid. */
  dir: string | null;
  network: NetworkName;
  session: string;
  sessionCap: bigint;
  dayCap: bigint;
  /** Set mode 700 on an existing folder that others can read (only for the default folder, which is ours). */
  tightenDir?: boolean;
  now?: () => Date;
}

class LedgerError extends Error {}
class Tampered extends LedgerError {}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);
const maxOf = (a: bigint, b: bigint) => (a > b ? a : b);

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface FileId { dev: number; ino: number; size: number }

/** Writes a whole buffer to an open file, makes it mode 600 and fsyncs it; returns the file's identity after the write. */
function writeFd(fd: number, text: string): FileId {
  const st0 = fstatSync(fd);
  if (!st0.isFile()) throw new LedgerError("not a file");
  if ((st0.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
  const buf = Buffer.from(text, "utf8");
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  fsyncSync(fd);
  const st = fstatSync(fd);
  return { dev: st.dev, ino: st.ino, size: st.size };
}

/** Creates `path` exclusively (the lock files) with the text, synced; throws on any failure, EEXIST included. */
function createExclusive(path: string, text: string): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFd(fd, text); } finally { closeSync(fd); }
}

/** Appends to the ledger, never through a link; returns the file's identity after the write. */
function appendNoFollow(path: string, text: string): FileId {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW, 0o600);
  try { return writeFd(fd, text); } finally { closeSync(fd); }
}

/** Best effort: makes a new file's folder entry durable (not every platform allows fsync on a folder). */
function syncDir(dir: string): void {
  try { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* platform */ }
}

export class SpendLedger {
  readonly file: string;
  private readonly lock: string;
  private readonly breaker: string;
  private readonly now: () => Date;
  /** This process's own reservations: the session total, and per UTC day. */
  private mineSession = 0n;
  private readonly mineByDay = new Map<string, bigint>();
  /** The ledger file as this process last wrote it; null until the first write. */
  private seen: FileId | null = null;
  /** Set for good once the ledger this process wrote to is gone, replaced or shorter. */
  private tampered = false;

  private readonly dir: string | null;

  constructor(private readonly opts: LedgerOptions) {
    this.dir = opts.dir;
    const at = (name: string) => (opts.dir === null ? "" : join(opts.dir, name));
    this.file = at(`spend-${opts.network}.jsonl`);
    this.lock = at(`spend-${opts.network}.lock`);
    this.breaker = at(`spend-${opts.network}.lock-break`);
    this.now = opts.now ?? (() => new Date());
  }

  /** Why the ledger can't be used, or null: "tampered" is permanent for this process, "unreadable" may clear. */
  problem(): "tampered" | "unreadable" | null {
    if (this.tampered) return "tampered";
    return this.state() ? null : this.tampered ? "tampered" : "unreadable";
  }

  /** Atomically checks both caps and reserves `amount` for one payment. Never throws. */
  async reserve(tool: string, amount: bigint): Promise<ReserveResult> {
    if (this.tampered) return { ok: false, reason: "tampered", state: null };
    if (this.dir === null) return { ok: false, reason: "ledger", state: null };
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      if (this.opts.tightenDir && (statSync(this.dir).mode & 0o077) !== 0) chmodSync(this.dir, 0o700);
    } catch {
      return { ok: false, reason: "ledger", state: null };
    }
    const token = randomUUID();
    try {
      if (!(await this.acquire(token))) return { ok: false, reason: "busy", state: null };
    } catch {
      return { ok: false, reason: "ledger", state: null };
    }
    try {
      return this.reserveLocked(tool, amount);
    } catch (e) {
      return { ok: false, reason: e instanceof Tampered ? "tampered" : "ledger", state: null };
    } finally {
      this.release(token);
    }
  }

  /** Appends what happened to a reservation. Best effort: it never affects the caps. Never throws. */
  async recordOutcome(id: string, fields: { outcome: string; transaction?: string | null; payer?: string; nonce?: string }): Promise<void> {
    if (this.tampered || this.dir === null) return;
    const token = randomUUID();
    try {
      if (!(await this.acquire(token))) return;
    } catch { return; }
    try {
      this.checkUnchanged(); // never recreate a removed ledger with an outcome line in it
      const line = { v: 1, type: "outcome", id, t: this.now().toISOString(), ...fields };
      this.seen = appendNoFollow(this.file, `${JSON.stringify(line)}\n`);
    } catch { /* best effort */ } finally {
      this.release(token);
    }
  }

  /** Current spend, read without the lock (display and quotes). Null if the ledger can't be read or was tampered with. */
  state(): SpendState | null {
    if (this.tampered || this.dir === null) return null;
    try {
      this.checkUnchanged();
      return this.sums(this.readLines(), utcDay(this.now()));
    } catch { return null; }
  }

  private reserveLocked(tool: string, amount: bigint): ReserveResult {
    const day = utcDay(this.now());
    const created = this.checkUnchanged() === null;
    const state = this.sums(this.readLines(), day);
    if (state.sessionAtomic + amount > this.opts.sessionCap) return { ok: false, reason: "session_cap", state };
    if (state.dayAtomic + amount > this.opts.dayCap) return { ok: false, reason: "day_cap", state };
    const id = randomUUID();
    const line = { v: 1, type: "reserve", id, t: this.now().toISOString(), day, network: this.opts.network, tool, amount: amount.toString(), session: this.opts.session };
    this.seen = appendNoFollow(this.file, `${JSON.stringify(line)}\n`);
    this.mineSession += amount;
    this.mineByDay.set(day, (this.mineByDay.get(day) ?? 0n) + amount);
    if (created) syncDir(this.dir!);
    return { ok: true, id, state: { ...state, sessionAtomic: state.sessionAtomic + amount, dayAtomic: state.dayAtomic + amount } };
  }

  /**
   * The ledger must be a plain file (not a link, folder or device), and, once this process has written to it, still the
   * same file and no shorter: every legitimate change is an append. Returns its identity, or null if it doesn't exist
   * yet. Throws Tampered (and stops paying for good) if it was removed, replaced or truncated.
   */
  private checkUnchanged(): FileId | null {
    let st;
    try {
      st = lstatSync(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new LedgerError("unreadable");
      if (this.seen) { this.tampered = true; throw new Tampered("removed"); }
      return null;
    }
    if (!st.isFile()) {
      if (this.seen) { this.tampered = true; throw new Tampered("replaced"); }
      throw new LedgerError("not a plain file");
    }
    if (this.seen && (st.dev !== this.seen.dev || st.ino !== this.seen.ino || st.size < this.seen.size)) {
      this.tampered = true;
      throw new Tampered("replaced or truncated");
    }
    return { dev: st.dev, ino: st.ino, size: st.size };
  }

  private readLines(): Array<Record<string, unknown>> {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" && !this.seen) return [];
      throw new LedgerError("unreadable");
    }
    const out: Array<Record<string, unknown>> = [];
    for (const raw of text.split("\n")) {
      if (raw.trim() === "") continue;
      let rec: unknown;
      try { rec = JSON.parse(raw); } catch { throw new LedgerError("malformed"); }
      if (!rec || typeof rec !== "object" || (rec as any).v !== 1) throw new LedgerError("malformed");
      const r = rec as Record<string, unknown>;
      if (r.type === "reserve") {
        if (typeof r.amount !== "string" || !/^\d{1,20}$/.test(r.amount) || typeof r.day !== "string" || typeof r.session !== "string") throw new LedgerError("malformed");
      } else if (r.type !== "outcome") {
        throw new LedgerError("malformed");
      }
      out.push(r);
    }
    return out;
  }

  /** Totals from the ledger, never below this process's own reservations. */
  private sums(lines: Array<Record<string, unknown>>, day: string): SpendState {
    let sessionAtomic = 0n, dayAtomic = 0n;
    for (const r of lines) {
      if (r.type !== "reserve") continue;
      const amount = BigInt(r.amount as string);
      if (r.day === day) dayAtomic += amount;
      if (r.session === this.opts.session) sessionAtomic += amount;
    }
    return {
      sessionAtomic: maxOf(sessionAtomic, this.mineSession), dayAtomic: maxOf(dayAtomic, this.mineByDay.get(day) ?? 0n),
      sessionCap: this.opts.sessionCap, dayCap: this.opts.dayCap, day,
    };
  }

  /** O_EXCL lock file holding {pid, token, t}. Waits up to LOCK_WAIT_MS; false if still busy. Throws if it can't be used. */
  private async acquire(token: string): Promise<boolean> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        createExclusive(this.lock, JSON.stringify({ pid: process.pid, token, t: Date.now() }));
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const again = this.breakStaleLock();
      if (Date.now() > deadline) return false;
      if (!again) await sleep(5 + Math.floor(Math.random() * 20));
    }
  }

  private release(token: string): void {
    try {
      const held = JSON.parse(readFileSync(this.lock, "utf8"));
      if (held?.token === token) unlinkSync(this.lock);
    } catch { /* already gone */ }
  }

  /**
   * Removes an abandoned lock (its process is gone, or it is older than STALE_LOCK_MS). Only one process may break a
   * lock at a time (the breaker file, O_EXCL too), and it re-reads the lock under that before removing it, so a fresh
   * lock taken in between is never removed. True if the caller should try again at once. Throws if the lock path is
   * something this package never makes (a folder, a link, an unreadable file): waiting would never end.
   */
  private breakStaleLock(): boolean {
    let content: string, age: number;
    try {
      const st = lstatSync(this.lock);
      if (!st.isFile()) throw new LedgerError("lock path isn't a plain file");
      content = readFileSync(this.lock, "utf8");
      age = Date.now() - st.mtimeMs;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return true; // released meanwhile
      throw new LedgerError("lock unusable");
    }
    let pid: number | null = null;
    try { const p = JSON.parse(content).pid; if (Number.isInteger(p) && p > 0) pid = p; } catch { /* half-written */ }
    const abandoned = age > STALE_LOCK_MS || (pid !== null && pid !== process.pid && !pidAlive(pid));
    if (!abandoned) return false;
    try {
      createExclusive(this.breaker, JSON.stringify({ pid: process.pid, t: Date.now() }));
    } catch {
      // Another process is breaking it; a breaker left by a crash is itself abandoned after STALE_LOCK_MS.
      try {
        if (Date.now() - statSync(this.breaker).mtimeMs > STALE_LOCK_MS) {
          const aside = `${this.breaker}.${randomUUID()}`;
          renameSync(this.breaker, aside);
          unlinkSync(aside);
        }
      } catch { /* someone else did */ }
      return false;
    }
    try {
      let now: string | null = null;
      try { now = readFileSync(this.lock, "utf8"); } catch { now = null; }
      if (now === content) {
        const aside = `${this.lock}.stale-${randomUUID()}`;
        renameSync(this.lock, aside);
        // Under the breaker nobody else removes the lock, and its dead owner can't release it, so this is the one we judged.
        if (readFileSync(aside, "utf8") === content) {
          unlinkSync(aside);
        } else {
          linkSync(aside, this.lock); // not the one we judged: put it back
          unlinkSync(aside);
        }
      }
    } catch { /* leave it: the caller waits and fails closed */ } finally {
      try { unlinkSync(this.breaker); } catch { /* gone */ }
    }
    return true;
  }
}

/** The ledger folder's spend for display: USD strings plus when the day resets. */
export function spendView(s: SpendState | null) {
  if (!s) return null;
  const usd = (a: bigint) => {
    const whole = a / 1_000_000n;
    let frac = (a % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    if (frac.length < 2) frac = frac.padEnd(2, "0");
    return `${whole}.${frac}`;
  };
  const reset = new Date(`${s.day}T00:00:00Z`);
  reset.setUTCDate(reset.getUTCDate() + 1);
  return { sessionUsd: usd(s.sessionAtomic), sessionCapUsd: usd(s.sessionCap), dayUsd: usd(s.dayAtomic), dayCapUsd: usd(s.dayCap), dayResetsAt: reset.toISOString().replace(".000Z", "Z") };
}

// Re-exported for tests of the lock's stale handling.
export const LOCK_TIMING = { STALE_LOCK_MS, LOCK_WAIT_MS };
