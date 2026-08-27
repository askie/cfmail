import { test, expect } from "vitest";
import { htmlToMarkdown } from "../src/html2md.mjs";

const md = (html) => htmlToMarkdown(html);

test("markup that is not text is dropped entirely", () => {
  const out = md(`
    <head><style>p{color:red}</style></head>
    <script>alert(1)</script>
    <!-- tracking pixel -->
    <p>正文</p>`);
  expect(out).toBe("正文");
});

test("headings, emphasis and lists become their markdown equivalents", () => {
  expect(md("<h2>标题</h2>")).toBe("## 标题");
  expect(md("<p>code is <strong>123456</strong></p>")).toBe("code is **123456**");
  expect(md("<p>this is <em>urgent</em></p>")).toBe("this is *urgent*");
  expect(md("<ul><li>一</li><li>二</li></ul>")).toBe("- 一\n- 二");
});

test("a link keeps its own text as the label", () => {
  expect(md('<a href="https://x.com/a?b=1">点这里</a>'))
    .toBe("[点这里](https://x.com/a?b=1)");
});

test("a link whose text is already the URL is not doubled up", () => {
  expect(md('<a href="https://x.com">https://x.com</a>')).toBe("https://x.com");
});

test("attribute quoting styles are all handled", () => {
  expect(md(`<a href='https://x.com'>q</a>`)).toBe("[q](https://x.com)");
  expect(md(`<a href=https://x.com>q</a>`)).toBe("[q](https://x.com)");
});

// --- Only safe schemes may keep their href. ------------------------------------

// An allowlist rather than a blocklist: the next dangerous scheme does not need
// to be predicted, and case or whitespace tricks cannot slip past it.
test.each([
  ["javascript:", '<a href="javascript:steal()">点我</a>'],
  ["mixed case", '<a href="JaVaScRiPt:alert(1)">点我</a>'],
  ["leading space", '<a href=" javascript:alert(1)">点我</a>'],
  ["embedded tab", '<a href="java\tscript:alert(1)">点我</a>'],
  ["data:", '<a href="data:text/html,<b>x</b>">点我</a>'],
  ["vbscript:", '<a href="vbscript:msgbox(1)">点我</a>'],
  ["file:", '<a href="file:///etc/passwd">点我</a>'],
])("a %s link keeps its text but loses the href", (_name, html) => {
  expect(md(html)).toBe("点我");
});

test.each([
  ["https", '<a href="https://x.com/a?b=1">go</a>', "[go](https://x.com/a?b=1)"],
  ["http", '<a href="http://x.com">go</a>', "[go](http://x.com)"],
  ["mailto", '<a href="mailto:a@x.com">写信</a>', "[写信](mailto:a@x.com)"],
  ["relative", '<a href="/path/page">相对</a>', "[相对](/path/page)"],
])("a %s link is kept", (_name, html, expected) => {
  expect(md(html)).toBe(expected);
});

// --- Crafted markup must not break out into markdown structure. ---------------

test("a bracket in the label is escaped so the link cannot be forged", () => {
  // Unescaped, "a](evil) [x" would close the link early and inject another.
  expect(md('<a href="https://x.com">a]b</a>')).toBe("[a\\]b](https://x.com)");
});

test("parentheses and spaces in a URL are percent-encoded, not left to break the link", () => {
  expect(md('<a href="https://x.com/a(b)c">链接</a>')).toBe("[链接](https://x.com/a%28b%29c)");
  expect(md('<a href="https://x.com/a b">链接</a>')).toBe("[链接](https://x.com/a%20b)");
});

test("a > inside an attribute value does not end the tag early", () => {
  expect(md('<a href="https://x.com/a>b">点我</a>')).toBe("[点我](https://x.com/a>b)");
  expect(md('<td title="a>b">单元格</td>')).toBe("单元格");
});

test("unclosed and nested anchors degrade to plain text rather than debris", () => {
  expect(md('<a href="https://x.com">未闭合')).toBe("未闭合");
  expect(md('<a href="https://o.com">外<a href="https://i.com">内</a></a>'))
    .toBe("[外内](https://o.com)");
});

test("a crafted label cannot forge a second, clickable link", () => {
  // The scheme check only sees the href, so an unescaped `]` in the label would
  // let the sender close the link early and open a javascript: one of their own.
  const out = md('<a href="https://ok.com">a](javascript:evil) [b</a>');
  // An escaped `\]` cannot close the link, so no second link is formed.
  expect(out).not.toMatch(/(?<!\\)\]\(javascript:/);
  expect(out).toBe("[a\\](javascript:evil) \\[b](https://ok.com)");
});

