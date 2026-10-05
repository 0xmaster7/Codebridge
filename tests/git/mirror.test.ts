import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { dirname, isAbsolute, resolve } from "node:path";
import test from "node:test";
import type { ProjectConfig } from "../../src/config/schema.js";
import { createGitMirror } from "../../src/git/mirror.js";
import { ConfigStore } from "../../src/config/store.js";
import { SnapshotManager } from "../../src/snapshot/manager.js";
import { GitAudit } from "../../src/git/audit.js";

async function findGit(): Promise<string> {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "git");
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Try the next executable search path.
    }
  }
  throw new Error("Git was not found for fixture setup.");
}

function projectConfig(root: string, git: string): ProjectConfig {
  return {
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
      maxSnapshotBytes: 16 * 1024 * 1024,
      maxFiles: 1000,
      maxSingleReadableFileBytes: 1024,
      maxSecretScanBytes: 1024,
      maxReadResponseBytes: 512,
      maxSearchResults: 20,
      maxConcurrentReads: 2,
      maxConcurrentChecks: 1,
      maxQueuedChecks: 2,
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
    checks: [],
  };
}

async function createCommittedFixture(base: string, git: string, format?: "sha1" | "sha256") {
  const repository = join(base, "repository");
  const sessionRoot = join(base, "session");
  await mkdir(repository, { recursive: true });
  await mkdir(sessionRoot, { recursive: true });
  execFileSync(
    git,
    ["init", "--quiet", ...(format === "sha256" ? ["--object-format=sha256"] : [])],
    {
      cwd: repository,
    },
  );
  await writeFile(join(repository, "source.txt"), "fixture source\n");
  execFileSync(
    git,
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", "source.txt"],
    { cwd: repository },
  );
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
  return { repository, sessionRoot, project: projectConfig(await realpath(repository), git) };
}

async function createGitWrapper(
  root: string,
  realGit: string,
  mode: "format" | "malformed-index" | "unsafe-index",
) {
  const executable = join(root, `git-${mode}`);
  const indexOutput =
    mode === "malformed-index"
      ? "printf 'malformed\\000'; exit 0"
      : "printf '100644 0123456789012345678901234567890123456789 0\\t../escape\\000'; exit 0";
  const program =
    `#!/bin/sh\n` +
    `case " $* " in\n` +
    (mode === "format"
      ? `  *" --show-object-format "*) printf 'sha512\\n'; exit 0 ;;\n`
      : `  *" ls-files --stage -z "*) ${indexOutput} ;;\n`) +
    `esac\nexec '${realGit}' "$@"\n`;
  await writeFile(executable, program, { mode: 0o700 });
  return executable;
}

async function captureGitMetadata(root: string): Promise<string[]> {
  const records: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        records.push(`L ${relativePath} ${await readlink(path)}`);
      } else if (info.isDirectory()) {
        records.push(`D ${relativePath} ${info.mode & 0o777}`);
        await walk(path, relativePath);
      } else if (info.isFile()) {
        const digest = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
        records.push(`F ${relativePath} ${info.mode & 0o777} ${info.size} ${digest}`);
      } else {
        records.push(`O ${relativePath} ${info.mode & 0o777}`);
      }
    }
  };
  await walk(root, "");
  return records.sort();
}

