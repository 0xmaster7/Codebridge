import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CheckReadinessService } from "../../src/checks/readiness.js";
import { ConfigStore } from "../../src/config/store.js";
import { ApprovalRegistry } from "../../src/security/approval-registry.js";
import { SnapshotManager } from "../../src/snapshot/manager.js";
import { createFakeDocker, fixtureProfile, fixtureProject, fixtureDigest } from "./helpers.js";
import type { WorktreeSnapshot } from "../../src/snapshot/manager.js";

function emptySnapshot(root: string): WorktreeSnapshot {
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

void test("check readiness pins an immutable image ID and probes the adapter inside restrictions", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-readiness-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const { executable, callsPath } = await createFakeDocker(root);
  const profile = fixtureProfile();
  const project = fixtureProject(root, {
    executables: { git: "/usr/bin/git", docker: executable },
    checks: [profile],
  });
  const readiness = new CheckReadinessService(project, emptySnapshot(root));
  const listed = await readiness.list();
  assert.equal(listed[0]?.dependencyReadiness, "ready");
  assert.deepEqual(await readiness.assertReady(profile.id, []), { profile, targets: [] });
  const calls = (
    await import("node:fs/promises").then(({ readFile }) => readFile(callsPath, "utf8"))
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.ok(calls.some((args) => args[0] === "image" && args.includes(profile.imageDigest)));
  const probe = calls.find((args) => args[0] === "run") ?? [];
  assert.ok(probe.includes("none"));
  assert.ok(probe.includes("--read-only"));
  assert.ok(probe.includes("65532:65532"));
  assert.ok(probe.includes("--memory-swap"));
  assert.ok(probe.includes("--pids-limit"));
});

void test("check readiness distinguishes missing images, digest mismatch, secrets, and missing adapter dependencies", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-readiness-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const cases = [
    { name: "missing", scenario: "image-missing" as const, expected: "image-missing" },
    { name: "wrong digest", imageId: `sha256:${"b".repeat(64)}`, expected: "image-missing" },
    {
      name: "secret environment",
      imageEnv: ["PASSWORD=FAKE_FIXTURE_VALUE"],
      expected: "dependencies-not-ready",
    },
    {
      name: "missing adapter",
      scenario: "probe-fails" as const,
      expected: "dependencies-not-ready",
    },
  ];
  for (const [index, item] of cases.entries()) {
    const caseRoot = join(root, String(index));
    await mkdir(caseRoot);
    const docker = await createFakeDocker(caseRoot, {
      ...(item.scenario === undefined ? {} : { scenario: item.scenario }),
      ...(item.imageId === undefined ? {} : { imageId: item.imageId }),
      ...(item.imageEnv === undefined ? {} : { imageEnv: item.imageEnv }),
    });
    const profile = fixtureProfile();
    const project = fixtureProject(caseRoot, {
      executables: { git: "/usr/bin/git", docker: docker.executable },
      checks: [profile],
    });
    const result = await new CheckReadinessService(project, emptySnapshot(caseRoot)).list();
    assert.equal(result[0]?.dependencyReadiness, item.expected, item.name);
  }
});

void test("check readiness refuses unsafe working directories and disabled profiles", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-readiness-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const docker = await createFakeDocker(root);
  const unsafeProfile = fixtureProfile({ workingDirectory: "/etc" });
  const disabledProfile = fixtureProfile({ id: "python.disabled", enabled: false });
  const project = fixtureProject(root, {
    executables: { git: "/usr/bin/git", docker: docker.executable },
    checks: [unsafeProfile, disabledProfile],
  });
  const service = new CheckReadinessService(project, emptySnapshot(root));
  assert.equal((await service.list())[0]?.dependencyReadiness, "dependencies-not-ready");
  assert.equal((await service.list())[1]?.dependencyReadiness, "disabled");
  await assert.rejects(service.assertReady("python.unknown", []), { code: "CHECK_NOT_FOUND" });
  await assert.rejects(service.assertReady("python.disabled", []), { code: "CHECK_NOT_ALLOWED" });
});

void test("project-script approval is valid only for the exact captured manifest bytes", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-script-readiness-"));
  const store = new ConfigStore(join(base, "state"));
  context.after(async () => {
    for (const id of await store.listOwnedSessionDirectories())
      await store.removeOwnedSessionDirectory(id);
    await rm(base, { recursive: true, force: true });
  });
  const repository = join(base, "repo");
  await mkdir(repository);
  const manifestPath = join(repository, "package.json");
  const manifest = Buffer.from('{"scripts":{"test":"python -m pytest"}}\n');
  await writeFile(manifestPath, manifest);
  const root = await realpath(repository);
  const docker = await createFakeDocker(base);
  const approval = new ApprovalRegistry().approveScript(
    "package.json",
    manifest,
    "test",
    fixtureDigest,
    "codebridge-adapter-1",
  );
  const profile = fixtureProfile({
    id: "project.test",
    adapter: "project-script-sandboxed",
    fixedArgs: ["run", "test"],
    scriptApproval: approval,
  });
  const project = fixtureProject(root, {
    executables: { git: "/usr/bin/git", docker: docker.executable },
    checks: [profile],
  });
  const firstSnapshot = await new SnapshotManager(project, store).create();
  const first = new CheckReadinessService(project, firstSnapshot);
  assert.equal((await first.list())[0]?.approvalStatus, "approved");
  assert.deepEqual(await first.assertReady(profile.id, []), { profile, targets: [] });

  await writeFile(manifestPath, '{"scripts":{"test":"python -c hostile"}}\n');
  const secondSnapshot = await new SnapshotManager(project, store).create();
  const second = new CheckReadinessService(project, secondSnapshot);
  assert.equal((await second.list())[0]?.approvalStatus, "stale");
  await assert.rejects(second.assertReady(profile.id, []), { code: "CHECK_APPROVAL_STALE" });
});
