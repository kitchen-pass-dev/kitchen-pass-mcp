// Public wording, all in one place: approved by Cristopher on 30 Sep 2026 (docs/mcp-publish.md). The approved route
// descriptions (listing.ts DESCRIPTIONS) are used word for word; everything below is added to them or used on its own.
// Tool text uses the first name only. The three 0.2.0 tools' titles and addenda, and check_coverage's added gluten-free
// clause, were approved on 21 Oct 2026. The two 0.3.0 tools' titles, addenda and result summaries are DRAFTS awaiting
// Cristopher's word-for-word yes (docs/mcp-publish.md, "Version 0.3.0").

/** Paid titles get " (paid, $<price>)" from the route price (tools.ts), so a price change can't leave them stale. */
export const TITLES = {
  scale_recipe: "Scale a recipe",
  calculate_yield_and_cost: "Yield and cost from a purchase",
  calculate_amount_to_buy: "How much to buy for N portions",
  diagnose_cooking_problem: "Why did this dish go wrong",
  find_ingredient_substitute: "What to use instead",
  get_gluten_free_bread_answer: "Gluten-free bread answers",
  calculate_menu_price: "Menu price and food cost % for a dish",
  calculate_menu_engineering: "Menu engineering from sales",
  plan_function_order: "Function order sheet: food quantities for an event",
  review_menu: "Whole-menu review: what to fix first",
  check_coverage: "What Kitchen Pass answers (free)",
  get_sample_answer: "Free sample answer (demo only)",
} as const;
export const paidTitle = (title: string, priceUsd: string) => `${title} (paid, ${priceUsd})`;
/** Ends each addendum, from the route price. */
export const costsSentence = (priceUsd: string) => `Costs ${priceUsd}.`;

/** Ends every paid tool's description. */
export const SHARED_PAID =
  "Paid automatically in USDC with x402 (test USDC when this server is set to base-sepolia), within this server's " +
  "per-session and per-day spend caps. Only a 200 answer is charged; 400, 404 and 422 are free. Set dryRun to true to " +
  "check for free whether this would be answered and what it costs; nothing is signed. If unsure what is covered, call " +
  "check_coverage first (free). Not every answer is chef-verified: say \"chef-verified by Cristopher\" only when the " +
  "result's label says exactly that; otherwise say it is not chef-verified. A refusal is final: don't rephrase the " +
  "question to get around it.";

