import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import { ConfigStore } from "../dist/src/config/store.js";
import { approveRequirementPath } from "../dist/src/config/project.js";
import { createSessionContext } from "../dist/src/mcp/server.js";
import { fixtureProject } from "../dist/tests/checks/helpers.js";

const repository = await realpath(new URL("../", import.meta.url));
const docker = process.env["CODEBRIDGE_DOCKER"] ?? "docker";
const image = process.env["CODEBRIDGE_DRY_RUN_IMAGE"] ?? "codebridge-dry-run:ci";
const dockerPath = execFileSync("which", [docker], { encoding: "utf8" }).trim();
const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const imageDigest = execFileSync(docker, ["image", "inspect", "--format", "{{.Id}}", image], {
  encoding: "utf8",
}).trim();
assert.match(imageDigest, /^sha256:[a-f0-9]{64}$/);

const workspace = await mkdtemp(join(tmpdir(), "codebridge-real-repository-"));
const stateRoot = join(workspace, "state");
let store;
let context;

async function captureTree(root, skipGit = false) {
  const records = [];
  const walk = async (directory, prefix) => {
    for (const name of (await readdir(directory)).sort()) {
      if (!prefix && (name === "node_modules" || name === "dist" || name === "coverage")) continue;
      const path = join(directory, name);
      const relativePath = prefix ? prefix + "/" + name : name;
      const info = await lstat(path);
      if (info.isSymbolicLink()) records.push("L " + relativePath + " " + (await readlink(path)));
      else if (info.isDirectory()) {
        if (skipGit && !prefix && name === ".git") continue;
        records.push("D " + relativePath + " " + (info.mode & 0o777));
        await walk(path, relativePath);
      } else if (info.isFile()) {
        const digest = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
        records.push("F " + relativePath + " " + info.size + " " + digest);
      } else records.push("O " + relativePath);
    }
  };
  await walk(root, "");
  return createHash("sha256").update(records.sort().join("\n")).digest("hex");
}

async function runCheck(profileId) {
  const ready = await context.readiness.assertReady(profileId, []);
  const submitted = await context.jobs.submit(ready.profile, ready.targets);
  let status = submitted;
  const deadline = Date.now() + 120_000;
  while (
    !["completed", "failed", "timed_out", "cancelled", "cleanup_failed"].includes(status.state)
  ) {
    if (Date.now() >= deadline) throw new Error("CodeBridge check exceeded the dry-run deadline.");
    await delay(25);
    status = context.jobs.status(submitted.runId);
  }
  assert.equal(status.state, "completed", JSON.stringify(status));
  assert.equal(status.exitCode, 0);
  assert.equal(status.snapshotId, context.snapshot.snapshotId);
  assert.equal(status.truncated, false);
  return {
    state: status.state,
    exitCode: status.exitCode,
    stdoutBytes: Buffer.byteLength(status.stdout ?? ""),
  };
}

