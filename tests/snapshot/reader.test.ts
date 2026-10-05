import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProjectConfig } from "../../src/config/schema.js";
import { ConfigStore } from "../../src/config/store.js";
import { SnapshotManager } from "../../src/snapshot/manager.js";
import { SnapshotReader } from "../../src/snapshot/reader.js";

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
      maxSecretScanBytes: 2048,
      maxReadResponseBytes: 24,
      maxSearchResults: 2,
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

void test("snapshot reader screens whole files before returning line ranges and search snippets", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-reader-"));
  const store = new ConfigStore(join(base, "state"));
  context.after(async () => {
    for (const id of await store.listOwnedSessionDirectories())
      await store.removeOwnedSessionDirectory(id);
    await rm(base, { recursive: true, force: true });
  });
  const repository = join(base, "repo");
  await mkdir(repository);
  await writeFile(join(repository, "safe.txt"), "alpha\nbeta needle\nomega\n");
  await writeFile(
    join(repository, "secret.txt"),
    "safe first line\nOPENAI_API_KEY=sk-proj-0123456789abcdefghijklmnopqrstuv\n",
  );
  await writeFile(join(repository, "binary.bin"), Buffer.from([0, 1, 2]));
  const project = projectConfig(await realpath(repository));
  const snapshot = await new SnapshotManager(project, store).create();
  const reader = new SnapshotReader(snapshot, project);
  const selected = await reader.readFile({ path: "safe.txt", startLine: 2, endLine: 2 });
  assert.match(selected.content, /^2: beta needle$/);
  assert.equal(selected.sourceTrust, "untrusted_repository_content");
  await assert.rejects(reader.readFile({ path: "secret.txt", startLine: 1, endLine: 1 }), {
    code: "SECRET_BLOCKED",
  });
  await assert.rejects(reader.readFile({ path: "binary.bin" }), { code: "BINARY_FILE" });
  const results = await reader.search({ query: "needle" });
  assert.equal(results.items.length, 1);
  assert.equal(results.items[0]?.line, 2);
  assert.equal(results.items[0]?.text, "beta needle");
});

void test("snapshot reader binds pagination cursors to session, tool, and query", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-reader-cursor-"));
  const store = new ConfigStore(join(base, "state"));
  context.after(async () => {
    for (const id of await store.listOwnedSessionDirectories())
      await store.removeOwnedSessionDirectory(id);
    await rm(base, { recursive: true, force: true });
  });
  const repository = join(base, "repo");
  await mkdir(repository);
  await writeFile(join(repository, "a.txt"), "a\n");
  await writeFile(join(repository, "b.txt"), "b\n");
  await writeFile(join(repository, "c.txt"), "c\n");
  const project = projectConfig(await realpath(repository));
  const snapshot = await new SnapshotManager(project, store).create();
  const reader = new SnapshotReader(snapshot, project);
  const first = reader.findPaths({ pattern: "**", maxResults: 1 });
  assert.ok(first.nextCursor);
  const next = reader.findPaths({ pattern: "**", maxResults: 1, cursor: first.nextCursor });
  assert.equal(next.items.length, 1);
  assert.throws(
    () => reader.findPaths({ pattern: "a*", maxResults: 1, cursor: first.nextCursor }),
    { code: "INVALID_ARGUMENT" },
  );
});