void test("Git mirror is session-owned, reads captured history, and ignores live config and hooks", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-git-mirror-"));
  const store = new ConfigStore(join(base, "state"));
  context.after(async () => {
    for (const id of await store.listOwnedSessionDirectories())
      await store.removeOwnedSessionDirectory(id);
    await rm(base, { recursive: true, force: true });
  });
  const repository = join(base, "repository");
  const sessionRoot = join(base, "session");
  const hooks = join(base, "malicious-hooks");
  const marker = join(base, "hook-executed");
  await mkdir(repository);
  await mkdir(sessionRoot);
  await mkdir(hooks);
  const git = await findGit();
  const run = (args: string[]): void => {
    execFileSync(git, args, {
      cwd: repository,
      env: { PATH: "/usr/bin:/bin", HOME: base, GIT_CONFIG_NOSYSTEM: "1" },
      stdio: "pipe",
    });
  };
  run(["init", "--quiet"]);
  run(["config", "user.name", "Fixture Author"]);
  run(["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repository, "source.txt"), "captured source\n");
  run(["add", "source.txt"]);
  run(["commit", "--quiet", "-m", "fixture commit"]);
  const hook = join(hooks, "post-checkout");
  await writeFile(hook, `#!/bin/sh\nprintf executed > '${marker}'\n`);
  await chmod(hook, 0o700);
  run(["config", "core.hooksPath", hooks]);
  run(["config", "diff.external", `touch ${marker}`]);
  run(["config", "diff.evil.external", `touch ${marker}`]);
  run(["config", "filter.evil.smudge", `touch ${marker}`]);
  await writeFile(join(repository, ".gitattributes"), "*.txt diff=evil filter=evil\n");
  await writeFile(
    join(repository, "history-secret.txt"),
    "password='historical-private-value-12345'\n",
  );
  run(["add", ".gitattributes", "history-secret.txt"]);
  run(["commit", "--quiet", "-m", "historical secret fixture"]);
  run(["config", "core.fsmonitor", join(hooks, "post-checkout")]);
  await writeFile(join(repository, "source.txt"), "worktree modification\n");
  await writeFile(join(repository, "untracked.txt"), "new file\n");

  const gitMetadataBefore = await captureGitMetadata(join(repository, ".git"));
  const project = projectConfig(await realpath(repository), git);
  const snapshot = await new SnapshotManager(project, store).create();
  const mirror = await createGitMirror(project, dirname(snapshot.root), snapshot.sessionId);
  assert.ok(mirror.headSha);
  assert.equal(mirror.branch !== null, true);
  assert.equal(mirror.complete, true);
  assert.equal(mirror.objectFormat, "sha1");
  const log = await mirror.runner.run(["log", "-1", "--format=%s"]);
  assert.equal(log.stdout.trim(), "historical secret fixture");
  const audit = new GitAudit(project, snapshot, mirror, dirname(snapshot.root));
  const status = await audit.status();
  assert.deepEqual(status.modifiedPaths, ["source.txt"]);
  assert.deepEqual(status.untrackedPaths, ["untracked.txt"]);
  const diff = await audit.diff({ mode: "audit-working-tree" });
  assert.match(diff.diff, /worktree modification/);
  await assert.rejects(
    audit.show({
      revision: mirror.headSha ?? "",
      path: "history-secret.txt",
      startLine: 1,
      endLine: 1,
    }),
    { code: "SECRET_BLOCKED" },
  );
  assert.equal(
    await readFile(join(mirror.root, "config"), "utf8").then((text) => text.includes(hooks)),
    false,
  );
  assert.equal(
    await readFile(join(mirror.root, "config"), "utf8").then((text) =>
      text.includes("diff.external"),
    ),
    false,
  );
  assert.equal(
    await readFile(join(mirror.root, "objects", "info", "alternates"))
      .then(() => true)
      .catch(() => false),
    false,
  );
  assert.equal(
    await readFile(marker)
      .then(() => true)
      .catch(() => false),
    false,
  );
  assert.deepEqual(
    await captureGitMetadata(join(repository, ".git")),
    gitMetadataBefore,
    "live Git metadata changed during mirror creation or audit operations",
  );
  assert.equal(await readFile(join(repository, "source.txt"), "utf8"), "worktree modification\n");
});

void test("Git mirror rejects object alternates rather than resolving external objects", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-git-alternates-"));
  context.after(async () => rm(base, { recursive: true, force: true }));
  const repository = join(base, "repository");
  const sessionRoot = join(base, "session");
  await mkdir(repository);
  await mkdir(sessionRoot);
  const git = await findGit();
  execFileSync(git, ["init", "--quiet"], {
    cwd: repository,
    env: { PATH: "/usr/bin:/bin", HOME: base },
  });
  await mkdir(join(repository, ".git", "objects", "info"), { recursive: true });
  await writeFile(
    join(repository, ".git", "objects", "info", "alternates"),
    join(base, "external") + "\n",
  );
  await assert.rejects(
    createGitMirror(projectConfig(await realpath(repository), git), sessionRoot, "session-test"),
    { code: "UNSUPPORTED_GIT_LAYOUT" },
  );
});

