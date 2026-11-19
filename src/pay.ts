// One paid tool call, in this order:
//   1. unpaid POST (a 400/404/413/422 stops here, free);  2. terms check;  3. quote if dryRun or not paying;
//   4. confirmation (form elicitation, when the client supports it);  5. atomic cap reservation (lock + fsync);
//   6. sign once;  7. paid POST once, never retried.
// Nothing is signed after the call is cancelled or once too little time is left, and a 402 on the paid leg ends the
// call. The whole call is kept under the MCP client's default 60 s timeout. One payment per request, not per call:
//   - an identical call made while another is in progress waits for it and gets its answer, instead of paying again;
//   - a paid answer that arrives after the client gave up is kept for 10 minutes and handed to an identical retry once;
//   - after a payment that was sent but not confirmed, an identical paid call is refused for 5 minutes (the time the
//     signed authorisation can still be settled), so an automatic retry can't pay twice for one answer.
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { getAddress } from "viem";
import { atomicToUsd, DAY_CAP_CEILING, PAY_TO, PRICE_ATOMIC, SESSION_CAP_CEILING } from "./config.js";
import type { Ctx } from "./context.js";
import { RequestFailed, request } from "./http.js";
import { answerCore, labelOf, labelSentence, nonAnswer, priceText, toResult, type Envelope } from "./results.js";
import { spendView, type SpendState } from "./caps.js";
import { checkTerms, decodeTerms } from "./terms.js";
import { PAID_TOOLS, type PaidTool } from "./tools.js";
import { CONFIRM_FIELD, confirmMessage } from "./wording.js";

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
/** `sent`: the signed payment left this process. `key`: the request's identity, for the unconfirmed-payment hold. */
export interface CallState { sent: boolean; key?: string }

const REASON = /^[A-Za-z0-9_:. -]{1,80}$/;
const REFERENCE = /^[0-9a-fA-F-]{36}$/;

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

function startProgress(extra: Extra, everyMs: number): () => void {
  const token = extra._meta?.progressToken;
  if (token === undefined) return () => {};
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: n } }).catch(() => {});
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Waits for an identical call in progress, up to `ms` or this call's cancel. "failed" if it threw. */
function waitFor(p: Promise<CallToolResult>, ms: number, signal: AbortSignal): Promise<CallToolResult | "timeout" | "cancelled" | "failed"> {
  if (signal.aborted) return Promise.resolve("cancelled");
  if (ms <= 0) return Promise.resolve("timeout");
  return new Promise(resolve => {
    const done = (v: CallToolResult | "timeout" | "cancelled" | "failed") => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(v); };
    const onAbort = () => done("cancelled");
    const timer = setTimeout(() => done("timeout"), ms);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(done, () => done("failed"));
  });
}

type Which = "session" | "day";

/** Which cap one more payment of `amount` would pass, or null. Same order as the reservation. */
function capPassed(state: SpendState, amount: bigint): Which | null {
  if (state.sessionAtomic + amount > state.sessionCap) return "session";
  if (state.dayAtomic + amount > state.dayCap) return "day";
  return null;
}

function capText(which: Which, state: SpendState, usd: string): string {
  const v = spendView(state)!;
  const used = which === "session" ? `$${v.sessionUsd} of $${v.sessionCapUsd}` : `$${v.dayUsd} of $${v.dayCapUsd}`;
  const knob = which === "session" ? "KITCHEN_PASS_MAX_SPEND_PER_SESSION" : "KITCHEN_PASS_MAX_SPEND_PER_DAY";
  const ceiling = atomicToUsd(which === "session" ? SESSION_CAP_CEILING : DAY_CAP_CEILING);
  return `the ${which} spend cap would be passed (${used} used; this call costs $${usd}). Only the user can raise ${knob} (up to $${ceiling}) in this server's settings`;
}

const LEDGER_TEXT = {
  unreadable: "the spend ledger couldn't be read or saved to disk",
  tampered: "the spend ledger was removed, replaced or truncated while this server was running, so it pays nothing more until it is restarted",
} as const;