test("a crafted label cannot rewrite the link to another site", () => {
  const out = md('<a href="https://ok.com">点击](https://evil.com) [x</a>');
  expect(out).not.toMatch(/(?<!\\)\]\(https:\/\/evil\.com\)/);
  // The real destination is the only one that survives as a link.
  expect(out.endsWith("](https://ok.com)")).toBe(true);
});

test("an image alt is escaped the same way as a link label", () => {
  const out = md('<img src="p.gif" alt="x](javascript:evil)">');
  expect(out).not.toMatch(/(?<!\\)\]\(javascript:/);
  expect(out).toBe("[图片: x\\](javascript:evil)]");
});

test("double-encoded markup does not come back as a literal tag", () => {
  // Text is decoded once inside the anchor and once more for the whole document;
  // without re-escaping, `&amp;lt;script&amp;gt;` would resurface as `<script>`
  // after the tag-stripping pass had already run.
  const out = md('<a href="https://x.com">&amp;lt;script&amp;gt;x&amp;lt;/script&amp;gt;</a>');
  expect(out).not.toContain("<script>");
  expect(out).toBe("[&lt;script&gt;x&lt;/script&gt;](https://x.com)");
});

test("ordinary ampersands still decode exactly once", () => {
  expect(md("<p>Tom &amp; Jerry</p>")).toBe("Tom & Jerry");
  expect(md('<a href="https://x.com/a?b=1&amp;c=2">正常</a>')).toBe("[正常](https://x.com/a?b=1&c=2)");
  expect(md('<a href="https://x.com/?a=1&amp;b=2">https://x.com/?a=1&amp;b=2</a>'))
    .toBe("https://x.com/?a=1&b=2");
});

test("an entity-encoded scheme is decoded before it is judged", () => {
  // `&#106;avascript:` is javascript: once decoded; checking the raw attribute
  // would wave it through.
  expect(md('<a href="&#106;avascript:alert(1)">x</a>')).toBe("x");
});

test("an empty or whitespace-only href is dropped", () => {
  expect(md('<a href="">文字</a>')).toBe("文字");
  expect(md('<a href="   ">文字</a>')).toBe("文字");
});

test("triple-encoded markup still cannot become a tag", () => {
  expect(md('<a href="https://x.com">&amp;amp;lt;script&amp;amp;gt;</a>'))
    .toBe("[&amp;lt;script&amp;gt;](https://x.com)");
});

test("a backslash in a label is escaped so it cannot cancel the next escape", () => {
  expect(md('<a href="https://x.com">a\\]b</a>')).toBe("[a\\\\\\]b](https://x.com)");
});

test("no output ever retains a tag", () => {
  const nasty = [
    '<a href="https://x.com/a>b">x</a>',
    '<div class="a>b">y</div>',
    '<img src="x" alt="z>">',
    "<p onclick='alert(1)'>w</p>",
    "<unknown-tag>v</unknown-tag>",
    '<a href="https://x.com">&amp;lt;script&amp;gt;</a>',
    '<img alt="&amp;lt;img onerror=x&amp;gt;" src="p.gif">',
  ];
  for (const html of nasty) expect(md(html), html).not.toMatch(/<[a-z!/]/i);
});

test("a tracking URL longer than the cap degrades to its label", () => {
  const long = "https://track.example.com/" + "a".repeat(300);
  expect(md(`<a href="${long}">查看详情</a>`)).toBe("查看详情");
});

test("images survive only as their alt text", () => {
  expect(md('<img src="logo.png" alt="公司标志">')).toBe("[图片: 公司标志]");
  expect(md('<img src="pixel.gif">')).toBe("");
});

test("entities are decoded, including numeric and hex forms", () => {
  expect(md("<p>Tom &amp; Jerry&hellip;</p>")).toBe("Tom & Jerry…");
  expect(md("<p>&#20320;&#22909;</p>")).toBe("你好");
  expect(md("<p>&#x4F60;&#x597D;</p>")).toBe("你好");
  expect(md("<p>10&nbsp;minutes</p>")).toBe("10 minutes");
});

test("an unknown entity is left alone rather than mangled", () => {
  expect(md("<p>&notanentity;</p>")).toBe("&notanentity;");
});

test("table rows read as lines, cells separated within a row", () => {
  expect(md("<table><tr><td>项目</td><td>金额</td></tr><tr><td>发票</td><td>100</td></tr></table>"))
    .toBe("项目 金额\n发票 100");
});

test("br and block boundaries become line breaks, not a wall of text", () => {
  expect(md("<p>第一行<br>第二行</p><p>第二段</p>")).toBe("第一行\n第二行\n\n第二段");
});

test("runs of blank lines collapse", () => {
  expect(md("<p>a</p><br><br><br><p>b</p>")).toBe("a\n\nb");
});