void test("Git mirror rejects partial clones and unsafe metadata links", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-git-layout-"));
  context.after(async () => rm(base, { recursive: true, force: true }));
  const git = await findGit();
  for (const [name, prepare] of [
    [
      "partial-clone",
      (repository: string) =>
        execFileSync(git, ["config", "extensions.partialClone", "origin"], { cwd: repository }),
    ],
    [
      "object-symlink",
      async (repository: string) => {
        const outside = join(base, "outside-objects");
        await mkdir(outside);
        await symlink(outside, join(repository, ".git", "objects", "external"));
      },
    ],
  ] as const) {
    const repository = join(base, name);
    const sessionRoot = join(base, `${name}-session`);
    await mkdir(repository);
    await mkdir(sessionRoot);
    execFileSync(git, ["init", "--quiet"], { cwd: repository });
    await writeFile(join(repository, "source.txt"), "fixture\n");
    execFileSync(
      git,
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", "source.txt"],
      { cwd: repository },
    );
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
    await prepare(repository);
    await assert.rejects(
      createGitMirror(
        projectConfig(await realpath(repository), git),
        sessionRoot,
        "00000000-0000-4000-8000-000000000001",
      ),
      {
        code: name === "partial-clone" ? "UNSUPPORTED_GIT_LAYOUT" : "UNSUPPORTED_GIT_LAYOUT",
      },
      name,
    );
  }
});

void test("Git mirror refuses malformed HEAD and non-regular index metadata", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-git-invalid-"));
  context.after(async () => rm(base, { recursive: true, force: true }));
  const git = await findGit();
  for (const mode of ["head", "index"] as const) {
    const repository = join(base, mode);
    const sessionRoot = join(base, `${mode}-session`);
    await mkdir(repository);
    await mkdir(sessionRoot);
    execFileSync(git, ["init", "--quiet"], { cwd: repository });
    await writeFile(join(repository, "source.txt"), "fixture\n");
    execFileSync(
      git,
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", "source.txt"],
      { cwd: repository },
    );
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
    if (mode === "head")
      await writeFile(join(repository, ".git", "HEAD"), "execute=host-command\n");
    else {
      await rm(join(repository, ".git", "index"));
      await symlink(join(repository, "source.txt"), join(repository, ".git", "index"));
    }
    await assert.rejects(
      createGitMirror(
        projectConfig(await realpath(repository), git),
        sessionRoot,
        "00000000-0000-4000-8000-000000000001",
      ),
      { code: mode === "head" ? "UNSUPPORTED_GIT_LAYOUT" : "UNSUPPORTED_FILE_TYPE" },
      mode,
    );
  }
});

