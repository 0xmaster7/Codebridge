import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CheckJobManager } from "../../src/checks/jobs.js";
import type { WorktreeSnapshot } from "../../src/snapshot/manager.js";
import { createFakeDocker, fixtureProfile, fixtureProject } from "./helpers.js";

function snapshot(root: string): WorktreeSnapshot {
  return {
    sessionId: "00000000-0000-4000-8000-000000000001",
    snapshotId: "00000000-0000-4000-8000-000000000002",
    root,
    createdAt: new Date(0).toISOString(),
    entries: [],
    fileCount: 0,
    bytes: 0,
    manifestSha256: "a".repeat(64),
  };
}

async function waitForState(
  manager: CheckJobManager,
  runId: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (manager.status(runId).state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(manager.status(runId).state, expected);
}

void test("CheckJobManager returns bounded completed jobs and rejects unknown run IDs", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-jobs-success-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const docker = await createFakeDocker(root, { scenario: "run" });
  const project = fixtureProject(root, {
    executables: { git: "/usr/bin/git", docker: docker.executable },
  });
  const manager = new CheckJobManager(project, snapshot(root), snapshot(root).sessionId);
  const submitted = await manager.submit(fixtureProfile(), []);
  await waitForState(manager, submitted.runId, "completed");
  const completed = manager.status(submitted.runId);
  assert.equal(completed.snapshotId, snapshot(root).snapshotId);
  assert.equal(completed.exitCode, 0);
  assert.match(completed.stdout ?? "", /REDACTED_OPENAI_KEY/);
  assert.equal(manager.cancel(submitted.runId).state, "completed");
  assert.throws(() => manager.status("missing"), { code: "RUN_NOT_FOUND" });
  assert.throws(() => manager.cancel("missing"), { code: "RUN_NOT_FOUND" });
  await manager.close();
});

void test("CheckJobManager bounds its queue and handles queued cancellation and active timeout", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-jobs-queue-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const docker = await createFakeDocker(root, { scenario: "sleep" });
  const project = fixtureProject(root, {
    executables: { git: "/usr/bin/git", docker: docker.executable },
    limits: { ...fixtureProject(root).limits, maxQueuedChecks: 1 },
  });
  const manager = new CheckJobManager(project, snapshot(root), snapshot(root).sessionId);
  const active = await manager.submit(fixtureProfile({ timeoutSeconds: 1 }), []);
  const queued = await manager.submit(fixtureProfile({ id: "python.queued" }), []);
  assert.equal(manager.status(queued.runId).state, "queued");
  await assert.rejects(manager.submit(fixtureProfile({ id: "python.extra" }), []), {
    code: "CHECK_NOT_ALLOWED",
  });
  assert.equal(manager.cancel(queued.runId).state, "cancelled");
  await waitForState(manager, active.runId, "timed_out");
  await manager.close();
});

void test("CheckJobManager cancels an active check and fails closed when Docker is unavailable", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-jobs-cancel-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const docker = await createFakeDocker(root, { scenario: "sleep" });
  const project = fixtureProject(root, {
    executables: { git: "/usr/bin/git", docker: docker.executable },
  });
  const manager = new CheckJobManager(project, snapshot(root), snapshot(root).sessionId);
  const active = await manager.submit(fixtureProfile(), []);
  assert.equal(manager.cancel(active.runId).state, "running");
  await waitForState(manager, active.runId, "cancelled");
  await manager.close();

  const unavailable = new CheckJobManager(
    fixtureProject(root),
    snapshot(root),
    snapshot(root).sessionId,
  );
  const failed = await unavailable.submit(fixtureProfile(), []);
  await waitForState(unavailable, failed.runId, "failed");
  assert.equal(unavailable.status(failed.runId).errorCode, "SANDBOX_UNAVAILABLE");
  await unavailable.close();
});
