-- Emails: queryable metadata + plain-text body. Large blobs (html/raw/attachments) live in R2.
CREATE TABLE IF NOT EXISTS emails (
  id              TEXT PRIMARY KEY,   -- uuid
  msg_id          TEXT,               -- original Message-ID header
  refs            TEXT,               -- original References header, for reply threading
  from_addr       TEXT,
  from_name       TEXT,
  to_addr         TEXT,               -- comma-joined recipients
  cc_addr         TEXT,
  subject         TEXT,
  date            INTEGER,            -- epoch ms from Date header (fallback: received_at)
  text_body       TEXT,
  html_key        TEXT,               -- R2 key, null if no html part
  raw_key         TEXT NOT NULL,      -- R2 key of the raw .eml
  size            INTEGER,            -- raw size in bytes
  has_attachments INTEGER NOT NULL DEFAULT 0,
  received_at     INTEGER NOT NULL    -- epoch ms when stored
);

CREATE INDEX IF NOT EXISTS idx_emails_date     ON emails(date DESC);
CREATE INDEX IF NOT EXISTS idx_emails_from      ON emails(from_addr);
CREATE INDEX IF NOT EXISTS idx_emails_received  ON emails(received_at DESC);

CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,      -- uuid
  email_id     TEXT NOT NULL,
  filename     TEXT,
  content_type TEXT,
  size         INTEGER,
  r2_key       TEXT NOT NULL,
  FOREIGN KEY (email_id) REFERENCES emails(id)
);

CREATE INDEX IF NOT EXISTS idx_att_email ON attachments(email_id);

-- Full-text search. trigram tokenizer so CJK (Chinese) subject/body is searchable.
CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
  email_id UNINDEXED,
  subject,
  text_body,
  tokenize = 'trigram'
);

-- Migrating a database created before `refs` existed (safe to fail if present):
--   ALTER TABLE emails ADD COLUMN refs TEXT;

-- Key/value config (e.g. webhook_url), settable via MCP tools.
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- API Keys: mapping from API Key to specific user email.
CREATE TABLE IF NOT EXISTS api_keys (
  key_value   TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

-- Outbound mail + open tracking. Created on demand by the worker as well, so an
-- existing deployment needs no manual migration.
CREATE TABLE IF NOT EXISTS sent (
  id              TEXT PRIMARY KEY,   -- tracking id, used in the pixel URL /o/<id>.gif
  provider        TEXT,               -- resend | cloudflare
  provider_id     TEXT,               -- provider's message id
  from_addr       TEXT,
  to_addr         TEXT,               -- comma-joined
  cc_addr         TEXT,
  subject         TEXT,
  sent_at         INTEGER NOT NULL,   -- epoch ms
  tracked         INTEGER NOT NULL DEFAULT 0,  -- 1 when the message carried a pixel
  open_count      INTEGER NOT NULL DEFAULT 0,
  first_opened_at INTEGER,
  last_opened_at  INTEGER
);
