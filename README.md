# Kitchen Pass MCP server


Kitchen Pass answers cooking questions from a head chef's rules: scale a recipe, work out yield and cost, how much to buy, why a dish went wrong, what to use instead, gluten-free bread, a dish's menu price, menu engineering from sales, food quantities for a function, and a whole-menu review. This server makes those answers available as tools in MCP hosts such as Claude Code and Claude Desktop. It runs on your own machine and pays per answer in USDC with [x402](https://www.x402.org/), from a wallet you control, within spend caps you set.

## Tools and prices

| Tool | What it answers | Price |
|---|---|---|
| `scale_recipe` | Scale a recipe up or down, line by line, with the reason for each line | $0.01 |
| `calculate_yield_and_cost` | What a purchase yields after trim and cook loss, and the cost per portion | $0.01 |
| `calculate_amount_to_buy` | How much to buy for N portions, with optional cost and food-cost % | $0.01 |
| `diagnose_cooking_problem` | The likely causes of a dish going wrong, and the fixes | $0.02 |
| `find_ingredient_substitute` | What to use instead: yes, no or depends | $0.01 |
| `get_gluten_free_bread_answer` | Gluten-free bread: flours, starters, swaps, techniques, fixes and tested recipes | $0.01 |
| `calculate_menu_price` | A dish's plate cost, food cost % and the menu price that hits target | $0.01 |
| `calculate_menu_engineering` | Star, Plowhorse, Puzzle or Dog for each dish from units sold, with an action for each | $0.02 |
| `plan_function_order` | Food per guest and totals for a plated, buffet, canapé, grazing or other function, with the weight to buy and cost per head | $1 |
| `review_menu` | Every dish costed, classed and ranked: what to fix first, with re-cost advice | $1 |
| `check_coverage` | The names of everything the paid tools answer today | free |
| `get_sample_answer` | A fixed demo of a paid answer | free |

**The two $1 tools need higher caps.** At the default caps ($0.10 a session, $0.50 a day) they only quote. To use them, raise `KITCHEN_PASS_MAX_SPEND_PER_SESSION` and `KITCHEN_PASS_MAX_SPEND_PER_DAY` (for example to `2` and `5`); the tool's answer names the setting when a cap stops it.

**What costs money:**
- Only an answer (HTTP 200) is charged.
- A request Kitchen Pass can't read (400), doesn't cover yet (404) or refuses (422, for example allergy or food-safety questions) is free.
- Any paid tool with `dryRun: true` gives a free quote: whether it would be answered, and the price. Nothing is signed.
- Without a key file, the server only quotes.

**Chef-verified label:** not every answer is chef-verified. A result says "Chef-verified by Cristopher" only when every rule it used is verified. Otherwise it says it isn't.

## Safety

- **Use a separate wallet holding only a few dollars of USDC.** Never point this at your main wallet.
- **The spend caps are the only guaranteed stop.** Your host may not ask before each payment: it won't in Claude Code's bypass-permissions mode, or after you choose "Always allow" in Claude Desktop.
  - Where the host supports MCP form elicitation, the server also asks "Pay $0.02 … ?" before each payment.
  - Defaults: $0.10 per session, $0.50 per UTC day. Code ceilings: $5 per session, $20 per day.
  - The session cap resets whenever the host restarts the server. The day cap holds across restarts and across every host on your machine.
- **Where money can go is fixed in the package.** The tools take no URL, pay-to address or amount. The server pays only:
  - the Kitchen Pass site for the chosen network;
  - the pinned Kitchen Pass pay-to address;
  - no more than the tool's listed price.
  Any other terms, or a redirect, means nothing is signed.
- **Your key stays on your machine.** It is read only from the key file you name, never from an environment variable or a tool argument. The server never prints, logs or returns it. Only the signed payment for one answer is sent, to Kitchen Pass.
- **Spending is recorded before signing.** Each payment goes into a local ledger, synced to disk, before it is signed. The amount is never given back to the cap, even if the payment fails. If the ledger can't be read or written, the server doesn't pay.
  - The ledger must be a plain file, never a link.
  - If the ledger is removed, replaced or truncated while the server is running, that server pays nothing more until it is restarted. It also keeps its own spend in memory, so emptying the file never lifts its caps.
- **One payment per request.** A payment is signed at most once per call and never retried. Nothing is signed after a call is cancelled or times out.
  - An identical call made while another is still in progress waits for it and gets the same answer, marked "not charged again".
  - After a payment that was sent but not confirmed (no answer, or a server error), the same request isn't paid for again for 5 minutes. A quote, or a different request, still works.

## Install

Node 20 or later.

**From source** (build from this repo):

```sh
cd mcp
npm run build      # writes dist/kitchen-pass-mcp.mjs, one self-contained file
```

Then use `node /path/to/kitchen-pass-mcp.mjs` as the command below.

**From npm**, always pin the exact version. An unpinned `npx -y` would run whatever is published next.

```sh
npx -y kitchen-pass-mcp@0.3.0
```

### 1. Make a key file

1. Create a new wallet and fund it with a few dollars of USDC on Base.
   - To try it for free first, use Base Sepolia with test USDC from a faucet.
2. Put its private key in a file that only you can read:

```sh
printf 'PAYER_PRIVATE_KEY=0x…\n' > ~/kitchen-pass-payer.key   # or just the key on one line
chmod 600 ~/kitchen-pass-payer.key
```

The server refuses a key file that other users can read. On macOS that includes a file with an access control list (`ls -le` shows numbered lines under it); remove the list with `chmod -N ~/kitchen-pass-payer.key`.

### 2. Add it to your host

**Claude Code** (local scope, so the key file's path isn't written into a shared project file):

```sh
claude mcp add --scope local kitchen-pass \
  -e KITCHEN_PASS_NETWORK=base-sepolia \
  -e KITCHEN_PASS_PAYER_KEY_FILE=/path/to/kitchen-pass-payer.key \
  -e KITCHEN_PASS_MAX_SPEND_PER_SESSION=0.10 \
  -e KITCHEN_PASS_MAX_SPEND_PER_DAY=0.50 \
  -- npx -y kitchen-pass-mcp@0.3.0
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "kitchen-pass": {
      "command": "npx",
      "args": ["-y", "kitchen-pass-mcp@0.3.0"],
      "env": {
        "KITCHEN_PASS_NETWORK": "base-sepolia",
        "KITCHEN_PASS_PAYER_KEY_FILE": "/path/to/kitchen-pass-payer.key",
        "KITCHEN_PASS_MAX_SPEND_PER_SESSION": "0.10",
        "KITCHEN_PASS_MAX_SPEND_PER_DAY": "0.50"
      }
    }
  }
}
```

Start on `base-sepolia` (test USDC). Switch to `base` (real USDC) when you're ready.

## Settings

| Variable | Values | Default |
|---|---|---|
| `KITCHEN_PASS_NETWORK` | `base` (real USDC) or `base-sepolia` (test USDC) | none: required |
| `KITCHEN_PASS_PAYER_KEY_FILE` | Absolute path to your key file (mode 600); a leading `~/` is expanded | unset: quotes only |
| `KITCHEN_PASS_MAX_SPEND_PER_SESSION` | USD, e.g. `0.10` (at most `5`) | `0.10` |
| `KITCHEN_PASS_MAX_SPEND_PER_DAY` | USD per UTC day, e.g. `0.50` (at most `20`) | `0.50` |
| `KITCHEN_PASS_LEDGER_DIR` | Absolute path of the folder for the spend ledgers, one per network; a leading `~/` is expanded | `~/.kitchen-pass-mcp` |
| `KITCHEN_PASS_CONFIRM` | `elicit` (ask where the host supports it) or `off` | `elicit` |
| `KITCHEN_PASS_DRY_RUN` | `1`: quotes only | unset |

**If a setting is wrong:**
- A cap that isn't a plain amount like `0.50`, or is over the ceiling, turns paying off. The tools say which variable to fix.
- So does a misspelt `KITCHEN_PASS_` variable (for example `KITCHEN_PASS_DRYRUN`), and a relative path for the key file or the ledger folder. Every host must use the same ledger folder for the day cap to hold across them.
- If `KITCHEN_PASS_NETWORK` is missing or wrong, every tool reports it.

## Results

Each result has:
- a one-line summary;
- the full result as JSON: `kind`, `charged` (amount, network, transaction and explorer link), `spend` (session and day totals against the caps), `label`, `verified`, and `replayed: true` on an answer an earlier identical call already paid for;
- the Kitchen Pass answer, word for word, under `api`.

A refusal (422) is a final answer, not an error. Don't rephrase the question to get around it.

## Spend ledger

`~/.kitchen-pass-mcp/spend-base.jsonl` and `spend-base-sepolia.jsonl` (mode 600, in a mode-700 folder) hold one line per payment:
- time, tool, amount and network;
- afterwards, its outcome, transaction and paying address.

They never hold your key, the signed payment or your questions.