export const ADDENDA = {
  scale_recipe:
    "Use for scaling ingredient quantities up or down (to double: fromPortions 1, toPortions 2). Not for nutrition, " +
    "allergen or diet swaps, food safety, or scaling staff, labour, covers or money lines (a free 400). One amount per " +
    "line: no ranges (\"2-3 cloves\"), no \"1 lb 4 oz\", no fl oz, pints or quarts; with cups, also give cupSize. A " +
    "recipe with a line in cups may come back not chef-verified.",
  calculate_yield_and_cost:
    "Use when the user already bought, or has priced, a weight of one ingredient and wants what it yields and the cost " +
    "per portion. For \"how much do I need for N people\", use calculate_amount_to_buy instead. ingredient must be an " +
    "exact listed name or alias (others get a free 404 with suggestions). price is the total paid for purchased, not a " +
    "price per kg. Give either portions (split the yield into N) or portionSize, not both. currency is required: the " +
    "user's 3-letter currency code (display only).",
  calculate_amount_to_buy:
    "Use when the user starts from portions (\"120 people, 180 g cooked each\"). For \"I bought 5 kg, what do I get\", " +
    "use calculate_yield_and_cost instead. portionSize is one portion as served (cooked when basis is cooked). For cost, " +
    "give pricePerKg or pricePerLb (the price as bought; not both, and not \"price\"). sellPrice is the ex-tax menu " +
    "price of one portion and needs one of them. currency is required: the user's 3-letter currency code (display " +
    "only).",
  diagnose_cooking_problem:
    "Send the dish and a short symptom in the user's words (\"dense\", \"split\", \"came out gluey\"). Leave out extra " +
    "clauses (\"…after I added the butter\"). Rescue questions (\"can I save it?\") aren't answered, and \"is it still " +
    "safe?\" is refused. An unlisted dish or symptom gets a free 404 with the valid names. Retry only if the user's " +
    "dish really is one of them; don't swap in a different dish.",
  find_ingredient_substitute:
    "ingredient is what the user wants to replace. use is optional: the replacement they have in mind, to get just " +
    "that answer. A \"no\" verdict is advice too: pass it on, with what it depends on for \"depends\". Allergy, dairy-, " +
    "egg- or gluten-free and storage framings are refused (free 422).",
  get_gluten_free_bread_answer:
    "Pick a topic: flour, starter, technique or recipe with name; swap with name (the ingredient to replace) and " +
    "optionally use; compare with by (hydration, protein or fermentation); fix with problem (what went wrong, e.g. " +
    "\"gummy crumb\"). An unlisted name or problem gets a free 404 with the valid ones (check_coverage section " +
    "glutenFree lists them). Pass on the answer's glutenFree line and any cautions as given. Allergen, mould, spoilage " +
    "and storage questions are refused (free 422).",
  calculate_menu_price:
    "Use for one dish's plate cost, food cost % and the menu price that hits target. Send lines (each with qty, " +
    "packPrice and packSize; unit and packUnit both or neither) or plateCost, not both. menuPrice is as shown on the " +
    "menu, tax included unless pricesIncludeTax is false. Food lines only: staff, labour or money lines are a free 400. " +
    "For several dishes with units sold, use calculate_menu_engineering instead.",
  calculate_menu_engineering:
    "Use when the user has units sold per dish for a period (one week from the POS is enough) and wants each dish " +
    "classed. Send 2-200 dishes, each with name, unitsSold, menuPrice (as shown on the menu) and plateCost; mark " +
    "catering platters with catering true. For one dish's price, use calculate_menu_price instead. Pass on each dish's " +
    "action as given.",
  plan_function_order:
    "Use when the user is catering an event and asks how much food to order for N guests. Send guests and style; for " +
    "canapes give durationHours, or canapesBefore true when they come before a sit-down meal; for buffet give " +
    "proteinCount (1-3). A field that doesn't go with the style is a free 400. For the weight to buy and cost per head, " +
    "add buy lines naming an item key from a first answer (protein, protein-1, starch...) and an ingredient " +
    "check_coverage lists under yieldCost. Pass on notCovered as given: nothing missing is filled in.",
  review_menu:
    "Use when the user wants their whole menu reviewed at once. Send 2-200 dishes, each with name, menuPrice (as shown " +
    "on the menu) and either lines or plateCost; add unitsSold (one week) for every dish or none, for classes and the " +
    "fix-first ranking. For one dish only, use calculate_menu_price; for classes from plate costs alone, " +
    "calculate_menu_engineering costs less. Pass on each dish's action and price advice as given.",
} as const;

export const FREE_DESCRIPTIONS = {
  check_coverage:
    "Free. Lists by name everything the paid Kitchen Pass tools answer today: diagnose dishes with their symptom " +
    "wordings, ingredients with answered swaps, yield ingredients with aliases (used by both calculate_yield_and_cost " +
    "and calculate_amount_to_buy), scaling classes and tip topics, gluten-free flours, starters, swaps, techniques, " +
    "problem wordings and recipes, and the food-safety topics that are always refused. " +
    "Names only, never the answers. Call it before a paid tool when unsure whether a dish, symptom or ingredient is " +
    "covered. Use section to fetch one part only.",
  get_sample_answer:
    "Free. A fixed demo: one bread recipe scaled from 10 to 60 portions by the same engine as scale_recipe. It does " +
    "not answer the user's question; use it only to see the shape of a paid answer.",
} as const;

/** Property descriptions that aren't in the public OpenAPI file. */
export const FIELD_TEXT = {
  dryRun: "Free quote only: check whether this would be answered and what it costs. Nothing is signed or charged.",
  section: "Return one part of the list only.",
  currency: "The user's 3-letter currency code, e.g. AUD, USD, GBP. Display only.",
} as const;

/** The payment confirmation (form elicitation): fixed text, the tool name and the price only. */
export function confirmMessage(tool: string, priceUsd: string, networkLabel: string): string {
  return `Pay $${priceUsd} (${networkLabel}) for one Kitchen Pass answer from ${tool}?`;
}
export const CONFIRM_FIELD = { title: "Pay", description: "Leave ticked and accept to pay. Untick or decline to stop; nothing is signed." } as const;

/** Added to an answer handed to a later identical call (its own summary, and the JSON's), which is also marked replayed. */
export const REPLAY_NOTE = " (Delivered to this call: an earlier identical call already paid for this answer; not charged again.)";
