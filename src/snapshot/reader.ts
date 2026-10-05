import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join, relative, sep } from "node:path";
import { CodeBridgeError } from "../errors.js";
import { LimitPolicy } from "../security/limit-policy.js";
import { PathGuard } from "../security/path-guard.js";
import { SecretScanner } from "../security/secret-scanner.js";
import type { ProjectConfig } from "../config/schema.js";
import type { SnapshotEntry, WorktreeSnapshot } from "./manager.js";
import { SnapshotGuard } from "../security/snapshot-guard.js";

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly truncated: boolean;
}

export interface FileReadResult {
  readonly path: string;
  readonly sha256: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
  readonly truncated: boolean;
  readonly sourceTrust: "untrusted_repository_content";
  readonly snapshotId: string;
}

interface CursorData {
  readonly version: 1;
  readonly sessionId: string;
  readonly tool: string;
  readonly querySha256: string;
  readonly offset: number;
  readonly expiresAt: number;
}

function queryDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function encodeCursor(value: CursorData, secret: Buffer): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodeCursor(
  value: string | null | undefined,
  snapshot: WorktreeSnapshot,
  tool: string,
  querySha256: string,
  secret: Buffer,
): number {
  if (!value) return 0;
  try {
    const [payload, signature] = value.split(".");
    if (!payload || !signature) throw new Error("cursor format is invalid");
    const expectedSignature = createHmac("sha256", secret).update(payload).digest();
    const actualSignature = Buffer.from(signature, "base64url");
    if (
      actualSignature.length !== expectedSignature.length ||
      !timingSafeEqual(actualSignature, expectedSignature)
    ) {
      throw new Error("cursor signature is invalid");
    }
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CursorData;
    if (
      decoded.version !== 1 ||
      decoded.sessionId !== snapshot.sessionId ||
      decoded.tool !== tool ||
      decoded.querySha256 !== querySha256 ||
      !Number.isSafeInteger(decoded.offset) ||
      decoded.offset < 0 ||
      decoded.expiresAt < Date.now()
    ) {
      throw new Error("cursor binding mismatch");
    }
    return decoded.offset;
  } catch {
    throw new CodeBridgeError("INVALID_ARGUMENT", "Pagination cursor is invalid or expired.");
  }
}

function makePage<T>(
  items: readonly T[],
  offset: number,
  pageSize: number,
  total: number,
  snapshot: WorktreeSnapshot,
  tool: string,
  querySha256: string,
  secret: Buffer,
): Page<T> {
  const next = offset + items.length;
  return {
    items,
    nextCursor:
      next < total
        ? encodeCursor(
            {
              version: 1,
              sessionId: snapshot.sessionId,
              tool,
              querySha256,
              offset: next,
              expiresAt: Date.now() + 15 * 60 * 1000,
            },
            secret,
          )
        : null,
    truncated: next < total,
  };
}

