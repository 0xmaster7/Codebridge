import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, opendir, lstat, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { CodeBridgeError } from "../errors.js";
import type { ProjectConfig } from "../config/schema.js";
import { discoverRepository, resolveAdditionalGitMetadata } from "../config/project.js";
import { GitRunner } from "./runner.js";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { SnapshotGuard } from "../security/snapshot-guard.js";
import { PathGuard } from "../security/path-guard.js";

export interface GitMirror {
  readonly root: string;
  readonly indexPath: string;
  readonly headSha: string | null;
  readonly branch: string | null;
  readonly objectFormat: "sha1" | "sha256";
  readonly complete: boolean;
  readonly mirrorSha256: string;
  readonly indexSha256: string;
  readonly trackedPaths: readonly string[];
  readonly submodulePaths: readonly string[];
  readonly warnings: readonly string[];
  readonly runner: GitRunner;
}

interface CopyEntry {
  path: string;
  mode: number;
  size: number;
  sha256?: string;
}

interface CopyState {
  bytes: number;
  files: number;
  directories: number;
  maxFiles: number;
  entries: CopyEntry[];
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function copyRegularFile(
  source: string,
  destination: string,
  state: CopyState,
  budget: number,
): Promise<void> {
  const beforePath = await lstat(source);
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink > 1) {
    throw new CodeBridgeError(
      "UNSUPPORTED_GIT_LAYOUT",
      "Git mirror metadata contains an unsafe file.",
    );
  }
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output;
  let copied = false;
  try {
    const before = await input.stat();
    if (
      !before.isFile() ||
      before.nlink > 1 ||
      before.dev !== beforePath.dev ||
      before.ino !== beforePath.ino
    ) {
      throw new CodeBridgeError(
        "SNAPSHOT_RACE_DETECTED",
        "Git metadata changed before it could be copied.",
      );
    }
    if (state.bytes + before.size > budget) {
      throw new CodeBridgeError(
        "SNAPSHOT_LIMIT_EXCEEDED",
        "Git mirror exceeds the configured snapshot budget.",
      );
    }
    output = await open(destination, "wx", 0o600);
    const hash = createHash("sha256");
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      createReadStream(source, { fd: input.fd, autoClose: false }),
      counter,
      createWriteStream(destination, { fd: output.fd, autoClose: false }),
    );
    const after = await input.stat();
    const pathAfter = await lstat(source);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino
    ) {
      throw new CodeBridgeError(
        "SNAPSHOT_RACE_DETECTED",
        "Git metadata changed during mirror creation.",
      );
    }
    await output.sync();
    state.bytes += before.size;
    state.files += 1;
    if (state.files + state.directories > state.maxFiles) {
      throw new CodeBridgeError(
        "SNAPSHOT_LIMIT_EXCEEDED",
        "Git mirror file count exceeds the safety limit.",
      );
    }
    state.entries.push({
      path: relative(destinationRootOf(destination), destination).split(sep).join("/"),
      mode: before.mode & 0o777,
      size: before.size,
      sha256: hash.digest("hex"),
    });
    copied = true;
  } finally {
    await input.close().catch(() => undefined);
    await output?.close().catch(() => undefined);
    if (!copied) await rm(destination, { force: true }).catch(() => undefined);
  }
}

function destinationRootOf(destination: string): string {
  const marker = `${sep}git${sep}`;
  const index = destination.lastIndexOf(marker);
  return index < 0 ? dirname(destination) : destination.slice(0, index + `${sep}git`.length);
}

