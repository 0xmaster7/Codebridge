import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { CodeBridgeError } from "../errors.js";

export interface AuditEvent {
  readonly timestamp: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly snapshotId: string;
  readonly tool: string;
  readonly decision: "allow" | "deny";
  readonly result: "success" | "error";
  readonly durationMs: number;
  readonly returnedBytes: number;
  readonly truncated: boolean;
  readonly target?: string;
  readonly checkId?: string;
  readonly exitCode?: number;
  readonly sandboxDigest?: string;
  readonly errorCode?: string;
  readonly argumentNames: readonly string[];
}

export interface AuditEventMetadata {
  readonly requestId: string;
  readonly durationMs: number;
  readonly returnedBytes: number;
  readonly truncated: boolean;
  readonly target?: string;
  readonly checkId?: string;
  readonly exitCode?: number;
  readonly sandboxDigest?: string;
  readonly errorCode?: string;
}

const ROTATED_FILE = "audit.jsonl.1";

export class SessionAuditLog {
  private appendQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly sessionRoot: string,
    private readonly sessionId: string,
    private readonly snapshotId: string,
    private readonly maxBytes: number,
  ) {}

  public append(
    tool: string,
    result: "success" | "error",
    argumentNames: readonly string[],
    metadata: AuditEventMetadata,
  ): Promise<void> {
    const pending = this.appendQueue.then(() =>
      this.appendOne(tool, result, argumentNames, metadata),
    );
    this.appendQueue = pending.catch(() => undefined);
    return pending;
  }

  private async appendOne(
    tool: string,
    result: "success" | "error",
    argumentNames: readonly string[],
    metadata: AuditEventMetadata,
  ): Promise<void> {
    if (
      !/^[a-z][a-z0-9_]{0,63}$/.test(tool) ||
      argumentNames.length > 32 ||
      !/^[0-9a-f-]{36}$/.test(metadata.requestId) ||
      !Number.isSafeInteger(metadata.durationMs) ||
      metadata.durationMs < 0 ||
      !Number.isSafeInteger(metadata.returnedBytes) ||
      metadata.returnedBytes < 0 ||
      (metadata.target !== undefined &&
        (!/^[A-Za-z0-9._/-]{1,512}$/.test(metadata.target) ||
          metadata.target.split("/").some((part) => part === ".." || part === ""))) ||
      (metadata.checkId !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(metadata.checkId)) ||
      (metadata.exitCode !== undefined && !Number.isSafeInteger(metadata.exitCode)) ||
      (metadata.sandboxDigest !== undefined &&
        !/^sha256:[a-f0-9]{64}$/.test(metadata.sandboxDigest))
    ) {
      throw new CodeBridgeError("INVALID_ARGUMENT", "Audit event metadata is invalid.");
    }
    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      requestId: metadata.requestId,
      snapshotId: this.snapshotId,
      tool,
      decision: result === "success" ? "allow" : "deny",
      result,
      durationMs: metadata.durationMs,
      returnedBytes: metadata.returnedBytes,
      truncated: metadata.truncated,
      ...(metadata.target === undefined ? {} : { target: metadata.target }),
      ...(metadata.checkId === undefined ? {} : { checkId: metadata.checkId }),
      ...(metadata.exitCode === undefined ? {} : { exitCode: metadata.exitCode }),
      ...(metadata.sandboxDigest === undefined ? {} : { sandboxDigest: metadata.sandboxDigest }),
      ...(metadata.errorCode === undefined ? {} : { errorCode: metadata.errorCode }),
      argumentNames: [
        ...new Set(argumentNames.filter((name) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name))),
      ].sort(),
    };
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line) > Math.min(this.maxBytes, 4096)) {
      throw new CodeBridgeError("SNAPSHOT_LIMIT_EXCEEDED", "Audit event exceeds its safe limit.");
    }
    await mkdir(this.sessionRoot, { mode: 0o700, recursive: true });
    const path = join(this.sessionRoot, "audit.jsonl");
    let size = 0;
    try {
      const current = await lstat(path);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.nlink !== 1 ||
        (current.mode & 0o777) !== 0o600
      ) {
        throw new CodeBridgeError("CONFIG_PERMISSION_UNSAFE", "Session audit log is unsafe.");
      }
      size = current.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (size + Buffer.byteLength(line) > this.maxBytes) {
      await rm(join(this.sessionRoot, ROTATED_FILE), { force: true });
      try {
        await rename(path, join(this.sessionRoot, ROTATED_FILE));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        (info.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && info.uid !== process.getuid())
      ) {
        throw new CodeBridgeError("CONFIG_PERMISSION_UNSAFE", "Session audit log is unsafe.");
      }
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
