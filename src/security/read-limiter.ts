import { CodeBridgeError } from "../errors.js";

export class ReadLimiter {
  private active = 0;

  public constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new CodeBridgeError("CONFIG_INVALID", "Read concurrency limit is invalid.");
    }
  }

  public async run<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.active >= this.maximum) {
      throw new CodeBridgeError(
        "READ_LIMIT_EXCEEDED",
        "Concurrent repository read limit is full; retry after an active read finishes.",
      );
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
    }
  }
}
