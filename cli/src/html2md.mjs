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

export function htmlToMarkdown(html, { maxLinkLength = 200 } = {}) {
  if (!html) return "";

  let s = String(html);

  // Content that is markup, not text.
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|head|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Links first: the anchor's own text becomes the label.
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, tag, inner) => {
    const href = attr(tag, "href");
    const label = decodeEntities(inner.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (!href || href.startsWith("javascript:")) return label;
    if (href.length > maxLinkLength) return label || href.slice(0, maxLinkLength);
    // A link whose text already is the URL reads better bare.
    if (!label || label === href) return href;
    return `[${label}](${href})`;
  });

  // Images carry meaning only through their alt text.
  s = s.replace(/<img\b([^>]*)>/gi, (whole, tag) => {
    const alt = attr(tag, "alt");
    return alt ? `[图片: ${alt}]` : "";
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

  // Whatever markup is left carries no text of its own.
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);

  return s
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
