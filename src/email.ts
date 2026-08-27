import type { Env } from "./types";
import { parseRaw } from "./parse";
import { storeEmail } from "./store";
import { pushNewEmail } from "./push";

// Email Routing entrypoint: read raw message -> parse -> persist -> notify.
export async function ingest(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const rawBuf = await new Response(message.raw).arrayBuffer();
  const parsed = await parseRaw(rawBuf);
  const row = await storeEmail(env, rawBuf, parsed);
  // Notify out-of-band so a slow/failing webhook never delays mail handling.
  ctx.waitUntil(pushNewEmail(env, row, row.attachments));
}
