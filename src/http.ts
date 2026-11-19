// Every request this package sends. redirect: "error" on every fetch, and the response must come from the exact URL
// requested: Node's fetch would otherwise follow a cross-origin 307/308 and resend the method, body and custom headers
// (including PAYMENT-SIGNATURE) to another host, which could then return a forged answer. Responses are size-capped
// before parsing. The monitoring header (x-kitchen-pass-monitor) is never sent: real MCP traffic stays in the request log.
import { MAX_RESPONSE_BYTES, USER_AGENT_HEADER } from "./config.js";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpResult {
  status: number;
  headers: Headers;
  /** Parsed JSON body, or undefined if the body wasn't JSON. */
  json: unknown;
}

/** Why a request produced no usable response. Fixed categories only; no error text is ever kept. */
export class RequestFailed extends Error {
  constructor(readonly why: "network" | "timeout" | "cancelled" | "redirect" | "wrong_url" | "too_large") {
    super(why);
    this.name = "RequestFailed";
  }
}

export interface RequestOptions {
  method: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new RequestFailed("too_large");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new RequestFailed("too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function request(fetchFn: FetchLike, url: string, opts: RequestOptions): Promise<HttpResult> {
  const timeout = AbortSignal.timeout(Math.max(1, Math.floor(opts.timeoutMs)));
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  const headers: Record<string, string> = { accept: "application/json", ...USER_AGENT_HEADER, ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetchFn(url, { method: opts.method, headers, body: opts.body, redirect: "error", signal });
  } catch {
    if (opts.signal?.aborted) throw new RequestFailed("cancelled");
    if (timeout.aborted) throw new RequestFailed("timeout");
    throw new RequestFailed("network"); // includes a refused redirect
  }
  if (res.redirected || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => {});
    throw new RequestFailed("redirect");
  }
  if (res.url !== url) {
    await res.body?.cancel().catch(() => {});
    throw new RequestFailed("wrong_url");
  }
  let text: string;
  try {
    text = await readCapped(res);
  } catch (e) {
    if (e instanceof RequestFailed) throw e;
    if (opts.signal?.aborted) throw new RequestFailed("cancelled");
    throw new RequestFailed(timeout.aborted ? "timeout" : "network");
  }
  let json: unknown;
  try { json = text === "" ? undefined : JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, headers: res.headers, json };
}
