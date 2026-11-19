// Tool results. Every result has a one-line summary built by template from the API's fields (never an answer's own
// text: no cause, fix or note), then the whole envelope as JSON, with the API body verbatim under `api`. The
// chef-verified label is copied from the API and shown only when R3's full rule holds. Summary texts approved with the rest of the wording (30 Sep 2026).
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { NetworkPins } from "./config.js";

export type Kind =
  | "answer" | "quote" | "refused" | "not_found" | "invalid"
  | "payment_not_made" | "payment_failed" | "payment_unconfirmed" | "service_error" | "config_error";

/** isError: true tells the model something went wrong it can act on. A 422 refusal is a final answer, not an error. */
const IS_ERROR: Record<Kind, boolean> = {
  answer: false, quote: false, refused: false,
  not_found: true, invalid: true, payment_not_made: true, payment_failed: true, payment_unconfirmed: true, service_error: true, config_error: true,
};

/** The label the API uses for fully verified answers. Used only to check the API's label, never to print one. */
const VERIFIED_LABEL = "Chef-verified by Cristopher";
const NOT_VERIFIED_TAIL = "Don't describe this answer as chef-verified or as Cristopher's.";

export interface Charged { amountUsd: string; network: string; transaction: string | null; explorer: string | null; settled: boolean | null }

export interface Envelope {
  kind: Kind;
  tool: string;
  httpStatus: number | null;
  charged: Charged | null;
  spend: ReturnType<typeof import("./caps.js").spendView>;
  label: string | null;
  verified: boolean | null;
  summary: string;
  /** Set on an answer handed to a later identical call: it was paid for once, by the earlier call. */
  replayed?: boolean;
  quote?: Record<string, unknown>;
  api: unknown;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
/** Short, single-line text for a summary. */
const clip = (v: unknown, max = 80) => String(v).replace(/[\r\n\t]+/g, " ").slice(0, max);

/** The verified label in any case or spacing, with or without a full stop: the claim itself, whatever its form. */
const claimsVerified = (label: string) =>
  label.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!]+$/, "") === VERIFIED_LABEL.toLowerCase();

/**
 * R3's full label rule: status ok, provenance.verified true, the label exactly the verified one, and rowsUsed
 * non-empty with every row verified. Returns the API's own label string when it holds. When it doesn't, a label that
 * still claims to be the verified one is dropped (null), so `label` can never say chef-verified while `verified` is false.
 */
export function labelOf(body: unknown): { verified: boolean; label: string | null } {
  if (!isObj(body) || !isObj(body.provenance)) return { verified: false, label: null };
  const p = body.provenance;
  const label = typeof p.label === "string" ? p.label : null;
  const rows = p.rowsUsed;
  const verified = body.status === "ok" && p.verified === true && label === VERIFIED_LABEL &&
    Array.isArray(rows) && rows.length > 0 && rows.every(r => isObj(r) && r.verified === true);
  return { verified, label: !verified && label !== null && claimsVerified(label) ? null : label };
}

export function labelSentence(l: { verified: boolean; label: string | null }): string {
  if (l.verified && l.label) return `${clip(l.label, 60)}.`;
  return l.label ? `Not chef-verified (label: "${clip(l.label, 80)}"). ${NOT_VERIFIED_TAIL}` : `Not chef-verified. ${NOT_VERIFIED_TAIL}`;
}