function globRegex(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        expression += ".*";
        index += 1;
      } else expression += "[^/]*";
    } else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}$`, "u");
}

export class SnapshotReader {
  private readonly cursorSecret = randomBytes(32);
  private readonly pathGuard = new PathGuard();
  private readonly scanner = new SecretScanner();
  private readonly snapshotGuard = new SnapshotGuard();
  private readonly policy: LimitPolicy;
  private readonly entries: ReadonlyMap<string, SnapshotEntry>;

  public constructor(
    private readonly snapshot: WorktreeSnapshot,
    private readonly project: ProjectConfig,
  ) {
    this.policy = new LimitPolicy(project.limits);
    this.entries = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
  }

  public tree(args: {
    path?: string | undefined;
    depth?: number;
    cursor?: string | null | undefined;
    maxEntries?: number | undefined;
  }): Page<SnapshotEntry> {
    const path =
      args.path === "." || args.path === undefined
        ? "."
        : this.pathGuard.normalizeRelativePath(args.path);
    const depth = args.depth ?? 4;
    const maxEntries = Math.min(args.maxEntries ?? 1000, 2000);
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > 32) {
      throw new CodeBridgeError("INVALID_ARGUMENT", "Tree depth must be from 0 to 32.");
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new CodeBridgeError("INVALID_ARGUMENT", "Tree page size must be positive.");
    }
    const query = { path, depth, maxEntries };
    const digest = queryDigest(query);
    const offset = decodeCursor(args.cursor, this.snapshot, "repo_tree", digest, this.cursorSecret);
    const matches = this.snapshot.entries
      .filter((entry) => {
        const rel = path === "." ? entry.path : relative(path, entry.path).split(sep).join("/");
        if (rel.startsWith("../") || rel === ".." || rel === "") return false;
        return rel.split("/").length <= depth;
      })
      .slice(offset, offset + maxEntries);
    return makePage(
      matches,
      offset,
      maxEntries,
      this.snapshot.entries.filter((entry) => {
        const rel = path === "." ? entry.path : relative(path, entry.path).split(sep).join("/");
        return (
          !rel.startsWith("../") && rel !== ".." && rel !== "" && rel.split("/").length <= depth
        );
      }).length,
      this.snapshot,
      "repo_tree",
      digest,
      this.cursorSecret,
    );
  }

  public findPaths(args: {
    pattern: string;
    path?: string | undefined;
    cursor?: string | null | undefined;
    maxResults?: number | undefined;
  }): Page<SnapshotEntry> {
    if (args.pattern.length < 1 || args.pattern.length > 512) {
      throw new CodeBridgeError("INVALID_ARGUMENT", "Path pattern length is invalid.");
    }
    const basePath = args.path ? this.pathGuard.normalizeRelativePath(args.path) : ".";
    const regex = globRegex(args.pattern.normalize("NFC"));
    const maxResults = this.policy.boundedSearchResults(args.maxResults ?? 100);
    const query = { pattern: args.pattern, basePath, maxResults };
    const digest = queryDigest(query);
    const offset = decodeCursor(
      args.cursor,
      this.snapshot,
      "find_paths",
      digest,
      this.cursorSecret,
    );
    const all = this.snapshot.entries.filter((entry) => {
      const rel =
        basePath === "." ? entry.path : relative(basePath, entry.path).split(sep).join("/");
      return rel !== ".." && !rel.startsWith("../") && regex.test(rel);
    });
    return makePage(
      all.slice(offset, offset + maxResults),
      offset,
      maxResults,
      all.length,
      this.snapshot,
      "find_paths",
      digest,
      this.cursorSecret,
    );
  }

  public async readFile(args: {
    path: string;
    startLine?: number | undefined;
    endLine?: number | undefined;
  }): Promise<FileReadResult> {
    const path = this.pathGuard.assertNotSecretPath(args.path);
    const entry = this.entries.get(path);
    if (!entry)
      throw new CodeBridgeError("FILE_NOT_FOUND", "Path is not present in the audit snapshot.");
    if (entry.type === "symlink")
      throw new CodeBridgeError("SYMLINK_BLOCKED", "Symlink content is not readable.");
    if (entry.type === "blocked") {
      const reason = entry.reason ?? "UNSUPPORTED_FILE_TYPE";
      if (reason.startsWith("SECRET"))
        throw new CodeBridgeError("SECRET_BLOCKED", "File content is blocked by secret policy.");
      if (reason === "HARDLINK_BLOCKED")
        throw new CodeBridgeError("HARDLINK_BLOCKED", "Hardlinked file content is unavailable.");
      throw new CodeBridgeError(
        "UNSUPPORTED_FILE_TYPE",
        "File content is unavailable in this snapshot.",
      );
    }
    if (entry.type !== "file")
      throw new CodeBridgeError("UNSUPPORTED_FILE_TYPE", "Path is not a regular file.");
    if ((entry.size ?? 0) > this.project.limits.maxSecretScanBytes) {
      throw new CodeBridgeError(
        "SECRET_SCAN_LIMIT",
        "File exceeds the whole-object secret scan limit.",
      );
    }
    if ((entry.size ?? 0) > this.project.limits.maxSingleReadableFileBytes) {
      throw new CodeBridgeError(
        "FILE_TOO_LARGE",
        "File exceeds the configured readable file limit.",
      );
    }
    const { digest, text } = await this.readSafeText(path, entry);
    const lines = text.split(/\r?\n/);
    const startLine = args.startLine ?? 1;
    const endLine = args.endLine ?? lines.length;
    if (
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLine) ||
      startLine < 1 ||
      endLine < startLine
    ) {
      throw new CodeBridgeError("INVALID_ARGUMENT", "Requested line range is invalid.");
    }
    if (startLine > lines.length) {
      throw new CodeBridgeError(
        "INVALID_ARGUMENT",
        "Requested line range starts after end of file.",
      );
    }
    const selected = lines.slice(startLine - 1, endLine);
    const boundedBytes = this.policy.boundedReadResponse(this.project.limits.maxReadResponseBytes);
    let content = "";
    for (let index = 0; index < selected.length; index += 1) {
      const line = `${startLine + index}: ${selected[index] ?? ""}${index + 1 < selected.length ? "\n" : ""}`;
      if (Buffer.byteLength(content + line, "utf8") > boundedBytes) break;
      content += line;
    }
    const returnedLineCount = content === "" ? 0 : content.split("\n").length;
    return {
      path,
      sha256: digest,
      startLine,
      endLine: Math.min(endLine, startLine + returnedLineCount - 1),
      content,
      truncated: startLine - 1 + returnedLineCount < Math.min(endLine, lines.length),
      sourceTrust: "untrusted_repository_content",
      snapshotId: this.snapshot.snapshotId,
    };
  }

  private async readSafeText(
    path: string,
    entry: SnapshotEntry,
  ): Promise<{ digest: string; text: string }> {
    const fullPath = join(this.snapshot.root, ...path.split("/"));
    await this.snapshotGuard.assertNoSymlinkComponents(this.snapshot.root, path);
    const {
      bytes,
      sha256: digest,
      size,
    } = await this.snapshotGuard.readRegularFile(fullPath, {
      maxBytes: this.project.limits.maxSecretScanBytes,
    });
    if (size !== entry.size)
      throw new CodeBridgeError("SNAPSHOT_RACE_DETECTED", "Snapshot file size changed.");
    if (digest !== entry.sha256)
      throw new CodeBridgeError("SNAPSHOT_RACE_DETECTED", "Snapshot file digest changed.");
    this.policy.requireSecretScanBytes(bytes.byteLength);
    if (this.scanner.scan(bytes).blocked)
      throw new CodeBridgeError("SECRET_BLOCKED", "File content is blocked by secret policy.");
    if (bytes.includes(0))
      throw new CodeBridgeError("BINARY_FILE", "Binary file content is not returned.");
    return { digest, text: new TextDecoder("utf-8", { fatal: false }).decode(bytes) };
  }

  public async readFiles(
    paths: readonly string[],
  ): Promise<readonly { path: string; result?: FileReadResult; error?: string }[]> {
    if (paths.length < 1 || paths.length > 32) {
      throw new CodeBridgeError("INVALID_ARGUMENT", "Batch reads accept from 1 to 32 paths.");
    }
    const results = [];
    let bytes = 0;
    for (const path of paths) {
      try {
        const result = await this.readFile({ path });
        bytes += Buffer.byteLength(result.content);
        if (bytes > 1024 * 1024)
          throw new CodeBridgeError("FILE_TOO_LARGE", "Batch response exceeds one MiB.");
        results.push({ path, result });
      } catch (error) {
        results.push({
          path,
          error: error instanceof CodeBridgeError ? error.code : "INTERNAL_ERROR",
        });
      }
    }
    return results;
  }

  public async search(args: {
    query: string;
    paths?: readonly string[] | undefined;
    caseSensitive?: boolean | undefined;
    contextLines?: number | undefined;
    maxResults?: number | undefined;
    cursor?: string | null | undefined;
  }): Promise<
    Page<{
      path: string;
      sha256: string;
      line: number;
      text: string;
      sourceTrust: "untrusted_repository_content";
    }>
  > {
    if (args.query.length < 1 || args.query.length > 4096 || args.query.includes("\0")) {
      throw new CodeBridgeError("INVALID_ARGUMENT", "Search query is empty or too large.");
    }
    const contextLines = args.contextLines ?? 0;
    if (!Number.isSafeInteger(contextLines) || contextLines < 0 || contextLines > 5) {
      throw new CodeBridgeError("INVALID_ARGUMENT", "Search context must be from 0 to 5 lines.");
    }
    const maxResults = this.policy.boundedSearchResults(args.maxResults ?? 100);
    const patterns = (args.paths ?? ["**"]).map((pattern) => globRegex(pattern));
    const queryConfig = {
      query: args.query,
      paths: args.paths ?? ["**"],
      caseSensitive: args.caseSensitive ?? false,
      contextLines,
      maxResults,
    };
    const digest = queryDigest(queryConfig);
    const offset = decodeCursor(
      args.cursor,
      this.snapshot,
      "search_repo",
      digest,
      this.cursorSecret,
    );
    const needle = args.caseSensitive === true ? args.query : args.query.toLocaleLowerCase("en-US");
    const matches: {
      path: string;
      sha256: string;
      line: number;
      text: string;
      sourceTrust: "untrusted_repository_content";
    }[] = [];
    for (const entry of this.snapshot.entries) {
      if (entry.type !== "file") continue;
      if (!patterns.some((pattern) => pattern.test(entry.path))) continue;
      if ((entry.size ?? 0) > this.project.limits.maxSingleReadableFileBytes) continue;
      let text: string;
      try {
        ({ text } = await this.readSafeText(entry.path, entry));
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const candidate = args.caseSensitive === true ? line : line.toLocaleLowerCase("en-US");
        if (candidate.includes(needle)) {
          matches.push({
            path: entry.path,
            sha256: entry.sha256 ?? "",
            line: index + 1,
            text: lines
              .slice(Math.max(0, index - contextLines), index + contextLines + 1)
              .join("\n"),
            sourceTrust: "untrusted_repository_content",
          });
          if (matches.length >= this.project.limits.maxSearchResults + 1) break;
        }
      }
      if (matches.length >= this.project.limits.maxSearchResults + 1) break;
    }
    const bounded = matches.slice(0, maxResults);
    return makePage(
      bounded.slice(offset, offset + maxResults),
      offset,
      maxResults,
      matches.length,
      this.snapshot,
      "search_repo",
      digest,
      this.cursorSecret,
    );
  }
}
