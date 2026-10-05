import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockerSandboxRunner } from "../../src/checks/docker-runner.js";
import { CodeBridgeError } from "../../src/errors.js";
import type { WorktreeSnapshot } from "../../src/snapshot/manager.js";
import { createFakeDocker, fixtureProfile, fixtureProject } from "./helpers.js";

function fixtureSnapshot(root: string): WorktreeSnapshot {
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

void test("DockerSandboxRunner creates, starts, redacts, and removes only its labeled container", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-docker-runner-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const docker = await createFakeDocker(root, { scenario: "run" });
  const project = fixtureProject(root, {
    executables: { git: "/usr/bin/git", docker: docker.executable },
  });
  const runner = new DockerSandboxRunner(project, fixtureSnapshot(root).sessionId);
  const result = await runner.run(fixtureProfile(), fixtureSnapshot(root), [], {
    signal: new AbortController().signal,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.cleanupFailed, false);
  assert.match(result.stdout, /REDACTED_OPENAI_KEY/);
  assert.doesNotMatch(result.stdout, /sk-proj-0123456789abcdefghijklmnopqrstuv/);
  await access(`${docker.statePath}.auto-removed`);
  const calls = (await readFile(docker.callsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["create", "start", "ps"],
  );
  assert.ok(calls[0]?.includes("--network") && calls[0].includes("none"));
  assert.ok(calls[0]?.includes("--user") && calls[0].includes("65532:65532"));
});

void test("DockerSandboxRunner refuses to remove a container whose ownership labels drift", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-docker-labels-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const docker = await createFakeDocker(root, { scenario: "wrong-labels" });
  const project = fixtureProject(root, {
    executables: { git: "/usr/bin/git", docker: docker.executable },
  });
  const result = await new DockerSandboxRunner(project, fixtureSnapshot(root).sessionId).run(
    fixtureProfile(),
    fixtureSnapshot(root),
    [],
    { signal: new AbortController().signal },
  );
  assert.equal(result.cleanupFailed, true);
  await assert.rejects(access(`${docker.statePath}.removed`));
});

void test("DockerSandboxRunner reports creation failures and fails closed on excessive output", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-docker-failure-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const docker = await createFakeDocker(root, { scenario: "create-fails" });
  const project = fixtureProject(root, {
    executables: { git: "/usr/bin/git", docker: docker.executable },
  });
  await assert.rejects(
    new DockerSandboxRunner(project, fixtureSnapshot(root).sessionId).run(
      fixtureProfile(),
      fixtureSnapshot(root),
      [],
      { signal: new AbortController().signal },
    ),
    { code: "SANDBOX_START_FAILED" },
  );
  const noisyDocker = await createFakeDocker(root, { scenario: "large-output" });
  const noisyProject = fixtureProject(root, {
    executables: { git: "/usr/bin/git", docker: noisyDocker.executable },
  });
  await assert.rejects(
    new DockerSandboxRunner(noisyProject, fixtureSnapshot(root).sessionId).run(
      fixtureProfile(),
      fixtureSnapshot(root),
      [],
      { signal: new AbortController().signal },
    ),
    { code: "SANDBOX_LIMIT_UNAVAILABLE" },
  );
});

void test("DockerSandboxRunner enforces its wall-clock limit and propagates cancellation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-docker-timeout-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const docker = await createFakeDocker(root, { scenario: "sleep" });
  const project = fixtureProject(root, {
    executables: { git: "/usr/bin/git", docker: docker.executable },
  });
  await assert.rejects(
    new DockerSandboxRunner(project, fixtureSnapshot(root).sessionId).run(
      fixtureProfile({ timeoutSeconds: 1 }),
      fixtureSnapshot(root),
      [],
      { signal: new AbortController().signal },
    ),
    { code: "RUN_TIMEOUT" },
  );

  const controller = new AbortController();
  const run = new DockerSandboxRunner(project, fixtureSnapshot(root).sessionId).run(
    fixtureProfile(),
    fixtureSnapshot(root),
    [],
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof CodeBridgeError);
    assert.equal(error.code, "RUN_CANCELLED");
    return true;
  });
});
