// The twelve tools: input schemas, descriptions and hints. Every schema is a zod object with .strict() at every level,
// passed to registerTool as an object (never a raw shape, which the SDK would turn into a non-strict object that drops
// unknown keys) and never wrapped in refine/transform (which the SDK lists as an empty {}). So a misnamed field such as
// price_per_kg is a free input error, never silently dropped from a paid call. Rules that span fields are left to the
// API's free 400. Property descriptions come from the public OpenAPI file, except FIELD_TEXT (approved 30 Sep 2026).
import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { PaidPath } from "./config.js";
import { DESCRIPTIONS, PRICES } from "./listing.js";
import { ADDENDA, costsSentence, FIELD_TEXT, FREE_DESCRIPTIONS, paidTitle, SHARED_PAID, TITLES } from "./wording.js";

const WEIGHT_TEXT = "Between 1 g and 10 t in total (0.0353 oz to 22,046 lb; lb and oz are converted exactly).";
/** A fresh object each time, so the JSON Schema has no $ref between fields. */
const weight = () => z.object({ qty: z.number().gt(0).max(10_000_000), unit: z.enum(["g", "kg", "lb", "oz"]) }).strict();
const dryRun = () => z.boolean().default(false).describe(FIELD_TEXT.dryRun);
const currency = () => z.string().regex(/^[A-Za-z]{3}$/).describe(FIELD_TEXT.currency);
const money = () => z.number().min(0.01).max(1_000_000_000);

const COST_UNITS = ["g", "kg", "lb", "oz", "ml", "l", "ea"] as const;
const taxPct = () => z.number().min(0).max(50).optional().describe("Only with pricesIncludeTax true.");

/** A dish's ingredient lines, as /v1/menu-price and /v1/menu-review take them. A fresh schema each time (no $ref). */
const costLines = () => z.array(z.object({
  name: z.string().min(1).max(120).optional(),
  qty: z.number().min(0.0001).max(10_000_000).describe("How much goes on the plate, in the pack's unit (or in `unit`)."),
  unit: z.enum(COST_UNITS).optional().describe("With packUnit, to convert; leave both out when qty and packSize are in the same unit."),
  packPrice: money().describe("The price of one pack as bought."),
  packSize: z.number().min(0.0001).max(10_000_000).describe("How much one pack holds."),
  packUnit: z.enum(COST_UNITS).optional(),
  yieldPct: z.number().min(1).max(100).optional().describe("The usable % of the pack after trim."),
}).strict()).min(1).max(50);

const FUNCTION_STYLES = ["plated", "alternate-drop", "buffet", "family-style", "canapes", "grazing", "breakfast-buffet", "morning-tea", "afternoon-tea", "working-lunch"] as const;

const RECIPE_UNITS = ["g", "kg", "ml", "l", "tsp", "tbsp", "lb", "oz", "cup", "cups", "mg", "cl", "dl", "hl", "US cup", "US cups", "metric cup", "metric cups"] as const;