void test("Git mirror handles unborn, detached, missing-ref, and SHA-256 repository states", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-git-states-"));
  context.after(async () => rm(base, { recursive: true, force: true }));
  const git = await findGit();

  const emptyRoot = join(base, "empty");
  await mkdir(emptyRoot);
  execFileSync(git, ["init", "--quiet"], { cwd: emptyRoot });
  const emptySession = join(base, "empty-session");
  await mkdir(emptySession);
  const empty = await createGitMirror(
    projectConfig(await realpath(emptyRoot), git),
    emptySession,
    "00000000-0000-4000-8000-000000000001",
  );
  assert.equal(empty.headSha, null);
  assert.equal(empty.trackedPaths.length, 0);

  const detachedBase = join(base, "detached");
  const detached = await createCommittedFixture(detachedBase, git);
  const headSha = execFileSync(git, ["rev-parse", "HEAD"], { cwd: detached.repository })
    .toString()
    .trim();
  await writeFile(join(detached.repository, ".git", "HEAD"), `${headSha}\n`);
  const detachedMirror = await createGitMirror(
    detached.project,
    detached.sessionRoot,
    "00000000-0000-4000-8000-000000000002",
  );
  assert.equal(detachedMirror.headSha, headSha);
  assert.equal(detachedMirror.branch, null);

  const noRefsBase = join(base, "no-refs");
  const noRefs = await createCommittedFixture(noRefsBase, git);
  const branchName = execFileSync(git, ["symbolic-ref", "--short", "HEAD"], {
    cwd: noRefs.repository,
  })
    .toString()
    .trim();
  await rm(join(noRefs.repository, ".git", "refs"), { recursive: true });
  const noRefsMirror = await createGitMirror(
    noRefs.project,
    noRefs.sessionRoot,
    "00000000-0000-4000-8000-000000000003",
  );
  assert.equal(noRefsMirror.branch, branchName);
  assert.equal(noRefsMirror.headSha, null);

  const sha256Base = join(base, "sha256");
  const sha256 = await createCommittedFixture(sha256Base, git, "sha256");
  const sha256Mirror = await createGitMirror(
    sha256.project,
    sha256.sessionRoot,
    "00000000-0000-4000-8000-000000000004",
  );
  assert.equal(sha256Mirror.objectFormat, "sha256");
  assert.match(sha256Mirror.headSha ?? "", /^[a-f0-9]{64}$/);
});

void test("Git mirror enforces byte and entry budgets and records missing-object incompleteness", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-git-budgets-"));
  context.after(async () => rm(base, { recursive: true, force: true }));
  const git = await findGit();
  const fixture = await createCommittedFixture(base, git);
  await mkdir(join(base, "byte-budget-session"));
  await assert.rejects(
    createGitMirror(
      { ...fixture.project, limits: { ...fixture.project.limits, maxSnapshotBytes: 1 } },
      join(base, "byte-budget-session"),
      "00000000-0000-4000-8000-000000000011",
    ),
    { code: "SNAPSHOT_LIMIT_EXCEEDED" },
  );
  await mkdir(join(base, "entry-budget-session"));
  await assert.rejects(
    createGitMirror(
      { ...fixture.project, limits: { ...fixture.project.limits, maxFiles: 1 } },
      join(base, "entry-budget-session"),
      "00000000-0000-4000-8000-000000000012",
    ),
    { code: "SNAPSHOT_LIMIT_EXCEEDED" },
  );
  const fileBudgetSession = join(base, "file-budget-session");
  await mkdir(fileBudgetSession);
  await assert.rejects(
    createGitMirror(
      { ...fixture.project, limits: { ...fixture.project.limits, maxFiles: 5 } },
      fileBudgetSession,
      "00000000-0000-4000-8000-000000000014",
    ),
    { code: "SNAPSHOT_LIMIT_EXCEEDED" },
  );

  const blob = execFileSync(git, ["rev-parse", "HEAD:source.txt"], { cwd: fixture.repository })
    .toString()
    .trim();
  await rm(join(fixture.repository, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  const incomplete = await createGitMirror(
    fixture.project,
    fixture.sessionRoot,
    "00000000-0000-4000-8000-000000000013",
  );
  assert.equal(incomplete.complete, false);
  assert.deepEqual(incomplete.warnings, ["GIT_MIRROR_INCOMPLETE"]);
});

void test("Git mirror rejects unsupported object formats and oversized source metadata", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-git-config-"));
  context.after(async () => rm(base, { recursive: true, force: true }));
  const git = await findGit();
  const unsupported = await createCommittedFixture(join(base, "unsupported"), git);
  await writeFile(
    join(unsupported.repository, ".git", "config"),
    "[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectFormat = sha512\n",
  );
  await assert.rejects(
    createGitMirror(
      unsupported.project,
      unsupported.sessionRoot,
      "00000000-0000-4000-8000-000000000021",
    ),
    { code: "UNSUPPORTED_GIT_LAYOUT" },
  );

  const largeConfig = await createCommittedFixture(join(base, "large-config"), git);
  await writeFile(join(largeConfig.repository, ".git", "config"), "x".repeat(1024 * 1024 + 1));
  await assert.rejects(
    createGitMirror(
      largeConfig.project,
      largeConfig.sessionRoot,
      "00000000-0000-4000-8000-000000000022",
    ),
    { code: "UNSUPPORTED_GIT_LAYOUT" },
  );
});

