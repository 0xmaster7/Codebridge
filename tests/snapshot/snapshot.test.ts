import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProjectConfig } from "../../src/config/schema.js";
import { ConfigStore } from "../../src/config/store.js";
import { SnapshotManager } from "../../src/snapshot/manager.js";

function projectConfig(root: string): ProjectConfig {
  return {
    version: 1,
    project: {
      id: "cb-0123456789abcdef",
      canonicalWorktreeRoot: root,
      approvedGitMetadataRoots: [],
      approvedRequirementPaths: [],
    },
    runtime: { nodeMajor: 24 },
    executables: { git: "/usr/bin/git", docker: null },
    limits: {
      maxSnapshotBytes: 1024 * 1024,
      maxFiles: 100,
      maxSingleReadableFileBytes: 1024,
      maxSecretScanBytes: 1024,
      maxReadResponseBytes: 512,
      maxSearchResults: 20,
      maxConcurrentReads: 2,
      maxConcurrentChecks: 1,
      maxQueuedChecks: 2,
      maxRetainedOutputBytes: 1024,
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

void test("snapshot copies safe files immutably and records symlink, hardlink, and secret metadata", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-snapshot-"));
  const store = new ConfigStore(join(base, "state"));
  context.after(async () => {
    for (const id of await store.listOwnedSessionDirectories())
      await store.removeOwnedSessionDirectory(id);
    await rm(base, { recursive: true, force: true });
  });
  const repository = join(base, "repo");
  await mkdir(repository);
  await mkdir(join(repository, "src"));
  await writeFile(join(repository, "src", "safe.ts"), "export const answer = 42;\n");
  await writeFile(join(repository, "src", "secret.ts"), "const api_key = 'not-for-model-12345';\n");
  await writeFile(join(repository, "src", "shared.ts"), "linked file\n");
  await link(join(repository, "src", "shared.ts"), join(repository, "src", "hardlink.ts"));
  await symlink("../.env", join(repository, "src", "secret-link"));
  await writeFile(join(repository, ".env"), "private environment value\n");

  const canonicalRoot = await realpath(repository);
  const project = projectConfig(canonicalRoot);
  const snapshot = await new SnapshotManager(project, store).create();
  const entries = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
  assert.equal(entries.get("src/safe.ts")?.type, "file");
  assert.equal(entries.get("src/secret.ts")?.reason, "SECRET_CONTENT");
  assert.equal(entries.get("src/shared.ts")?.reason, "HARDLINK_BLOCKED");
  assert.equal(entries.get("src/hardlink.ts")?.reason, "HARDLINK_BLOCKED");
  assert.equal(entries.get(".env")?.type, "blocked");
  assert.equal(entries.get("src/secret-link")?.type, "blocked");
  const snapshotFile = join(snapshot.root, "src", "safe.ts");
  assert.equal(await readFile(snapshotFile, "utf8"), "export const answer = 42;\n");
  await writeFile(join(repository, "src", "safe.ts"), "changed after capture\n");
  assert.equal(await readFile(snapshotFile, "utf8"), "export const answer = 42;\n");
  const manifest = await readFile(join(snapshot.root, "..", "manifest.json"));
  assert.equal(createHash("sha256").update(manifest).digest("hex"), snapshot.manifestSha256);
  assert.equal((await lstat(snapshotFile)).nlink, 1);
});

void test("snapshot rejects a root whose canonical identity differs from approval", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-snapshot-"));
  context.after(async () => rm(base, { recursive: true, force: true }));
  const repository = join(base, "repo");
  const alias = join(base, "alias");
  await mkdir(repository);
  await writeFile(join(repository, "file.txt"), "safe\n");
  await symlink(repository, alias);
  const project = projectConfig(alias);
  const manager = new SnapshotManager(project, new ConfigStore(join(base, "state")));
  await assert.rejects(manager.create(), { code: "OUTSIDE_ROOT" });
});

void test("snapshot applies root and nested pure-library Git ignore rules", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-ignore-"));
  const store = new ConfigStore(join(base, "state"));
  context.after(async () => {
    for (const id of await store.listOwnedSessionDirectories())
      await store.removeOwnedSessionDirectory(id);
    await rm(base, { recursive: true, force: true });
  });
  const repository = join(base, "repo");
  await mkdir(join(repository, "nested"), { recursive: true });
  await mkdir(join(repository, "generated"), { recursive: true });
  await mkdir(join(repository, "submodule"), { recursive: true });
  await writeFile(join(repository, ".gitignore"), "*.log\n!keep.log\n/generated/\n");
  await writeFile(join(repository, "nested", ".gitignore"), "*.tmp\n");
  await writeFile(join(repository, "hidden.log"), "hidden\n");
  await writeFile(join(repository, "keep.log"), "included\n");
  await writeFile(join(repository, "visible.txt"), "visible\n");
  await writeFile(join(repository, "nested", "ignored.tmp"), "hidden nested\n");
  await writeFile(join(repository, "nested", "visible.txt"), "visible nested\n");
  await writeFile(join(repository, "generated", "bundle.js"), "generated\n");
  await writeFile(join(repository, "generated", "tracked.py"), "tracked despite ignore\n");
  await writeFile(join(repository, "submodule", "unapproved.py"), "submodule content\n");

  const snapshot = await new SnapshotManager(
    projectConfig(await realpath(repository)),
    store,
  ).create({
    trackedPaths: [".gitignore", "hidden.log", "generated/tracked.py", "submodule"],
    submodulePaths: ["submodule"],
  });
  const paths = new Set(snapshot.entries.map((entry) => entry.path));
  assert.ok(paths.has(".gitignore"));
  assert.ok(paths.has("keep.log"));
  assert.ok(paths.has("visible.txt"));
  assert.ok(paths.has("nested/visible.txt"));
  assert.ok(paths.has("hidden.log"));
  assert.ok(!paths.has("nested/ignored.tmp"));
  assert.ok(!paths.has("generated/bundle.js"));
  assert.ok(paths.has("generated/tracked.py"));
  assert.equal(
    snapshot.entries.find((entry) => entry.path === "submodule")?.reason,
    "SUBMODULE_NOT_APPROVED",
  );
  assert.ok(!paths.has("submodule/unapproved.py"));
});

void test("snapshot fails closed on malformed UTF-8 ignore metadata", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-ignore-"));
  const store = new ConfigStore(join(base, "state"));
  context.after(async () => {
    for (const id of await store.listOwnedSessionDirectories())
      await store.removeOwnedSessionDirectory(id);
    await rm(base, { recursive: true, force: true });
  });
  const repository = join(base, "repo");
  await mkdir(repository);
  await writeFile(join(repository, ".gitignore"), Buffer.from([0xff, 0xfe]));
  const manager = new SnapshotManager(projectConfig(await realpath(repository)), store);
  await assert.rejects(manager.create(), { code: "SNAPSHOT_FAILED" });
});
