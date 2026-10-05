import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  chmod,
  lstat,
  link,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  discoverRepository,
  createProjectConfig,
  resolveAdditionalGitMetadata,
} from "../../src/config/project.js";
import { ConfigStore } from "../../src/config/store.js";
import type { ProjectConfig } from "../../src/config/schema.js";
import { CodeBridgeError } from "../../src/errors.js";

function projectConfig(projectId = "cb-0123456789abcdef"): ProjectConfig {
  return {
    version: 1,
    project: {
      id: projectId,
      canonicalWorktreeRoot: "/tmp/example-project",
      approvedGitMetadataRoots: [],
      approvedRequirementPaths: [],
    },
    runtime: { nodeMajor: 24 },
    executables: { git: "/usr/bin/git", docker: null },
    limits: {
      maxSnapshotBytes: 512 * 1024 * 1024,
      maxFiles: 50_000,
      maxSingleReadableFileBytes: 2 * 1024 * 1024,
      maxSecretScanBytes: 10 * 1024 * 1024,
      maxReadResponseBytes: 512 * 1024,
      maxSearchResults: 200,
      maxConcurrentReads: 8,
      maxConcurrentChecks: 1,
      maxQueuedChecks: 4,
      maxRetainedOutputBytes: 2 * 1024 * 1024,
    },
    sandbox: {
      memoryMb: 2048,
      cpus: 2,
      pids: 128,
      timeoutSeconds: 600,
      writableWorkspaceMb: 2048,
      tmpMb: 256,
      homeMb: 64,
      nofileSoft: 1024,
      nofileHard: 1024,
    },
    checks: [],
  };
}

void test("ConfigStore creates private directories and exact 0600 project files", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-config-"));
  context.after(async () => rm(base, { recursive: true, force: true }));
  const store = new ConfigStore(join(base, "state"));
  await store.saveProject(projectConfig());
  const stateInfo = await lstat(store.root);
  const projectFile = join(store.root, "projects", "cb-0123456789abcdef.json");
  const fileInfo = await lstat(projectFile);
  assert.equal(stateInfo.mode & 0o777, 0o700);
  assert.equal(fileInfo.mode & 0o777, 0o600);
  assert.equal((await store.loadProject("cb-0123456789abcdef")).project.id, "cb-0123456789abcdef");
});

void test("ConfigStore rejects malformed config and state files with unsafe permissions", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-config-"));
  context.after(async () => rm(base, { recursive: true, force: true }));
  const store = new ConfigStore(join(base, "state"));
  await store.saveProject(projectConfig());
  const projectFile = join(store.root, "projects", "cb-0123456789abcdef.json");

  await writeFile(projectFile, "{ malformed", { mode: 0o600 });
  await chmod(projectFile, 0o600);
  await assert.rejects(store.loadProject("cb-0123456789abcdef"), (error: unknown) => {
    assert.ok(error instanceof CodeBridgeError);
    assert.equal(error.code, "CONFIG_INVALID");
    return true;
  });

  await writeFile(projectFile, JSON.stringify(projectConfig()), { mode: 0o622 });
  await chmod(projectFile, 0o622);
  await assert.rejects(store.loadProject("cb-0123456789abcdef"), (error: unknown) => {
    assert.ok(error instanceof CodeBridgeError);
    assert.equal(error.code, "CONFIG_PERMISSION_UNSAFE");
    return true;
  });
});

void test("ConfigStore keeps each running process bound to the project it loaded", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-config-"));
  context.after(async () => rm(base, { recursive: true, force: true }));
  const store = new ConfigStore(join(base, "state"));
  await store.saveProject(projectConfig("cb-0123456789abcdef"));
  await store.saveProject(projectConfig("cb-fedcba9876543210"));
  await store.selectProject("cb-0123456789abcdef");
  const processBinding = await store.loadActiveProject();
  await store.selectProject("cb-fedcba9876543210");
  assert.equal(processBinding.project.project.id, "cb-0123456789abcdef");
  assert.equal((await store.loadActiveProject()).project.project.id, "cb-fedcba9876543210");
});

void test("ConfigStore rejects a group/world-accessible authorization directory", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-config-"));
  context.after(async () => rm(base, { recursive: true, force: true }));
  const state = join(base, "state");
  await mkdir(state, { mode: 0o755 });
  await chmod(state, 0o755);
  const store = new ConfigStore(state);
  await assert.rejects(store.initialize(), (error: unknown) => {
    assert.ok(error instanceof CodeBridgeError);
    assert.equal(error.code, "CONFIG_PERMISSION_UNSAFE");
    return true;
  });
});