async function copyTree(
  source: string,
  destination: string,
  state: CopyState,
  budget: number,
  depth = 0,
): Promise<void> {
  if (depth > 128) {
    throw new CodeBridgeError(
      "SNAPSHOT_LIMIT_EXCEEDED",
      "Git metadata nesting exceeds its safe limit.",
    );
  }
  const info = await lstat(source);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new CodeBridgeError(
      "UNSUPPORTED_GIT_LAYOUT",
      "Git metadata directory is not a regular directory.",
    );
  }
  state.directories += 1;
  if (state.files + state.directories > state.maxFiles) {
    throw new CodeBridgeError(
      "SNAPSHOT_LIMIT_EXCEEDED",
      "Git metadata entry count exceeds its safe limit.",
    );
  }
  await mkdir(destination, { mode: 0o700 });
  const names: string[] = [];
  try {
    const directory = await opendir(source);
    for await (const entry of directory) {
      names.push(entry.name);
      if (names.length > state.maxFiles) {
        throw new CodeBridgeError(
          "SNAPSHOT_LIMIT_EXCEEDED",
          "Git metadata directory exceeds its safe entry limit.",
        );
      }
    }
  } catch (error) {
    if (error instanceof CodeBridgeError) throw error;
    throw new CodeBridgeError(
      "UNSUPPORTED_GIT_LAYOUT",
      "Git metadata directory could not be read safely.",
      { cause: error },
    );
  }
  for (const name of names.sort()) {
    if (
      (name === "alternates" || name === "http-alternates") &&
      source.endsWith(join("objects", "info"))
    ) {
      throw new CodeBridgeError("UNSUPPORTED_GIT_LAYOUT", "Git object alternates are unsupported.");
    }
    const sourceChild = join(source, name);
    const destinationChild = join(destination, name);
    const child = await lstat(sourceChild);
    if (child.isSymbolicLink()) {
      throw new CodeBridgeError("UNSUPPORTED_GIT_LAYOUT", "Git metadata symlinks are unsupported.");
    }
    if (child.isDirectory())
      await copyTree(sourceChild, destinationChild, state, budget, depth + 1);
    else if (child.isFile()) await copyRegularFile(sourceChild, destinationChild, state, budget);
    else
      throw new CodeBridgeError(
        "UNSUPPORTED_GIT_LAYOUT",
        "Git metadata contains an unsupported file type.",
      );
  }
}

async function writeGeneratedConfig(path: string, objectFormat: "sha1" | "sha256"): Promise<void> {
  const repositoryFormatVersion = objectFormat === "sha1" ? 0 : 1;
  const extension = objectFormat === "sha256" ? "\n[extensions]\n\tobjectFormat = sha256\n" : "";
  await writePrivateFile(
    path,
    `[core]\n\trepositoryformatversion = ${repositoryFormatVersion}\n\tfilemode = true\n\tbare = true\n\tfsmonitor = false\n\thooksPath = /dev/null\n\tattributesFile = /dev/null\n[gc]\n\tauto = 0\n${extension}`,
  );
}

