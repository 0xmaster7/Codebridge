import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { CodeBridgeError } from "../errors.js";
import { PathGuard } from "../security/path-guard.js";
import { SecretScanner } from "../security/secret-scanner.js";
import { SnapshotGuard } from "../security/snapshot-guard.js";
import type { ProjectConfig } from "../config/schema.js";
import type { GitMirror } from "./mirror.js";
import type { WorktreeSnapshot } from "../snapshot/manager.js";

export interface GitStatusModel {
  readonly snapshotId: string;
  readonly headSha: string | null;
  readonly branch: string | null;
  readonly stagedChanges: readonly string[];
  readonly modifiedPaths: readonly string[];
  readonly deletedPaths: readonly string[];
  readonly untrackedPaths: readonly string[];
  readonly unavailablePaths: readonly string[];
  readonly workingTree: "clean" | "dirty" | "partially-observed";
  readonly warnings: readonly string[];
}

function gitBlobOid(bytes: Uint8Array, format: "sha1" | "sha256"): string {
  const hash = createHash(format);
  hash.update(`blob ${bytes.byteLength}\0`);
  hash.update(bytes);
  return hash.digest("hex");
}

function parseIndex(data: string): Map<string, { mode: string; oid: string }> {
  const entries = new Map<string, { mode: string; oid: string }>();
  for (const item of data.split("\0")) {
    if (!item) continue;
    const tab = item.indexOf("\t");
    if (tab < 0) throw new CodeBridgeError("GIT_FAILED", "Session Git index output is malformed.");
    const [mode, oid] = item.slice(0, tab).split(" ");
    const stage = item.slice(0, tab).split(" ")[2];
    const path = item.slice(tab + 1);
    if (stage !== "0" || !mode || !oid) continue;
    entries.set(path, { mode, oid });
  }
  return entries;
}

function safeListedPath(path: string, guard: PathGuard): string {
  try {
    return guard.assertNotSecretPath(path);
  } catch {
    return "[UNAVAILABLE_PATH]";
  }
}

export class GitAudit {
  private readonly pathGuard = new PathGuard();
  private readonly scanner = new SecretScanner();
  private readonly snapshotGuard = new SnapshotGuard();

  public constructor(
    private readonly project: ProjectConfig,
    private readonly snapshot: WorktreeSnapshot,
    private readonly mirror: GitMirror,
    private readonly sessionRoot: string,
  ) {}

  public async status(): Promise<GitStatusModel> {
    const indexResult = await this.mirror.runner.run(["ls-files", "--stage", "-z"]);
    const index = parseIndex(indexResult.stdout);
    const stagedResult = this.mirror.headSha
      ? await this.mirror.runner.run(["diff", "--cached", "--name-only", "-z", "HEAD"])
      : {
          stdout: indexResult.stdout
            .split("\0")
            .filter(Boolean)
            .map((item) => item.slice(item.indexOf("\t") + 1))
            .join("\0"),
          stderr: "",
          exitCode: 0,
        };
    const staged = [...new Set(stagedResult.stdout.split("\0").filter(Boolean))].map((path) =>
      safeListedPath(path, this.pathGuard),
    );
    const files = new Map(this.snapshot.entries.map((entry) => [entry.path, entry]));
    const modified: string[] = [];
    const deleted: string[] = [];
    const unavailable: string[] = [];
    for (const [path, indexed] of index) {
      const entry = files.get(path);
      if (!entry) {
        deleted.push(safeListedPath(path, this.pathGuard));
        continue;
      }
      if (entry.type !== "file" && entry.type !== "symlink") {
        unavailable.push(safeListedPath(path, this.pathGuard));
        continue;
      }
      if (entry.type === "symlink") {
        unavailable.push(safeListedPath(path, this.pathGuard));
        continue;
      }
      let content: Buffer;
      try {
        content = await this.readSnapshotFile(path, entry);
      } catch {
        unavailable.push(safeListedPath(path, this.pathGuard));
        continue;
      }
      const oid = gitBlobOid(content, this.mirror.objectFormat);
      const indexExecutable = indexed.mode === "100755";
      const worktreeExecutable = ((entry.mode ?? 0) & 0o111) !== 0;
      if (oid !== indexed.oid || indexExecutable !== worktreeExecutable) {
        modified.push(safeListedPath(path, this.pathGuard));
      }
    }
    const untracked = this.snapshot.entries
      .filter(
        (entry) => (entry.type === "file" || entry.type === "symlink") && !index.has(entry.path),
      )
      .map((entry) => safeListedPath(entry.path, this.pathGuard));
    const stagedPaths = [...new Set(staged)].sort();
    const modifiedPaths = [...new Set(modified)].sort();
    const deletedPaths = [...new Set(deleted)].sort();
    const untrackedPaths = [...new Set(untracked)].sort();
    const unavailablePaths = [...new Set(unavailable)].sort();
    const dirty =
      stagedPaths.length + modifiedPaths.length + deletedPaths.length + untrackedPaths.length > 0;
    const partial =
      unavailablePaths.length > 0 ||
      this.snapshot.entries.some((entry) => entry.type === "blocked");
    return {
      snapshotId: this.snapshot.snapshotId,
      headSha: this.mirror.headSha,
      branch: this.mirror.branch,
      stagedChanges: stagedPaths,
      modifiedPaths,
      deletedPaths,
      untrackedPaths,
      unavailablePaths,
      workingTree: partial ? "partially-observed" : dirty ? "dirty" : "clean",
      warnings: partial ? ["PARTIAL_SNAPSHOT_OBSERVATION"] : [],
    };
  }