void test("Git mirror rejects unsupported repository formats and ref storage extensions", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-git-format-"));
  context.after(async () => rm(base, { recursive: true, force: true }));
  const git = await findGit();
  const cases = [
    ["reftable", "[core]\n\trepositoryformatversion = 1\n[extensions]\n\trefStorage = reftable\n"],
    [
      "unknown-extension",
      "[core]\n\trepositoryformatversion = 1\n[extensions]\n\tunknownFeature = true\n",
    ],
    ["unknown-repository-format", "[core]\n\trepositoryformatversion = 2\n"],
    [
      "ambiguous-object-format",
      "[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectFormat = sha1\n\tobjectFormat = sha256\n",
    ],
  ] as const;
  for (const [name, config] of cases) {
    const fixture = await createCommittedFixture(join(base, name), git);
    await writeFile(join(fixture.repository, ".git", "config"), config);
    await assert.rejects(
      createGitMirror(fixture.project, fixture.sessionRoot, `00000000-0000-4000-8000-${name}`),
      { code: "UNSUPPORTED_GIT_LAYOUT" },
      name,
    );
  }
});

void test("Git mirror blocks unsupported metadata entries, hardlinks, and excessive nesting", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-git-adversarial-"));
  context.after(async () => rm(base, { recursive: true, force: true }));
  const git = await findGit();

  const linked = await createCommittedFixture(join(base, "hardlink"), git);
  const external = join(base, "external-packed-refs");
  await writeFile(external, "# external alias\n");
  await link(external, join(linked.repository, ".git", "packed-refs"));
  await assert.rejects(
    createGitMirror(linked.project, linked.sessionRoot, "00000000-0000-4000-8000-000000000031"),
    { code: "UNSUPPORTED_GIT_LAYOUT" },
  );
  assert.equal(
    (await lstat(external)).nlink,
    2,
    "mirror rejection must not change the alias inode",
  );

  const fifo = await createCommittedFixture(join(base, "fifo"), git);
  execFileSync("mkfifo", [join(fifo.repository, ".git", "objects", "info", "malformed-pipe")]);
  await assert.rejects(
    createGitMirror(fifo.project, fifo.sessionRoot, "00000000-0000-4000-8000-000000000032"),
    { code: "UNSUPPORTED_GIT_LAYOUT" },
  );

  const nested = await createCommittedFixture(join(base, "nested"), git);
  let cursor = join(nested.repository, ".git", "objects");
  for (let index = 0; index < 130; index += 1) {
    cursor = join(cursor, "x");
    await mkdir(cursor);
  }
  await assert.rejects(
    createGitMirror(nested.project, nested.sessionRoot, "00000000-0000-4000-8000-000000000033"),
    { code: "SNAPSHOT_LIMIT_EXCEEDED" },
  );

  const objectLink = await createCommittedFixture(join(base, "object-link"), git);
  const replacementObjects = join(base, "replacement-objects");
  await mkdir(replacementObjects);
  await rm(join(objectLink.repository, ".git", "objects"), { recursive: true });
  await symlink(replacementObjects, join(objectLink.repository, ".git", "objects"));
  await assert.rejects(
    createGitMirror(
      objectLink.project,
      objectLink.sessionRoot,
      "00000000-0000-4000-8000-000000000034",
    ),
    { code: "UNSUPPORTED_GIT_LAYOUT" },
  );
});

