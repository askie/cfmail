import type { Env } from "./types";

// Open tracking, self-hosted: every outbound HTML message carries a 1x1 image
// served by this worker at /o/<id>.gif. Loading it bumps the counters on the
// matching `sent` row. Counts are a floor, not a truth: mail clients that
// block remote images never register, and privacy proxies (Apple Mail) fetch
// the image whether or not a human looked at the message.

// The table is created on first use so an existing deployment picks the feature
// up without a manual migration; the promise is cached per isolate.
let sentReady: Promise<void> | null = null;
export function ensureSentTable(env: Env): Promise<void> {
  sentReady ??= env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS sent (
       id              TEXT PRIMARY KEY,
       provider        TEXT,
       provider_id     TEXT,
       from_addr       TEXT,
       to_addr         TEXT,
       cc_addr         TEXT,
       subject         TEXT,
       sent_at         INTEGER NOT NULL,
       tracked         INTEGER NOT NULL DEFAULT 0,
       open_count      INTEGER NOT NULL DEFAULT 0,
       first_opened_at INTEGER,
       last_opened_at  INTEGER
     )`
  ).run().then(() => undefined).catch((e) => { sentReady = null; throw e; });
  return sentReady;
}
export function _resetSentTableCacheForTests(): void { sentReady = null; }

export function newTrackingId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function pixelUrl(base: string, id: string): string {
  return `${base.replace(/\/+$/, "")}/o/${id}.gif`;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ESC[c]);
}

// A text-only message has nowhere to put an image, so it gets a minimal HTML
// twin (the plain text still travels alongside as the text/plain part).
export function textToHtml(text: string): string {
  return `<div style="white-space:pre-wrap;font-family:inherit">${escapeHtml(text)}</div>`;
}

export function injectPixel(html: string, url: string): string {
  const img = `<img src="${escapeHtml(url)}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0">`;
  const at = html.search(/<\/body\s*>/i);
  return at === -1 ? html + img : html.slice(0, at) + img + html.slice(at);
}

export interface SentRecord {
  id: string;
  provider: string;
  provider_id: string | null;
  from_addr: string;
  to_addr: string[];
  cc_addr: string[];
  subject: string | null;
  tracked: boolean;
}

export async function recordSent(env: Env, r: SentRecord): Promise<void> {
  await ensureSentTable(env);
  await env.DB.prepare(
    `INSERT INTO sent (id, provider, provider_id, from_addr, to_addr, cc_addr, subject, sent_at, tracked)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    r.id, r.provider, r.provider_id, r.from_addr.toLowerCase(),
    r.to_addr.join(", "), r.cc_addr.length ? r.cc_addr.join(", ") : null,
    r.subject, Date.now(), r.tracked ? 1 : 0
  ).run();
}

export async function recordOpen(env: Env, id: string, now = Date.now()): Promise<void> {
  await ensureSentTable(env);
  await env.DB.prepare(
    `UPDATE sent SET open_count = open_count + 1,
       first_opened_at = COALESCE(first_opened_at, ?), last_opened_at = ?
     WHERE id = ?`
  ).bind(now, now, id).run();
}

// A transparent 1x1 GIF (43 bytes).
const GIF = Uint8Array.from([
  0x47,0x49,0x46,0x38,0x39,0x61,0x01,0x00,0x01,0x00,0x80,0x00,0x00,0x00,0x00,0x00,
  0xff,0xff,0xff,0x21,0xf9,0x04,0x01,0x00,0x00,0x00,0x00,0x2c,0x00,0x00,0x00,0x00,
  0x01,0x00,0x01,0x00,0x00,0x02,0x02,0x44,0x01,0x00,0x3b,
]);

const OPEN_PATH = /^\/o\/([0-9a-f]{32})\.gif$/;

// Serves the pixel for /o/<id>.gif; null when the path is not a tracking URL.
// Always answers with the image — an unknown id must look identical to a known
// one, so nobody can probe which ids exist.
export function handleOpen(request: Request, env: Env, ctx: ExecutionContext): Response | null {
  const m = new URL(request.url).pathname.match(OPEN_PATH);
  if (!m) return null;
  if (request.method === "GET" || request.method === "HEAD") {
    ctx.waitUntil(recordOpen(env, m[1]).catch((e) => console.error("open tracking:", e)));
  }
  return new Response(request.method === "HEAD" ? null : GIF, {
    headers: {
      "content-type": "image/gif",
      "content-length": String(GIF.length),
      "cache-control": "no-store, no-cache, max-age=0, must-revalidate",
      "pragma": "no-cache",
      "expires": "0",
    },
  });
}

export interface SentFilters {
  since?: number;
  until?: number;
  from?: string;      // admin only; non-admin callers are pinned to their own address
  limit?: number;
  offset?: number;
}

function sentWhere(f: SentFilters, userEmail?: string): { where: string; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  const from = userEmail ?? f.from;
  if (from) { where.push("from_addr = ?"); args.push(from.trim().toLowerCase()); }
  if (f.since) { where.push("sent_at >= ?"); args.push(f.since); }
  if (f.until) { where.push("sent_at <= ?"); args.push(f.until); }
  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", args };
}

export async function listSent(env: Env, f: SentFilters, userEmail?: string) {
  await ensureSentTable(env);
  const limit = Math.max(1, Math.min(100, f.limit ?? 20));
  const offset = Math.max(0, f.offset ?? 0);
  const { where, args } = sentWhere(f, userEmail);
  const { results } = await env.DB.prepare(
    `SELECT id, provider, provider_id, from_addr, to_addr, cc_addr, subject, sent_at, tracked,
            open_count, first_opened_at, last_opened_at
     FROM sent ${where} ORDER BY sent_at DESC LIMIT ? OFFSET ?`
  ).bind(...args, limit, offset).all<any>();
  const rows = (results ?? []).map((r) => ({
    id: r.id, provider: r.provider, provider_id: r.provider_id,
    from: r.from_addr, to: r.to_addr, cc: r.cc_addr, subject: r.subject,
    sent_at: r.sent_at, tracked: !!r.tracked,
    opened: r.open_count > 0, open_count: r.open_count,
    first_opened_at: r.first_opened_at, last_opened_at: r.last_opened_at,
  }));
  return { sent: rows, next_offset: rows.length === limit ? offset + limit : null };
}

export async function sentStats(env: Env, f: SentFilters, userEmail?: string) {
  await ensureSentTable(env);
  const { where, args } = sentWhere(f, userEmail);
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(tracked) AS tracked,
            SUM(CASE WHEN open_count > 0 THEN 1 ELSE 0 END) AS opened,
            SUM(open_count) AS opens
     FROM sent ${where}`
  ).bind(...args).first<any>();
  const total = r?.total ?? 0, tracked = r?.tracked ?? 0, opened = r?.opened ?? 0;
  return {
    total, tracked, opened, opens: r?.opens ?? 0,
    // Rate over messages that actually carried a pixel; untracked mail cannot open.
    open_rate: tracked ? Math.round((opened / tracked) * 1000) / 10 : null,
  };
}
