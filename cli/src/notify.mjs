// Local-side Grix notification for freshly archived mail.
//
// The worker cannot do this: it runs on Cloudflare and has no access to the
// machine holding the archive, so it can only say "mail arrived". Only the
// process that just wrote the files knows their absolute paths, which is what
// makes the links in the message clickable.

const GRIX_ENDPOINT = "https://grix.dhf.pub/v1/webhook/incoming/";
const GRIX_KEY = /^whk_[A-Za-z0-9_-]+$/;

export function isGrixKey(value) {
  return GRIX_KEY.test(String(value || "").trim());
}

export function grixUrl(key) {
  return GRIX_ENDPOINT + String(key).trim();
}

function fold(text, len) {
  if (!text) return null;
  const t = String(text).replace(/\s+/g, " ").trim();
  const chars = [...t];
  return chars.length > len ? chars.slice(0, len).join("") + "…" : t;
}

// The body keeps its line structure — a folded-to-one-line email is unreadable
// once it has a greeting, a list and a signature. Only runs of blank lines and
// trailing whitespace and runs of spaces inside a line are squeezed; the cap
// counts characters, not lines.
function foldBody(text, len) {
  if (!text) return null;
  const t = String(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const chars = [...t];
  return chars.length > len ? chars.slice(0, len).join("").trimEnd() + "…" : t;
}

function humanSize(n) {
  if (!Number.isFinite(n)) return "";
  return Math.round(n / 1024) >= 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : n >= 1024 ? `${Math.round(n / 1024)} KB`
    : `${n} B`;
}

// A file:// URL a chat client can open. Percent-encode each segment so spaces
// and Chinese filenames survive; keep the separators intact.
export function fileUrl(absPath) {
  const encoded = String(absPath).split("/").map(encodeURIComponent).join("/");
  return `file://${encoded}`;
}

// Markdown links, so the reader can jump straight to the file or its folder.
export function buildMessage({ meta, folder, files }) {
  const sender = meta.from_name && meta.from
    ? `${meta.from_name} <${meta.from}>`
    : meta.from_name || meta.from || "(未知发件人)";

  const lines = [
    `📬 新邮件${files.length ? "（含附件）" : ""}`,
    `发件人: ${fold(sender, 200)}`,
    `收件人: ${fold(meta.to, 200) || "(未知)"}`,
    `主题: ${fold(meta.subject, 120) || "(无主题)"}`,
  ];

  const body = foldBody(meta.text, 500);
  if (body) lines.push("", body);

  if (files.length) {
    lines.push("", `附件 ${files.length} 个:`);
    for (const f of files) {
      lines.push(`- [${fold(f.name, 80)}](${fileUrl(f.path)})  ${humanSize(f.size)}`);
    }
  }
  lines.push("", `📁 [打开邮件目录](${fileUrl(folder)})`);

  return {
    content: lines.join("\n"),
    msg_type: "text",
    // The Message-ID is stable across redelivery; the archive folder is the
    // fallback when a message carries no Message-ID at all.
    client_msg_id: meta.msg_id || meta.id || folder,
  };
}

export async function sendToGrix(key, payload) {
  const res = await fetch(grixUrl(key), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  try { return JSON.parse(text); } catch { return {}; }
}
