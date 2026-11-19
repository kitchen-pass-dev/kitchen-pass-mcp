// The only code that touches the buyer's key. It comes only from a key file (KITCHEN_PASS_PAYER_KEY_FILE) on the buyer's
// machine: no env var, no tool argument. The key is never printed, logged, returned or sent anywhere; only the signed
// authorisation leaves this process, in PAYMENT-SIGNATURE, to the pinned Kitchen Pass URL. Every problem is reported as
// fixed text that names "the key file", never its path or content.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

/** secp256k1 group order, written so no 64-hex literal sits in the source. */
const CURVE_N = 2n ** 256n - 0x14551231950b75fc4402da1732fc9bebfn;
const MAX_KEY_FILE_BYTES = 4096;

export const KEY_PROBLEMS = {
  unreadable: "the key file can't be read",
  permissions: "the key file can be read by other users (run chmod 600 on it)",
  acl: "the key file has an access control list, which can let other users read it (run chmod -N on it)",
  size: "the key file is too large to be a key file",
  format: "the key file must hold exactly one line, PAYER_PRIVATE_KEY=0x… or the bare key (comment lines starting with # are fine)",
  invalid: "the key in the key file isn't a valid private key",
} as const;
export type KeyProblem = keyof typeof KEY_PROBLEMS;

export interface LoadedKey {
  account: PrivateKeyAccount;
  /** True if the text carries the key in hex (any case, with or without 0x), decimal or base64. */
  leaks: (text: string) => boolean;
}

export type KeyLoad = { ok: true; key: LoadedKey } | { ok: false; problem: KeyProblem };

const KEY_LINE = /^PAYER_PRIVATE_KEY=(?:0x)?([0-9a-fA-F]{64})$/;
const BARE_KEY = /^(?:0x)?([0-9a-fA-F]{64})$/;

/** Parses key file text. Exported for tests (which only ever use keys generated at run time). */
export function parseKeyText(text: string): { ok: true; hex: string } | { ok: false; problem: KeyProblem } {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l !== "" && !l.startsWith("#"));
  if (lines.length !== 1) return { ok: false, problem: "format" };
  const m = KEY_LINE.exec(lines[0]) ?? BARE_KEY.exec(lines[0]);
  if (!m) return { ok: false, problem: "format" };
  const n = BigInt(`0x${m[1]}`);
  if (n <= 0n || n >= CURVE_N) return { ok: false, problem: "invalid" };
  return { ok: true, hex: m[1].toLowerCase() };
}

export function keyFromHex(hex: string): KeyLoad {
  let account: PrivateKeyAccount;
  try {
    account = privateKeyToAccount(`0x${hex}`);
  } catch {
    return { ok: false, problem: "invalid" }; // viem's message can carry the key's value: never pass it on
  }
  const bytes = Buffer.from(hex, "hex");
  const forms = [hex, BigInt(`0x${hex}`).toString(10), bytes.toString("base64").replace(/=+$/, ""), bytes.toString("base64url")];
  return { ok: true, key: { account, leaks: (text: string) => { const t = text.toLowerCase(); return forms.some(f => t.includes(f.toLowerCase())); } } };
}

/**
 * macOS: true if the file carries any access-control entry (`ls -le` lists them as numbered lines). An ACL can grant
 * other users read access that the mode bits don't show, for example one inherited from a shared folder. Throws if
 * it can't tell. `ls` gets the resolved path after "--", never through a shell.
 */
export function hasAcl(path: string): boolean {
  const out = execFileSync("/bin/ls", ["-led", "--", realpathSync(path)], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
  return out.split("\n").slice(1).some(line => /^\s*\d+: /.test(line));
}

export function loadKeyFile(path: string, platform: NodeJS.Platform = process.platform, aclCheck: (path: string) => boolean = hasAcl): KeyLoad {
  let text: string;
  try {
    const st = statSync(path);
    if (!st.isFile()) return { ok: false, problem: "unreadable" };
    if (st.size > MAX_KEY_FILE_BYTES) return { ok: false, problem: "size" };
    if (platform !== "win32" && (st.mode & 0o077) !== 0) return { ok: false, problem: "permissions" };
    if (platform === "darwin" && aclCheck(path)) return { ok: false, problem: "acl" };
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, problem: "unreadable" };
  }
  const parsed = parseKeyText(text);
  return parsed.ok ? keyFromHex(parsed.hex) : parsed;
}
