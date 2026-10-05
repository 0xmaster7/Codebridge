import assert from "node:assert/strict";
import test from "node:test";
import type { CheckProfile, ProjectConfig } from "../../src/config/schema.js";
import { buildDockerSandboxPlan } from "../../src/checks/docker-args.js";
import { validateTargets } from "../../src/checks/target-policy.js";
import type { WorktreeSnapshot } from "../../src/snapshot/manager.js";

function profile(overrides: Partial<CheckProfile> = {}): CheckProfile {
  return {
    id: "node.test.targeted",
    adapter: "node-test",
    imageDigest: `sha256:${"a".repeat(64)}`,
    executable: "/usr/bin/node",
    fixedArgs: ["--test"],
    targetMode: "paths",
    allowedTargetSuffixes: [".test.js"],
    allowedTargetPaths: [],
    timeoutSeconds: 60,
    stdoutLimitBytes: 4096,
    stderrLimitBytes: 4096,
    environmentAllowlist: [],
    workingDirectory: "/workspace",
    dependencyMode: "image-contained",
    enabled: true,
    ...overrides,
  };
}

function projectConfig(): ProjectConfig {
  return {
    version: 1,
    project: {
      id: "cb-0123456789abcdef",
      canonicalWorktreeRoot: "/tmp/fixture",
      approvedGitMetadataRoots: [],
      approvedRequirementPaths: [],
    },
    runtime: { nodeMajor: 24 },
    executables: { git: "/usr/bin/git", docker: "/usr/bin/docker" },
    limits: {
      maxSnapshotBytes: 1024 * 1024,
      maxFiles: 100,
      maxSingleReadableFileBytes: 1024,
      maxSecretScanBytes: 2048,
      maxReadResponseBytes: 1024,
      maxSearchResults: 20,
      maxConcurrentReads: 2,
      maxConcurrentChecks: 1,
      maxQueuedChecks: 2,
      maxRetainedOutputBytes: 8192,
    },
    sandbox: {
      memoryMb: 512,
      cpus: 1,
      pids: 64,
      timeoutSeconds: 60,
      writableWorkspaceMb: 64,
      tmpMb: 16,
      homeMb: 16,
      nofileSoft: 128,
      nofileHard: 128,
    },
    checks: [],
  };
}

const snapshot: WorktreeSnapshot = {
  sessionId: "session-test",
  snapshotId: "snapshot-test",
  root: "/tmp/state/sessions/session-test/worktree",
  createdAt: "2026-10-05T00:00:00.000Z",
  entries: [
    { path: "tests/sample.test.js", type: "file", size: 1, sha256: "a".repeat(64), mode: 0o644 },
  ],
  fileCount: 1,
  bytes: 1,
  manifestSha256: "b".repeat(64),
};

void test("Docker sandbox plan fixes non-root, offline, read-only, and bounded resources", () => {
  const plan = buildDockerSandboxPlan({
    project: projectConfig(),
    profile: profile(),
    snapshotRoot: snapshot.root,
    sessionId: snapshot.sessionId,
    targets: ["tests/sample.test.js"],
    runId: "12345678-1234-4234-8234-123456789012",
  });
  const args = plan.createArgs;
  const joined = args.join(" ");
  for (const required of [
    "--rm",
    "--network none",
    "--read-only",
    "--cap-drop ALL",
    "no-new-privileges",
    "--user 65532:65532",
    "--memory 512m",
    "--memory-swap 512m",
    "--cpus 1",
    "--pids-limit 64",
    "nofile=128:128",
    "core=0:0",
    "/workspace:rw,nosuid,nodev,size=64m,mode=700,uid=65532,gid=65532",
    "/tmp:rw,nosuid,nodev,size=16m,mode=700,uid=65532,gid=65532",
    "/home/cb:rw,nosuid,nodev,size=16m,mode=700,uid=65532,gid=65532",
    "dst=/source,readonly",
    "io.codebridge.session=session-test",
    "io.codebridge.managed=true",
    "--",
    "tests/sample.test.js",
  ]) {
    assert.ok(joined.includes(required), `missing ${required}`);
  }
  for (const forbidden of [
    "--privileged",
    "--network host",
    "--device",
    "--cap-add",
    "--env-file",
    "/var/run/docker.sock",
  ]) {
    assert.equal(joined.includes(forbidden), false, `unexpected ${forbidden}`);
  }
});

void test("target policy rejects command-like inputs, options, traversal, and non-allowlisted files", () => {
  const check = profile();
  for (const target of [
    "--help",
    "--config",
    "--exec",
    "../outside.test.js",
    "$(touch pwned).test.js",
    "`id`.test.js",
    "a;id.test.js",
    "a&&b.test.js",
    "a||b.test.js",
    "a|b.test.js",
    "a>b.test.js",
    "a>>b.test.js",
    "a<b.test.js",
    "a\nb.test.js",
    "a\rb.test.js",
    "/tmp/x.test.js",
  ]) {
    assert.throws(() => validateTargets([target], check, snapshot), {
      code: "INVALID_CHECK_TARGET",
    });
  }
  assert.throws(() => validateTargets(["README.md"], check, snapshot), {
    code: "INVALID_CHECK_TARGET",
  });
  assert.throws(() => validateTargets([], check, snapshot), { code: "INVALID_CHECK_TARGET" });
  assert.deepEqual(validateTargets(["tests/sample.test.js"], check, snapshot), [
    "tests/sample.test.js",
  ]);
});