  public async log(
    count = 20,
  ): Promise<readonly { sha: string; author: string; date: string; subject: string }[]> {
    if (!Number.isSafeInteger(count) || count < 1)
      throw new CodeBridgeError("INVALID_ARGUMENT", "Commit count must be positive.");
    const bounded = Math.min(count, 100);
    if (!this.mirror.headSha) return [];
    const result = await this.mirror.runner.run([
      "log",
      `-${bounded}`,
      "--format=%H%x00%an%x00%aI%x00%s%x00",
      this.mirror.headSha,
    ]);
    const fields = result.stdout.split("\0").filter(Boolean);
    const commits = [];
    for (let index = 0; index + 3 < fields.length; index += 4) {
      commits.push({
        sha: fields[index] ?? "",
        author: fields[index + 1] ?? "",
        date: fields[index + 2] ?? "",
        subject: fields[index + 3] ?? "",
      });
    }
    return commits;
  }

  public async show(args: {
    revision: string;
    path: string;
    startLine?: number | undefined;
    endLine?: number | undefined;
  }): Promise<{
    revision: string;
    path: string;
    blobSha: string;
    content: string;
    startLine: number;
    endLine: number;
    sourceTrust: "untrusted_repository_content";
    snapshotId: string;
  }> {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(args.revision)) {
      throw new CodeBridgeError(
        "INVALID_REVISION",
        "Revision must be a full immutable commit SHA.",
      );
    }
    const path = this.pathGuard.assertNotSecretPath(args.path);
    const commit = await this.mirror.runner.run(
      ["rev-parse", "--verify", `${args.revision}^{commit}`],
      { allowFailure: true },
    );
    if (commit.exitCode !== 0)
      throw new CodeBridgeError(
        "INVALID_REVISION",
        "Revision is not present in the session Git mirror.",
      );
    const tree = await this.mirror.runner.run(["ls-tree", "-z", commit.stdout.trim(), "--", path]);
    const record = tree.stdout.split("\0").find(Boolean);
    if (!record)
      throw new CodeBridgeError("FILE_NOT_FOUND", "Path is not present at the requested revision.");
    const tab = record.indexOf("\t");
    const metadata = record.slice(0, tab).split(" ");
    const mode = metadata[0];
    const type = metadata[1];
    const blobSha = metadata[2];
    if (type !== "blob" || !blobSha || mode === "120000") {
      throw new CodeBridgeError("UNSUPPORTED_FILE_TYPE", "Historical path is not a regular blob.");
    }
    const sizeResult = await this.mirror.runner.run(["cat-file", "-s", blobSha]);
    const size = Number.parseInt(sizeResult.stdout.trim(), 10);
    if (!Number.isSafeInteger(size) || size > this.project.limits.maxSecretScanBytes) {
      throw new CodeBridgeError(
        "SECRET_SCAN_LIMIT",
        "Historical blob exceeds the whole-object secret scan limit.",
      );
    }
    if (size > this.project.limits.maxSingleReadableFileBytes) {
      throw new CodeBridgeError(
        "FILE_TOO_LARGE",
        "Historical blob exceeds the configured readable file limit.",
      );
    }
    const result = await this.mirror.runner.run(["cat-file", "blob", blobSha]);
    if (result.stdout.includes("[REDACTED_")) {
      throw new CodeBridgeError(
        "SECRET_BLOCKED",
        "Historical blob contains a high-confidence secret.",
      );
    }
    if (this.scanner.scan(result.stdout).blocked)
      throw new CodeBridgeError("SECRET_BLOCKED", "Historical blob contains a blocked secret.");
    if (result.stdout.includes("\0"))
      throw new CodeBridgeError("BINARY_FILE", "Binary historical blobs are not returned.");
    const lines = result.stdout.split(/\r?\n/);
    const startLine = args.startLine ?? 1;
    const endLine = Math.min(args.endLine ?? lines.length, lines.length);
    if (
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLine) ||
      startLine < 1 ||
      endLine < startLine
    ) {
      throw new CodeBridgeError("INVALID_ARGUMENT", "Requested historical line range is invalid.");
    }
    return {
      revision: commit.stdout.trim(),
      path,
      blobSha,
      content: lines
        .slice(startLine - 1, endLine)
        .map((line, index) => `${startLine + index}: ${line}`)
        .join("\n"),
      startLine,
      endLine,
      sourceTrust: "untrusted_repository_content",
      snapshotId: this.snapshot.snapshotId,
    };
  }

  public async diff(args: {
    mode: "audit-working-tree" | "commits";
    from?: string | undefined;
    to?: string | undefined;
  }): Promise<{
    mode: string;
    diff: string;
    truncated: boolean;
    snapshotId: string;
    sourceTrust: "untrusted_repository_content";
  }> {
    if (args.mode === "commits") {
      const from = args.from ?? "";
      const to = args.to ?? "";
      for (const rev of [from, to]) {
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(rev)) {
          throw new CodeBridgeError(
            "INVALID_REVISION",
            "Commit diffs require full immutable commit SHAs.",
          );
        }
        const resolved = await this.mirror.runner.run(
          ["rev-parse", "--verify", `${rev}^{commit}`],
          { allowFailure: true },
        );
        if (resolved.exitCode !== 0)
          throw new CodeBridgeError(
            "INVALID_REVISION",
            "A commit is not present in the session Git mirror.",
          );
      }
      const result = await this.mirror.runner.run([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-renames",
        "--unified=3",
        from,
        to,
      ]);
      return {
        mode: args.mode,
        diff: result.stdout,
        truncated: false,
        snapshotId: this.snapshot.snapshotId,
        sourceTrust: "untrusted_repository_content",
      };
    }
    const status = await this.status();
    const files = [
      ...new Set([...status.modifiedPaths, ...status.deletedPaths, ...status.untrackedPaths]),
    ]
      .filter((path) => path !== "[UNAVAILABLE_PATH]")
      .slice(0, 200);
    const tempRoot = join(this.sessionRoot, "tmp", `diff-${randomUUID()}`);
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    const fragments: string[] = [];
    try {
      const index = parseIndex(
        (await this.mirror.runner.run(["ls-files", "--stage", "-z"])).stdout,
      );
      for (const path of files) {
        const safePath = this.pathGuard.normalizeRelativePath(path);
        const oldFile = join(tempRoot, "old", ...safePath.split("/"));
        const newFile = join(tempRoot, "new", ...safePath.split("/"));
        await mkdir(join(oldFile, ".."), { recursive: true, mode: 0o700 });
        await mkdir(join(newFile, ".."), { recursive: true, mode: 0o700 });
        const previous = index.get(safePath);
        if (previous) {
          const oldBlob = await this.mirror.runner.run(["cat-file", "blob", previous.oid]);
          if (oldBlob.stdout.includes("[REDACTED_")) continue;
          await writePrivateFile(oldFile, oldBlob.stdout);
        } else await writePrivateFile(oldFile, "");
        const snapshotEntry = this.snapshot.entries.find((entry) => entry.path === safePath);
        if (snapshotEntry?.type === "file") {
          const bytes = await this.readSnapshotFile(safePath, snapshotEntry);
          if (this.scanner.scan(bytes).blocked) continue;
          await writePrivateFile(newFile, bytes);
        } else await writePrivateFile(newFile, "");
        const diffResult = await this.mirror.runner.run(
          [
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--unified=3",
            "--",
            oldFile,
            newFile,
          ],
          { allowFailure: true },
        );
        if (diffResult.stdout) fragments.push(diffResult.stdout);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
    const text = fragments.join("\n");
    const limit = this.project.limits.maxRetainedOutputBytes;
    const bounded =
      Buffer.byteLength(text) > limit
        ? Buffer.from(text).subarray(0, limit).toString("utf8")
        : text;
    return {
      mode: args.mode,
      diff: bounded,
      truncated: bounded.length < text.length,
      snapshotId: this.snapshot.snapshotId,
      sourceTrust: "untrusted_repository_content",
    };
  }

  private async readSnapshotFile(
    path: string,
    entry: { size?: number; sha256?: string },
  ): Promise<Buffer> {
    await this.snapshotGuard.assertNoSymlinkComponents(this.snapshot.root, path);
    const file = await this.snapshotGuard.readRegularFile(
      join(this.snapshot.root, ...path.split("/")),
      { maxBytes: this.project.limits.maxSecretScanBytes },
    );
    if (file.size !== entry.size || file.sha256 !== entry.sha256) {
      throw new CodeBridgeError("SNAPSHOT_RACE_DETECTED", "Captured snapshot file changed.");
    }
    return file.bytes;
  }
}

async function writePrivateFile(path: string, value: string | Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(value);
  } finally {
    await handle.close();
  }
}
