import { EmailMCP } from "./mcp";
import { ingest } from "./email";
import { authenticate } from "./auth";
import { handleOpen } from "./track";
import type { Env } from "./types";

// Durable Object class backing the MCP session (referenced by wrangler.jsonc).
export { EmailMCP };

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

    if (url.pathname === "/mcp" || url.pathname === "/sse" || url.pathname === "/sse/message") {
      const auth = await authenticate(request, env);
      if (!auth.authed) return unauthorized();

      // Pass the resolved identity to the MCP agent via ctx.props. The runtime
      // persists it with the session, so init() can register tools per identity.
      (ctx as ExecutionContext & { props?: unknown }).props = {
        isAdmin: auth.isAdmin,
        email: auth.email,
      };

      if (url.pathname === "/mcp") {
        return EmailMCP.serve("/mcp").fetch(request, env, ctx);
      }
      return EmailMCP.serveSSE("/sse").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
