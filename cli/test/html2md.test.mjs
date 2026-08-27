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

test("a javascript: link is stripped of its href", () => {
  // Rendering it as a markdown link would put a clickable script URL in chat.
  expect(md(`<a href="javascript:steal()">点我</a>`)).toBe("点我");
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