test("empty input is handled without throwing", () => {
  expect(md("")).toBe("");
  expect(md(null)).toBe("");
  expect(md(undefined)).toBe("");
});

test("a real verification-code email becomes readable", () => {
  const out = md(`
    <html><body style="margin:0">
      <table width="100%"><tr><td align="center">
        <h1 style="font-size:24px">Your verification code</h1>
        <p>Enter this code to continue:</p>
        <p style="font-size:32px"><strong>558213</strong></p>
        <p>It expires in 10&nbsp;minutes. If you didn't request it, ignore this email.</p>
        <p><a href="https://app.example.com/verify?token=xyz">Verify now</a></p>
      </td></tr></table>
    </body></html>`);

  expect(out).toContain("# Your verification code");
  expect(out).toContain("**558213**");
  expect(out).toContain("expires in 10 minutes");
  expect(out).toContain("[Verify now](https://app.example.com/verify?token=xyz)");
  expect(out).not.toContain("<");
  expect(out).not.toContain("style=");
});

// --- Markdown written into the body itself. -----------------------------------

// The scheme allowlist only ever inspects hrefs. Markdown typed directly into
// the email body never passes through it, so the brackets are neutralised and
// only links this converter built survive as links.
test.each([
  ["a paragraph", "<p>[click](javascript:alert(1))</p>"],
  ["bold text", "<b>[click](javascript:alert(1))</b>"],
  ["a heading", "<h2>[click](javascript:alert(1))</h2>"],
  ["a list item", "<ul><li>[click](javascript:alert(1))</li></ul>"],
  ["a table cell", "<table><tr><td>[click](javascript:alert(1))</td></tr></table>"],
])("markdown typed into %s cannot become a link", (_name, html) => {
  const out = md(html);
  expect(out).not.toMatch(/(?<!\\)\[click\]\(/);
  expect(out).toContain("\\[click\\]");
});

test("a bare URL printed as its own text cannot carry a link inside it", () => {
  // The label branch skips mdLabel, so the URL itself must be encoded.
  const out = md('<a href="https://x.com/[a](javascript:evil)">https://x.com/[a](javascript:evil)</a>');
  expect(out).not.toMatch(/(?<!\\)\[a\]\(javascript:/);
  expect(out).toBe("https://x.com/%5Ba%5D%28javascript:evil%29");
});

test("invisible characters cannot smuggle a scheme past the allowlist", () => {
  // NBSP is whitespace to \s but not to the C0 range alone.
  expect(md('<a href="java\u00A0script:alert(1)">x</a>')).toBe("x");
  expect(md('<a href="java\u007Fscript:alert(1)">x</a>')).toBe("x");
});

test("brackets in ordinary prose are escaped but still readable", () => {
  expect(md("<p>见附件[1]和[2]</p>")).toBe("见附件\\[1\\]和\\[2\\]");
});

test("links this converter builds survive the body-wide escaping", () => {
  const out = md('<p>见 <a href="https://x.com">这里</a> 和 <img alt="图" src="p.gif"></p>');
  expect(out).toContain("[这里](https://x.com)");
  expect(out).toContain("[图片: 图]");
});

// --- The placeholder and the autolink form. -----------------------------------

const NUL = String.fromCharCode(0);

test("a body cannot forge a placeholder and clone another link", () => {
  // The placeholder is built from NUL, so NUL is stripped from the input first.
  // Otherwise a sender could replay any link the same message contains — say,
  // moving a legitimate "unsubscribe" URL under text of their choosing.
  const out = md(`<p>${NUL}L0${NUL}</p><a href="https://ok.com">真</a>`);

  expect(out.match(/\[真\]\(https:\/\/ok\.com\)/g)).toHaveLength(1);
  expect(out).not.toContain(NUL);
});

test("an out-of-range placeholder in the body is inert", () => {
  expect(md(`<p>${NUL}L99${NUL}</p>`)).toBe("L99");
});

test("the autolink form cannot smuggle a scheme past the allowlist", () => {
  // `<javascript:alert(1)>` is a markdown autolink, and the tag-stripping pass
  // runs before entities are decoded — so `&lt;` arrives here as a live `<`.
  const out = md("<p>&lt;javascript:alert(1)&gt;</p>");
  expect(out).not.toMatch(/(?<!\\)<javascript:/);
  expect(out).toBe("\\<javascript:alert(1)>");
});

test("markdown image syntax in the body cannot become a link either", () => {
  expect(md("<p>![img](javascript:alert(1))</p>")).toBe("!\\[img\\](javascript:alert(1))");
});

test("a less-than in ordinary prose stays readable", () => {
  expect(md("<p>价格 &lt; 100 元</p>")).toBe("价格 \\< 100 元");
});
