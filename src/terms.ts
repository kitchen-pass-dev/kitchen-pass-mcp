// The 402 terms check. Anything that isn't exactly what this package expects means nothing is signed: one offer only
// (so the SDK can't sign a different offer from the one checked), scheme "exact", x402 version 2, the configured
// network, that network's USDC with its EIP-712 domain, the pinned pay-to, an amount above zero and no more than the
// route price, maxTimeoutSeconds no more than 300, and the resource URL just called. `extra` may hold only the USDC
// domain: any other key (a Permit2 transfer method, a payment flow) would change what gets signed.
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { getAddress, isAddress } from "viem";
import { MAX_TIMEOUT_SECONDS, PAY_TO, type NetworkPins } from "./config.js";

export interface Expected {
  network: NetworkPins;
  url: string;
  /** The route's pinned price in atomic USDC units. */
  maxAtomic: bigint;
}

export type TermsCheck = { ok: true; required: PaymentRequired; amount: bigint } | { ok: false; problem: string };

/** Fixed texts only: no value from the 402 is ever echoed to the model. */
export const TERMS_PROBLEMS = {
  header: "the payment terms were missing or unreadable",
  version: "the payment terms use an x402 version this package doesn't support",
  offers: "the payment terms didn't offer exactly one way to pay",
  scheme: "the payment scheme isn't the expected one",
  network: "the payment network isn't the configured one",
  asset: "the payment asset isn't USDC on the configured network",
  payTo: "the pay-to address isn't Kitchen Pass's pinned address",
  amount: "the price is above this tool's pinned price",
  timeout: "the payment's validity window is longer than allowed",
  extra: "the payment terms carry settings this package doesn't accept",
  resource: "the payment terms are for a different address from the one called",
} as const;

const sameAddress = (a: unknown, b: string) => typeof a === "string" && isAddress(a, { strict: false }) && getAddress(a) === getAddress(b);

export function decodeTerms(header: string | null): PaymentRequired | null {
  if (!header || header.length > 16_384) return null;
  try { return decodePaymentRequiredHeader(header); } catch { return null; }
}

export function checkTerms(required: PaymentRequired | null, expected: Expected): TermsCheck {
  const fail = (k: keyof typeof TERMS_PROBLEMS): TermsCheck => ({ ok: false, problem: TERMS_PROBLEMS[k] });
  if (!required || typeof required !== "object") return fail("header");
  if (required.x402Version !== 2) return fail("version");
  if (!Array.isArray(required.accepts) || required.accepts.length !== 1) return fail("offers");
  const a = required.accepts[0] as unknown as Record<string, unknown>;
  if (!a || typeof a !== "object") return fail("offers");
  if (a.scheme !== "exact") return fail("scheme");
  if (a.network !== expected.network.caip2) return fail("network");
  if (!sameAddress(a.asset, expected.network.usdc)) return fail("asset");
  if (!sameAddress(a.payTo, PAY_TO)) return fail("payTo");
  if (typeof a.amount !== "string" || !/^\d{1,20}$/.test(a.amount)) return fail("amount");
  const amount = BigInt(a.amount);
  if (amount <= 0n || amount > expected.maxAtomic) return fail("amount");
  const t = a.maxTimeoutSeconds;
  if (typeof t !== "number" || !Number.isInteger(t) || t <= 0 || t > MAX_TIMEOUT_SECONDS) return fail("timeout");
  const extra = a.extra as Record<string, unknown> | undefined;
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return fail("extra");
  const keys = Object.keys(extra).sort().join(",");
  if (keys !== "name,version" || extra.name !== expected.network.usdcDomain.name || extra.version !== expected.network.usdcDomain.version) return fail("extra");
  if (!required.resource || typeof required.resource !== "object" || required.resource.url !== expected.url) return fail("resource");
  return { ok: true, required, amount };
}