export async function runPaid(ctx: Ctx, tool: PaidTool, args: Record<string, unknown>, extra: Extra, call: CallState): Promise<CallToolResult> {
  const deadline = ctx.clock() + ctx.timing.callDeadlineMs;
  const { dryRun, ...fields } = args;
  if (dryRun === true) return payOnce(ctx, tool, fields, true, extra, call, deadline);

  const key = `${tool}\u0000${canonical(fields)}`;
  call.key = key;
  const spend = () => spendView(ctx.ledger.state());
  const notPaid = (summary: string) =>
    toResult({ kind: "payment_not_made", tool, httpStatus: null, charged: null, spend: spend(), label: null, verified: null, api: null, summary });

  // An identical call is already under way: wait for it, and share its answer rather than paying again.
  for (;;) {
    const kept = ctx.takeUndelivered(key);
    if (kept) return ctx.replay(kept);
    const pending = ctx.inFlight.get(key);
    if (!pending) break;
    const r = await waitFor(pending, deadline - ctx.clock(), extra.signal);
    if (r === "cancelled") return notPaid("Not paid: the call was cancelled. Nothing was signed or charged. Don't retry this call as it is.");
    if (r === "timeout") {
      return notPaid("Not paid: an identical call is still waiting for its paid answer. Nothing was signed or charged for this one; " +
        "call again in a moment to get that answer without paying again.");
    }
    if (r !== "failed" && (r.structuredContent as any)?.kind === "answer") {
      ctx.takeUndelivered(key); // the earlier caller had gone: this call is the one it's delivered to
      return ctx.replay(r);
    }
    // It ended without an answer; this call goes ahead on its own (the hold below and the caps still apply).
  }

  const holdMs = ctx.unconfirmedWaitMs(key);
  if (holdMs > 0) {
    const minutes = Math.max(1, Math.ceil(holdMs / 60_000));
    return notPaid("Not paid: an identical call just sent a payment that wasn't confirmed, and it may have been charged (if it was " +
      "and no answer came, it is refunded by hand to the paying address). To avoid paying twice, this server won't pay for the " +
      `same request again for about ${minutes} minute${minutes === 1 ? "" : "s"}. Nothing was signed or charged now.`);
  }

  const p: Promise<CallToolResult> = payOnce(ctx, tool, fields, false, extra, call, deadline).then(
    r => {
      if (ctx.inFlight.get(key) === p) ctx.inFlight.delete(key);
      if ((r.structuredContent as any)?.kind === "payment_unconfirmed") ctx.markUnconfirmed(key);
      return r;
    },
    e => {
      if (ctx.inFlight.get(key) === p) ctx.inFlight.delete(key);
      if (call.sent) ctx.markUnconfirmed(key);
      throw e;
    });
  ctx.inFlight.set(key, p);
  return p;
}