void test("ConfigStore rejects hardlinked authorization files and cleanup never chmods an outside alias", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-config-link-"));
  const store = new ConfigStore(join(base, "state"));
  context.after(async () => rm(base, { recursive: true, force: true }));
  const project = projectConfig();
  await store.saveProject(project);
  const configPath = join(store.root, "projects", `${project.project.id}.json`);
  const configAlias = join(base, "config-alias.json");
  await link(configPath, configAlias);
  await assert.rejects(store.loadProject(project.project.id), { code: "CONFIG_PERMISSION_UNSAFE" });

  const sessionId = "00000000-0000-4000-8000-000000000000";
  const sessionRoot = await store.createOwnedSessionDirectory(sessionId);
  const shared = join(sessionRoot, "shared.txt");
  const alias = join(base, "outside-alias.txt");
  await writeFile(shared, "same-user alias\n", { mode: 0o644 });
  await link(shared, alias);
  await assert.rejects(store.removeOwnedSessionDirectory(sessionId), {
    code: "CONFIG_PERMISSION_UNSAFE",
  });
  assert.equal((await lstat(alias)).mode & 0o777, 0o644);
});

void test("linked worktree metadata paths are discovered without reading unapproved external metadata", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-linked-worktree-"));
  context.after(async () => rm(base, { recursive: true, force: true }));
  const worktree = join(base, "worktree");
  const gitDirectory = join(base, "repo.git", "worktrees", "topic");
  const commonDirectory = join(base, "repo.git");
  await mkdir(worktree);
  await mkdir(gitDirectory, { recursive: true });
  await writeFile(join(worktree, ".git"), `gitdir: ${gitDirectory}\n`);
  await writeFile(join(gitDirectory, "commondir"), "../..\n");

  const canonicalGitDirectory = await realpath(gitDirectory);
  const canonicalCommonDirectory = await realpath(commonDirectory);
  const discovery = await discoverRepository(worktree);
  assert.deepEqual(discovery.externalMetadataRoots, [canonicalGitDirectory]);
  await assert.rejects(resolveAdditionalGitMetadata(discovery, []), (error: unknown) => {
    assert.ok(error instanceof CodeBridgeError);
    assert.equal(error.code, "CONFIG_INVALID");
    return true;
  });
  const approved = await resolveAdditionalGitMetadata(discovery, [canonicalGitDirectory]);
  assert.ok(approved.externalMetadataRoots.includes(canonicalGitDirectory));
  assert.ok(approved.externalMetadataRoots.includes(canonicalCommonDirectory));
  assert.deepEqual(await readFile(join(gitDirectory, "commondir"), "utf8"), "../..\n");
});

void test("project config cannot be created while any external Git metadata root lacks exact approval", async () => {
  const externalRoot = "/tmp/private/git-metadata";
  const discovery = {
    worktreeRoot: "/tmp/worktree",
    gitDirectory: externalRoot,
    commonGitDirectory: externalRoot,
    metadataRoots: [externalRoot],
    externalMetadataRoots: [externalRoot],
    requirementCandidates: [],
    checkCandidates: [],
  };
  await assert.rejects(createProjectConfig(discovery, []), (error: unknown) => {
    assert.ok(error instanceof CodeBridgeError);
    assert.equal(error.code, "CONFIG_INVALID");
    return true;
  });
});

void test("ConfigStore cleanup classifies only dead owner processes as stale", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-stale-sessions-"));
  const store = new ConfigStore(join(base, "state"));
  context.after(async () => rm(base, { recursive: true, force: true }));
  const exitedProcess = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const ownerPid = exitedProcess.pid;
  await new Promise<void>((resolve, reject) => {
    exitedProcess.once("error", reject);
    exitedProcess.once("close", () => resolve());
  });
  assert.ok(ownerPid);
  const staleSession = "00000000-0000-4000-8000-000000000301";
  const liveSession = "00000000-0000-4000-8000-000000000302";
  await store.createOwnedSessionDirectory(staleSession, ownerPid);
  await store.createOwnedSessionDirectory(liveSession, process.pid);
  assert.deepEqual(await store.listStaleOwnedSessionDirectories(), [staleSession]);
  assert.deepEqual(await store.listOwnedSessionDirectories(), [liveSession, staleSession].sort());
});