void test("Git mirror validates tool output, external metadata approval, and submodule index entries", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-git-boundaries-"));
  context.after(async () => rm(base, { recursive: true, force: true }));
  const git = await findGit();

  const malformed = await createCommittedFixture(join(base, "malformed-index"), git);
  const malformedGit = await createGitWrapper(base, git, "malformed-index");
  await assert.rejects(
    createGitMirror(
      { ...malformed.project, executables: { git: malformedGit, docker: null } },
      malformed.sessionRoot,
      "00000000-0000-4000-8000-000000000041",
    ),
    { code: "GIT_FAILED" },
  );

  const unsafeIndex = await createCommittedFixture(join(base, "unsafe-index"), git);
  const unsafeGit = await createGitWrapper(base, git, "unsafe-index");
  await assert.rejects(
    createGitMirror(
      { ...unsafeIndex.project, executables: { git: unsafeGit, docker: null } },
      unsafeIndex.sessionRoot,
      "00000000-0000-4000-8000-000000000042",
    ),
    { code: "UNSUPPORTED_GIT_LAYOUT" },
  );

  const wrongFormat = await createCommittedFixture(join(base, "wrong-format"), git);
  const wrongFormatGit = await createGitWrapper(base, git, "format");
  await assert.rejects(
    createGitMirror(
      { ...wrongFormat.project, executables: { git: wrongFormatGit, docker: null } },
      wrongFormat.sessionRoot,
      "00000000-0000-4000-8000-000000000043",
    ),
    { code: "UNSUPPORTED_GIT_LAYOUT" },
  );

  const linkedBase = await createCommittedFixture(join(base, "linked-base"), git);
  const linkedWorktree = join(base, "external-worktree");
  execFileSync(git, ["worktree", "add", "--quiet", "--detach", linkedWorktree, "HEAD"], {
    cwd: linkedBase.repository,
  });
  const linkedSession = join(base, "linked-session");
  await mkdir(linkedSession);
  const linkedProject = projectConfig(await realpath(linkedWorktree), git);
  await assert.rejects(
    createGitMirror(linkedProject, linkedSession, "00000000-0000-4000-8000-000000000044"),
    { code: "CONFIG_INVALID" },
  );
  const pointer = await readFile(join(linkedWorktree, ".git"), "utf8");
  const linkedGitPath = pointer.trim().slice("gitdir:".length).trim();
  const linkedGitDirectory = await realpath(
    isAbsolute(linkedGitPath) ? linkedGitPath : resolve(linkedWorktree, linkedGitPath),
  );
  const commonPointer = await readFile(join(linkedGitDirectory, "commondir"), "utf8");
  const commonGitDirectory = await realpath(resolve(linkedGitDirectory, commonPointer.trim()));
  const approvedProject = {
    ...linkedProject,
    project: {
      ...linkedProject.project,
      approvedGitMetadataRoots: [...new Set([linkedGitDirectory, commonGitDirectory])],
    },
  };
  const partialApproval = {
    ...linkedProject,
    project: {
      ...linkedProject.project,
      approvedGitMetadataRoots: [linkedGitDirectory],
    },
  };
  await mkdir(join(base, "partial-approval-session"));
  await assert.rejects(
    createGitMirror(
      partialApproval,
      join(base, "partial-approval-session"),
      "00000000-0000-4000-8000-000000000047",
    ),
    { code: "CONFIG_INVALID" },
  );
  const approved = await createGitMirror(
    approvedProject,
    linkedSession,
    "00000000-0000-4000-8000-000000000045",
  );
  assert.equal(
    approved.headSha,
    execFileSync(git, ["rev-parse", "HEAD"], { cwd: linkedWorktree }).toString().trim(),
  );

  const submodule = await createCommittedFixture(join(base, "submodule-index"), git);
  const submoduleHead = execFileSync(git, ["rev-parse", "HEAD"], { cwd: submodule.repository })
    .toString()
    .trim();
  execFileSync(
    git,
    ["update-index", "--add", "--cacheinfo", `160000,${submoduleHead},vendor/module`],
    { cwd: submodule.repository },
  );
  const withSubmodule = await createGitMirror(
    submodule.project,
    submodule.sessionRoot,
    "00000000-0000-4000-8000-000000000046",
  );
  assert.deepEqual(withSubmodule.submodulePaths, ["vendor/module"]);
});

