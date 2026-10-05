import assert from "node:assert/strict";
import test from "node:test";
import { ReadLimiter } from "../../src/security/read-limiter.js";

void test("ReadLimiter rejects excess concurrent work and releases capacity after success or failure", async () => {
  const limiter = new ReadLimiter(1);
  let release: (() => void) | undefined;
  const active = limiter.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await assert.rejects(
    limiter.run(() => "excess"),
    { code: "READ_LIMIT_EXCEEDED" },
  );
  release?.();
  await active;
  assert.equal(await limiter.run(() => "available"), "available");
  await assert.rejects(
    limiter.run(() => {
      throw new Error("controlled failure");
    }),
    /controlled failure/,
  );
  assert.equal(await limiter.run(() => 7), 7);
  assert.throws(() => new ReadLimiter(0), { code: "CONFIG_INVALID" });
});
