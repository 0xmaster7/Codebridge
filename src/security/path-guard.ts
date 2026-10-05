import { CodeBridgeError } from "../errors.js";
import { classifySecretPath } from "./secret-policy.js";

const forbiddenPathCharacters = /[\0\r\n]/;

export class PathGuard {
  public normalizeRelativePath(path: string, options: { allowDot?: boolean } = {}): string {
    if (typeof path !== "string" || path.length === 0 || forbiddenPathCharacters.test(path)) {
      throw new CodeBridgeError(
        "INVALID_PATH",
        "Path must be a non-empty repository-relative string.",
      );
    }
    const normalized = path.normalize("NFC");
    if (
      normalized.startsWith("/") ||
      normalized.startsWith("~") ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.includes("\\") ||
      normalized.includes("//")
    ) {
      throw new CodeBridgeError("OUTSIDE_ROOT", "Absolute and non-portable paths are not allowed.");
    }
    if (normalized === "." && options.allowDot === true) return ".";
    const segments = normalized.split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
      throw new CodeBridgeError(
        "PATH_TRAVERSAL",
        "Dot segments and empty path components are not allowed.",
      );
    }
    if (segments.some((segment) => segment.trim() === "")) {
      throw new CodeBridgeError("INVALID_PATH", "Whitespace-only path components are not allowed.");
    }
    return normalized;
  }

  public assertNotSecretPath(path: string): string {
    const normalized = this.normalizeRelativePath(path);
    const reason = classifySecretPath(normalized);
    if (reason !== null) {
      throw new CodeBridgeError(
        "SECRET_BLOCKED",
        `Path is blocked by the secret path policy (${reason}).`,
      );
    }
    return normalized;
  }

  public isSecretPath(path: string): boolean {
    return classifySecretPath(path) !== null;
  }
}
