// Pinned addresses, URLs and prices, and the environment settings. Everything that decides where money can go is a
// constant here: the tools take no URL, pay-to or amount, so a hijacked prompt can only buy Kitchen Pass answers, at
// these prices, up to the caps. Settings are parsed strictly and fail closed.
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PRICES } from "./listing.js";

export const VERSION = "0.3.0";
export const USER_AGENT_HEADER = { "x-kitchen-pass-client": `mcp/${VERSION}` } as const;

export type NetworkName = "base" | "base-sepolia";
export type PaidPath = keyof typeof PRICES;

export interface NetworkPins {
  name: NetworkName;
  caip2: "eip155:8453" | "eip155:84532";
  site: string;
  usdc: `0x${string}`;
  /** The USDC contract's EIP-712 domain, as in the 402's extra (the live 402s on 30 Sep 2026). */
  usdcDomain: { name: string; version: string };
  explorerTx: string;
  /** How the price is described to people. */
  label: string;
}

/** The Kitchen Pass pay-to address, from the live 402s on 30 Sep 2026 (both networks). */
export const PAY_TO = "0x582807F02712b4FBaa82D65b73D9B9101B7b33f4" as const;

export const NETWORKS: Record<NetworkName, NetworkPins> = {
  base: {
    name: "base", caip2: "eip155:8453", site: "https://kitchen-pass.netlify.app",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", usdcDomain: { name: "USD Coin", version: "2" }, explorerTx: "https://basescan.org/tx/", label: "USDC on Base",
  },
  "base-sepolia": {
    name: "base-sepolia", caip2: "eip155:84532", site: "https://kitchen-pass-testnet.netlify.app",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", usdcDomain: { name: "USDC", version: "2" }, explorerTx: "https://sepolia.basescan.org/tx/", label: "test USDC on Base Sepolia (testnet)",
  },
};

