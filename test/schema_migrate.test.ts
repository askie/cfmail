import { test, expect, vi, beforeEach } from "vitest";
import { ensureSchema, _resetSchemaCacheForTests } from "../src/store";

function envWith(run: any) {
  return { DB: { prepare: vi.fn().mockReturnValue({ run }) } } as any;
}

beforeEach(() => _resetSchemaCacheForTests());

test("adds the refs column once per isolate", async () => {
  const run = vi.fn().mockResolvedValue({});
  const env = envWith(run);

  await ensureSchema(env);
  await ensureSchema(env);

  expect(run).toHaveBeenCalledTimes(1);
  expect(env.DB.prepare).toHaveBeenCalledWith("ALTER TABLE emails ADD COLUMN refs TEXT");
});

test("an already-migrated database is not retried", async () => {
  const run = vi.fn().mockRejectedValue(new Error("duplicate column name: refs"));
  const env = envWith(run);

  await expect(ensureSchema(env)).resolves.toBeUndefined();
  await ensureSchema(env);

  expect(run).toHaveBeenCalledTimes(1);
});

// Asserts the swallow documented on ensureSchema: the caller proceeds to the
// INSERT and fails there. Flip this together with that decision, never alone.
test("a genuine failure is retried on the next message instead of being cached", async () => {
  const run = vi.fn()
    .mockRejectedValueOnce(new Error("D1_ERROR: network"))
    .mockResolvedValueOnce({});
  const env = envWith(run);

  await expect(ensureSchema(env)).resolves.toBeUndefined();
  await ensureSchema(env);

  expect(run).toHaveBeenCalledTimes(2);
});
