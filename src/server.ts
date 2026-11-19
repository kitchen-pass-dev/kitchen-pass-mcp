// The MCP server: seven tools, no resources, no prompts, nothing that shows the environment or the key file's path.
// Every handler runs inside a catch-all that returns fixed text: the SDK would otherwise send any thrown error's
// message to the model, and some libraries put a key's value in their error messages. The same guard checks every
// outgoing result for the payer key in any form, and never lets an error after a paid 200 lose the paid answer.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { spendView } from "./caps.js";
import { VERSION } from "./config.js";
import { createContext, type Ctx, type ServerDeps } from "./context.js";
import { RequestFailed, request } from "./http.js";
import { runPaid, type CallState, type Extra } from "./pay.js";
import { fixedFailure, labelOf, labelSentence, nonAnswer, toResult } from "./results.js";
import { PAID_TOOLS, toolSpecs, type PaidTool, type ToolName } from "./tools.js";

export type { ServerDeps } from "./context.js";

const COVERAGE_TTL_MS = 10 * 60_000;
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);

async function runFree(ctx: Ctx, tool: "check_coverage" | "get_sample_answer", args: Record<string, unknown>, extra: Extra): Promise<CallToolResult> {
  const s = ctx.settings!;
  const url = `${s.baseUrl}${tool === "check_coverage" ? "/v1/coverage" : "/v1/sample"}`;
  const spend = spendView(ctx.ledger.state());
  const base = { tool, charged: null, spend, label: null, verified: null } as const;

  let status = 200;
  let json: unknown;
  const hit = ctx.cache.get(url);
  if (hit && ctx.clock() - hit.at < COVERAGE_TTL_MS) {
    json = hit.json;
  } else {
    if (!ctx.countUnpaidRequest()) return toResult({ ...base, kind: "service_error", httpStatus: null, api: null, summary: "This session has used its allowance of unpaid requests. Nothing was charged; restart the server to reset it." });
    try {
      const res = await request(ctx.fetch, url, { method: "GET", timeoutMs: ctx.timing.freeGetMs, signal: extra.signal });
      status = res.status;
      json = res.json;
    } catch (e) {
      const why = e instanceof RequestFailed ? e.why : "network";
      return toResult({ ...base, kind: "service_error", httpStatus: null, api: null, summary: `Kitchen Pass couldn't be reached (${why}). Nothing was charged; retry shortly.` });
    }
    if (status === 200 && isObj(json)) ctx.cache.set(url, { at: ctx.clock(), json });
  }
  if (status !== 200 || !isObj(json)) return toResult(nonAnswer(tool, status, json, { spend }));

  if (tool === "check_coverage") {
    const section = args.section as string | undefined;
    const api = section ? { dataVersion: json.dataVersion, note: json.note, [section]: json[section] } : json;
    const summary = `Free. What Kitchen Pass answers today (data ${String(json.dataVersion).slice(0, 40)}): ${count(json.diagnose)} diagnose dishes, ` +
      `${count(json.substitute)} swap ingredients, ${count(json.yieldCost)} yield ingredients, ${count(json.scale?.rules)} scaling rule classes, ` +
      `${count(json.refused)} refused topics${section ? `; section ${section} only` : ""}. Names only: the answers come from the paid tools.`;
    return toResult({ ...base, kind: "answer", httpStatus: 200, api, summary });
  }
  const l = labelOf(json.response);
  const lines = isObj(json.response) ? count(json.response.lines) : 0;
  const from = isObj(json.request) ? String(json.request.fromPortions).slice(0, 8) : "?";
  const to = isObj(json.request) ? String(json.request.toPortions).slice(0, 8) : "?";
  return toResult({
    ...base, kind: "answer", httpStatus: 200, api: json, label: l.label, verified: l.verified,
    summary: `Free demo, not the user's question: a fixed recipe scaled ${from}→${to} portions (${lines} lines). ${labelSentence(l)}`,
  });
}

export function createKitchenPassServer(deps: ServerDeps): { server: McpServer; ctx: Ctx } {
  const server = new McpServer({ name: "kitchen-pass", version: VERSION });
  const ctx = createContext(deps, server);

  const guarded = (tool: ToolName) => async (args: Record<string, unknown>, extra: Extra): Promise<CallToolResult> => {
    const call: CallState = { sent: false };
    let result: CallToolResult;
    try {
      if (!ctx.settings) {
        result = toResult({ kind: "config_error", tool, httpStatus: null, charged: null, spend: null, label: null, verified: null, api: null, summary: `This Kitchen Pass server isn't set up: ${ctx.fatal.join("; ")}.` });
      } else if (tool in PAID_TOOLS) {
        result = await runPaid(ctx, tool as PaidTool, args, extra, call);
      } else {
        result = await runFree(ctx, tool as "check_coverage" | "get_sample_answer", args, extra);
      }
    } catch {
      result = fixedFailure(tool, call.sent);
    }
    try {
      if (ctx.leaks(JSON.stringify(result))) result = fixedFailure(tool, call.sent);
    } catch {
      result = fixedFailure(tool, call.sent);
    }
    // A fixed failure after the payment left may have been charged: hold identical paid calls, as for any unconfirmed one.
    if (call.sent && call.key && (result.structuredContent as any)?.kind === "payment_unconfirmed") ctx.markUnconfirmed(call.key);
    return result;
  };

  for (const spec of toolSpecs()) {
    server.registerTool(spec.name, { title: spec.title, description: spec.description, inputSchema: spec.schema, annotations: spec.annotations }, guarded(spec.name) as any);
  }
  return { server, ctx };
}