void test("Git mirror copies packed refs and shallow metadata, and denies unreadable object trees", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-git-optional-meta-"));
  context.after(async () => rm(base, { recursive: true, force: true }));
  const git = await findGit();
  const packed = await createCommittedFixture(join(base, "packed"), git);
  execFileSync(git, ["pack-refs", "--all", "--prune"], { cwd: packed.repository });
  const packedHead = execFileSync(git, ["rev-parse", "HEAD"], { cwd: packed.repository })
    .toString()
    .trim();
  await writeFile(join(packed.repository, ".git", "shallow"), `${packedHead}\n`);
  const packedMirror = await createGitMirror(
    packed.project,
    packed.sessionRoot,
    "00000000-0000-4000-8000-000000000051",
  );
  assert.equal(packedMirror.headSha, packedHead);
  assert.equal(await readFile(join(packedMirror.root, "shallow"), "utf8"), `${packedHead}\n`);
  assert.match(await readFile(join(packedMirror.root, "packed-refs"), "utf8"), /refs\/heads\//);

  const unsafeOptional = await createCommittedFixture(join(base, "unsafe-optional"), git);
  await writeFile(join(base, "shallow-target"), "not used\n");
  await symlink(join(base, "shallow-target"), join(unsafeOptional.repository, ".git", "shallow"));
  await assert.rejects(
    createGitMirror(
      unsafeOptional.project,
      unsafeOptional.sessionRoot,
      "00000000-0000-4000-8000-000000000053",
    ),
    { code: "UNSUPPORTED_GIT_LAYOUT" },
  );

  const unreadable = await createCommittedFixture(join(base, "unreadable"), git);
  const infoDirectory = join(unreadable.repository, ".git", "objects", "info");
  await chmod(infoDirectory, 0);
  try {
    await assert.rejects(
      createGitMirror(
        unreadable.project,
        unreadable.sessionRoot,
        "00000000-0000-4000-8000-000000000052",
      ),
      { code: "UNSUPPORTED_GIT_LAYOUT" },
    );
  } finally {
    await chmod(infoDirectory, 0o700);
  }
});

void test("Git audit status and diff fail closed when a captured snapshot file is replaced", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-git-snapshot-race-"));
  const store = new ConfigStore(join(base, "state"));
  context.after(async () => {
    for (const id of await store.listOwnedSessionDirectories())
      await store.removeOwnedSessionDirectory(id);
    await rm(base, { recursive: true, force: true });
  });
  const repository = join(base, "repository");
  await mkdir(repository);
  const git = await findGit();
  const run = (args: string[]): void => {
    execFileSync(git, args, {
      cwd: repository,
      env: { PATH: "/usr/bin:/bin", HOME: base, GIT_CONFIG_NOSYSTEM: "1" },
    });
  };
  run(["init", "--quiet"]);
  run([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "fixture",
  ]);
  await writeFile(join(repository, "safe.txt"), "captured source\n");
  run(["add", "safe.txt"]);
  run([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "source",
  ]);
  const project = projectConfig(await realpath(repository), git);
  const snapshot = await new SnapshotManager(project, store).create();
  const mirror = await createGitMirror(project, dirname(snapshot.root), snapshot.sessionId);
  const audit = new GitAudit(project, snapshot, mirror, dirname(snapshot.root));
  const capturedFile = join(snapshot.root, "safe.txt");
  const outsideFile = join(base, "outside.txt");
  await writeFile(outsideFile, "synthetic external sentinel\n");
  await chmod(snapshot.root, 0o755);
  await rm(capturedFile);
  await symlink(outsideFile, capturedFile);
  assert.ok((await lstat(capturedFile)).isSymbolicLink());
  const status = await audit.status();
  assert.deepEqual(status.unavailablePaths, ["safe.txt"]);
  assert.equal(status.workingTree, "partially-observed");
  const diff = await audit.diff({ mode: "audit-working-tree" });
  assert.doesNotMatch(diff.diff, /synthetic external sentinel/);
});