/** "$0.01" → 10000n (USDC has 6 decimals). */
export function usdToAtomic(usd: string): bigint {
  const m = /^\$?(0|[1-9]\d{0,5})(?:\.(\d{1,6}))?$/.exec(usd.trim());
  if (!m) throw new Error("not a USD amount");
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** 10000n → "0.01"; at least two decimals, no trailing zeros past them. */
export function atomicToUsd(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  let frac = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${whole}.${frac}`;
}

/** Per-call price in atomic USDC units: the route price, fixed in the package. */
export const PRICE_ATOMIC: Record<PaidPath, bigint> = Object.fromEntries(
  Object.entries(PRICES).map(([p, usd]) => [p, usdToAtomic(usd)]),
) as Record<PaidPath, bigint>;

/** The x402 SDK's own per-payment backstop (its default is $1): the dearest route price, $1 (function order, menu review). */
export const MAX_AMOUNT_PER_PAYMENT = "$1";
export const MAX_TIMEOUT_SECONDS = 300;

/** Code ceilings: a typo like "50" for "0.50" can't lift a cap past these. */
export const SESSION_CAP_CEILING = 5_000_000n; // $5
export const DAY_CAP_CEILING = 20_000_000n; // $20
export const DEFAULT_SESSION_CAP = 100_000n; // $0.10
export const DEFAULT_DAY_CAP = 500_000n; // $0.50

/**
 * Kitchen Pass's side: a paid request answers within 25 s of reaching its function, but platform start-up and transit
 * come on top, and Netlify's edge gives up with a 504 at about 30 s (seen 30 Sep 2026). The paid leg must outlast both,
 * or a paid answer (or the edge's 504) can arrive after this package stopped waiting and look unconfirmed.
 */
export const EDGE_TIMEOUT_MS = 30_000;

/** Timing, kept under the MCP client's default 60 s request timeout. */
export const TIMING = {
  callDeadlineMs: 57_000,
  unpaidLegMs: 12_000,
  freeGetMs: 12_000,
  confirmMs: 20_000,
  /** Never sign with less left than this: the edge's ~30 s plus 2 s for transit. Confirmation stops in time for it. */
  minPaidLegMs: 32_000,
  paidLegMs: 55_000,
  progressEveryMs: 5_000,
};
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const UNPAID_REQUESTS_PER_SESSION = 60;

/** Every setting this server reads. Any other KITCHEN_PASS_ name is a misspelling and turns paying off. */
export const SETTING_NAMES = [
  "KITCHEN_PASS_NETWORK", "KITCHEN_PASS_BASE_URL", "KITCHEN_PASS_PAYER_KEY_FILE", "KITCHEN_PASS_MAX_SPEND_PER_SESSION",
  "KITCHEN_PASS_MAX_SPEND_PER_DAY", "KITCHEN_PASS_LEDGER_DIR", "KITCHEN_PASS_CONFIRM", "KITCHEN_PASS_DRY_RUN",
] as const;
/** Not read by the server, but not a typo either: scripts/prepublish-check.ts reads it, and it may be exported in a shell. */
const OTHER_KNOWN_NAMES = ["KITCHEN_PASS_BLOCKLIST"] as const;

/**
 * A path setting as an absolute path: a leading "~/" (or "~" alone) is the home folder, because JSON host configs don't
 * expand it. Anything still relative would depend on the folder the host starts the server in, so it's refused (null).
 */
export function absolutePath(raw: string, home: string = homedir()): string | null {
  const p = raw === "~" ? home : /^~[\\/]/.test(raw) ? join(home, raw.slice(2)) : raw;
  return isAbsolute(p) ? p : null;
}

export const DEFAULT_LEDGER_DIR = () => join(homedir(), ".kitchen-pass-mcp");

export interface Settings {
  network: NetworkPins;
  /** Where requests go: the network's site, or http://localhost:<port> on base-sepolia only. */
  baseUrl: string;
  /** Unset → quote only. Never shown anywhere (it contains the macOS user name). */
  keyFile: string | null;
  sessionCap: bigint;
  dayCap: bigint;
  /** Null when KITCHEN_PASS_LEDGER_DIR was rejected: no ledger is read or written at all (and nothing is paid). */
  ledgerDir: string | null;
  /** True for the default ledger folder, which this server may tighten to mode 700 (a folder the user chose is left alone). */
  ledgerDirIsDefault: boolean;
  quoteOnly: boolean;
  confirm: "elicit" | "off";
}

/**
 * Problems are fixed clauses naming the variable, never its value. `fatal` problems (network, base URL) stop every tool;
 * `payment` problems (caps, confirm, dry-run) stop paying but leave free tools and quotes working.
 */
export interface ParsedSettings { settings: Settings | null; fatal: string[]; payment: string[] }

const CAP_FORMAT = /^(0|[1-9]\d{0,5})(\.\d{1,6})?$/;

function parseCap(raw: string | undefined, name: string, fallback: bigint, ceiling: bigint, problems: string[]): bigint {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim();
  if (!CAP_FORMAT.test(v)) { problems.push(`${name} must be a plain USD amount such as 0.50 (no $ sign, no letters)`); return 0n; }
  const atomic = usdToAtomic(v);
  if (atomic > ceiling) { problems.push(`${name} is above this package's limit of $${atomicToUsd(ceiling)}`); return 0n; }
  return atomic;
}

export function parseSettings(env: Record<string, string | undefined>): ParsedSettings {
  const fatal: string[] = [];
  const payment: string[] = [];
  const get = (k: string) => env[k]?.trim() ?? "";

  const networkName = get("KITCHEN_PASS_NETWORK");
  const network = networkName === "base" || networkName === "base-sepolia" ? NETWORKS[networkName] : null;
  if (!network) fatal.push("set KITCHEN_PASS_NETWORK to base (real USDC) or base-sepolia (test USDC); there is no default");

  let baseUrl = network?.site ?? "";
  const override = get("KITCHEN_PASS_BASE_URL");
  if (override) {
    let ok = false;
    try {
      const u = new URL(override);
      ok = u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname) && /^\d{1,5}$/.test(u.port) &&
        (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash && !u.username && !u.password;
      if (ok) baseUrl = `http://${u.hostname}:${u.port}`;
    } catch { ok = false; }
    if (!ok) fatal.push("KITCHEN_PASS_BASE_URL may only be http://localhost:<port> (a local test server)");
    else if (network?.name !== "base-sepolia") fatal.push("KITCHEN_PASS_BASE_URL is only allowed with KITCHEN_PASS_NETWORK=base-sepolia");
  }

  const sessionCap = parseCap(env.KITCHEN_PASS_MAX_SPEND_PER_SESSION, "KITCHEN_PASS_MAX_SPEND_PER_SESSION", DEFAULT_SESSION_CAP, SESSION_CAP_CEILING, payment);
  const dayCap = parseCap(env.KITCHEN_PASS_MAX_SPEND_PER_DAY, "KITCHEN_PASS_MAX_SPEND_PER_DAY", DEFAULT_DAY_CAP, DAY_CAP_CEILING, payment);

  const dry = get("KITCHEN_PASS_DRY_RUN");
  if (!["", "0", "1"].includes(dry)) payment.push("KITCHEN_PASS_DRY_RUN must be 1 (quotes only) or unset");
  const confirm = get("KITCHEN_PASS_CONFIRM") || "elicit";
  if (confirm !== "elicit" && confirm !== "off") payment.push("KITCHEN_PASS_CONFIRM must be elicit or off");

  // A relative or "~" folder would give each launch folder its own ledger, and so its own day cap.
  const rawLedger = get("KITCHEN_PASS_LEDGER_DIR");
  let ledgerDir: string | null = DEFAULT_LEDGER_DIR();
  if (rawLedger) {
    ledgerDir = absolutePath(rawLedger);
    if (!ledgerDir) payment.push("KITCHEN_PASS_LEDGER_DIR must be an absolute path (a leading ~/ is fine)");
  }
  const rawKey = get("KITCHEN_PASS_PAYER_KEY_FILE");
  const keyFile = rawKey ? absolutePath(rawKey) : null;
  if (rawKey && !keyFile) payment.push("KITCHEN_PASS_PAYER_KEY_FILE must be an absolute path (a leading ~/ is fine)");

  // A misspelt setting (KITCHEN_PASS_DRYRUN, ..._PER_SESION) would otherwise be ignored and the default would apply.
  const known = new Set<string>([...SETTING_NAMES, ...OTHER_KNOWN_NAMES]);
  for (const name of Object.keys(env).sort()) {
    if (env[name] === undefined || known.has(name) || !/^KITCHEN_PASS_/i.test(name)) continue;
    payment.push(`${/^[A-Za-z0-9_]{1,64}$/.test(name) ? name : "a KITCHEN_PASS_ variable"} isn't a setting this server knows (check the spelling)`);
  }

  if (!network || fatal.length) return { settings: null, fatal, payment };
  return {
    settings: {
      network, baseUrl, keyFile, sessionCap, dayCap, ledgerDir, ledgerDirIsDefault: ledgerDir === DEFAULT_LEDGER_DIR(), quoteOnly: dry === "1",
      confirm: confirm === "off" ? "off" : "elicit",
    },
    fatal, payment,
  };
}
