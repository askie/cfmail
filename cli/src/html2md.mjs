// HTML -> Markdown, aimed at email bodies.
//
// Many messages (verification codes, notifications, newsletters) ship HTML only:
// their plain-text part is empty, so a notification built from it says nothing.
// This is deliberately small — enough to make such a message readable in chat,
// not a general-purpose converter.

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", ldquo: "“", rdquo: "”",
  lsquo: "‘", rsquo: "’", middot: "·", bull: "·", copy: "©", reg: "®",
};

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    const key = body.toLowerCase();
    return key in ENTITIES ? ENTITIES[key] : whole;
  });
}

// Attribute values may be quoted with either kind of quote, or bare.
function attr(tag, name) {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "").trim() : "";
}

// Only schemes that are safe to hand a chat client. Anything else — javascript:,
// data:, vbscript:, and whatever comes next — loses its href and survives as
// plain text. A blocklist would have to guess at the future; this does not.
// Leading control characters and case are both normalised first: `JaVaScRiPt:`
// and " javascript:" are the classic ways past a naive check.
const SAFE_SCHEME = /^(https?:|mailto:)/i;

function safeHref(href) {
  const cleaned = href.replace(/[\u0000-\u0020]/g, "");
  if (!cleaned) return "";
  // A relative or anchor-only href has no scheme to abuse.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(cleaned)) return href.trim();
  return SAFE_SCHEME.test(cleaned) ? href.trim() : "";
}

// `]` inside a label and `(` `)` inside a URL both break the link syntax, and a
// crafted email could use that to forge markdown around its own content —
// including a clickable javascript: link, since the scheme check only sees the
// href. `<a href="ok">a](javascript:evil) [b</a>` is the shape to keep out.
function mdLabel(text) {
  return reEscape(text.replace(/([\\[\]])/g, "\\$1"));
}

// Text pulled out of an attribute or an anchor is decoded here, but the whole
// document is decoded again at the end. Without re-escaping the ampersands, a
// doubly-encoded `&amp;lt;script&amp;gt;` would come back as a literal
// `<script>` — after the tag-stripping pass has already run.
function reEscape(text) {
  return text.replace(/&/g, "&amp;");
}

function mdUrl(url) {
  url = reEscape(url);
  // Percent-encode rather than wrap in <>: the angle-bracket form would be eaten
  // by the tag-stripping pass that runs after this one. These escapes are
  // ordinary URL syntax, so the link still resolves.
  return url
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\s/g, "%20");
}

export function htmlToMarkdown(html, { maxLinkLength = 200 } = {}) {
  if (!html) return "";

  let s = String(html);

  // Content that is markup, not text.
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|head|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Links first: the anchor's own text becomes the label. The tag pattern skips
  // over quoted attribute values so a `>` inside one does not end the tag early.
  s = s.replace(
    /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a>/gi,
    (whole, tag, inner) => {
      const href = safeHref(attr(tag, "href"));
      const label = decodeEntities(inner.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
      if (!href) return mdLabel(label);
      if (href.length > maxLinkLength) return mdLabel(label) || reEscape(href.slice(0, maxLinkLength));
      // A link whose text already is the URL reads better bare.
      if (!label || label === href) return reEscape(href);
      return `[${mdLabel(label)}](${mdUrl(href)})`;
    }
  );

  // Images carry meaning only through their alt text.
  s = s.replace(/<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi, (whole, tag) => {
    const alt = attr(tag, "alt");
    return alt ? `[图片: ${mdLabel(alt)}]` : "";
  });

  s = s.replace(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi, (whole, tag, inner) =>
    `\n\n${"#".repeat(Number(tag[1]))} ${inner.replace(/<[^>]+>/g, "").trim()}\n\n`);

  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (w, t, inner) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    return text ? `**${text}**` : "";
  });
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (w, t, inner) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    return text ? `*${text}*` : "";
  });

  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<\/li>/gi, "");
  s = s.replace(/<(br|hr)\b[^>]*\/?>/gi, "\n");
  // Table cells read as a row when separated; rows need their own line.
  s = s.replace(/<\/t[dh]>/gi, "  ");
  s = s.replace(/<\/tr>/gi, "\n");
  s = s.replace(/<\/(p|div|section|article|blockquote|ul|ol|table|h[1-6])>/gi, "\n\n");

  // Whatever markup is left carries no text of its own. Quoted values are
  // skipped here too: `<td title="a>b">` must be removed whole.
  s = s.replace(/<[a-z!/][^>"']*(?:"[^"]*"|'[^']*'[^>"']*)*>/gi, "");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);

  return s
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