/** The answer part of a summary, per tool. Missing fields are left out; anything unexpected falls back. */
export function answerCore(tool: string, a: any): string {
  try {
    switch (tool) {
      case "scale_recipe":
        return `Scaled ${clip(a.fromPortions, 12)}→${clip(a.toPortions, 12)} portions (×${clip(a.factor, 12)}): ${a.lines.length} line(s), ` +
          `${clip(a.batches?.count ?? 1, 6)} batch(es), ${Array.isArray(a.tips) ? a.tips.length : 0} tip(s).`;
      case "calculate_yield_and_cost":
        return `${clip(a.ingredient)} (${clip(a.basis, 12)}): ${clip(a.purchasedWeightG, 12)} g bought → usable ${clip(a.usableWeightG.mid, 12)} g mid` +
          `${a.basis === "cooked" && isObj(a.cookedWeightG) ? `, cooked ${clip(a.cookedWeightG.mid, 12)} g mid` : ""}` +
          `${isObj(a.portion) && isObj(a.portion.fullPortions) ? `; ${clip(a.portion.fullPortions.mid, 12)} full portions mid` : ""}.`;
      case "calculate_amount_to_buy":
        return `Buy ${clip(a.buyDisplay.best, 20)} / ${clip(a.buyDisplay.mid, 20)} / ${clip(a.buyDisplay.worst, 20)} of ${clip(a.ingredient)} ` +
          `(best/mid/worst, rounded up) for ${clip(a.portions, 12)} × ${clip(a.portionSizeG, 12)} g ${clip(a.basis, 12)}` +
          `${isObj(a.cost) && isObj(a.cost.perPortion) ? `; ${clip(a.cost.currency, 3)} ${clip(a.cost.perPortion.mid, 12)} a portion mid` : ""}` +
          `${isObj(a.foodCostPct) ? `; food cost ${clip(a.foodCostPct.mid, 8)}% mid` : ""}.`;
      case "diagnose_cooking_problem": {
        const causes = a.causes as any[];
        return `${clip(a.dish, 60)} / ${clip(a.symptom, 60)}: ${causes.length} ranked cause(s), ${causes.filter(c => isObj(c) && c.fix).length} with a fix.`;
      }
      case "find_ingredient_substitute":
        return `${clip(a.ingredient)}: ${(a.options as any[]).slice(0, 8).map(o => `${clip(o.use, 60)}: ${clip(o.verdict, 8)}`).join("; ")}.`;
      // Draft summaries for 0.2.0 (docs/mcp-publish.md, "Version 0.2.0"): names and counts only.
      case "get_gluten_free_bread_answer": {
        const what: Record<string, () => string> = {
          flour: () => `flour ${clip(a.flour.name)}`,
          starter: () => `starter ${clip(a.starter.name)}, ${clip(a.starter.hydrationPct, 8)}% hydration`,
          swap: () => `${a.swaps.length} swap(s)`,
          compare: () => `compared by ${clip(a.by, 20)}`,
          fix: () => `${a.fixes.length} matching fix(es)`,
          technique: () => `technique ${clip(a.technique.name)}: ${a.answers.length} answer(s), ${a.notes.length} note(s), ${a.swaps.length} swap(s)`,
          recipe: () => `recipe ${clip(a.recipe.name)}`,
        };
        const core = what[a.topic];
        if (!core) break;
        return `Gluten-free bread, ${core()}${Array.isArray(a.cautions) && a.cautions.length ? `; ${a.cautions.length} caution(s) to pass on` : ""}.`;
      }
      case "calculate_menu_price":
        return `Plate cost ${clip(a.plateCost, 12)} (with ${clip(a.allowancePct, 6)}% allowance)` +
          `${a.foodCostPct !== null && a.foodCostPct !== undefined ? `; food cost ${clip(a.foodCostPct, 8)}% ex tax, ${clip(a.foodCostStatus, 12)} against ${clip(a.targetPct, 6)}%` : ""}` +
          `; price at target ${clip(a.priceAtTarget, 12)}.`;
      case "calculate_menu_engineering": {
        const dishes = a.dishes as any[];
        const n = (c: string) => dishes.filter(d => isObj(d) && d.class === c).length;
        return `${dishes.length} dish(es) classed: ${n("STAR")} Star, ${n("PLOWHORSE")} Plowhorse, ${n("PUZZLE")} Puzzle, ${n("DOG")} Dog` +
          `${Array.isArray(a.pools) && a.pools.length > 1 ? `, in ${a.pools.length} pools` : ""}.`;
      }
      // Draft summaries for 0.3.0 (docs/mcp-publish.md, "Version 0.3.0"): names and counts only.
      case "plan_function_order": {
        const items = a.items as any[];
        return `Function order, ${clip(a.style, 20)} for ${clip(a.guests, 6)} guest(s)` +
          `${isObj(a.guestsWithBuffer) && a.guestsWithBuffer.worst !== a.guests ? ` (${clip(a.guestsWithBuffer.best, 6)}-${clip(a.guestsWithBuffer.worst, 6)} with buffer)` : ""}` +
          `: ${items.length} item(s)${Array.isArray(a.buy) ? `, ${a.buy.length} buy line(s)` : ""}` +
          `${isObj(a.costPerHead) ? `; ${clip(a.costPerHead.currency, 3)} ${clip(a.costPerHead.mid, 12)} a head mid` : ""}` +
          `; ${Array.isArray(a.notCovered) ? a.notCovered.length : 0} thing(s) not covered.`;
      }
      case "review_menu": {
        const dishes = a.dishes as any[];
        const over = dishes.filter(d => isObj(d) && d.foodCostStatus === "OVER TARGET").length;
        return `${dishes.length} dish(es) reviewed: ${over} over target` +
          `${Array.isArray(a.fixFirst) ? `; ${a.fixFirst.length} to fix first` : "; no fix-first ranking (no units sold)"}` +
          `${Array.isArray(a.dogs) ? `, ${a.dogs.length} Dog(s)` : ""}` +
          `${Array.isArray(a.sectionReviews) && a.sectionReviews.length ? `; ${a.sectionReviews.length} section(s) to review` : ""}.`;
      }
    }
  } catch { /* fall through */ }
  return "Answer received; see api.";
}