async function writePrivateFile(path: string, value: string | Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function findObjectFormat(configText: string): "sha1" | "sha256" {
  let section = "";
  let format: string | undefined;
  for (const line of configText.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]/.exec(line)?.[1];
    if (header) {
      section = header.trim().toLowerCase();
      continue;
    }
    if (section !== "extensions") continue;
    const value = /^\s*objectformat\s*=\s*([^\s#;]+)\s*(?:[#;].*)?$/i.exec(line)?.[1];
    if (value !== undefined) {
      if (format !== undefined) {
        throw new CodeBridgeError("UNSUPPORTED_GIT_LAYOUT", "The Git object format is ambiguous.");
      }
      format = value.toLowerCase();
    }
  }
  if (format === "sha256") return "sha256";
  if (format === undefined || format === "sha1") return "sha1";
  throw new CodeBridgeError("UNSUPPORTED_GIT_LAYOUT", "The Git object format is unsupported.");
}

function assertSupportedGitConfig(configText: string): void {
  let section = "";
  const supportedExtensions = new Set(["objectformat", "worktreeconfig", "refstorage"]);
  let repositoryFormatVersion: string | undefined;
  for (const line of configText.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]/.exec(line)?.[1];
    if (header) {
      section = header.trim().toLowerCase();
      continue;
    }
    const key = /^\s*([A-Za-z][A-Za-z0-9]*)\s*(?:=|$)/.exec(line)?.[1]?.toLowerCase();
    if (!key) continue;
    if (section === "core" && key === "repositoryformatversion") {
      repositoryFormatVersion = /^\s*repositoryformatversion\s*=\s*(\d+)\s*(?:[#;].*)?$/i.exec(
        line,
      )?.[1];
      if (repositoryFormatVersion === undefined || !["0", "1"].includes(repositoryFormatVersion)) {
        throw new CodeBridgeError(
          "UNSUPPORTED_GIT_LAYOUT",
          "The repository format version is unsupported.",
        );
      }
      continue;
    }
    if (section !== "extensions" || /^\s*[#;]/.test(line)) continue;
    if (key === "partialclone") {
      throw new CodeBridgeError(
        "UNSUPPORTED_GIT_LAYOUT",
        "Partial-clone Git metadata is unsupported offline.",
      );
    }
    if (!supportedExtensions.has(key)) {
      throw new CodeBridgeError(
        "UNSUPPORTED_GIT_LAYOUT",
        "The repository uses an unsupported Git extension.",
      );
    }
    if (key === "refstorage" && !/^\s*refstorage\s*=\s*files\s*(?:[#;].*)?$/i.test(line)) {
      throw new CodeBridgeError(
        "UNSUPPORTED_GIT_LAYOUT",
        "Only the files Git ref storage format is supported.",
      );
    }
  }
}

async function readSourceConfig(
  commonDirectory: string,
): Promise<{ objectFormat: "sha1" | "sha256"; partial: boolean }> {
  let text: string;
  try {
    const result = await new SnapshotGuard().readRegularFile(join(commonDirectory, "config"), {
      maxBytes: 1024 * 1024,
    });
    text = result.bytes.toString("utf8");
  } catch (error) {
    throw new CodeBridgeError(
      "UNSUPPORTED_GIT_LAYOUT",
      "Git metadata config cannot be read safely.",
      { cause: error },
    );
  }
  assertSupportedGitConfig(text);
  const partial = /^\s*(?:promisor\s*=\s*true|partialclone\s*=)/im.test(text);
  if (partial) {
    throw new CodeBridgeError(
      "UNSUPPORTED_GIT_LAYOUT",
      "Partial-clone Git metadata is unsupported offline.",
    );
  }
  return { objectFormat: findObjectFormat(text), partial };
}

export async function createGitMirror(
  project: ProjectConfig,
  sessionRoot: string,
  sessionId: string,
): Promise<GitMirror> {
  const discovery = await discoverRepository(project.project.canonicalWorktreeRoot);
  const approvedDiscovery = await resolveAdditionalGitMetadata(
    discovery,
    project.project.approvedGitMetadataRoots,
  );
  for (const metadataRoot of approvedDiscovery.metadataRoots) {
    if (
      !within(project.project.canonicalWorktreeRoot, metadataRoot) &&
      !project.project.approvedGitMetadataRoots.includes(metadataRoot)
    ) {
      throw new CodeBridgeError(
        "CONFIG_INVALID",
        "An external Git metadata path lacks exact approval.",
      );
    }
  }
  const metadata = await readSourceConfig(approvedDiscovery.commonGitDirectory);
  const gitRoot = join(sessionRoot, "git");
  await mkdir(gitRoot, { mode: 0o700 });
  const objectState: CopyState = {
    bytes: 0,
    files: 0,
    directories: 0,
    maxFiles: project.limits.maxFiles,
    entries: [],
  };
  const objectSource = join(approvedDiscovery.commonGitDirectory, "objects");
  const objectDestination = join(gitRoot, "objects");
  await copyTree(objectSource, objectDestination, objectState, project.limits.maxSnapshotBytes);
  const refsSource = join(approvedDiscovery.commonGitDirectory, "refs");
  try {
    await copyTree(refsSource, join(gitRoot, "refs"), objectState, project.limits.maxSnapshotBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(join(gitRoot, "refs"), { recursive: true, mode: 0o700 });
  }
  for (const name of ["packed-refs", "shallow"]) {
    const source = join(approvedDiscovery.commonGitDirectory, name);
    try {
      const info = await lstat(source);
      if (info.isFile() && !info.isSymbolicLink()) {
        await copyRegularFile(
          source,
          join(gitRoot, name),
          objectState,
          project.limits.maxSnapshotBytes,
        );
      } else {
        throw new CodeBridgeError(
          "UNSUPPORTED_GIT_LAYOUT",
          `Git ${name} metadata is not a regular file.`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const head = (
    await new SnapshotGuard().readRegularFile(join(approvedDiscovery.gitDirectory, "HEAD"), {
      maxBytes: 4096,
    })
  ).bytes;
  if (
    !/^(?:ref: refs\/[A-Za-z0-9._/-]+|[a-f0-9]{40}|[a-f0-9]{64})\n?$/.test(head.toString("ascii"))
  ) {
    throw new CodeBridgeError("UNSUPPORTED_GIT_LAYOUT", "The source Git HEAD is malformed.");
  }
  await writePrivateFile(join(gitRoot, "HEAD"), head);
  await writeGeneratedConfig(join(gitRoot, "config"), metadata.objectFormat);
  const sourceIndex = join(approvedDiscovery.gitDirectory, "index");
  const indexPath = join(sessionRoot, "index");
  let hasSourceIndex = true;
  try {
    const indexBytes = (
      await new SnapshotGuard().readRegularFile(sourceIndex, {
        maxBytes: project.limits.maxSnapshotBytes,
      })
    ).bytes;
    await writePrivateFile(indexPath, indexBytes);
  } catch (error) {
    if (
      !(error instanceof CodeBridgeError && error.code === "FILE_NOT_FOUND") &&
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
    hasSourceIndex = false;
  }
  const mirrorManifest = JSON.stringify({
    sessionId,
    entries: objectState.entries.sort((a, b) => a.path.localeCompare(b.path, "en")),
  });
  const mirrorSha256 = createHash("sha256").update(mirrorManifest).digest("hex");
  const runner = new GitRunner(
    project.executables.git,
    gitRoot,
    indexPath,
    join(sessionRoot, "home"),
    project.limits.maxRetainedOutputBytes,
  );
  await mkdir(join(sessionRoot, "home", "config"), { recursive: true, mode: 0o700 });
  if (!hasSourceIndex) await runner.run(["read-tree", "--empty"]);
  const indexSha256 = createHash("sha256")
    .update(await readFile(indexPath))
    .digest("hex");
  const formatResult = await runner.run(["rev-parse", "--show-object-format"]);
  if (formatResult.stdout.trim() !== metadata.objectFormat) {
    throw new CodeBridgeError(
      "UNSUPPORTED_GIT_LAYOUT",
      "Session Git mirror object format is inconsistent.",
    );
  }
  const headResult = await runner.run(["rev-parse", "--verify", "HEAD"], { allowFailure: true });
  const headSha = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
  const branchResult = await runner.run(["symbolic-ref", "-q", "HEAD"], { allowFailure: true });
  const branch =
    branchResult.exitCode === 0 ? branchResult.stdout.trim().replace(/^refs\/heads\//, "") : null;
  const indexed = await runner.run(["ls-files", "--stage", "-z"]);
  const trackedPaths: string[] = [];
  const submodulePaths: string[] = [];
  for (const record of indexed.stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) throw new CodeBridgeError("GIT_FAILED", "Session Git index output is malformed.");
    const metadataFields = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    try {
      new PathGuard().normalizeRelativePath(path);
    } catch (error) {
      throw new CodeBridgeError(
        "UNSUPPORTED_GIT_LAYOUT",
        "Session Git index contains an unsafe path.",
        { cause: error },
      );
    }
    trackedPaths.push(path);
    if (metadataFields[0] === "160000") submodulePaths.push(path);
  }
  const fsck = await runner.run(["fsck", "--connectivity-only", "--no-reflogs", "--no-dangling"], {
    allowFailure: true,
  });
  const complete = fsck.exitCode === 0;
  const warnings = complete ? [] : ["GIT_MIRROR_INCOMPLETE"];
  return {
    root: gitRoot,
    indexPath,
    headSha,
    branch,
    objectFormat: metadata.objectFormat,
    complete,
    mirrorSha256,
    indexSha256,
    trackedPaths,
    submodulePaths,
    warnings,
    runner,
  };
}
