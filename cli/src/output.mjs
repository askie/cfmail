// Every command prints through here, so --json is uniform across the CLI and
// a failure always leaves a non-zero exit code for scripts to check.

let jsonMode = false;

export function setJsonMode(on) {
  jsonMode = !!on;
}

export function isJson() {
  return jsonMode;
}

export function out(text) {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

export function json(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

// In --json mode errors are structured too, so a caller parsing stdout never
// has to fall back to scraping stderr.
export function fail(msg, extra) {
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ ok: false, error: msg, ...extra }, null, 2) + "\n");
  } else {
    process.stderr.write(`error: ${msg}\n`);
    if (extra?.code) process.stderr.write(`code: ${extra.code}\n`);
    if (extra?.hint) process.stderr.write(`hint: ${extra.hint}\n`);
  }
  process.exit(1);
}

// With more than one mailbox configured, every command should say which one it
// acted on — that ambiguity is the reason multi-account support exists.
export function mailboxTag(email, total) {
  if (!email) return "";
  return total > 1 ? `（${email}）` : "";
}

export function formatDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
