import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { CodeBridgeError } from "../errors.js";
export interface SnapshotGuardIo {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly open: (path: string, flags: number) => Promise<FileHandle>;
  readonly realpath: (path: string) => Promise<string>;
}

const defaultIo: SnapshotGuardIo = {
  lstat: (path) => lstat(path),
  open: (path, flags) => open(path, flags),
  realpath: (path) => realpath(path),
};

export interface SafeFileRead {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: number;
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export class SnapshotGuard {
  public constructor(private readonly io: SnapshotGuardIo = defaultIo) {}

  public async readRegularFile(
    path: string,
    options: { maxBytes: number; rejectHardlinks?: boolean },
  ): Promise<SafeFileRead> {
    const canonicalPath = resolve(path);
    let pathInfo;
    try {
      pathInfo = await this.io.lstat(canonicalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CodeBridgeError("FILE_NOT_FOUND", "Approved file is missing.", { cause: error });
      }
      throw error;
    }
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
      throw new CodeBridgeError("UNSUPPORTED_FILE_TYPE", "Approved path is not a regular file.");
    }
    if (options.rejectHardlinks !== false && pathInfo.nlink > 1) {
      throw new CodeBridgeError("HARDLINK_BLOCKED", "Hardlinked files are unavailable.");
    }
    if (pathInfo.size > options.maxBytes) {
      throw new CodeBridgeError("SECRET_SCAN_LIMIT", "Approved file exceeds its read limit.");
    }
    let handle;
    try {
      handle = await this.io.open(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      throw new CodeBridgeError(
        "SNAPSHOT_RACE_DETECTED",
        "File could not be opened without following links.",
        { cause: error },
      );
    }
    let bytes: Buffer;
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        (options.rejectHardlinks !== false && before.nlink > 1) ||
        before.dev !== pathInfo.dev ||
        before.ino !== pathInfo.ino
      ) {
        throw new CodeBridgeError(
          "SNAPSHOT_RACE_DETECTED",
          "File identity changed before reading.",
        );
      }
      bytes = await handle.readFile();
      const after = await handle.stat();
      const pathAfter = await this.io.lstat(canonicalPath);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        pathAfter.dev !== after.dev ||
        pathAfter.ino !== after.ino ||
        bytes.byteLength !== before.size
      ) {
        throw new CodeBridgeError("SNAPSHOT_RACE_DETECTED", "File changed while being read.");
      }
    } finally {
      await handle.close();
    }
    if (bytes.byteLength > options.maxBytes) {
      throw new CodeBridgeError("SECRET_SCAN_LIMIT", "Approved file exceeds its read limit.");
    }
    return {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      device: pathInfo.dev,
      inode: pathInfo.ino,
      size: pathInfo.size,
      mtimeMs: pathInfo.mtimeMs,
      mode: pathInfo.mode & 0o777,
    };
  }

  public async assertNoSymlinkComponents(root: string, relativePath: string): Promise<void> {
    const suppliedRoot = resolve(root);
    const suppliedInfo = await this.io.lstat(suppliedRoot);
    if (!suppliedInfo.isDirectory() || suppliedInfo.isSymbolicLink()) {
      throw new CodeBridgeError("OUTSIDE_ROOT", "Approved root is not a real directory.");
    }
    const canonicalRoot = await this.io.realpath(root);
    const canonicalInfo = await this.io.lstat(canonicalRoot);
    if (
      !canonicalInfo.isDirectory() ||
      canonicalInfo.isSymbolicLink() ||
      suppliedInfo.dev !== canonicalInfo.dev ||
      suppliedInfo.ino !== canonicalInfo.ino
    ) {
      throw new CodeBridgeError("OUTSIDE_ROOT", "Approved root identity changed.");
    }
    const canonicalTarget = resolve(canonicalRoot, relativePath);
    if (!within(canonicalRoot, canonicalTarget)) {
      throw new CodeBridgeError("OUTSIDE_ROOT", "Path escaped the approved root.");
    }
    const rootInfo = await this.io.lstat(canonicalRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new CodeBridgeError("OUTSIDE_ROOT", "Approved root is not a real directory.");
    }
    let current = canonicalRoot;
    const components = relative(canonicalRoot, canonicalTarget).split(sep).filter(Boolean);
    for (const component of components) {
      current = resolve(current, component);
      const info = await this.io.lstat(current);
      if (info.isSymbolicLink())
        throw new CodeBridgeError("SYMLINK_BLOCKED", "Path cannot traverse symlinks.");
      if (current !== canonicalTarget && !info.isDirectory()) {
        throw new CodeBridgeError(
          "UNSUPPORTED_FILE_TYPE",
          "Parent path component is not a directory.",
        );
      }
    }
  }
}
