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
      content_type: a.mimeType ?? null,
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
