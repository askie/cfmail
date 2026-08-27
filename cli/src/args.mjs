// Tiny flag parser. A flag left without its value is an error rather than a
// silent undefined that surfaces much later as a confusing server-side message.

import { fail } from "./output.mjs";

// spec: { "--to": "list", "--limit": "number", "--peek": "bool", ... }
export function parseArgs(argv, spec) {
  const opts = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith("--")) {
      positional.push(raw);
      continue;
    }
    // `--flag=value` is the only way to pass a value that itself starts with
    // `--`, since the space form cannot tell a value from the next flag.
    const eq = raw.indexOf("=");
    const arg = eq > 2 ? raw.slice(0, eq) : raw;
    const inline = eq > 2 ? raw.slice(eq + 1) : undefined;

    const kind = spec[arg];
    if (!kind) fail(`unknown option: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());

    if (kind === "bool") {
      if (inline !== undefined) fail(`${arg} takes no value`);
      opts[key] = true;
      continue;
    }
    let value = inline;
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(`${arg} requires a value (use ${arg}=<value> if the value starts with --)`);
      }
      i++;
    }

    if (kind === "list") (opts[key] ||= []).push(value);
    else if (kind === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) fail(`${arg} expects a number, got: ${value}`);
      opts[key] = n;
    } else opts[key] = value;
  }

  return { opts, positional };
}
