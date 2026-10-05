import { StringDecoder } from "node:string_decoder";
import { SecretScanner } from "./secret-scanner.js";

const PRIVATE_KEY_START = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export class StreamingRedactor {
  private readonly scanner = new SecretScanner();
  private readonly decoder = new StringDecoder("utf8");
  private bufferedText = "";
  private seenBytes = 0;
  private closed = false;

  public constructor(private readonly maxBytes = DEFAULT_MAX_BYTES) {}

  public push(chunk: string | Uint8Array): string {
    if (this.closed) throw new Error("Cannot write to a closed StreamingRedactor.");
    const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (this.seenBytes + bytes > this.maxBytes) {
      throw new RangeError("Streaming redaction buffer limit exceeded.");
    }
    this.seenBytes += bytes;
    this.bufferedText += typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
    return "";
  }

  public flush(): string {
    if (this.closed) return "";
    this.closed = true;
    this.bufferedText += this.decoder.end();
    const unclosedPrivateKey = PRIVATE_KEY_START.exec(this.bufferedText);
    if (unclosedPrivateKey?.index !== undefined) {
      const before = this.scanner.redact(this.bufferedText.slice(0, unclosedPrivateKey.index));
      return `${before}[REDACTED_PRIVATE_KEY]`;
    }
    const output = this.scanner.redact(this.bufferedText);
    this.bufferedText = "";
    return output;
  }
}
