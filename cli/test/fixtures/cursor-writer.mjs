// A stand-in for one program: advance one field of the config, repeatedly, as
// fast as it can. Run several against one config to reproduce real contention —
// `cfmail sync` moving syncCursor while `cfmail unread` moves cursor is exactly
// this race.
const [cfg, field, rounds] = process.argv.slice(2);
process.env.EMAIL_INBOX_CONFIG = cfg;

const { saveConfig } = await import("../../src/config.mjs");

for (let i = 1; i <= Number(rounds); i++) saveConfig({ [field]: i }, "user");
