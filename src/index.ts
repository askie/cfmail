import { EmailMCP } from "./mcp";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ingest } from "./email";
import { authenticate } from "./auth";
import { handleOpen } from "./track";
import type { Env } from "./types";


function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer realm="mcp"' },
  });
}

export default {
  // Inbound mail (Cloudflare Email Routing).
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await ingest(message, env, ctx);
  },

  // HTTP: MCP endpoint (token-gated) + health check.
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    // Open-tracking pixel: public by design (mail clients fetch it unauthenticated).
    const pixel = handleOpen(request, env, ctx);
    if (pixel) return pixel;

    if (url.pathname === "/mcp") {
      const auth = await authenticate(request, env);
      if (!auth.authed) return unauthorized();

      // Stateless: one server + transport per request, nothing persisted between
      // calls (no Durable Object, so no DO row-write quota involved).
      const mcp = new EmailMCP(env, { isAdmin: auth.isAdmin, email: auth.email });
      await mcp.init();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcp.server.connect(transport);
      return transport.handleRequest(request);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