export function toResult(env: Envelope): CallToolResult {
  const structured = {
    kind: env.kind, tool: env.tool, httpStatus: env.httpStatus, charged: env.charged, spend: env.spend,
    label: env.label, verified: env.verified, summary: env.summary, ...(env.replayed ? { replayed: true } : {}),
    ...(env.quote ? { quote: env.quote } : {}), api: env.api,
  };
  return {
    content: [{ type: "text", text: env.summary }, { type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: IS_ERROR[env.kind],
  };
}

/** The fixed result used whenever anything unexpected happens. It carries no error text. */
export function fixedFailure(tool: string, paidMayHaveHappened: boolean): CallToolResult {
  const summary = paidMayHaveHappened
    ? "Something went wrong after a payment was sent. It may have been charged; don't retry straight away, as a retry pays again."
    : "Something went wrong in this server before anything was paid. Nothing was signed or charged.";
  return toResult({ kind: paidMayHaveHappened ? "payment_unconfirmed" : "service_error", tool, httpStatus: null, charged: null, spend: null, label: null, verified: null, summary, api: null });
}

/**
 * Maps an API response that isn't a payment step (400/404/413/422/5xx) to an envelope. `useGiven`: a substitute call
 * that named a replacement, whose 404 can also be retried without it.
 */
export function nonAnswer(tool: string, status: number, body: unknown, base: Pick<Envelope, "spend">, opts: { useGiven?: boolean } = {}): Envelope {
  const b = isObj(body) ? body : null;
  const common = { tool, httpStatus: status, charged: null, label: null, verified: null, api: body ?? null, ...base };
  if ((status === 400 || status === 413) && b?.status === "invalid") {
    return { ...common, kind: "invalid", summary: `Couldn't read the request (free, nothing charged): ${clip(b.message, 400)}` };
  }
  if (status === 404 && b?.status === "not_found" && Array.isArray(b.suggestions)) {
    const s = b.suggestions as unknown[];
    const message = clip(b.message, 300).trim();
    const stop = message === "" || /[.!?]$/.test(message) ? "" : ".";
    return {
      ...common, kind: "not_found",
      summary: `No answer for that yet (free, nothing charged): ${message}${stop} ${s.length} valid names, e.g. ` +
        `${s.slice(0, 5).map(x => clip(x, 40)).join(", ")}. Retry only if the user's dish, symptom or ingredient really is one of them ` +
        `(check_coverage lists them)${opts.useGiven ? ", or leave use out" : ""}; never swap in a different one.`,
    };
  }
  if (status === 422 && b?.status === "refused") {
    return {
      ...common, kind: "refused",
      summary: `Refused (free, nothing charged; topic: ${clip(b.topic, 40)}). Kitchen Pass never answers this topic in any wording. ` +
        "Pass the message in api.message to the user; don't rephrase the question to get an answer.",
    };
  }
  if (status === 429) return { ...common, kind: "service_error", summary: "Kitchen Pass is rate-limiting requests right now. Nothing was charged; retry in a minute." };
  if (status === 503) return { ...common, kind: "service_error", summary: "Kitchen Pass isn't available right now. Nothing was charged; retry shortly." };
  return { ...common, kind: "service_error", summary: `Unexpected response from Kitchen Pass (HTTP ${status}). Nothing was charged. If it repeats, this package may need an update.` };
}

export function priceText(usd: string, pins: NetworkPins) {
  return `$${usd} ${pins.label}`;
}
