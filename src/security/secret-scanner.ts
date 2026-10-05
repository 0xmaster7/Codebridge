export type SecretKind =
  "private-key" | "openai-key" | "github-token" | "aws-key" | "bearer-token" | "secret-assignment";

export interface SecretScanResult {
  readonly blocked: boolean;
  readonly kinds: readonly SecretKind[];
  readonly matchCount: number;
}

const detectors: ReadonlyArray<{ kind: SecretKind; pattern: RegExp }> = [
  {
    kind: "private-key",
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  },
  { kind: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/g },
  {
    kind: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g,
  },
  { kind: "aws-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  {
    kind: "secret-assignment",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret(?:[_-]?key)?|password|passwd|private[_-]?key)\b\s*[:=]\s*["']?([^\s"'`,;]{8,})/gi,
  },
];

function toText(content: Uint8Array | string): string {
  return typeof content === "string"
    ? content
    : new TextDecoder("utf-8", { fatal: false }).decode(content);
}

export class SecretScanner {
  public scan(content: Uint8Array | string): SecretScanResult {
    const text = toText(content);
    const kinds = new Set<SecretKind>();
    let matchCount = 0;
    for (const detector of detectors) {
      detector.pattern.lastIndex = 0;
      const matches = [...text.matchAll(detector.pattern)];
      if (matches.length > 0) {
        kinds.add(detector.kind);
        matchCount += matches.length;
      }
    }
    return { blocked: matchCount > 0, kinds: [...kinds].sort(), matchCount };
  }

  public redact(content: string): string {
    let output = content;
    for (const detector of detectors) {
      detector.pattern.lastIndex = 0;
      output = output.replace(
        detector.pattern,
        `[REDACTED_${detector.kind.toUpperCase().replaceAll("-", "_")}]`,
      );
    }
    return output;
  }
}
