import type { Env, EmailRow, StoredAttachment } from "./types";
import { getWebhook } from "./config";

// A Grix inbound webhook is identified by its key alone; the endpoint is fixed.
// Storing just the key keeps the secret short enough to paste and makes the
// target unambiguous.
const GRIX_ENDPOINT = "https://grix.dhf.pub/v1/webhook/incoming/";
const GRIX_KEY = /^whk_[A-Za-z0-9_-]+$/;

export function isGrixKey(value: string): boolean {
  return GRIX_KEY.test(value.trim());
}

export function webhookTarget(value: string): string {
  const v = value.trim();
  return isGrixKey(v) ? GRIX_ENDPOINT + v : v;
}

function snippet(text: string | null, len: number): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ").trim();
  // Slice by code point: cutting a surrogate pair in half would emit a lone
  // surrogate into the JSON payload.
  const chars = [...t];
  return chars.length > len ? chars.slice(0, len).join("") + "…" : t;
}

// Bytes are not sent: a chat message carries the file list so the reader knows
// what arrived and can fetch it with `cfmail attachment <id>`.
function attachmentLines(files: StoredAttachment[]): string[] {
  if (!files.length) return [];
  // Rounding is applied before the threshold check, so 1023.6 KB reads as
  // "1.0 MB" rather than the odd-looking "1024 KB".
  const size = (n: number) =>
    Math.round(n / 1024) >= 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : n >= 1024 ? `${Math.round(n / 1024)} KB`
    : `${n} B`;

  const shown = files.slice(0, 10);
  // The filename comes straight from the sender. Subject and body are already
  // folded by `snippet`; without the same treatment here a crafted name could
  // inject newlines and forge extra lines in the chat message — or simply run to
  // thousands of characters.
  const lines = shown.map(
    (f) => `  · ${snippet(f.filename, 80) || "(未命名)"}  ${size(f.size ?? 0)}`
  );
  if (files.length > shown.length) lines.push(`  · …还有 ${files.length - shown.length} 个`);
  return [`附件 ${files.length} 个:`, ...lines];
}

// Grix renders `content` as a chat message, so it has to read as one — a JSON
// dump would show up verbatim in the conversation.
function grixBody(row: EmailRow, attachments: StoredAttachment[]) {
  const sender = row.from_name && row.from_addr
    ? `${row.from_name} <${row.from_addr}>`
    : row.from_name || row.from_addr || "(未知发件人)";

  // Say "has attachments" only when the message can actually name them: a header
  // promising files the reader cannot see is worse than no header at all.
  const lines = [
    `📬 新邮件${attachments.length ? "（含附件）" : ""}`,
    // Display name and recipient list are sender-controlled too, so they get the
    // same folding and cap as the subject, body and filenames.
    `发件人: ${snippet(sender, 200)}`,
    `收件人: ${snippet(row.to_addr, 200) || "(未知)"}`,
    // Bulk senders sometimes use very long subjects; cap it like the body.
    `主题: ${snippet(row.subject, 120) || "(无主题)"}`,
  ];
  const files = attachmentLines(attachments);
  if (files.length) lines.push("", ...files);

  const body = snippet(row.text_body, 500);
  if (body) lines.push("", body);

  return {
    content: lines.join("\n"),
    msg_type: "text",
    // The RFC Message-ID, which stays the same when Email Routing redelivers a
    // message. The storage id would not: every ingest mints a fresh UUID, so a
    // redelivery would look like a new message to Grix and post twice.
    client_msg_id: row.msg_id || row.id,
  };
}

function genericBody(row: EmailRow, attachments: StoredAttachment[]) {
  return {
    type: "email.received",
    id: row.id,
    from: row.from_addr,
    from_name: row.from_name,
    to: row.to_addr,
    subject: row.subject,
    date: row.date,
    has_attachments: !!row.has_attachments,
    attachments: attachments.map((a) => ({
      id: a.id, filename: a.filename, content_type: a.content_type, size: a.size,
    })),
    snippet: snippet(row.text_body, 280),
  };
}

// POST a "new email" event to the configured webhook (if any).
// Best-effort: failures are logged, never block ingestion.
export async function pushNewEmail(
  env: Env,
  row: EmailRow,
  attachments: StoredAttachment[] = []
): Promise<void> {
  const configured = await getWebhook(env);
  if (!configured) return;

  const url = webhookTarget(configured);
  const payload = isGrixKey(configured)
    ? grixBody(row, attachments)
    : genericBody(row, attachments);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`webhook push failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.error("webhook push error:", err);
  }
}
