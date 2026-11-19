// stdio entry point. stdout carries the MCP protocol, so nothing else is ever written to it. stderr (which hosts keep
// in log files) only ever gets fixed text: no error message, stack, path or setting value.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createKitchenPassServer } from "./server.js";

const fixed = (text: string) => { try { process.stderr.write(`kitchen-pass-mcp: ${text}\n`); } catch { /* nowhere to write */ } };
process.on("uncaughtException", () => { fixed("stopped after an unexpected error (details withheld)."); process.exit(1); });
process.on("unhandledRejection", () => { fixed("stopped after an unexpected error (details withheld)."); process.exit(1); });

try {
  const { server, ctx } = createKitchenPassServer({ env: process.env });
  const blocked = ctx.settings ? ctx.payBlocked() : null;
  await server.connect(new StdioServerTransport());
  fixed(!ctx.settings ? "started, but not set up (every tool will say what's missing)."
    : `started on ${ctx.settings.network.name}; ${blocked ? (blocked.quoteOnly ? "quotes only" : "paying is off (the tools say why)") : "paying within the spend caps"}.`);
} catch {
  fixed("couldn't start (details withheld).");
  process.exit(1);
}
