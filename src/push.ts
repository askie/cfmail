import type { Env, EmailRow } from "./types";
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
  return t.length > len ? t.slice(0, len) + "…" : t;
}

// Grix renders `content` as a chat message, so it has to read as one — a JSON
// dump would show up verbatim in the conversation.
function grixBody(row: EmailRow) {
  const sender = row.from_name ? `${row.from_name} <${row.from_addr ?? ""}>` : row.from_addr || "(未知发件人)";
  const lines = [
    `📬 新邮件${row.has_attachments ? "（含附件）" : ""}`,
    `发件人: ${sender}`,
    `收件人: ${row.to_addr || "(未知)"}`,
    `主题: ${row.subject || "(无主题)"}`,
  ];
  const body = snippet(row.text_body, 500);
  if (body) lines.push("", body);

  return {
    content: lines.join("\n"),
    msg_type: "text",
    // The stored email id: re-delivering the same mail cannot post twice.
    client_msg_id: row.id,
  };
}

function genericBody(row: EmailRow) {
  return {
    type: "email.received",
    id: row.id,
    from: row.from_addr,
    from_name: row.from_name,
    to: row.to_addr,
    subject: row.subject,
    date: row.date,
    has_attachments: !!row.has_attachments,
    snippet: snippet(row.text_body, 280),
  };
}

// POST a "new email" event to the configured webhook (if any).
// Best-effort: failures are logged, never block ingestion.
export async function pushNewEmail(env: Env, row: EmailRow): Promise<void> {
  const configured = await getWebhook(env);
  if (!configured) return;

  const url = webhookTarget(configured);
  const payload = isGrixKey(configured) ? grixBody(row) : genericBody(row);

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
