import type { Env } from "./types";
import { getEmail } from "./store";

export interface SendRequest {
  to?: string[];
  cc?: string[];
  subject?: string;
  text: string;
  html?: string;
  in_reply_to?: string;
}

export interface SendOutcome {
  ok: boolean;
  message_id?: string;
  to?: string[];
  subject?: string;
  error?: string;
  code?: string;
  hint?: string;
}

// Cloudflare error codes worth translating into an actionable hint, so the
// caller (an AI assistant) knows what the operator must fix in the dashboard.
const HINTS: Record<string, string> = {
  E_SENDER_NOT_VERIFIED:
    "The sending domain is not onboarded. Add it under Email -> Email Sending in the Cloudflare dashboard and publish the SPF/DKIM/DMARC records.",
  E_RECIPIENT_NOT_ALLOWED:
    "Recipient is not a verified destination address. Either verify it under Email Routing -> Destination addresses (free), or onboard a sending domain to reach arbitrary recipients.",
  E_DAILY_LIMIT_EXCEEDED: "Daily sending quota exhausted; retry tomorrow or request a limit increase.",
  E_RATE_LIMIT_EXCEEDED: "Sending too fast; retry after a short delay.",
  E_TOO_MANY_RECIPIENTS: "At most 50 recipients across to and cc.",
  E_CONTENT_TOO_LARGE: "Message exceeds the 5 MiB limit.",
};

function dedupe(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))];
}

// Send one message as `from`. When `in_reply_to` names a stored email, the
// recipient, subject and threading headers are derived from it unless the
// caller overrides them. Never throws: Cloudflare errors come back as a result.
export async function sendEmail(
  env: Env,
  from: string,
  req: SendRequest,
  userEmail?: string
): Promise<SendOutcome> {
  if (!env.EMAIL) {
    return {
      ok: false,
      error: "send_email binding is not configured",
      hint: 'Add "send_email": [{ "name": "EMAIL" }] to wrangler config and redeploy.',
    };
  }

  let to = dedupe(req.to ?? []);
  let subject = req.subject?.trim();
  const headers: Record<string, string> = {};

  if (req.in_reply_to) {
    // Scoped by userEmail, so a non-admin key can only reply to its own mail.
    const src = await getEmail(env, req.in_reply_to, false, userEmail);
    if (!src) return { ok: false, error: "in_reply_to: email not found or access denied" };
    if (!to.length && src.from) to = [src.from];
    if (!subject) subject = /^re:/i.test(src.subject ?? "") ? src.subject! : `Re: ${src.subject ?? ""}`.trim();
    if (src.msg_id) {
      headers["In-Reply-To"] = src.msg_id;
      headers["References"] = src.msg_id;
    }
  }

  if (!to.length) return { ok: false, error: "to is required (or pass in_reply_to)" };
  if (!subject) return { ok: false, error: "subject is required (or pass in_reply_to)" };

  const cc = dedupe(req.cc ?? []);
  if (to.length + cc.length > 50) return { ok: false, error: "at most 50 recipients across to and cc" };

  try {
    const r = await env.EMAIL.send({
      from,
      to,
      subject,
      text: req.text,
      ...(req.html ? { html: req.html } : {}),
      ...(cc.length ? { cc } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    });
    return { ok: true, message_id: r?.messageId, to, subject };
  } catch (e: any) {
    const code = e?.code as string | undefined;
    return {
      ok: false,
      error: e?.message ?? String(e),
      ...(code ? { code } : {}),
      ...(code && HINTS[code] ? { hint: HINTS[code] } : {}),
    };
  }
}
