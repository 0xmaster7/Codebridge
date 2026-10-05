import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, readlink, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { CodeBridgeError } from "../errors.js";
import type { ProjectConfig } from "../config/schema.js";
import type { ConfigStore } from "../config/store.js";
import { LimitPolicy } from "../security/limit-policy.js";
import { PathGuard } from "../security/path-guard.js";
import { classifySecretPath } from "../security/secret-policy.js";

export type SnapshotEntryType = "directory" | "file" | "symlink" | "blocked";

export interface SnapshotEntry {
  readonly path: string;
  readonly type: SnapshotEntryType;
  readonly mode?: number;
  readonly size?: number;
  readonly sha256?: string;
  readonly target?: string;
  readonly reason?: string;
}

export interface WorktreeSnapshot {
  readonly sessionId: string;
  readonly snapshotId: string;
  readonly root: string;
  readonly createdAt: string;
  readonly entries: readonly SnapshotEntry[];
  readonly fileCount: number;
  readonly bytes: number;
  readonly manifestSha256: string;
}

const MAX_RACE_RETRIES = 2;
const IGNORED_NAMES = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "coverage",
  "dist",
  "build",
  "target",
]);

interface SnapshotCounters {
  fileCount: number;
  bytes: number;
}

interface IgnoreScope {
  readonly base: string;
  readonly matcher: Ignore;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sameStat(
  a: Awaited<ReturnType<typeof lstat>>,
  b: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.mode === b.mode &&
    a.nlink === b.nlink
  );
}

export class SnapshotManager {
  private readonly policy: LimitPolicy;

  public constructor(
    private readonly project: ProjectConfig,
    private readonly store: ConfigStore,
  ) {
    this.policy = new LimitPolicy(project.limits);
  }

  public async create(options?: {
    readonly sessionId?: string;
    readonly snapshotId?: string;
    readonly sessionRoot?: string;
    readonly trackedPaths?: readonly string[];
    readonly submodulePaths?: readonly string[];
  }): Promise<WorktreeSnapshot> {
    const sourceRoot = await realpath(this.project.project.canonicalWorktreeRoot);
    if (sourceRoot !== this.project.project.canonicalWorktreeRoot) {
      throw new CodeBridgeError("OUTSIDE_ROOT", "The approved repository root changed identity.");
    }
    const sessionId = options?.sessionId ?? randomUUID();
    const snapshotId = options?.snapshotId ?? randomUUID();
    const sessionRoot =
      options?.sessionRoot ?? (await this.store.createOwnedSessionDirectory(sessionId));
    if (
      !/^[a-f0-9-]{36}$/.test(sessionId) ||
      !/^[a-f0-9-]{36}$/.test(snapshotId) ||
      !isAbsolute(sessionRoot)
    ) {
      throw new CodeBridgeError("INVALID_ARGUMENT", "Snapshot session identity is invalid.");
    }
    const trackedPaths = new Set(options?.trackedPaths ?? []);
    for (const path of trackedPaths) {
      try {
        new PathGuard().normalizeRelativePath(path);
      } catch (error) {
        throw new CodeBridgeError(
          "UNSUPPORTED_GIT_LAYOUT",
          "Session index contains an unsafe path.",
          { cause: error },
        );
      }
    }
    this.policy.requireFileCount(trackedPaths.size);
    const trackedOrAncestor = new Set(trackedPaths);
    for (const path of trackedPaths) {
      const components = path.split("/");
      for (let index = 1; index < components.length; index += 1)
        trackedOrAncestor.add(components.slice(0, index).join("/"));
    }
    const destinationRoot = join(sessionRoot, "worktree");
    await mkdir(destinationRoot, { mode: 0o700 });
    const entries: SnapshotEntry[] = [];
    const counters: SnapshotCounters = { fileCount: 0, bytes: 0 };
    try {
      await this.copyDirectory(
        sourceRoot,
        destinationRoot,
        "",
        entries,
        counters,
        [],
        trackedOrAncestor,
        new Set(options?.submodulePaths ?? []),
      );
      await chmod(destinationRoot, 0o555);
      entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
      const createdAt = new Date().toISOString();
      const manifestValue = {
        sessionId,
        snapshotId,
        createdAt,
        entries,
        fileCount: counters.fileCount,
        bytes: counters.bytes,
      };
      const manifestJson = stableJson(manifestValue);
      const manifestSha256 = createHash("sha256").update(manifestJson).digest("hex");
      const manifestHandle = await open(join(sessionRoot, "manifest.json"), "wx", 0o600);
      try {
        await manifestHandle.writeFile(manifestJson, "utf8");
        await manifestHandle.sync();
      } finally {
        await manifestHandle.close();
      }
      return {
        sessionId,
        snapshotId,
        root: destinationRoot,
        createdAt,
        entries,
        fileCount: counters.fileCount,
        bytes: counters.bytes,
        manifestSha256,
      };
    } catch (error) {
      await this.store.removeOwnedSessionDirectory(sessionId).catch(() => {
        void rm(sessionRoot, { recursive: true, force: true }).catch(() => undefined);
      });
      throw error;
    }
  }

