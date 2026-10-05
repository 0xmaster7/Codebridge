import assert from "node:assert/strict";
import { link, lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionAuditLog } from "../../src/mcp/audit-log.js";

void test("session audit log records only tool and argument names and rotates at its size bound", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-audit-log-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const audit = new SessionAuditLog(
    root,
    "00000000-0000-4000-8000-000000000001",
    "snapshot-fixture",
    1100,
  );
  for (let index = 0; index < 5; index += 1) {
    await audit.append("read_file", index === 3 ? "error" : "success", ["path"], {
      requestId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
      durationMs: 3,
      returnedBytes: 42,
      truncated: false,
      ...(index === 3 ? { errorCode: "FILE_NOT_FOUND" } : {}),
      ...(index === 1 ? { target: "src/index.ts" } : {}),
    });
  }
  const current = await import("node:fs/promises").then(({ readFile }) =>
    readFile(join(root, "audit.jsonl"), "utf8"),
  );
  const rotated = await import("node:fs/promises").then(({ readFile }) =>
    readFile(join(root, "audit.jsonl.1"), "utf8"),
  );
  assert.ok(Buffer.byteLength(current) <= 1100);
  assert.ok(Buffer.byteLength(rotated) <= 1100);
  assert.match(current, /"snapshotId":"snapshot-fixture"/);
  assert.match(current + rotated, /"sessionId":"00000000-0000-4000-8000-000000000001"/);
  assert.match(current + rotated, /"requestId":"00000000-0000-4000-8000-/);
  assert.match(current + rotated, /"decision":"allow"/);
  assert.match(current + rotated, /"returnedBytes":42/);
  assert.match(current + rotated, /"target":"src\/index.ts"/);
  assert.match(rotated, /"tool":"read_file"/);
  assert.match(current, /"argumentNames":\["path"\]/);
  assert.doesNotMatch(current + rotated, /sensitive-user-supplied-value/);
  const events = (current + rotated)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { result: string; errorCode?: string });
  assert.ok(
    events.some((event) => event.result === "error" && event.errorCode === "FILE_NOT_FOUND"),
  );
  assert.equal((await lstat(join(root, "audit.jsonl"))).nlink, 1);
});

void test("session audit log refuses symlinks and hardlinks at the active log path", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-audit-log-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const outside = join(root, "outside.jsonl");
  await (
    await import("node:fs/promises")
  ).writeFile(outside, "do not overwrite\n", { mode: 0o600 });
  const active = join(root, "audit.jsonl");
  await symlink(outside, active);
  const audit = new SessionAuditLog(
    root,
    "00000000-0000-4000-8000-000000000001",
    "snapshot-fixture",
    4096,
  );
  const metadata = {
    requestId: "00000000-0000-4000-8000-000000000002",
    durationMs: 1,
    returnedBytes: 0,
    truncated: false,
  };
  await assert.rejects(audit.append("read_file", "success", [], metadata));
  await rm(active);
  await link(outside, active);
  await assert.rejects(audit.append("read_file", "success", [], metadata), {
    code: "CONFIG_PERMISSION_UNSAFE",
  });
});

void test("concurrent MCP requests append complete audit records without losing events", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-audit-concurrent-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const audit = new SessionAuditLog(
    root,
    "00000000-0000-4000-8000-000000000001",
    "snapshot-fixture",
    64 * 1024,
  );
  await Promise.all(
    Array.from({ length: 32 }, (_, index) =>
      audit.append("read_file", "success", ["path"], {
        requestId: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
        durationMs: index,
        returnedBytes: index * 2,
        truncated: false,
      }),
    ),
  );
  const { readFile } = await import("node:fs/promises");
  const records = (await readFile(join(root, "audit.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { requestId: string });
  assert.equal(records.length, 32);
  assert.equal(new Set(records.map((record) => record.requestId)).size, 32);
});
