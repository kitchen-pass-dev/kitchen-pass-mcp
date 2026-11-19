// Per-process state: settings, the key (if any), the x402 client, the ledger, and small per-session counters.
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { SpendLedger, spendView } from "./caps.js";
import { MAX_AMOUNT_PER_PAYMENT, MAX_TIMEOUT_SECONDS, parseSettings, TIMING, UNPAID_REQUESTS_PER_SESSION, type Settings } from "./config.js";
import type { FetchLike } from "./http.js";
import { KEY_PROBLEMS, loadKeyFile, type KeyLoad } from "./key.js";
import { toResult, type Envelope } from "./results.js";
import { REPLAY_NOTE } from "./wording.js";

export interface ServerDeps {
  env: Record<string, string | undefined>;
  fetch?: FetchLike;
  now?: () => Date;
  /** Monotonic milliseconds, for deadlines. */
  clock?: () => number;
  loadKey?: (path: string) => KeyLoad;
  timing?: Partial<typeof TIMING>;
}

export interface Ctx {
  settings: Settings | null;
  fatal: string[];
  fetch: FetchLike;
  clock: () => number;
  timing: typeof TIMING;
  ledger: SpendLedger;
  x402: x402HTTPClient | null;
  server: McpServer;
  cache: Map<string, { at: number; json: unknown }>;
  /** Why this server won't pay right now, or null. quoteOnly: by design (no key file, dry-run), not a problem. */
  payBlocked(): { why: string; quoteOnly: boolean } | null;
  clientCanConfirm(): boolean;
  countUnpaidRequest(): boolean;
  /** A paid answer whose caller had gone when it arrived, for an identical retry (once, within 10 minutes). */
  takeUndelivered(key: string): CallToolResult | null;
  keepUndelivered(key: string, result: CallToolResult): void;
  /** Identical paid calls in progress, from the start of the call until it settles: an identical call waits for it. */
  inFlight: Map<string, Promise<CallToolResult>>;
  /** Remembers a call whose payment was sent but not confirmed; an identical paid call is refused for a while. */
  markUnconfirmed(key: string): void;
  /** Milliseconds until an identical paid call may pay again, or 0. */
  unconfirmedWaitMs(key: string): number;
  /** An answer paid for by an earlier call, marked as not charged again, with the current spend. */
  replay(result: CallToolResult): CallToolResult;
  /** True if the text carries the payer key in any form checked. */
  leaks(text: string): boolean;
}

const UNDELIVERED_TTL_MS = 10 * 60_000;
/** As long as the signed authorisation can still be settled (the terms allow at most 300 s). */
const UNCONFIRMED_HOLD_MS = MAX_TIMEOUT_SECONDS * 1_000;

export function createContext(deps: ServerDeps, server: McpServer): Ctx {
  const parsed = parseSettings(deps.env);
  const s = parsed.settings;
  const clock = deps.clock ?? (() => performance.now());
  const key: KeyLoad | null = s?.keyFile ? (deps.loadKey ?? loadKeyFile)(s.keyFile) : null;
  let x402: x402HTTPClient | null = null;
  if (s && key?.ok) {
    const client = registerExactEvmScheme(new x402Client(), { signer: key.key.account, networks: [s.network.caip2] });
    client.setSpendControls({ maxAmountPerPayment: MAX_AMOUNT_PER_PAYMENT });
    x402 = new x402HTTPClient(client);
  }
  const tlsOff = (deps.env.NODE_TLS_REJECT_UNAUTHORIZED ?? "").trim() === "0";
  const ledger = new SpendLedger({
    dir: s?.ledgerDir ?? null, network: s?.network.name ?? "base-sepolia", session: randomUUID(),
    sessionCap: s?.sessionCap ?? 0n, dayCap: s?.dayCap ?? 0n, tightenDir: s?.ledgerDirIsDefault ?? false, now: deps.now,
  });
  let unpaid = 0;
  const undelivered = new Map<string, { at: number; result: CallToolResult }>();
  const unconfirmed = new Map<string, number>();

  return {
    settings: s, fatal: parsed.fatal, fetch: deps.fetch ?? ((url, init) => fetch(url, init)), clock,
    timing: { ...TIMING, ...(deps.timing ?? {}) }, ledger, x402, server, cache: new Map(),
    payBlocked() {
      if (parsed.payment.length) return { why: `paying is off until the settings are fixed: ${parsed.payment.join("; ")}`, quoteOnly: false };
      if (s?.quoteOnly) return { why: "KITCHEN_PASS_DRY_RUN=1 is set, so this server only quotes", quoteOnly: true };
      if (!s?.keyFile) return { why: "no key file is set up, so this server only quotes", quoteOnly: true };
      if (!key || !key.ok) return { why: `${KEY_PROBLEMS[key && !key.ok ? key.problem : "unreadable"]}, so this server won't pay`, quoteOnly: false };
      if (tlsOff) return { why: "NODE_TLS_REJECT_UNAUTHORIZED=0 is set, so this server won't pay", quoteOnly: false };
      if (!x402) return { why: "the payment client isn't ready", quoteOnly: false };
      return null;
    },
    clientCanConfirm: () => !!server.server.getClientCapabilities()?.elicitation?.form,
    countUnpaidRequest: () => (unpaid += 1) <= UNPAID_REQUESTS_PER_SESSION,
    takeUndelivered(k) {
      const got = undelivered.get(k);
      undelivered.delete(k);
      return got && clock() - got.at < UNDELIVERED_TTL_MS ? got.result : null;
    },
    keepUndelivered(k, result) {
      undelivered.set(k, { at: clock(), result });
    },
    inFlight: new Map(),
    markUnconfirmed(k) {
      unconfirmed.set(k, clock());
    },
    unconfirmedWaitMs(k) {
      const at = unconfirmed.get(k);
      if (at === undefined) return 0;
      const wait = at + UNCONFIRMED_HOLD_MS - clock();
      if (wait <= 0) unconfirmed.delete(k);
      return Math.max(0, wait);
    },
    replay(result) {
      const sc = result.structuredContent as unknown as Envelope;
      return toResult({ ...sc, spend: spendView(ledger.state()), summary: `${sc.summary}${REPLAY_NOTE}`, replayed: true });
    },
    leaks: text => !!key?.ok && key.key.leaks(text),
  };
}
