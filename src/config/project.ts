import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CodeBridgeError } from "../errors.js";
import type { ProjectConfig } from "./schema.js";
import { PathGuard } from "../security/path-guard.js";
import { SnapshotGuard } from "../security/snapshot-guard.js";

export interface RepositoryDiscovery {
  readonly worktreeRoot: string;
  readonly gitDirectory: string;
  readonly commonGitDirectory: string;
  readonly metadataRoots: readonly string[];
  readonly externalMetadataRoots: readonly string[];
  readonly requirementCandidates: readonly string[];
  readonly checkCandidates: readonly string[];
}

export function deriveProjectId(canonicalRoot: string): string {
  const digest = createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 16);
  return `cb-${digest}`;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function parseGitPointer(path: string): Promise<string> {
  const stat = await lstat(path);
  if (stat.isDirectory() && !stat.isSymbolicLink()) return realpath(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CodeBridgeError(
      "UNSUPPORTED_GIT_LAYOUT",
      "The .git entry must be a directory or pointer file.",
    );
  }
  const { bytes } = await new SnapshotGuard().readRegularFile(path, { maxBytes: 4096 });
  const value = bytes.toString("utf8");
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(value);
  if (!match?.[1])
    throw new CodeBridgeError("UNSUPPORTED_GIT_LAYOUT", "The .git pointer is malformed.");
  return realpath(resolve(join(path, ".."), match[1]));
}

async function resolveCommonGitDirectory(gitDirectory: string): Promise<string> {
  const commonDirPointer = join(gitDirectory, "commondir");
  try {
    const stat = await lstat(commonDirPointer);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new CodeBridgeError(
        "UNSUPPORTED_GIT_LAYOUT",
        "The Git commondir entry is not a regular file.",
      );
    }
    const { bytes } = await new SnapshotGuard().readRegularFile(commonDirPointer, {
      maxBytes: 4096,
    });
    const value = bytes.toString("utf8");
    if (value.includes("\0")) {
      throw new CodeBridgeError("UNSUPPORTED_GIT_LAYOUT", "The Git commondir pointer is invalid.");
    }
    const target = value.trim();
    if (!target || target.includes("\n") || target.includes("\r")) {
      throw new CodeBridgeError(
        "UNSUPPORTED_GIT_LAYOUT",
        "The Git commondir pointer is malformed.",
      );
    }
    return realpath(resolve(gitDirectory, target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return gitDirectory;
    throw error;
  }
}

export async function resolveAdditionalGitMetadata(
  discovery: RepositoryDiscovery,
  approvedRoots: readonly string[],
): Promise<RepositoryDiscovery> {
  if (
    !isWithin(discovery.worktreeRoot, discovery.gitDirectory) &&
    !approvedRoots.includes(discovery.gitDirectory)
  ) {
    throw new CodeBridgeError(
      "CONFIG_INVALID",
      "The external Git metadata directory must be approved before CodeBridge reads its commondir pointer.",
    );
  }
  const commonGitDirectory = await resolveCommonGitDirectory(discovery.gitDirectory);
  const metadataRoots = [...new Set([discovery.gitDirectory, commonGitDirectory])].sort();
  return {
    ...discovery,
    commonGitDirectory,
    metadataRoots,
    externalMetadataRoots: metadataRoots.filter((item) => !isWithin(discovery.worktreeRoot, item)),
  };
}

async function findExecutable(name: string): Promise<string | null> {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      const canonical = await realpath(candidate);
      const stat = await lstat(canonical);
      if (stat.isFile() && (stat.mode & constants.S_IXUSR) !== 0) return canonical;
    } catch {
      // A missing path entry or non-executable candidate is not an approval.
    }
  }
  return null;
}

