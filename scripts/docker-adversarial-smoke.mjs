import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { ConfigStore } from "../dist/src/config/store.js";
import { SnapshotManager } from "../dist/src/snapshot/manager.js";
import { DockerSandboxRunner } from "../dist/src/checks/docker-runner.js";
import { CheckReadinessService } from "../dist/src/checks/readiness.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const maliciousFixture = join(
  repositoryRoot,
  "fixtures",
  "fixture-malicious-tests",
  "test_sandbox.test.mjs",
);
const imageReference = process.env["CODEBRIDGE_TEST_IMAGE"] ?? "codebridge-adversarial:ci";
const docker = process.env["CODEBRIDGE_DOCKER"] ?? "docker";

function projectConfig(root, dockerPath) {
  return {
    version: 1,
    project: {
      id: "cb-0123456789abcdef",
      canonicalWorktreeRoot: root,
      approvedGitMetadataRoots: [],
      approvedRequirementPaths: [],
    },
    runtime: { nodeMajor: 24 },
    executables: { git: "/usr/bin/git", docker: dockerPath },
    limits: {
      maxSnapshotBytes: 16 * 1024 * 1024,
      maxFiles: 1000,
      maxSingleReadableFileBytes: 1024 * 1024,
      maxSecretScanBytes: 1024 * 1024,
      maxReadResponseBytes: 4096,
      maxSearchResults: 20,
      maxConcurrentReads: 2,
      maxConcurrentChecks: 1,
      maxQueuedChecks: 2,
      maxRetainedOutputBytes: 1024 * 1024,
    },
    sandbox: {
      memoryMb: 256,
      cpus: 1,
      pids: 32,
      timeoutSeconds: 30,
      writableWorkspaceMb: 16,
      tmpMb: 8,
      homeMb: 8,
      nofileSoft: 64,
      nofileHard: 64,
    },
    checks: [],
  };
}

function profile(imageDigest, overrides = {}) {
  return {
    id: "node.test.sandbox-adversarial",
    adapter: "node-test",
    imageDigest,
    executable: "/usr/local/bin/node",
    fixedArgs: ["--test", "test_sandbox.test.mjs"],
    targetMode: "none",
    allowedTargetSuffixes: [],
    allowedTargetPaths: [],
    timeoutSeconds: 30,
    stdoutLimitBytes: 128 * 1024,
    stderrLimitBytes: 128 * 1024,
    environmentAllowlist: [],
    workingDirectory: "/workspace",
    dependencyMode: "image-contained",
    enabled: true,
    ...overrides,
  };
}

const imageDigest = execFileSync(
  docker,
  ["image", "inspect", "--format", "{{.Id}}", imageReference],
  { encoding: "utf8" },
).trim();
assert.match(imageDigest, /^sha256:[a-f0-9]{64}$/);
const dockerPath = execFileSync("which", [docker], { encoding: "utf8" }).trim();
const workspace = await mkdtemp(join(tmpdir(), "codebridge-docker-security-"));
const repository = join(workspace, "repository");
const state = join(workspace, "state");
await Promise.all([mkdir(repository), mkdir(state, { mode: 0o700 })]);
await cp(maliciousFixture, join(repository, "test_sandbox.test.mjs"));

const hostSecret = "host-secret-canary-must-not-cross-into-the-container";
const hostSecretKey = "CODEBRIDGE_HOST_SECRET_CANARY";
const project = projectConfig(await realpath(repository), dockerPath);
const sessionId = randomUUID();
const snapshotId = randomUUID();

try {
  const store = new ConfigStore(state);
  await store.initialize();
  const snapshot = await new SnapshotManager(project, store).create({ sessionId, snapshotId });
  const snapshotFile = join(snapshot.root, "test_sandbox.test.mjs");
  const beforeDigest = createHash("sha256")
    .update(await readFile(snapshotFile))
    .digest("hex");
  process.env[hostSecretKey] = hostSecret;
  const imageProfile = profile(imageDigest);
  project.checks = [imageProfile];
  const readiness = new CheckReadinessService(project, snapshot);
  const ready = await readiness.assertReady(imageProfile.id, []);
  assert.equal(ready.profile.imageDigest, imageDigest);
  const runner = new DockerSandboxRunner(project, sessionId);
  const result = await runner.run(imageProfile, snapshot, [], {
    signal: new globalThis.AbortController().signal,
  });
  assert.equal(result.exitCode, 0, result.stderr + "\n" + result.stdout);
  assert.equal(result.cleanupFailed, false);
  assert.ok(!result.stdout.includes("not ok"), result.stdout);
  assert.equal(
    createHash("sha256")
      .update(await readFile(snapshotFile))
      .digest("hex"),
    beforeDigest,
    "the check must not modify its captured source",
  );

  const outputProfile = profile(imageDigest, {
    id: "node.test.output-redaction",
    fixedArgs: ["-e", "process.stdout.write('sk-proj-0123456789abcdefghijklmnopqrstuv')"],
  });
  const output = await runner.run(outputProfile, snapshot, [], {
    signal: new globalThis.AbortController().signal,
  });
  assert.equal(output.exitCode, 0);
  assert.match(output.stdout, /\[REDACTED_[A-Z_]+\]/);
  assert.doesNotMatch(output.stdout, /sk-proj-0123456789/);

  const timeoutProfile = profile(imageDigest, {
    id: "node.test.timeout",
    timeoutSeconds: 2,
    fixedArgs: ["-e", "setTimeout(() => {}, 30000)"],
  });
  await assert.rejects(
    runner.run(timeoutProfile, snapshot, [], { signal: new globalThis.AbortController().signal }),
    { code: "RUN_TIMEOUT" },
  );
  const remaining = execFileSync(
    docker,
    ["ps", "--all", "--filter", "label=io.codebridge.session=" + sessionId, "--format", "{{.ID}}"],
    { encoding: "utf8" },
  ).trim();
  assert.equal(remaining, "", "all smoke containers must be removed after success and timeout");

  process.stdout.write(
    "Docker adversarial smoke passed using immutable local image " + imageDigest + ".\n",
  );
} finally {
  delete process.env[hostSecretKey];
  const sessions = await storeSessions(state);
  for (const id of sessions) {
    const store = new ConfigStore(state);
    await store.removeOwnedSessionDirectory(id);
  }
  await rm(workspace, { recursive: true, force: true });
}

async function storeSessions(stateRoot) {
  const store = new ConfigStore(stateRoot);
  await store.initialize();
  return store.listOwnedSessionDirectories();
}
