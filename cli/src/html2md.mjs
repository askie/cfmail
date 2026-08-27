// HTML -> Markdown for email bodies.
//
// Many messages (verification codes, notifications, newsletters) ship HTML only:
// their plain-text part is empty, so a notification built from it says nothing.
//
// Parsing HTML and escaping Markdown are both done by turndown. Hand-rolling
// either is a losing game — an earlier version of this file did, and review
// found a fresh injection in it three rounds running. What stays here is the
// part turndown deliberately leaves to the caller: which link schemes may
// survive, and making sure no markup reaches the output.

import TurndownService from "turndown";

// Only schemes that are safe to hand a chat client. Anything else —
// javascript:, data:, vbscript:, and whatever comes next — loses its href and
// survives as plain text. A blocklist would have to guess at the future.
const SAFE_SCHEME = /^(https?:|mailto:)/i;

// `JaVaScRiPt:`, " javascript:" and "java\tscript:" are the classic ways past a
// naive check. \s covers NBSP; \x7f and the C1 range are invisible but are not
// whitespace, so they are listed too.
const INVISIBLE = /[\s\u0000-\u0020\u007f-\u009f]/g;

export function safeHref(href) {
  const cleaned = String(href || "").replace(INVISIBLE, "");
  if (!cleaned) return "";
  // No scheme at all: a relative, anchor-only or protocol-relative link. None
  // can name a dangerous scheme, so they keep their href.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(cleaned)) return cleaned;
  return SAFE_SCHEME.test(cleaned) ? cleaned : "";
}

// Tracking URLs run to hundreds of characters and drown the message; past this
// the link keeps its text and loses its target.
const MAX_LINK_LENGTH = 200;

// `(` `)` inside a link target end it early; the rest are ordinary URL syntax.
function encodeTarget(url) {
  return url
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\[/g, "%5B")
    .replace(/\]/g, "%5D")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E")
    .replace(/\s/g, "%20");
}

function escapeMd(text) {
  return text.replace(/([\\[\]])/g, "\\$1");
}

function buildService() {
  const td = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });

  // Content that is markup, not text.
  td.remove(["script", "style", "head", "noscript", "iframe", "object", "embed"]);

  // turndown keeps a link's href verbatim; the scheme check is ours to make.
  td.addRule("safeLink", {
    filter: (node) => node.nodeName === "A" && node.getAttribute("href"),
    replacement: (content, node) => {
      const href = safeHref(node.getAttribute("href"));
      const text = content.trim();
      if (!href) return text;
      if (href.length > MAX_LINK_LENGTH) return text || encodeTarget(href.slice(0, MAX_LINK_LENGTH));
      if (!text) return encodeTarget(href);
      return `[${text}](${encodeTarget(href)})`;
    },
  });

  // An image carries meaning only through its alt text; its src is a
  // sender-controlled URL there is no reason to pass on.
  td.addRule("altOnly", {
    filter: "img",
    replacement: (content, node) => {
      const alt = (node.getAttribute("alt") || "").trim();
      return alt ? `[图片: ${escapeMd(alt)}]` : "";
    },
  });

  // Table cells read as a row; rows need their own line.
  td.addRule("tableCell", {
    filter: ["td", "th"],
    replacement: (content) => content.trim() + "  ",
  });
  td.addRule("tableRow", {
    filter: "tr",
    replacement: (content) => content.trim() + "\n",
  });

  return td;
}

const service = buildService();

export function htmlToMarkdown(html) {
  if (!html) return "";

  let out;
  try {
    out = service.turndown(String(html));
  } catch {
    // A malformed document should degrade to nothing rather than break a sync.
    return "";
  }

  // turndown passes inline HTML through, and text that was entity-encoded in the
  // source arrives here as live markup. Neither should reach a renderer, so any
  // `<` left in the output is escaped — the links built above contain none.
  out = out.replace(/</g, "\\<");

  return out
    .replace(/[ \t\u00a0\u3000]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
