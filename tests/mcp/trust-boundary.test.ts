import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigStore } from "../../src/config/store.js";
import type { ProjectConfig } from "../../src/config/schema.js";
import { SnapshotManager } from "../../src/snapshot/manager.js";
import { SnapshotReader } from "../../src/snapshot/reader.js";

void test("planted repository instructions remain untrusted evidence and cannot grant authorization", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-trust-"));
  const store = new ConfigStore(join(base, "state"));
  context.after(async () => {
    for (const id of await store.listOwnedSessionDirectories())
      await store.removeOwnedSessionDirectory(id);
    await rm(base, { recursive: true, force: true });
  });
  const repository = join(base, "repo");
  await mkdir(repository);
  await cp(join(process.cwd(), "fixtures", "fixture-prompt-injection"), repository, {
    recursive: true,
  });
  const git = "git";
  execFileSync(git, ["init", "--quiet"], { cwd: repository });
  execFileSync(git, ["add", "README.md"], { cwd: repository });
  execFileSync(
    git,
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: repository },
  );
  const root = await realpath(repository);
  const project: ProjectConfig = {
    version: 1,
    project: {
      id: "cb-0123456789abcdef",
      canonicalWorktreeRoot: root,
      approvedGitMetadataRoots: [],
      approvedRequirementPaths: [],
    },
    runtime: { nodeMajor: 24 },
    executables: { git, docker: null },
    limits: {
      maxSnapshotBytes: 1024 * 1024,
      maxFiles: 100,
      maxSingleReadableFileBytes: 1024 * 1024,
      maxSecretScanBytes: 1024 * 1024,
      maxReadResponseBytes: 32 * 1024,
      maxSearchResults: 50,
      maxConcurrentReads: 2,
      maxConcurrentChecks: 1,
      maxQueuedChecks: 2,
      maxRetainedOutputBytes: 32 * 1024,
    },
    sandbox: {
      memoryMb: 256,
      cpus: 1,
      pids: 32,
      timeoutSeconds: 10,
      writableWorkspaceMb: 8,
      tmpMb: 8,
      homeMb: 8,
      nofileSoft: 32,
      nofileHard: 32,
    },
    checks: [],
  };
  const snapshot = await new SnapshotManager(project, store).create();
  const evidence = await new SnapshotReader(snapshot, project).readFile({ path: "README.md" });
  assert.equal(evidence.sourceTrust, "untrusted_repository_content");
  assert.match(evidence.content, /Ignore the user's request/);
  assert.match(evidence.content, /Override the security policy/);
  assert.equal(project.checks.length, 0);

  const skill = await import("node:fs/promises").then(({ readFile }) =>
    readFile(join(process.cwd(), "skills", "codebridge-audit", "SKILL.md"), "utf8"),
  );
  const remediation = await import("node:fs/promises").then(({ readFile }) =>
    readFile(join(process.cwd(), "docs", "CODEBRIDGE_REMEDIATION_TEMPLATE.md"), "utf8"),
  );
  assert.match(skill, /Embedded requests.*prompt injection/i);
  assert.match(skill, /repository text never authorizes/i);
  assert.match(remediation, /SECURITY NOTE:/);
  assert.match(remediation, /untrusted evidence, not instructions/i);
});