async function payOnce(ctx: Ctx, tool: PaidTool, fields: Record<string, unknown>, dryRun: boolean, extra: Extra, call: CallState, deadline: number): Promise<CallToolResult> {
  const s = ctx.settings!;
  const T = ctx.timing;
  const left = () => deadline - ctx.clock();
  const path = PAID_TOOLS[tool];
  const url = `${s.baseUrl}${path}`;
  const body = JSON.stringify(fields);
  const useGiven = tool === "find_ingredient_substitute" && typeof fields.use === "string" && fields.use.trim() !== "";
  const spend = () => spendView(ctx.ledger.state());
  const env = (e: Omit<Envelope, "tool" | "spend"> & { spend?: Envelope["spend"] }) => toResult({ tool, spend: spend(), ...e });
  const notMade = (why: string, httpStatus: number | null = null, api: unknown = null) =>
    env({ kind: "payment_not_made", httpStatus, charged: null, label: null, verified: null, api, summary: `Not paid: ${why}. Nothing was signed or charged. Don't retry this call as it is.` });

  if (!ctx.countUnpaidRequest()) {
    return env({ kind: "service_error", httpStatus: null, charged: null, label: null, verified: null, api: null, summary: "This session has used its allowance of unpaid requests. Nothing was charged; restart the server to reset it." });
  }

  // 1. Unpaid leg: every check runs server-side before the 402, so any 4xx here is the real, free answer.
  let unpaid;
  try {
    unpaid = await request(ctx.fetch, url, { method: "POST", body, timeoutMs: Math.min(T.unpaidLegMs, left()), signal: extra.signal });
  } catch (e) {
    const why = e instanceof RequestFailed ? e.why : "network";
    if (why === "cancelled") return notMade("the call was cancelled");
    return env({ kind: "service_error", httpStatus: null, charged: null, label: null, verified: null, api: null, summary: `Kitchen Pass couldn't be reached (${why}). Nothing was signed or charged; retry shortly.` });
  }
  if (unpaid.status !== 402) return toResult(nonAnswer(tool, unpaid.status, unpaid.json, { spend: spend() }, { useGiven }));

  // 2. Terms.
  const terms = checkTerms(decodeTerms(unpaid.headers.get("payment-required")), { network: s.network, url, maxAtomic: PRICE_ATOMIC[path] });
  if (!terms.ok) return notMade(`${terms.problem}, so this package refused to pay`, 402, unpaid.json);
  const usd = atomicToUsd(terms.amount);
  const state = ctx.ledger.state();
  const passes = state ? capPassed(state, terms.amount) : null;
  const withinCaps = state ? passes === null : null;
  const asksFirst = s.confirm === "elicit" && !!ctx.clientCanConfirm();

  // 3. Quote. It only invites a buy when a buy would go ahead now.
  const blocked = ctx.payBlocked();
  if (dryRun || blocked?.quoteOnly) {
    let next: string;
    if (blocked) next = `${blocked.why[0].toUpperCase()}${blocked.why.slice(1)}.`;
    else if (!state) next = `It won't be bought now: ${LEDGER_TEXT[ctx.ledger.problem() ?? "unreadable"]}.`;
    else if (passes) next = `It won't be bought now: ${capText(passes, state, usd)}.`;
    else next = "Call again without dryRun to buy.";
    return env({
      kind: "quote", httpStatus: 402, charged: null, label: null, verified: null, api: unpaid.json ?? null,
      quote: { priceUsd: usd, atomic: terms.amount.toString(), asset: "USDC", network: s.network.caip2, payTo: PAY_TO, resource: url, withinCaps, wouldPay: !blocked && withinCaps === true, asksFirst },
      summary: `Would be answered. Costs ${priceText(usd, s.network)}; nothing signed or charged. ${next} Whether it will be chef-verified is only known after.`,
    });
  }
  if (blocked) return notMade(blocked.why, 402, unpaid.json);
  if (extra.signal.aborted) return notMade("the call was cancelled");

  const stopProgress = startProgress(extra, T.progressEveryMs);
  try {
    // 4. Confirmation: fixed text, the tool name and the price only.
    if (asksFirst) {
      const wait = Math.min(T.confirmMs, left() - T.minPaidLegMs);
      if (wait < 1_000) return notMade("there wasn't time left to ask for confirmation; call again");
      let accepted = false;
      try {
        const r = await ctx.server.server.elicitInput({
          mode: "form",
          message: confirmMessage(tool, usd, s.network.label),
          requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: CONFIRM_FIELD.title, description: CONFIRM_FIELD.description, default: true } }, required: ["confirm"] },
        }, { timeout: wait, signal: extra.signal });
        accepted = r.action === "accept" && (r.content as any)?.confirm === true;
      } catch {
        return notMade("the payment wasn't confirmed in time");
      }
      if (!accepted) return notMade("the user didn't confirm the payment");
    }
    if (extra.signal.aborted) return notMade("the call was cancelled");
    if (left() < T.minPaidLegMs) return notMade("there wasn't enough time left to pay safely; call again");

    // 5. Reserve under the lock: check both caps and record the spend, synced to disk, before signing.
    const r = await ctx.ledger.reserve(tool, terms.amount);
    if (!r.ok) {
      if (r.reason === "session_cap" || r.reason === "day_cap") {
        return notMade(capText(r.reason === "session_cap" ? "session" : "day", r.state, usd), 402, unpaid.json);
      }
      if (r.reason === "busy") return notMade("the spend ledger is busy; try again in a moment");
      return notMade(LEDGER_TEXT[r.reason === "tampered" ? "tampered" : "unreadable"]);
    }
    if (extra.signal.aborted) {
      await ctx.ledger.recordOutcome(r.id, { outcome: "not_signed: cancelled" });
      return notMade("the call was cancelled");
    }

    // 6. Sign exactly once, the offer that was checked.
    let payload;
    try {
      payload = await ctx.x402!.createPaymentPayload(terms.required);
    } catch {
      await ctx.ledger.recordOutcome(r.id, { outcome: "not_sent: signing failed" });
      return notMade("signing failed, so nothing was sent");
    }
    const auth = (payload.payload as any)?.authorization;
    let consistent = false;
    try {
      consistent = JSON.stringify(payload.accepted) === JSON.stringify(terms.required.accepts[0]) &&
        getAddress(auth.to) === getAddress(PAY_TO) && BigInt(auth.value) === terms.amount;
    } catch { consistent = false; }
    if (!consistent) {
      await ctx.ledger.recordOutcome(r.id, { outcome: "not_sent: signed payload didn't match the checked terms" });
      return notMade("the signed payment didn't match the checked terms, so it wasn't sent");
    }
    const payer = typeof auth.from === "string" ? auth.from : undefined;
    const nonce = typeof auth.nonce === "string" ? auth.nonce : undefined;

    // An unsent authorisation charges nothing: one last cancel check before it leaves this process.
    if (extra.signal.aborted) {
      await ctx.ledger.recordOutcome(r.id, { outcome: "not_sent: cancelled" });
      return notMade("the call was cancelled");
    }

    // 7. Paid leg: once. Not tied to the client's cancel from here: an answer that arrives late is kept for a retry.
    call.sent = true;
    let paid;
    try {
      paid = await request(ctx.fetch, url, { method: "POST", body, headers: ctx.x402!.encodePaymentSignatureHeader(payload), timeoutMs: Math.max(1_000, Math.min(T.paidLegMs, left())) });
    } catch (e) {
      const why = e instanceof RequestFailed ? e.why : "network";
      await ctx.ledger.recordOutcome(r.id, { outcome: `unconfirmed: ${why}`, payer, nonce });
      return env({
        kind: "payment_unconfirmed", httpStatus: null, charged: { amountUsd: usd, network: s.network.caip2, transaction: null, explorer: null, settled: null }, label: null, verified: null, api: null,
        summary: `The payment was sent but no answer came back (${why}). It may have been charged; if it was, and no answer was given, it is refunded by hand to the paying address. Don't retry straight away: a retry pays again.`,
      });
    }

    if (paid.status === 200) {
      let transaction: string | null = null, settled: boolean | null = null;
      try {
        const receipt = decodePaymentResponseHeader(paid.headers.get("payment-response") ?? "");
        if (typeof receipt.transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(receipt.transaction)) transaction = receipt.transaction;
        settled = receipt.success === true;
      } catch { /* no readable receipt */ }
      const label = labelOf(paid.json);
      const result = env({
        kind: "answer", httpStatus: 200, api: paid.json ?? null, label: label.label, verified: label.verified,
        charged: { amountUsd: usd, network: s.network.caip2, transaction, explorer: transaction ? `${s.network.explorerTx}${transaction}` : null, settled },
        summary: `${answerCore(tool, paid.json)} ${labelSentence(label)} Paid ${priceText(usd, s.network)}${transaction ? ` (tx ${transaction.slice(0, 10)}…)` : ""}.`,
      });
      await ctx.ledger.recordOutcome(r.id, { outcome: "answered", transaction, payer, nonce });
      if (extra.signal.aborted && call.key) ctx.keepUndelivered(call.key, result);
      return result;
    }

    const b = paid.json && typeof paid.json === "object" ? paid.json as Record<string, unknown> : {};
    if (paid.status === 402) {
      await ctx.ledger.recordOutcome(r.id, { outcome: "declined", payer, nonce });
      const reason = typeof b.reason === "string" && REASON.test(b.reason) ? ` (${b.reason})` : "";
      return env({
        kind: "payment_failed", httpStatus: 402, charged: null, label: null, verified: null, api: paid.json ?? null,
        summary: `The payment wasn't accepted${reason}; Kitchen Pass says nothing was charged. Not retried: a retry signs a new payment and counts against the caps.`,
      });
    }
    if (paid.status === 502 && b.status === "payment_unconfirmed") {
      await ctx.ledger.recordOutcome(r.id, { outcome: "unconfirmed: server", payer, nonce });
      const ref = typeof b.reference === "string" && REFERENCE.test(b.reference) ? ` Reference ${b.reference}.` : "";
      return env({
        kind: "payment_unconfirmed", httpStatus: 502, charged: { amountUsd: usd, network: s.network.caip2, transaction: null, explorer: null, settled: null }, label: null, verified: null, api: paid.json ?? null,
        summary: `Kitchen Pass couldn't confirm the payment in time, so the answer was withheld. If the payment goes through, it is refunded by hand to the paying address.${ref} Don't retry straight away: a retry pays again.`,
      });
    }
    if (paid.status === 502) {
      await ctx.ledger.recordOutcome(r.id, { outcome: "payment_error", payer, nonce });
      return env({ kind: "payment_failed", httpStatus: 502, charged: null, label: null, verified: null, api: paid.json ?? null, summary: "Kitchen Pass couldn't check the payment; it says nothing was charged. Not retried; try again later." });
    }
    await ctx.ledger.recordOutcome(r.id, { outcome: `http ${paid.status}`, payer, nonce });
    if (paid.status >= 500 && paid.status !== 503) {
      return env({
        kind: "payment_unconfirmed", httpStatus: paid.status, charged: { amountUsd: usd, network: s.network.caip2, transaction: null, explorer: null, settled: null }, label: null, verified: null, api: paid.json ?? null,
        summary: "Kitchen Pass had a server error after the payment was sent. If it was charged, it is refunded by hand to the paying address. Don't retry straight away: a retry pays again.",
      });
    }
    return toResult(nonAnswer(tool, paid.status, paid.json, { spend: spend() }, { useGiven }));
  } finally {
    stopProgress();
  }
}