export const SCHEMAS = {
  scale_recipe: z.object({
    recipe: z.union([
      z.string().min(1).max(4000),
      z.array(z.object({
        qty: z.number().min(0.0001).max(1_000_000),
        unit: z.enum(RECIPE_UNITS).nullable().optional().describe('Omit or null for counted items like eggs. mg is also accepted (converted to g), and cl, dl and hl (converted to ml). lb and oz are weight (never fluid ounces). cup or cups stay cups; "US cup(s)" or "metric cup(s)" also set the cup size. fl oz, pints, quarts, gallons, "c", "T" and "t" are rejected.'),
        item: z.string().min(1).max(120),
      }).strict()).min(1).max(40),
    ]).describe('Text ("2 kg brisket; 500 ml stock; 1 tbsp salt; 3 eggs", ; or newline separated, one amount per line, max 200 characters a line) or structured lines. Max 40 lines. Mixed numbers ("1 1/2 kg") are read as one amount; "1,5 kg", "2-3 cloves" and "1 kg 500 g" are rejected.'),
    fromPortions: z.number().min(0.01).max(10_000),
    toPortions: z.number().min(0.01).max(10_000),
    method: z.string().max(40).optional().describe('Optional cooking method ("roast", "fry", "stir-fry") — selects method-specific tips. Screened like a question: a cure, ferment, preserve or holding method ("cold smoke", "pickling", "sous vide") is refused.'),
    cupSize: z.enum(["us", "us-legal", "metric"]).optional().describe('Cup size for lines in cups: us = 236.5882365 ml, us-legal = 240 ml (US nutrition label), metric = 250 ml. Lines saying "US cups" or "metric cups" carry their own ("US cups" with us-legal is 240 ml); metric against a US size is rejected. Without a size, cups are scaled as cups with no ml and are not counted toward volume batch limits. Cups are never converted to grams, so they never count as a weight: a recipe with a line in cups gets no baker\'s percentage, and a rule that goes by the recipe\'s proportions by weight (salt in a cake or bread) can\'t be checked. When the recipe could be a cake or bread, its salt then scales straight as an engine default and the whole answer is labelled not chef-verified (the line\'s undecidedClass names the rule); when the known ingredients already rule that out (no flour, stock in it), the usual salt rule applies. Give weights to get the chef\'s rule.'),
    dryRun: dryRun(),
  }).strict(),
  calculate_yield_and_cost: z.object({
    ingredient: z.string().min(1).max(120),
    purchased: weight().describe(WEIGHT_TEXT),
    price: money().describe("Total paid for the purchased quantity."),
    currency: currency(),
    portions: z.number().int().min(1).max(1_000_000).optional().describe("Split the yield into this many portions: cooked when the chef has a cook-loss range for the ingredient, otherwise trimmed raw (`basis` says which). Not with portionSize."),
    portionSize: weight().optional().describe("Weight of one portion as served: cooked when the chef has a cook-loss range for the ingredient, otherwise trimmed raw (`basis` says which). Not with portions."),
    dryRun: dryRun(),
  }).strict(),
  calculate_amount_to_buy: z.object({
    ingredient: z.string().min(1).max(120),
    portions: z.number().int().min(1).max(1_000_000).describe("How many portions to buy for."),
    portionSize: weight().describe("Weight of one portion as served — cooked when the chef has a cook-loss range for the ingredient, otherwise trimmed raw (the response's `basis` says which). portions × portionSize is at most 10 t."),
    pricePerKg: money().optional().describe("Price per kg as bought. Not with pricePerLb."),
    pricePerLb: money().optional().describe("Price per lb as bought. Not with pricePerKg."),
    sellPrice: money().optional().describe("Menu price of one portion, excluding GST/VAT/sales tax. Needs pricePerKg or pricePerLb (400 without)."),
    currency: currency(),
    dryRun: dryRun(),
  }).strict(),
  diagnose_cooking_problem: z.object({
    dish: z.string().min(1).max(120),
    symptom: z.string().min(1).max(300),
    dryRun: dryRun(),
  }).strict(),
  find_ingredient_substitute: z.object({
    ingredient: z.string().min(1).max(80).describe("What you want to replace."),
    use: z.string().max(80).optional().describe("Optional: the replacement you have in mind."),
    dryRun: dryRun(),
  }).strict(),
  get_gluten_free_bread_answer: z.object({
    topic: z.enum(["flour", "starter", "swap", "compare", "fix", "technique", "recipe"]),
    name: z.string().min(1).max(80).optional().describe("flour, starter, technique, recipe, swap (the ingredient to replace): required. Not with compare or fix."),
    use: z.string().max(80).optional().describe("swap only, optional: the replacement you have in mind."),
    by: z.enum(["hydration", "protein", "fermentation"]).optional().describe("compare only, required."),
    problem: z.string().min(1).max(160).optional().describe("fix only, required: what went wrong, e.g. gummy crumb."),
    dryRun: dryRun(),
  }).strict(),
  calculate_menu_price: z.object({
    lines: costLines().optional(),
    plateCost: money().optional().describe("A plate cost you already have."),
    plateCostIncludesAllowance: z.boolean().optional().describe("With plateCost only. True when it already has the allowance in."),
    menuPrice: money().optional().describe("As shown on the menu."),
    pricesIncludeTax: z.boolean().optional(),
    taxPct: taxPct(),
    targetPct: z.number().min(1).max(99).optional(),
    allowancePct: z.number().min(0).max(15).optional().describe("Waste and garnish allowance. Not with plateCostIncludesAllowance true."),
    roundTo: z.number().min(0.01).max(100).optional().describe("priceAtTarget is rounded up to the next multiple."),
    dryRun: dryRun(),
  }).strict(),
  calculate_menu_engineering: z.object({
    dishes: z.array(z.object({
      name: z.string().min(1).max(120),
      unitsSold: z.number().int().min(0).max(10_000_000),
      menuPrice: money().describe("As shown on the menu."),
      plateCost: money(),
      section: z.string().min(1).max(60).optional(),
      catering: z.boolean().optional().describe("Judged in the catering pool. Default: true when section names catering, platter or function."),
    }).strict()).min(2).max(200),
    pricesIncludeTax: z.boolean().optional(),
    taxPct: taxPct(),
    dryRun: dryRun(),
  }).strict(),
  plan_function_order: z.object({
    guests: z.number().int().min(1).max(5000),
    style: z.enum(FUNCTION_STYLES),
    mealTime: z.enum(["morning", "lunch", "afternoon", "evening"]).optional(),
    courses: z.array(z.enum(["entree", "main", "dessert"])).min(1).max(3).optional(),
    proteinCount: z.number().int().min(1).max(3).optional(),
    durationHours: z.number().min(0.5).max(8).optional(),
    selfServe: z.boolean().optional(),
    canapesBefore: z.boolean().optional(),
    straightFromWork: z.boolean().optional(),
    alongside: z.boolean().optional(),
    buy: z.array(z.object({
      ingredient: z.string().min(1).max(120).describe("An exact name GET /v1/coverage lists under yieldCost (or an alias)."),
      item: z.string().min(1).max(60).describe("The key of an item this order weighs in grams, e.g. protein, protein-1, main-a, starch."),
      share: z.number().min(0.01).max(1).optional().describe("This ingredient's part of the item's weight."),
      pricePerKg: money().optional().describe("As bought. Not with pricePerLb."),
      pricePerLb: money().optional().describe("As bought. Not with pricePerKg."),
    }).strict()).min(1).max(30).optional(),
    currency: z.string().regex(/^[A-Za-z]{3}$/).optional().describe("Only with priced buy lines."),
    dryRun: dryRun(),
  }).strict(),
  review_menu: z.object({
    dishes: z.array(z.object({
      name: z.string().min(1).max(120),
      section: z.string().min(1).max(60).optional(),
      catering: z.boolean().optional(),
      menuPrice: money().describe("As shown on the menu."),
      unitsSold: z.number().int().min(0).max(10_000_000).optional().describe("Units sold in one week. For every dish or none."),
      lines: costLines().optional(),
      plateCost: money().optional(),
      plateCostIncludesAllowance: z.boolean().optional(),
    }).strict().describe("lines or plateCost, not both.")).min(2).max(200),
    pricesIncludeTax: z.boolean().optional(),
    taxPct: taxPct(),
    targetPct: z.number().min(1).max(99).optional(),
    allowancePct: z.number().min(0).max(15).optional(),
    roundTo: z.number().min(0.01).max(100).optional(),
    dryRun: dryRun(),
  }).strict(),
  check_coverage: z.object({
    section: z.enum(["scale", "diagnose", "substitute", "yieldCost", "glutenFree", "refused"]).optional().describe(FIELD_TEXT.section),
  }).strict(),
  get_sample_answer: z.object({}).strict(),
} as const;