  private async copyDirectory(
    sourceDirectory: string,
    destinationDirectory: string,
    relativeDirectory: string,
    entries: SnapshotEntry[],
    counters: SnapshotCounters,
    parentScopes: readonly IgnoreScope[],
    trackedOrAncestor: ReadonlySet<string>,
    submodulePaths: ReadonlySet<string>,
  ): Promise<void> {
    if (relativeDirectory.split("/").filter(Boolean).length > 128) {
      throw new CodeBridgeError(
        "SNAPSHOT_LIMIT_EXCEEDED",
        "Repository directory nesting exceeds its safe limit.",
      );
    }
    const directoryBefore = await lstat(sourceDirectory);
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
      throw new CodeBridgeError("SNAPSHOT_RACE_DETECTED", "Repository directory identity changed.");
    }
    let children: string[];
    const directory = await opendir(sourceDirectory);
    try {
      children = [];
      for await (const child of directory) {
        children.push(child.name);
        if (children.length > this.project.limits.maxFiles) {
          throw new CodeBridgeError(
            "SNAPSHOT_LIMIT_EXCEEDED",
            "A repository directory exceeds the safe entry limit.",
          );
        }
      }
    } catch (error) {
      if (error instanceof CodeBridgeError) throw error;
      throw new CodeBridgeError("SNAPSHOT_FAILED", "A repository directory could not be read.", {
        cause: error,
      });
    }
    const scopes = [...parentScopes];
    const ignorePath = join(sourceDirectory, ".gitignore");
    try {
      const ignoreInfo = await lstat(ignorePath);
      if (ignoreInfo.isFile() && !ignoreInfo.isSymbolicLink() && ignoreInfo.nlink === 1) {
        const handle = await open(ignorePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const before = await handle.stat();
          if (
            before.dev !== ignoreInfo.dev ||
            before.ino !== ignoreInfo.ino ||
            before.size > this.project.limits.maxSecretScanBytes
          ) {
            throw new CodeBridgeError(
              "SNAPSHOT_RACE_DETECTED",
              "A Git ignore file changed or exceeded its safe limit.",
            );
          }
          const bytes = await handle.readFile();
          const after = await handle.stat();
          const pathAfter = await lstat(ignorePath);
          if (
            !sameStat(before, after) ||
            !sameStat(pathAfter, after) ||
            bytes.byteLength !== before.size
          ) {
            throw new CodeBridgeError(
              "SNAPSHOT_RACE_DETECTED",
              "A Git ignore file changed while being read.",
            );
          }
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          const matcher = ignore().add(decoded.split(/\r?\n/));
          scopes.push({ base: relativeDirectory, matcher });
        } finally {
          await handle.close();
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof CodeBridgeError) throw error;
        throw new CodeBridgeError(
          "SNAPSHOT_FAILED",
          "A Git ignore file could not be parsed safely.",
          { cause: error },
        );
      }
    }
    for (const name of children.sort()) {
      const childPath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (name === ".git") continue;
      if (IGNORED_NAMES.has(name) && !trackedOrAncestor.has(childPath)) continue;
      this.policy.requireFileCount(entries.length + 1);
      if (submodulePaths.has(childPath)) {
        entries.push({ path: childPath, type: "blocked", reason: "SUBMODULE_NOT_APPROVED" });
        continue;
      }
      const ignored = scopes.some(({ base, matcher }) => {
        const scopedPath = base ? childPath.slice(base.length + 1) : childPath;
        return scopedPath.length > 0 && matcher.ignores(scopedPath);
      });
      if (ignored && !trackedOrAncestor.has(childPath)) continue;
      const sourcePath = join(sourceDirectory, name);
      const destinationPath = join(destinationDirectory, name);
      let info;
      try {
        info = await lstat(sourcePath);
      } catch (error) {
        throw new CodeBridgeError("SNAPSHOT_RACE_DETECTED", "A path changed during inventory.", {
          cause: error,
        });
      }
      if (info.isSymbolicLink()) {
        const target = await readlink(sourcePath);
        if (classifySecretPath(childPath) !== null || classifySecretPath(target) !== null) {
          entries.push({ path: childPath, type: "blocked", reason: "SECRET_PATH" });
        } else {
          entries.push({ path: childPath, type: "symlink", target });
        }
        continue;
      }
      if (info.isDirectory()) {
        await mkdir(destinationPath, { mode: 0o700 });
        entries.push({ path: childPath, type: "directory", mode: info.mode & 0o777 });
        await this.copyDirectory(
          sourcePath,
          destinationPath,
          childPath,
          entries,
          counters,
          scopes,
          trackedOrAncestor,
          submodulePaths,
        );
        await chmod(destinationPath, 0o555);
        continue;
      }
      if (!info.isFile()) {
        entries.push({ path: childPath, type: "blocked", reason: "UNSUPPORTED_FILE_TYPE" });
        continue;
      }
      const secretReason = classifySecretPath(childPath);
      if (secretReason !== null) {
        entries.push({ path: childPath, type: "blocked", reason: `SECRET_PATH:${secretReason}` });
        continue;
      }
      if (info.nlink > 1) {
        entries.push({ path: childPath, type: "blocked", reason: "HARDLINK_BLOCKED" });
        continue;
      }
      await this.copyRegularFile(sourcePath, destinationPath, childPath, info, entries, counters);
    }
    const directoryAfter = await lstat(sourceDirectory);
    if (!sameStat(directoryBefore, directoryAfter)) {
      throw new CodeBridgeError(
        "SNAPSHOT_RACE_DETECTED",
        "Repository directory identity changed during inventory.",
      );
    }
  }

  private async copyRegularFile(
    sourcePath: string,
    destinationPath: string,
    relativePath: string,
    initialInfo: Awaited<ReturnType<typeof lstat>>,
    entries: SnapshotEntry[],
    counters: SnapshotCounters,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RACE_RETRIES; attempt += 1) {
      let input;
      let output;
      let copied = false;
      try {
        input = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const before = await input.stat();
        if (!before.isFile())
          throw new CodeBridgeError("UNSUPPORTED_FILE_TYPE", "Not a regular file.");
        if (before.nlink > 1)
          throw new CodeBridgeError("HARDLINK_BLOCKED", "Hardlinks are blocked.");
        if (before.dev !== initialInfo.dev || before.ino !== initialInfo.ino) {
          throw new CodeBridgeError("SNAPSHOT_RACE_DETECTED", "File identity changed before copy.");
        }
        if (before.size > this.project.limits.maxSecretScanBytes) {
          entries.push({ path: relativePath, type: "blocked", reason: "SECRET_SCAN_LIMIT" });
          return;
        }
        const chunks: Buffer[] = [];
        const hash = createHash("sha256");
        let count = 0;
        for await (const chunk of input.createReadStream({ autoClose: false })) {
          const buffer: Buffer<ArrayBufferLike> = Buffer.from(chunk as Uint8Array);
          count += buffer.length;
          this.policy.requireSnapshotBytes(counters.bytes + count);
          chunks.push(buffer);
          hash.update(buffer);
        }
        const after = await input.stat();
        const pathAfter = await lstat(sourcePath);
        if (!sameStat(before, after) || !sameStat(pathAfter, after) || count !== before.size) {
          throw new CodeBridgeError("SNAPSHOT_RACE_DETECTED", "File changed while being copied.");
        }
        const bytes = Buffer.concat(chunks, count);
        const { SecretScanner } = await import("../security/secret-scanner.js");
        if (new SecretScanner().scan(bytes).blocked) {
          entries.push({ path: relativePath, type: "blocked", reason: "SECRET_CONTENT" });
          return;
        }
        this.policy.requireFileCount(counters.fileCount + 1);
        this.policy.requireSnapshotBytes(counters.bytes + count);
        output = await open(destinationPath, "wx", 0o600);
        await output.writeFile(bytes);
        await output.sync();
        await chmod(destinationPath, 0o444 | (before.mode & 0o111));
        entries.push({
          path: relativePath,
          type: "file",
          mode: before.mode & 0o777,
          size: count,
          sha256: hash.digest("hex"),
        });
        counters.fileCount += 1;
        counters.bytes += count;
        copied = true;
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof CodeBridgeError && error.code !== "SNAPSHOT_RACE_DETECTED")
          throw error;
        if (attempt >= MAX_RACE_RETRIES) break;
      } finally {
        await input?.close().catch(() => undefined);
        await output?.close().catch(() => undefined);
        if (!copied) await rm(destinationPath, { force: true }).catch(() => undefined);
      }
    }
    throw new CodeBridgeError(
      "SNAPSHOT_RACE_DETECTED",
      `Snapshot consistency failed for ${relativePath}.`,
      {
        cause: lastError,
      },
    );
  }
}

export function isSnapshotPathWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function snapshotEntryPath(root: string, path: string): string {
  const candidate = resolve(root, path);
  if (!isSnapshotPathWithin(root, candidate)) {
    throw new CodeBridgeError("OUTSIDE_ROOT", "Snapshot path escaped its root.");
  }
  return candidate;
}