export async function discoverRepository(requestedRoot: string): Promise<RepositoryDiscovery> {
  let root: string;
  try {
    root = await realpath(requestedRoot);
  } catch (error) {
    throw new CodeBridgeError("INVALID_PATH", "The requested repository path does not exist.", {
      cause: error,
    });
  }
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new CodeBridgeError("INVALID_PATH", "The requested repository root must be a directory.");
  }
  let gitDirectory: string;
  try {
    gitDirectory = await parseGitPointer(join(root, ".git"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CodeBridgeError(
        "UNSUPPORTED_GIT_LAYOUT",
        "The requested path is not a supported Git worktree.",
      );
    }
    throw error;
  }
  const commonGitDirectory = isWithin(root, gitDirectory)
    ? await resolveCommonGitDirectory(gitDirectory)
    : gitDirectory;
  const metadataRoots = [...new Set([gitDirectory, commonGitDirectory])].sort();
  const externalMetadataRoots = metadataRoots.filter((item) => !isWithin(root, item));

  const requirementCandidates: string[] = [];
  for (const candidate of ["SPEC.md", "ARCHITECTURE.md", "README.md", "docs/architecture.md"]) {
    try {
      const candidatePath = join(root, candidate);
      const stat = await lstat(candidatePath);
      if (stat.isFile() && !stat.isSymbolicLink()) requirementCandidates.push(candidate);
    } catch {
      // Candidate discovery is advisory; missing documents remain unapproved.
    }
  }

  const checkCandidates: string[] = [];
  for (const candidate of [
    "package.json",
    "pyproject.toml",
    "pytest.ini",
    "Makefile",
    "Cargo.toml",
  ]) {
    try {
      const stat = await lstat(join(root, candidate));
      if (stat.isFile() && !stat.isSymbolicLink()) checkCandidates.push(candidate);
    } catch {
      // This is discovery metadata only; it never enables a check.
    }
  }

  return {
    worktreeRoot: root,
    gitDirectory,
    commonGitDirectory,
    metadataRoots,
    externalMetadataRoots,
    requirementCandidates,
    checkCandidates,
  };
}

export async function createProjectConfig(
  discovery: RepositoryDiscovery,
  approvedMetadataRoots: readonly string[],
): Promise<ProjectConfig> {
  if (
    discovery.externalMetadataRoots.some(
      (external) => !approvedMetadataRoots.some((approved) => approved === external),
    )
  ) {
    throw new CodeBridgeError(
      "CONFIG_INVALID",
      "Each external Git metadata root must receive exact user approval before project setup.",
    );
  }
  const git = await findExecutable("git");
  if (!git) throw new CodeBridgeError("CONFIG_INVALID", "A Git executable is required.");
  const docker = await findExecutable("docker");
  return {
    version: 1,
    project: {
      id: deriveProjectId(discovery.worktreeRoot),
      canonicalWorktreeRoot: discovery.worktreeRoot,
      approvedGitMetadataRoots: [...approvedMetadataRoots].sort(),
      approvedRequirementPaths: [],
    },
    runtime: { nodeMajor: 24 },
    executables: { git, docker },
    limits: {
      maxSnapshotBytes: 512 * 1024 * 1024,
      maxFiles: 50_000,
      maxSingleReadableFileBytes: 2 * 1024 * 1024,
      maxSecretScanBytes: 10 * 1024 * 1024,
      maxReadResponseBytes: 512 * 1024,
      maxSearchResults: 200,
      maxConcurrentReads: 8,
      maxConcurrentChecks: 1,
      maxQueuedChecks: 4,
      maxRetainedOutputBytes: 2 * 1024 * 1024,
    },
    sandbox: {
      memoryMb: 2048,
      cpus: 2,
      pids: 128,
      timeoutSeconds: 600,
      writableWorkspaceMb: 2048,
      tmpMb: 256,
      homeMb: 64,
      nofileSoft: 1024,
      nofileHard: 1024,
    },
    checks: [],
  };
}

export async function approveRequirementPath(
  project: ProjectConfig,
  requestedPath: string,
): Promise<{ path: string; approvedSha256: string }> {
  const safePath = new PathGuard().assertNotSecretPath(requestedPath);
  const root = project.project.canonicalWorktreeRoot;
  const candidate = resolve(root, safePath);
  if (!isWithin(root, candidate))
    throw new CodeBridgeError("OUTSIDE_ROOT", "Requirement path is outside the approved root.");
  const guard = new SnapshotGuard();
  await guard.assertNoSymlinkComponents(root, safePath);
  const { bytes } = await guard.readRegularFile(candidate, {
    maxBytes: project.limits.maxSecretScanBytes,
  });
  const { SecretScanner } = await import("../security/secret-scanner.js");
  const scan = new SecretScanner().scan(bytes);
  if (scan.blocked)
    throw new CodeBridgeError("SECRET_BLOCKED", "Requirement document contains a blocked secret.");
  return {
    path: safePath,
    approvedSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
