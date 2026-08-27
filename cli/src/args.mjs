// Tiny flag parser. A flag left without its value is an error rather than a
// silent undefined that surfaces much later as a confusing server-side message.

import { fail } from "./output.mjs";

// spec: { "--to": "list", "--limit": "number", "--peek": "bool", ... }
export function parseArgs(argv, spec) {
  const opts = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const kind = spec[arg];
    if (!kind) fail(`unknown option: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());

    if (kind === "bool") {
      opts[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`${arg} requires a value`);
    i++;

    if (kind === "list") (opts[key] ||= []).push(value);
    else if (kind === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) fail(`${arg} expects a number, got: ${value}`);
      opts[key] = n;
    } else opts[key] = value;
  }

  return { opts, positional };
}
