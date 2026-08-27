// A stand-in for one agent: advance a mailbox's cursor, repeatedly, as fast as
// it can. Run several against one config to reproduce real contention.
const [cfg, mailbox, rounds] = process.argv.slice(2);
process.env.EMAIL_INBOX_CONFIG = cfg;

const { saveConfig, selectAccount } = await import("../../src/config.mjs");
selectAccount(mailbox);

for (let i = 1; i <= Number(rounds); i++) saveConfig({ cursor: i }, "user");
