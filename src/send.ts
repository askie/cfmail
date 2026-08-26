import type { Env } from "./types";
import { getEmail, getAttachment } from "./store";

export interface SendAttachment {
  filename: string;
  content_type?: string;
  content_base64: string;
}

export interface SendRequest {
  to?: string[];
  cc?: string[];
  subject?: string;
  text: string;
  html?: string;
  in_reply_to?: string;
  attachments?: SendAttachment[];
  // Ids of stored attachments to forward, resolved against the caller's mailbox.
  forward_attachment_ids?: string[];
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

// What each backend accepts, measured the way the provider measures it: the size
// of the whole message on the wire, where attachments travel base64-encoded and
// are therefore 4/3 of their decoded size. Checking decoded bytes instead would
// wave through a payload that the provider then rejects.
const LIMITS: Record<
  Provider,
  { maxBytes: number; maxCount: number; label: string; unit: number; unitName: string }
> = {
  // Resend documents "40MB after Base64 encoding"; decimal is the conservative
  // reading of an unqualified "MB".
  resend: { maxBytes: 40 * 1000 * 1000, maxCount: 32, label: "40 MB", unit: 1000 * 1000, unitName: "MB" },
  cloudflare: { maxBytes: 5 * 1024 * 1024, maxCount: 32, label: "5 MiB", unit: 1024 * 1024, unitName: "MiB" },
};

// Assembling the MIME message costs more than the payload itself: base64 is
// re-wrapped at 76 columns (~3%) and every part carries its own headers. Without
// this margin a message sized right at the limit still gets rejected.
const WRAP_FACTOR = 1.03;
const PART_OVERHEAD = 512;

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

// Long threads would otherwise grow References without bound. Mail clients keep
// the root (it identifies the thread) plus the most recent ancestors; so do we.
const REF_LIMIT = 20;

// RFC 5322 §3.6.4: the reply's References is the parent's References followed by
// the parent's Message-ID. Only well-formed <...> tokens survive.
function buildReferences(parentRefs: string | null, parentMsgId: string | null): string[] {
  const chain: string[] = parentRefs?.match(/<[^<>\s]+>/g) ?? [];
  if (parentMsgId) chain.push(parentMsgId);

  const unique = [...new Set(chain)];
  if (unique.length <= REF_LIMIT) return unique;
  return [unique[0], ...unique.slice(unique.length - (REF_LIMIT - 1))];
}

interface Envelope {
  to: string[];
  cc: string[];
  subject: string;
  headers: Record<string, string>;
  attachments: SendAttachment[];
}

// Strip the line wrapping many encoders apply, and reject anything that is not
// standard padded base64. Providers do not promise to tolerate whitespace, so
// the stripped form is what gets sent.
function normalizeBase64(raw: string): string | null {
  const b64 = raw.replace(/\s+/g, "");
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  return b64;
}

function utf8Bytes(s?: string): number {
  return s ? new TextEncoder().encode(s).length : 0;
}

// Merge inline attachments with forwarded stored ones, then check them against
// the chosen backend's limits. Forwarded ids go through getAttachment, so the
// caller can only attach files from their own mailbox.
async function collectAttachments(
  env: Env,
  req: SendRequest,
  provider: Provider,
  userEmail?: string
): Promise<{ attachments: SendAttachment[] } | { error: string }> {
  const out: SendAttachment[] = [];

  for (const a of req.attachments ?? []) {
    const name = a.filename?.trim();
    if (!name) return { error: "each attachment needs a filename" };
    const b64 = normalizeBase64(a.content_base64);
    if (b64 === null) {
      return {
        error: `attachment "${name}": content_base64 must be standard base64 with padding (A-Z a-z 0-9 + / =)`,
      };
    }
    out.push({ filename: name, content_type: a.content_type, content_base64: b64 });
  }

  for (const id of req.forward_attachment_ids ?? []) {
    let stored;
    try {
      stored = await getAttachment(env, id, userEmail);
    } catch (e: any) {
      return { error: `forward_attachment_ids: lookup failed: ${e?.message ?? String(e)}` };
    }
    if (!stored) return { error: `forward_attachment_ids: ${id} not found or access denied` };
    // An empty string is a legitimately empty file; only a null means it is gone.
    if (stored.content_base64 == null) {
      return { error: `forward_attachment_ids: ${id} has no stored content` };
    }
    out.push({
      filename: stored.meta.filename || `attachment-${id}`,
      content_type: stored.meta.content_type ?? undefined,
      content_base64: stored.content_base64,
    });
  }

  const { maxBytes, maxCount, label, unit, unitName } = LIMITS[provider];
  if (out.length > maxCount) {
    return { error: `at most ${maxCount} attachments (${provider})` };
  }

  // Runs even with no attachments: a body alone can exceed the limit, and that
  // would otherwise reach the provider as the very rejection this check prevents.
  const wire =
    out.reduce((n, a) => n + Math.ceil(a.content_base64.length * WRAP_FACTOR) + PART_OVERHEAD, 0) +
    utf8Bytes(req.text) +
    utf8Bytes(req.html);
  if (wire > maxBytes) {
    const size = (wire / unit).toFixed(1);
    return { error: `message is ~${size} ${unitName} encoded, over the ${label} limit (${provider})` };
  }

  return { attachments: out };
}

// Resolve recipient/subject/threading headers, deriving them from the replied-to
// email when `in_reply_to` is given. Returns an error string instead of throwing.
async function buildEnvelope(
  env: Env,
  req: SendRequest,
  provider: Provider,
  userEmail?: string
): Promise<{ envelope: Envelope } | { error: string }> {
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
    if (msgId) headers["In-Reply-To"] = msgId;

    const refs = buildReferences(src.refs, msgId);
    if (refs.length) headers["References"] = refs.join(" ");
  }

  if (!to.length) return { error: "to is required (or pass in_reply_to)" };
  if (!subject) {
    return {
      error: req.in_reply_to
        ? "subject is required (the replied-to email has no subject)"
        : "subject is required",
    };
  }

  const cc = dedupe(req.cc ?? []);
  if (to.length + cc.length > 50) return { error: "at most 50 recipients across to and cc" };

  const att = await collectAttachments(env, req, provider, userEmail);
  if ("error" in att) return { error: att.error };

  return { envelope: { to, cc, subject, headers, attachments: att.attachments } };
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
        ...(e.attachments.length
          ? {
              attachments: e.attachments.map((a) => ({
                filename: a.filename,
                content: a.content_base64,
                ...(a.content_type ? { content_type: a.content_type } : {}),
              })),
            }
          : {}),
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
      ...(e.attachments.length
        ? {
            attachments: e.attachments.map((a) => ({
              filename: a.filename,
              content: a.content_base64,
              type: a.content_type || "application/octet-stream",
              disposition: "attachment" as const,
            })),
          }
        : {}),
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

  const provider: Provider = apiKey ? "resend" : "cloudflare";
  const built = await buildEnvelope(env, req, provider, userEmail);
  if ("error" in built) return { ok: false, provider, error: built.error };

  return apiKey
    ? viaResend(apiKey, from, built.envelope, req)
    : viaCloudflare(env.EMAIL!, from, built.envelope, req);
}
