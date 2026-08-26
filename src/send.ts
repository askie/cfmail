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

export type Provider = "resend" | "cloudflare";

export interface SendOutcome {
  ok: boolean;
  provider?: Provider;
  message_id?: string;
  to?: string[];
  subject?: string;
  error?: string;
  code?: string;
  hint?: string;
}

// A non-admin key always sends as the address it is bound to; a caller-supplied
// `from` is only honoured for the admin identity, which has no bound address.
export function resolveSender(userEmail?: string, from?: string): string | null {
  return userEmail || from?.trim() || null;
}

// Provider error -> what the operator actually has to fix. Unknown codes simply
// carry no hint, which degrades gracefully.
const HINTS: Record<string, string> = {
  // Resend
  validation_error:
    "Usually the sending domain is not verified. Add the domain in Resend and publish its MX/SPF/DKIM records (the MX goes on the `send` subdomain, so it does not clash with Email Routing).",
  missing_api_key: "RESEND_API_KEY is missing or malformed.",
  restricted_api_key: "This Resend API key is inactive or lacks send permission.",
  daily_quota_exceeded: "Resend daily quota exhausted; retry tomorrow or upgrade the plan.",
  rate_limit_exceeded: "Sending too fast; retry after a short delay.",
  // Cloudflare Email Sending
  E_SENDER_NOT_VERIFIED:
    "The sending domain is not onboarded. Add it under Email -> Email Sending in the Cloudflare dashboard and publish the SPF/DKIM/DMARC records.",
  E_RECIPIENT_NOT_ALLOWED:
    "Recipient is not a verified destination address. Either verify it under Email Routing -> Destination addresses (free), or onboard a sending domain to reach arbitrary recipients.",
  E_DAILY_LIMIT_EXCEEDED: "Daily sending quota exhausted; retry tomorrow or request a limit increase.",
  E_RATE_LIMIT_EXCEEDED: "Sending too fast; retry after a short delay.",
  E_TOO_MANY_RECIPIENTS: "At most 50 recipients across to and cc.",
  E_CONTENT_TOO_LARGE: "Message exceeds the 5 MiB limit.",
};

function hintFor(code?: string): { code?: string; hint?: string } {
  if (!code) return {};
  return { code, ...(HINTS[code] ? { hint: HINTS[code] } : {}) };
}

function dedupe(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))];
}

// A Message-ID copied from an inbound header is attacker-controlled text. Only
// let a well-formed one through into our outbound threading headers.
function safeMsgId(id: string | null): string | null {
  return id && /^<[^<>\s]+>$/.test(id) ? id : null;
}

interface Envelope {
  to: string[];
  cc: string[];
  subject: string;
  headers: Record<string, string>;
}

// Resolve recipient/subject/threading headers, deriving them from the replied-to
// email when `in_reply_to` is given. Returns an error string instead of throwing.
async function buildEnvelope(
  env: Env,
  req: SendRequest,
  userEmail?: string
): Promise<{ env_: Envelope } | { error: string }> {
  let to = dedupe(req.to ?? []);
  let subject = req.subject?.trim();
  const headers: Record<string, string> = {};

  if (req.in_reply_to) {
    let src;
    try {
      // Scoped by userEmail, so a non-admin key can only reply to its own mail.
      src = await getEmail(env, req.in_reply_to, false, userEmail);
    } catch (e: any) {
      return { error: `in_reply_to: lookup failed: ${e?.message ?? String(e)}` };
    }
    if (!src) return { error: "in_reply_to: email not found or access denied" };

    if (!to.length && src.from) to = [src.from];
    const orig = src.subject?.trim();
    if (!subject && orig) subject = /^re:/i.test(orig) ? orig : `Re: ${orig}`;

    const msgId = safeMsgId(src.msg_id);
    if (msgId) {
      headers["In-Reply-To"] = msgId;
      headers["References"] = msgId;
    }
  }

  if (!to.length) return { error: "to is required (or pass in_reply_to)" };
  if (!subject) return { error: "subject is required (the replied-to email has no subject)" };

  const cc = dedupe(req.cc ?? []);
  if (to.length + cc.length > 50) return { error: "at most 50 recipients across to and cc" };

  return { env_: { to, cc, subject, headers } };
}

async function viaResend(apiKey: string, from: string, e: Envelope, req: SendRequest): Promise<SendOutcome> {
  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: e.to,
        subject: e.subject,
        text: req.text,
        ...(req.html ? { html: req.html } : {}),
        ...(e.cc.length ? { cc: e.cc } : {}),
        ...(Object.keys(e.headers).length ? { headers: e.headers } : {}),
      }),
    });
  } catch (err: any) {
    return { ok: false, provider: "resend", error: `request failed: ${err?.message ?? String(err)}` };
  }

  const body: any = await res.json().catch(() => null);
  if (!res.ok) {
    return {
      ok: false,
      provider: "resend",
      error: body?.message ?? `HTTP ${res.status}`,
      ...hintFor(body?.name),
    };
  }
  return { ok: true, provider: "resend", message_id: body?.id, to: e.to, subject: e.subject };
}

async function viaCloudflare(binding: SendEmail, from: string, e: Envelope, req: SendRequest): Promise<SendOutcome> {
  try {
    const r = await binding.send({
      from,
      to: e.to,
      subject: e.subject,
      text: req.text,
      ...(req.html ? { html: req.html } : {}),
      ...(e.cc.length ? { cc: e.cc } : {}),
      ...(Object.keys(e.headers).length ? { headers: e.headers } : {}),
    });
    return { ok: true, provider: "cloudflare", message_id: r?.messageId, to: e.to, subject: e.subject };
  } catch (err: any) {
    return { ok: false, provider: "cloudflare", error: err?.message ?? String(err), ...hintFor(err?.code) };
  }
}

// Send one message as `from`. Resend is the default backend; the Cloudflare
// send_email binding is the fallback when no Resend key is configured.
// Never throws: provider and validation errors come back as a result.
export async function sendEmail(
  env: Env,
  from: string,
  req: SendRequest,
  userEmail?: string
): Promise<SendOutcome> {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey && !env.EMAIL) {
    return {
      ok: false,
      error: "no sending backend configured",
      hint: 'Set the RESEND_API_KEY secret, or add "send_email": [{ "name": "EMAIL" }] to wrangler config and redeploy.',
    };
  }

  const built = await buildEnvelope(env, req, userEmail);
  if ("error" in built) return { ok: false, error: built.error };

  return apiKey
    ? viaResend(apiKey, from, built.env_, req)
    : viaCloudflare(env.EMAIL!, from, built.env_, req);
}
