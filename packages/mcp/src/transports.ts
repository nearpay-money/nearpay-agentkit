/**
 * Transports: stdio (the default for local agents) and streamable HTTP (stateless: one MCP server object
 * per request, all sharing one context and therefore one session budget).
 *
 * The HTTP transport spends money on behalf of whoever reaches it, so it is locked down: a bearer token is
 * required (constant-time compare), it binds to loopback unless told otherwise, `Host` must be in the
 * allow-list (DNS rebinding), browser `Origin`s are refused unless allowed, bodies are capped at 1 MiB.
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createNearPayMcpServer, type NearPayMcpContext } from "./server.js";

export async function startStdio(ctx: NearPayMcpContext): Promise<{ close(): Promise<void> }> {
  const server = createNearPayMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  ctx.log("info", "NearPay MCP server listening on stdio", { livemode: ctx.options.livemode });
  return { close: () => server.close() };
}

export interface HttpOptions {
  host: string;
  port: number;
  /** Required bearer token (≥ 32 characters). */
  token: string;
  /** Accepted `Host` header values (default `127.0.0.1:<port>`, `localhost:<port>`). */
  allowedHosts?: readonly string[];
  /** Accepted browser `Origin` values (default none: requests carrying an Origin are refused). */
  allowedOrigins?: readonly string[];
  /** Path of the MCP endpoint (default `/mcp`). */
  path?: string;
}

const MAX_BODY = 1_048_576;

function tokenOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1] as string);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function deny(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new RangeError("body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startHttp(
  ctx: NearPayMcpContext,
  o: HttpOptions,
): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  if (o.token.length < 32) throw new RangeError("the HTTP transport needs a bearer token of at least 32 characters");
  const path = o.path ?? "/mcp";
  let allowedHosts = o.allowedHosts;
  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://mcp");
      if (url.pathname !== path) return deny(res, 404, "not found");
      if (!allowedHosts?.includes(req.headers.host ?? "")) return deny(res, 403, "host not allowed");
      const origin = req.headers.origin;
      if (origin !== undefined && !(o.allowedOrigins ?? []).includes(origin))
        return deny(res, 403, "origin not allowed");
      if (!tokenOk(req.headers.authorization, o.token)) {
        return deny(res, 401, "unauthorized", { "www-authenticate": 'Bearer realm="nearpay-mcp"' });
      }
      if (req.method !== "POST")
        return deny(res, 405, "method not allowed (stateless server: POST only)", { allow: "POST" });
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (e) {
        return deny(
          res,
          e instanceof RangeError ? 413 : 400,
          e instanceof RangeError ? "body too large" : "invalid JSON",
        );
      }
      const server = createNearPayMcpServer(ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        ctx.log("error", "MCP HTTP request failed", { message: (e as Error).message });
        if (!res.headersSent) deny(res, 500, "internal error");
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(o.port, o.host, () => resolve());
  });
  const port = (http.address() as AddressInfo).port;
  allowedHosts ??= [`127.0.0.1:${port}`, `localhost:${port}`];
  const url = `http://${o.host.includes(":") ? `[${o.host}]` : o.host}:${port}${path}`;
  ctx.log("info", "NearPay MCP server listening", { url, livemode: ctx.options.livemode });
  return {
    server: http,
    url,
    close: () => new Promise<void>((r) => http.close(() => r())),
  };
}