export type ToolName = keyof typeof SCHEMAS;
export type PaidTool = Exclude<ToolName, "check_coverage" | "get_sample_answer">;

export const PAID_TOOLS: Record<PaidTool, PaidPath> = {
  scale_recipe: "/v1/scale",
  calculate_yield_and_cost: "/v1/yield-cost",
  calculate_amount_to_buy: "/v1/how-much-to-buy",
  diagnose_cooking_problem: "/v1/diagnose",
  find_ingredient_substitute: "/v1/substitute",
  get_gluten_free_bread_answer: "/v1/gluten-free",
  calculate_menu_price: "/v1/menu-price",
  calculate_menu_engineering: "/v1/menu-engineering",
  plan_function_order: "/v1/function-order",
  review_menu: "/v1/menu-review",
};

/**
 * Paid tools: not read-only, and destructive (the spec's default, set explicitly): a payment can't be undone. Not
 * idempotent: each call pays again. None of this is relied on as a safeguard; the caps are the hard stop.
 */
const PAID_HINTS: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const FREE_HINTS: ToolAnnotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };

export interface ToolSpec { name: ToolName; title: string; description: string; schema: z.ZodObject<any>; annotations: ToolAnnotations }

/** `prices` is only ever the route prices; tests pass others to check nothing in the text keeps an old price. */
export function toolSpecs(prices: Record<PaidPath, string> = PRICES): ToolSpec[] {
  const paid = (Object.keys(PAID_TOOLS) as PaidTool[]).map(name => {
    const price = prices[PAID_TOOLS[name]];
    const title = paidTitle(TITLES[name], price);
    return {
      name, title, schema: SCHEMAS[name], annotations: { title, ...PAID_HINTS },
      description: `${DESCRIPTIONS[PAID_TOOLS[name]]}\n\n${ADDENDA[name]} ${costsSentence(price)} ${SHARED_PAID}`,
    };
  });
  const free = (["check_coverage", "get_sample_answer"] as const).map(name => ({
    name, title: TITLES[name], schema: SCHEMAS[name], annotations: { title: TITLES[name], ...FREE_HINTS }, description: FREE_DESCRIPTIONS[name],
  }));
  return [...paid, ...free];
}
