import { CodeBridgeError } from "../errors.js";

export interface Limits {
  readonly maxSnapshotBytes: number;
  readonly maxFiles: number;
  readonly maxSingleReadableFileBytes: number;
  readonly maxSecretScanBytes: number;
  readonly maxReadResponseBytes: number;
  readonly maxSearchResults: number;
  readonly maxConcurrentReads: number;
  readonly maxConcurrentChecks: 1;
  readonly maxQueuedChecks: number;
  readonly maxRetainedOutputBytes: number;
}

export class LimitPolicy {
  public constructor(public readonly limits: Limits) {}

  public requireFileCount(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.limits.maxFiles) {
      throw new CodeBridgeError(
        "SNAPSHOT_LIMIT_EXCEEDED",
        "Snapshot file count exceeds the approved limit.",
      );
    }
  }

  public requireSnapshotBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limits.maxSnapshotBytes) {
      throw new CodeBridgeError(
        "SNAPSHOT_LIMIT_EXCEEDED",
        "Snapshot size exceeds the approved limit.",
      );
    }
  }

  public requireSecretScanBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limits.maxSecretScanBytes) {
      throw new CodeBridgeError(
        "SECRET_SCAN_LIMIT",
        "Object exceeds the approved secret scan limit.",
      );
    }
  }

  public boundedReadResponse(requestedBytes: number): number {
    if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 0) {
      throw new CodeBridgeError(
        "INVALID_ARGUMENT",
        "Requested response size must be a non-negative integer.",
      );
    }
    return Math.min(requestedBytes, this.limits.maxReadResponseBytes);
  }

  public boundedSearchResults(requested: number): number {
    if (!Number.isSafeInteger(requested) || requested < 1) {
      throw new CodeBridgeError(
        "INVALID_ARGUMENT",
        "Search result limit must be a positive integer.",
      );
    }
    return Math.min(requested, this.limits.maxSearchResults);
  }
}