try {
  store = new ConfigStore(stateRoot);
  await store.initialize();
  const project = fixtureProject(repository, {
    project: {
      id: "cb-0123456789abcdef",
      canonicalWorktreeRoot: repository,
      approvedGitMetadataRoots: [],
      approvedRequirementPaths: [],
    },
    executables: { git: gitPath, docker: dockerPath },
    limits: {
      maxSnapshotBytes: 256 * 1024 * 1024,
      maxFiles: 10_000,
      maxSingleReadableFileBytes: 10 * 1024 * 1024,
      maxSecretScanBytes: 10 * 1024 * 1024,
      maxReadResponseBytes: 512 * 1024,
      maxSearchResults: 200,
      maxConcurrentReads: 8,
      maxConcurrentChecks: 1,
      maxQueuedChecks: 4,
      maxRetainedOutputBytes: 1024 * 1024,
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
  });
  const requirement = await approveRequirementPath(project, "CODEBRIDGE_SPEC.md");
  const targetedProfile = {
    id: "python.launcher.targeted",
    adapter: "pytest",
    imageDigest,
    executable: "/usr/bin/python3",
    fixedArgs: [
      "-m",
      "pytest",
      "-q",
      "sandbox/test_launcher.py::LauncherTests::test_copies_regular_files_into_workspace_and_preserves_executable_bits",
    ],
    targetMode: "none",
    allowedTargetSuffixes: [],
    allowedTargetPaths: [],
    timeoutSeconds: 60,
    stdoutLimitBytes: 128 * 1024,
    stderrLimitBytes: 128 * 1024,
    environmentAllowlist: [],
    workingDirectory: "/workspace",
    dependencyMode: "image-contained",
    enabled: true,
  };
  const fullProfile = {
    ...targetedProfile,
    id: "python.launcher.full",
    fixedArgs: ["-m", "pytest", "-q", "sandbox"],
  };
  project.project.approvedRequirementPaths = [requirement];
  project.checks = [targetedProfile, fullProfile];
  await store.saveProject(project);
  await store.selectProject(project.project.id);

  const gitMetadataBefore = await captureTree(join(repository, ".git"));
  const sourceBefore = await captureTree(repository, true);
  const startedAt = Date.now();
  context = await createSessionContext(project, store);
  assert.match(context.snapshot.snapshotId, /^[a-f0-9-]{36}$/);
  assert.match(context.snapshot.manifestSha256, /^[a-f0-9]{64}$/);

  const status = await context.git.status();
  assert.ok(["clean", "partially-observed"].includes(status.workingTree));
  assert.equal(status.stagedChanges.length, 0);
  assert.equal(status.modifiedPaths.length, 0);
  assert.equal(status.deletedPaths.length, 0);
  assert.equal(status.untrackedPaths.length, 0);
  if (status.workingTree === "partially-observed") {
    assert.ok(
      status.unavailablePaths.length > 0 ||
        context.snapshot.entries.some((entry) => entry.type === "blocked"),
    );
  }
  assert.equal(status.snapshotId, context.snapshot.snapshotId);
  const tree = context.reader.tree({ path: ".", depth: 4, maxEntries: 2000 });
  assert.ok(tree.items.some((entry) => entry.path === "src/git/mirror.ts"));
  const paths = context.reader.findPaths({ pattern: "**/*.ts", maxResults: 20 });
  assert.ok(paths.items.some((entry) => entry.path === "src/mcp/server.ts"));
  const search = await context.reader.search({
    query: "createGitMirror",
    paths: ["src/**/*.ts"],
    maxResults: 20,
  });
  assert.ok(search.items.some((entry) => entry.path === "src/git/mirror.ts"));
  const approvedText = await context.reader.readFile({ path: "CODEBRIDGE_SPEC.md" });
  assert.equal(approvedText.sha256, requirement.approvedSha256);
  const injection = await context.reader.readFile({
    path: "fixtures/fixture-prompt-injection/README.md",
  });
  assert.equal(injection.sourceTrust, "untrusted_repository_content");
  const head = context.mirror.headSha;
  assert.ok(head);
  const history = await context.git.log(5);
  assert.ok(history.some((entry) => entry.sha === head));
  const historicalSource = await context.git.show({ revision: head, path: "src/git/mirror.ts" });
  assert.equal(historicalSource.sourceTrust, "untrusted_repository_content");
  assert.equal((await context.git.diff({ mode: "audit-working-tree" })).diff, "");

  const checks = [];
  checks.push(await runCheck(targetedProfile.id));
  checks.push(await runCheck(fullProfile.id));
  assert.equal(await captureTree(repository, true), sourceBefore);
  assert.equal(await captureTree(join(repository, ".git")), gitMetadataBefore);
  await context.jobs.close();
  process.stdout.write(
    JSON.stringify({
      snapshotId: context.snapshot.snapshotId,
      manifestSha256: context.snapshot.manifestSha256,
      headSha: head,
      branch: context.mirror.branch,
      workingTree: status.workingTree,
      approvedRequirementSha256: requirement.approvedSha256,
      gitMirrorSha256: context.mirror.mirrorSha256,
      indexSha256: context.mirror.indexSha256,
      checkImageDigest: imageDigest,
      checks,
      elapsedMs: Date.now() - startedAt,
      liveRepositoryUnchanged: true,
      liveGitMetadataUnchanged: true,
      promptInjectionTrust: injection.sourceTrust,
    }) + "\n",
  );
} finally {
  await context?.jobs.close();
  if (context && store) {
    await store.removeOwnedSessionDirectory(context.snapshot.sessionId).catch(() => undefined);
  }
  await rm(workspace, { recursive: true, force: true });
}
