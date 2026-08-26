import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./types";
import {
  listEmails,
  searchEmails,
  getEmail,
  getAttachment,
  stats,
  createApiKey,
  listApiKeys,
  deleteApiKey,
} from "./store";
import { getWebhook, setWebhook } from "./config";
import { sendEmail, resolveSender } from "./send";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function toMs(s?: string): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

// Remote MCP server (Streamable HTTP). Exposes read tools over the stored mailbox
// plus webhook configuration. Backed by a Durable Object per session.
// Identity injected by the worker entrypoint via ctx.props. The agents runtime
// persists props with the session, so it's available in init() on first start
// and on every later wake (including SSE messages after hibernation).
interface Identity {
  isAdmin?: boolean;
  email?: string;
}

export class EmailMCP extends McpAgent<Env> {
  server = new McpServer({ name: "cloudflare-email", version: "0.1.0" });
  userEmail?: string;
  isAdmin = false;

  async init() {
    const id = (this.props ?? {}) as Identity;
    this.isAdmin = !!id.isAdmin;
    this.userEmail = id.email || undefined;

    // --- Read tools: available to every authenticated identity. They self-scope
    // to the caller's mailbox via this.userEmail (admin = undefined = full view).
    this.server.tool(
      "search_emails",
      "Full-text search over stored email subjects and bodies (supports Chinese). Returns matching emails with a snippet.",
      { query: z.string().describe("Search text"), limit: z.number().int().optional().describe("Max results, default 20") },
      async ({ query, limit }) => json(await searchEmails(this.env, query, limit ?? 20, this.userEmail))
    );

    this.server.tool(
      "list_emails",
      "List stored emails newest-first, optionally filtered by sender/recipient/subject/date range. Use offset for paging.",
      {
        from: z.string().optional().describe("Filter: sender contains"),
        to: z.string().optional().describe("Filter: recipient contains"),
        subject: z.string().optional().describe("Filter: subject contains"),
        since: z.string().optional().describe("ISO date/time, inclusive lower bound"),
        until: z.string().optional().describe("ISO date/time, inclusive upper bound"),
        limit: z.number().int().optional().describe("Page size, default 20, max 100"),
        offset: z.number().int().optional().describe("Rows to skip for paging"),
      },
      async ({ from, to, subject, since, until, limit, offset }) =>
        json(
          await listEmails(this.env, {
            from, to, subject,
            since: toMs(since), until: toMs(until),
            limit, offset,
          }, this.userEmail)
        )
    );

    this.server.tool(
      "get_email",
      "Fetch one email's full content (headers, plain text, optional HTML, attachment list) by id.",
      {
        id: z.string().describe("Email id from list/search"),
        include_html: z.boolean().optional().describe("Also return the HTML body, default false"),
      },
      async ({ id, include_html }) => {
        const r = await getEmail(this.env, id, include_html ?? false, this.userEmail);
        return r ? json(r) : json({ error: "not found or access denied", id });
      }
    );

    this.server.tool(
      "get_attachment",
      "Fetch one attachment's bytes (base64) and metadata by attachment id.",
      { attachment_id: z.string().describe("Attachment id from get_email") },
      async ({ attachment_id }) => {
        const r = await getAttachment(this.env, attachment_id, this.userEmail);
        return r ? json(r) : json({ error: "not found or access denied", attachment_id });
      }
    );

    this.server.tool(
      "stats",
      "Mailbox stats: total stored emails, how many have attachments, latest timestamps.",
      {},
      async () => json(await stats(this.env, this.userEmail))
    );

    // --- Write tool: send mail. A non-admin key always sends as the address it
    // is bound to; the admin identity has no bound address and must pass `from`.
    this.server.tool(
      "send_email",
      "Send an email via Resend (or the Cloudflare send_email binding when no Resend key is configured). Non-admin keys always send from their own bound address. Pass in_reply_to with a stored email id to reply in-thread (recipient, subject and threading headers are filled in automatically). Attach new files with attachments, or forward files from stored mail with forward_attachment_ids.",
      {
        to: z.array(z.string().email()).optional().describe("Recipients; optional when in_reply_to is given"),
        cc: z.array(z.string().email()).optional().describe("Cc recipients"),
        subject: z.string().optional().describe("Subject; optional when in_reply_to is given"),
        text: z.string().describe("Plain-text body"),
        html: z.string().optional().describe("Optional HTML body"),
        in_reply_to: z.string().optional().describe("Email id to reply to"),
        attachments: z
          .array(
            z.object({
              filename: z.string().describe("File name shown to the recipient"),
              content_base64: z.string().describe("File bytes, base64-encoded"),
              content_type: z.string().optional().describe("MIME type, default application/octet-stream"),
            })
          )
          .optional()
          .describe("Files to attach"),
        forward_attachment_ids: z
          .array(z.string())
          .optional()
          .describe("Attachment ids from get_email, to forward files from stored mail without re-uploading them"),
        from: z.string().email().optional().describe("Admin only: the sending address"),
      },
      async ({ to, cc, subject, text, html, in_reply_to, attachments, forward_attachment_ids, from }) => {
        const sender = resolveSender(this.userEmail, from);
        if (!sender) return json({ ok: false, error: "from is required for the admin identity" });
        return json(
          await sendEmail(
            this.env,
            sender,
            { to, cc, subject, text, html, in_reply_to, attachments, forward_attachment_ids },
            this.userEmail
          )
        );
      }
    );

    // --- Admin-only tools: registered only for the admin identity, so non-admin
    // keys never see them in tools/list. The per-handler isAdmin check below is
    // kept as a defense-in-depth backstop — never rely on hiding alone.
    if (!this.isAdmin) return;

    this.server.tool(
      "get_webhook",
      "Get the currently configured webhook URL that receives new-email notifications.",
      {},
      async () => {
        if (!this.isAdmin) return json({ error: "Permission denied: admin only" });
        return json({ webhook_url: await getWebhook(this.env) });
      }
    );

    this.server.tool(
      "set_webhook",
      "Set or clear the webhook URL. New emails are POSTed there as JSON. Pass an empty string to disable.",
      { url: z.string().describe("Webhook URL, or empty string to clear") },
      async ({ url }) => {
        if (!this.isAdmin) return json({ error: "Permission denied: admin only" });
        const trimmed = url.trim();
        if (trimmed && !/^https?:\/\//i.test(trimmed)) {
          return json({ ok: false, error: "url must start with http(s)://" });
        }
        await setWebhook(this.env, trimmed || null);
        return json({ ok: true, webhook_url: trimmed || null });
      }
    );

    // API key management (Admin only)
    this.server.tool(
      "create_api_key",
      "Admin only. Create a new API Key bound to a specific user email.",
      { email: z.string().email().describe("The user email to bind this key to") },
      async ({ email }) => {
        if (!this.isAdmin) return json({ error: "Permission denied: admin only" });
        const key = await createApiKey(this.env, email);
        return json({ ok: true, email, api_key: key });
      }
    );

    this.server.tool(
      "list_api_keys",
      "Admin only. List all active API keys.",
      {},
      async () => {
        if (!this.isAdmin) return json({ error: "Permission denied: admin only" });
        const keys = await listApiKeys(this.env);
        return json({ keys });
      }
    );

    this.server.tool(
      "delete_api_key",
      "Admin only. Delete the API key associated with a specific user email.",
      { email: z.string().email().describe("The user email to delete the key for") },
      async ({ email }) => {
        if (!this.isAdmin) return json({ error: "Permission denied: admin only" });
        const ok = await deleteApiKey(this.env, email);
        return json({ ok });
      }
    );
  }
}
