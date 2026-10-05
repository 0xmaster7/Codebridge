import { CodeBridgeError } from "../errors.js";
import type { CheckProfile } from "../config/schema.js";
import type { WorktreeSnapshot } from "../snapshot/manager.js";
import { PathGuard } from "../security/path-guard.js";

const commandLike = /[$`;'"\\\r\n\0&|><]/;

export function validateTargets(
  targets: readonly string[],
  profile: CheckProfile,
  snapshot: WorktreeSnapshot,
): readonly string[] {
  if (profile.targetMode === "none" && targets.length > 0) {
    throw new CodeBridgeError(
      "INVALID_CHECK_TARGET",
      "This approved check does not accept targets.",
    );
  }
  if (targets.length > 32)
    throw new CodeBridgeError("INVALID_CHECK_TARGET", "Too many check targets.");
  const guard = new PathGuard();
  const validated: string[] = [];
  for (const target of targets) {
    if (commandLike.test(target) || target.startsWith("-") || target.startsWith("~")) {
      throw new CodeBridgeError(
        "INVALID_CHECK_TARGET",
        "Check targets must be plain repository-relative paths.",
      );
    }
    let path: string;
    try {
      path = guard.normalizeRelativePath(target);
    } catch {
      throw new CodeBridgeError(
        "INVALID_CHECK_TARGET",
        "Check target is not a normalized repository-relative path.",
      );
    }
    const entry = snapshot.entries.find((candidate) => candidate.path === path);
    if (!entry || entry.type !== "file") {
      throw new CodeBridgeError(
        "INVALID_CHECK_TARGET",
        "Check target is not a safe regular file in the audit snapshot.",
      );
    }
    const exactAllowed = profile.allowedTargetPaths.includes(path);
    const suffixAllowed = profile.allowedTargetSuffixes.some((suffix) =>
      path.toLowerCase().endsWith(suffix),
    );
    if (!exactAllowed && !suffixAllowed) {
      throw new CodeBridgeError(
        "INVALID_CHECK_TARGET",
        "Check target is outside the profile allowlist.",
      );
    }
    if (
      profile.allowedTargetPaths.some(
        (allowed) => allowed.startsWith("/") || allowed.split("/").includes(".."),
      )
    ) {
      throw new CodeBridgeError(
        "CONFIG_INVALID",
        "Approved check profile contains an unsafe target path.",
      );
    }
    validated.push(path);
  }
  if (profile.targetMode === "paths" && validated.length === 0) {
    throw new CodeBridgeError(
      "INVALID_CHECK_TARGET",
      "This approved check requires at least one target.",
    );
  }
  return [...new Set(validated)];
}
