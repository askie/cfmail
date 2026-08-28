import PostalMime from "postal-mime";
import type { ParsedEmail, ParsedAttachment } from "./types";

function joinAddrs(list: { address?: string; name?: string }[] | undefined): string | null {
  if (!list || list.length === 0) return null;
  const s = list
    .map((a) => a.address)
    .filter((a): a is string => !!a)
    .join(", ");
  return s || null;
}

function toEpochMs(date: string | undefined): number | null {
  if (!date) return null;
  const t = Date.parse(date);
  return Number.isNaN(t) ? null : t;
}

// Some senders (QQ Mail among them) label every attachment
// application/octet-stream, which stops clients from previewing images. When
// the declared type says nothing, the filename extension is the next best hint.
const EXT_MIME: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  xml: "application/xml", html: "text/html", pdf: "application/pdf", zip: "application/zip",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", heic: "image/heic",
  mp4: "video/mp4", mp3: "audio/mpeg",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function inferContentType(filename: string | null | undefined, declared: string | null | undefined): string | null {
  const d = declared?.trim().toLowerCase() || null;
  if (d && d !== "application/octet-stream") return d;
  const ext = filename?.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
  return (ext && EXT_MIME[ext]) || d;
}

// Pure parser: raw .eml bytes -> normalized ParsedEmail. Runs in Workers and Node.
export async function parseRaw(raw: ArrayBuffer | Uint8Array | string): Promise<ParsedEmail> {
  const email = await PostalMime.parse(raw);

  const attachments: ParsedAttachment[] = (email.attachments ?? []).map((a) => {
    let content: ArrayBuffer;
    if (typeof a.content === "string") {
      content = new TextEncoder().encode(a.content).buffer as ArrayBuffer;
    } else if (a.content instanceof ArrayBuffer) {
      content = a.content;
    } else {
      // Uint8Array / ArrayBufferView fallback
      const view = a.content as ArrayBufferView;
      content = view.buffer.slice(
        view.byteOffset,
        view.byteOffset + view.byteLength
      ) as ArrayBuffer;
    }
    return {
      filename: a.filename ?? null,
      content_type: inferContentType(a.filename, a.mimeType),
      content,
    };
  });

  return {
    msg_id: email.messageId ?? null,
    refs: email.references ?? null,
    from_addr: email.from?.address ?? null,
    from_name: email.from?.name || null,
    to_addr: joinAddrs(email.to),
    cc_addr: joinAddrs(email.cc),
    subject: email.subject ?? null,
    date: toEpochMs(email.date),
    text_body: email.text ?? null,
    html_body: email.html ?? null,
    attachments,
  };
}
