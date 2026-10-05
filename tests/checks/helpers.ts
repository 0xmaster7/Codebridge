import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckProfile, ProjectConfig } from "../../src/config/schema.js";

export const fixtureDigest = `sha256:${"a".repeat(64)}`;

export function fixtureProfile(overrides: Partial<CheckProfile> = {}): CheckProfile {
  return {
    id: "python.pytest.fixture",
    adapter: "pytest",
    imageDigest: fixtureDigest,
    executable: "/usr/local/bin/python3",
    fixedArgs: ["-m", "pytest"],
    targetMode: "none",
    allowedTargetSuffixes: [],
    allowedTargetPaths: [],
    timeoutSeconds: 60,
    stdoutLimitBytes: 4096,
    stderrLimitBytes: 4096,
    environmentAllowlist: [],
    workingDirectory: "/workspace",
    dependencyMode: "image-contained",
    enabled: true,
    ...overrides,
  };
}

export function fixtureProject(
  root: string,
  overrides: Partial<ProjectConfig> = {},
): ProjectConfig {
  return {
    version: 1,
    project: {
      id: "cb-0123456789abcdef",
      canonicalWorktreeRoot: root,
      approvedGitMetadataRoots: [],
      approvedRequirementPaths: [],
    },
    runtime: { nodeMajor: 24 },
    executables: { git: "/usr/bin/git", docker: null },
    limits: {
      maxSnapshotBytes: 16 * 1024 * 1024,
      maxFiles: 1000,
      maxSingleReadableFileBytes: 2 * 1024 * 1024,
      maxSecretScanBytes: 2 * 1024 * 1024,
      maxReadResponseBytes: 512 * 1024,
      maxSearchResults: 200,
      maxConcurrentReads: 4,
      maxConcurrentChecks: 1,
      maxQueuedChecks: 2,
      maxRetainedOutputBytes: 4096,
    },
    sandbox: {
      memoryMb: 256,
      cpus: 1,
      pids: 32,
      timeoutSeconds: 10,
      writableWorkspaceMb: 16,
      tmpMb: 8,
      homeMb: 8,
      nofileSoft: 64,
      nofileHard: 64,
    },
    checks: [],
    ...overrides,
  };
}

export async function createFakeDocker(
  root: string,
  options: {
    readonly imageId?: string;
    readonly imageEnv?: readonly string[];
    readonly dockerHost?: string;
    readonly scenario?:
      | "ready"
      | "image-missing"
      | "wrong-digest"
      | "probe-fails"
      | "run"
      | "wrong-labels"
      | "create-fails"
      | "create-fails-after-create"
      | "start-fails"
      | "sleep"
      | "large-output";
  } = {},
): Promise<{ executable: string; statePath: string; callsPath: string }> {
  const executable = join(root, "docker-fixture");
  const statePath = join(root, "docker-state.json");
  const callsPath = join(root, "docker-calls.jsonl");
  const imageId = options.imageId ?? fixtureDigest;
  const imageEnv = options.imageEnv ?? [];
  const dockerHost = options.dockerHost ?? "unix:///tmp/codebridge-test.sock";
  const scenario = options.scenario ?? "ready";
  const program = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
const callsPath = ${JSON.stringify(callsPath)};
const scenario = ${JSON.stringify(scenario)};
fs.appendFileSync(callsPath, JSON.stringify(args) + "\\n");
if (args[0] === "context" && args[1] === "show") {
  process.stdout.write("default\\n");
} else if (args[0] === "context" && args[1] === "inspect") {
  process.stdout.write(${JSON.stringify(dockerHost)} + "\\n");
} else if (args[0] === "image") {
  if (scenario === "image-missing") process.exit(1);
  const image = { Id: ${JSON.stringify(imageId)}, RepoDigests: [], Config: { Env: ${JSON.stringify(imageEnv)} } };
  process.stdout.write(JSON.stringify(image));
} else if (args[0] === "run") {
  if (scenario === "probe-fails") process.exit(1);
} else if (args[0] === "create") {
  if (scenario === "create-fails") process.exit(1);
  const labels = {};
  for (let i = 0; i < args.length - 1; i += 1) if (args[i] === "--label") { const [key, ...value] = args[i + 1].split("="); labels[key] = value.join("="); }
  fs.writeFileSync(statePath, JSON.stringify({ labels, autoRemove: args.includes("--rm") }));
  if (scenario === "create-fails-after-create") process.exit(1);
  process.stdout.write("${"c".repeat(64)}\\n");
} else if (args[0] === "start") {
  if (scenario === "sleep") setTimeout(() => process.exit(0), 3000);
  else if (scenario === "start-fails") process.exit(1);
  else if (scenario === "large-output") process.stdout.write("x".repeat(10000));
  else { const state = JSON.parse(fs.readFileSync(statePath, "utf8")); if (scenario === "run" && state.autoRemove) fs.writeFileSync(statePath + ".auto-removed", "removed"); process.stdout.write("prefix sk-proj-0123456789abc"); process.stdout.write("defghijklmnopqrstuv suffix\\n"); }
} else if (args[0] === "ps") {
  if (fs.existsSync(statePath + ".auto-removed") || fs.existsSync(statePath + ".removed")) process.stdout.write("");
  else if (fs.existsSync(statePath)) process.stdout.write("${"c".repeat(12)}\\n");
} else if (args[0] === "inspect") {
  const labels = JSON.parse(fs.readFileSync(statePath, "utf8")).labels;
  if (scenario === "wrong-labels") labels["io.codebridge.managed"] = "false";
  process.stdout.write(JSON.stringify(labels));
} else if (args[0] === "rm") {
  fs.writeFileSync(statePath + ".removed", "removed");
}
`;
  await writeFile(executable, program, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { executable, statePath, callsPath };
}
