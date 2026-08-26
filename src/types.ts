export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  MCP_OBJECT: DurableObjectNamespace;
  MCP_TOKEN: string;
  // Present only when the send_email binding is configured in wrangler.
  EMAIL?: SendEmail;
}

// One stored attachment (R2 + a row in `attachments`).
export interface StoredAttachment {
  id: string;
  email_id: string;
  filename: string | null;
  content_type: string | null;
  size: number;
  r2_key: string;
}

// One stored email row (mirrors the `emails` table).
export interface EmailRow {
  id: string;
  msg_id: string | null;
  from_addr: string | null;
  from_name: string | null;
  to_addr: string | null;
  cc_addr: string | null;
  subject: string | null;
  date: number | null;
  text_body: string | null;
  html_key: string | null;
  raw_key: string;
  size: number | null;
  has_attachments: number;
  received_at: number;
}

// Result of parsing a raw message, before persistence.
export interface ParsedEmail {
  msg_id: string | null;
  from_addr: string | null;
  from_name: string | null;
  to_addr: string | null;
  cc_addr: string | null;
  subject: string | null;
  date: number | null;
  text_body: string | null;
  html_body: string | null;
  attachments: ParsedAttachment[];
}

export interface ParsedAttachment {
  filename: string | null;
  content_type: string | null;
  content: ArrayBuffer;
}
