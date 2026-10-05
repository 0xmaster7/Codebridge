#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { homedir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import {
  approveRequirementPath,
  createProjectConfig,
  deriveProjectId,
  discoverRepository,
  resolveAdditionalGitMetadata,
} from "./config/project.js";
import { ConfigStore } from "./config/store.js";
import { CodeBridgeError } from "./errors.js";
import { CODEBRIDGE_VERSION } from "./version.js";
import { createSessionContext, runStdioServer } from "./mcp/server.js";
import {
  CheckProfileApprovalInputSchema,
  type CheckProfile,
  type CheckProfileApprovalInput,
} from "./config/schema.js";
import { SnapshotGuard } from "./security/snapshot-guard.js";
import { SecretScanner } from "./security/secret-scanner.js";
import { ApprovalRegistry } from "./security/approval-registry.js";
import { PathGuard } from "./security/path-guard.js";
import { cleanupStaleSessionContainers } from "./cleanup/stale-containers.js";

function stateStore(): ConfigStore {
  return new ConfigStore(join(homedir(), ".codebridge"));
}

function writeLine(value: string): void {
  stdout.write(`${value}\n`);
}

function usage(): void {
  stderr.write(
    "Usage: codebridge <init <repo>|select <project-id-or-path>|status|doctor|checks|mcp|sessions|cleanup|approve-requirements <path>|approve-check <profile.json>|--version>\n",
  );
}

async function promptForExactApproval(path: string): Promise<boolean> {
  stderr.write(
    `Git metadata is outside the worktree. To authorize exactly this path, type it verbatim:\n${path}\n`,
  );
  if (!stdin.isTTY) return false;
  const readline = createInterface({ input: stdin, output: stderr });
  try {
    return (await readline.question("> ")).trim() === path;
  } finally {
    readline.close();
  }
}

async function initializeProject(repositoryPath: string): Promise<void> {
  let discovery = await discoverRepository(repositoryPath);
  const approvedMetadataRoots: string[] = [];
  for (const metadataPath of discovery.externalMetadataRoots) {
    if (!(await promptForExactApproval(metadataPath))) {
      throw new CodeBridgeError(
        "CONFIG_INVALID",
        "External Git metadata was not approved; project setup stopped.",
      );
    }
    approvedMetadataRoots.push(metadataPath);
  }
  discovery = await resolveAdditionalGitMetadata(discovery, approvedMetadataRoots);
  for (const metadataPath of discovery.externalMetadataRoots) {
    if (approvedMetadataRoots.includes(metadataPath)) continue;
    if (!(await promptForExactApproval(metadataPath))) {
      throw new CodeBridgeError(
        "CONFIG_INVALID",
        "External Git metadata was not approved; project setup stopped.",
      );
    }
    approvedMetadataRoots.push(metadataPath);
  }

  const store = stateStore();
  await store.initialize();
  const project = await createProjectConfig(discovery, approvedMetadataRoots);
  try {
    await store.loadProject(project.project.id);
    throw new CodeBridgeError(
      "CONFIG_INVALID",
      `This project is already initialized as ${project.project.id}; use 'codebridge select ${project.project.id}'.`,
    );
  } catch (error) {
    if (!(error instanceof CodeBridgeError) || error.code !== "FILE_NOT_FOUND") throw error;
  }
  await store.saveProject(project);
  writeLine(`Initialized ${project.project.id}.`);
  writeLine(`Repository: ${project.project.canonicalWorktreeRoot}`);
  if (project.executables.docker === null) {
    writeLine(
      "Docker-compatible executable was not found; repository checks will remain unavailable.",
    );
  }
  if (discovery.requirementCandidates.length > 0) {
    writeLine(
      `Requirement candidates (not approved): ${discovery.requirementCandidates.join(", ")}`,
    );
  }
  if (discovery.checkCandidates.length > 0) {
    writeLine(
      `Check configuration candidates (not approved): ${discovery.checkCandidates.join(", ")}`,
    );
  }
  writeLine(`Select the project with: codebridge select ${project.project.id}`);
}

async function selectProject(selector: string): Promise<void> {
  const store = stateStore();
  await store.initialize();
  let projectId = selector;
  if (!/^cb-[a-f0-9]{16}$/.test(selector)) {
    const canonicalPath = await realpath(selector).catch(() => null);
    if (canonicalPath === null) {
      throw new CodeBridgeError(
        "INVALID_ARGUMENT",
        "Provide a configured project ID or its canonical worktree path.",
      );
    }
    projectId = deriveProjectId(canonicalPath);
  }
  await store.selectProject(projectId);
  writeLine(`Selected ${projectId}.`);
}

async function printStatus(): Promise<void> {
  const store = stateStore();
  try {
    const { project } = await store.loadActiveProject();
    writeLine(`Active project: ${project.project.id}`);
    writeLine(`Repository: ${project.project.canonicalWorktreeRoot}`);
    writeLine(`Approved Git metadata roots: ${project.project.approvedGitMetadataRoots.length}`);
    writeLine(`Approved requirements: ${project.project.approvedRequirementPaths.length}`);
    writeLine(`Approved checks: ${project.checks.filter((check) => check.enabled).length}`);
  } catch (error) {
    if (error instanceof CodeBridgeError && error.code === "FILE_NOT_FOUND") {
      writeLine(
        "No active CodeBridge project. Run 'codebridge init <repo>' and 'codebridge select <project>'.",
      );
      return;
    }
    throw error;
  }
}

async function doctor(): Promise<void> {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major < 24) {
    throw new CodeBridgeError(
      "CONFIG_INVALID",
      `Node.js 24 or later is required; found ${process.versions.node}.`,
    );
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new CodeBridgeError("CONFIG_INVALID", "CodeBridge v0.1 supports macOS and Linux only.");
  }
  const store = stateStore();
  await store.initialize();
  writeLine(`Node.js ${process.versions.node}: supported.`);
  writeLine(`Platform ${process.platform}: supported.`);
  writeLine(`State directory ${store.root}: private permissions verified.`);
  try {
    const { project } = await store.loadActiveProject();
    writeLine(`Active project ${project.project.id}: configuration valid.`);
    writeLine(`Git executable registered: ${project.executables.git}`);
    writeLine(`Docker executable registered: ${project.executables.docker ?? "not found"}`);
    writeLine(
      "Docker image and launcher readiness are verified when an approved check profile is inspected or run.",
    );
  } catch (error) {
    if (error instanceof CodeBridgeError && error.code === "FILE_NOT_FOUND") {
      writeLine(
        "No project selected; initialize and select a project to check project executables.",
      );
      return;
    }
    throw error;
  }
}

async function listChecks(): Promise<void> {
  const { project } = await stateStore().loadActiveProject();
  if (project.checks.length === 0) {
    writeLine("No externally approved check profiles are configured.");
    return;
  }
  for (const check of project.checks) {
    writeLine(`${check.id}\t${check.enabled ? "enabled" : "disabled"}\t${check.imageDigest}`);
  }
}

async function listSessions(): Promise<void> {
  const sessions = await stateStore().listOwnedSessionDirectories();
  if (sessions.length === 0) {
    writeLine("No CodeBridge-owned sessions.");
    return;
  }
  for (const session of sessions) writeLine(session);
}

async function cleanupSessions(): Promise<void> {
  const store = stateStore();
  const sessions = await store.listStaleOwnedSessionDirectories();
  const projects = await store.listProjects();
  const dockerExecutables = [
    ...new Set(
      projects
        .map((project) => project.executables.docker)
        .filter((executable): executable is string => executable !== null),
    ),
  ];
  let containers = 0;
  for (const sessionId of sessions) {
    for (const executable of dockerExecutables) {
      containers += await cleanupStaleSessionContainers(executable, sessionId);
    }
    await store.removeOwnedSessionDirectory(sessionId);
  }
  writeLine(
    `Removed ${sessions.length} stale CodeBridge-owned session${sessions.length === 1 ? "" : "s"} and ${containers} stale container${containers === 1 ? "" : "s"}.`,
  );
}

async function approveRequirements(path: string): Promise<void> {
  const store = stateStore();
  const { project } = await store.loadActiveProject();
  const approval = await approveRequirementPath(project, path);
  const approvedRequirementPaths = project.project.approvedRequirementPaths.filter(
    (existing) => existing.path !== path,
  );
  approvedRequirementPaths.push(approval);
  await store.saveProject({
    ...project,
    project: { ...project.project, approvedRequirementPaths },
  });
  writeLine(`Approved requirement path ${path} at SHA-256 ${approval.approvedSha256}.`);
}

async function approveCheckProfile(profilePath: string): Promise<void> {
  if (!stdin.isTTY) {
    throw new CodeBridgeError(
      "CHECK_NOT_ALLOWED",
      "Check approval requires an interactive terminal so the user can confirm the exact profile.",
    );
  }
  const store = stateStore();
  const { project } = await store.loadActiveProject();
  const inputFile = await new SnapshotGuard().readRegularFile(profilePath, { maxBytes: 64 * 1024 });
  const scanner = new SecretScanner();
  if (scanner.scan(inputFile.bytes).blocked) {
    throw new CodeBridgeError(
      "SECRET_BLOCKED",
      "Check profile contains a high-confidence secret value.",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inputFile.bytes)) as unknown;
  } catch (error) {
    throw new CodeBridgeError("CONFIG_INVALID", "Check profile file is not valid UTF-8 JSON.", {
      cause: error,
    });
  }
  const parsed = CheckProfileApprovalInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CodeBridgeError(
      "CONFIG_INVALID",
      "Check profile does not match the approval schema.",
    );
  }
  const approvalInput: CheckProfileApprovalInput = parsed.data;
  const { scriptApproval: scriptRequest, ...profileFields } = approvalInput;
  let profile: CheckProfile = profileFields;
  if (profile.adapter === "project-script-sandboxed") {
    if (!scriptRequest) {
      throw new CodeBridgeError(
        "CHECK_NOT_ALLOWED",
        "Project script approval requires configPath and scriptName.",
      );
    }
    const path = new PathGuard().assertNotSecretPath(scriptRequest.configPath);
    const component = new SnapshotGuard();
    await component.assertNoSymlinkComponents(project.project.canonicalWorktreeRoot, path);
    const configBytes = (
      await component.readRegularFile(
        join(project.project.canonicalWorktreeRoot, ...path.split("/")),
        { maxBytes: project.limits.maxSecretScanBytes },
      )
    ).bytes;
    if (scanner.scan(configBytes).blocked) {
      throw new CodeBridgeError(
        "SECRET_BLOCKED",
        "Project script manifest contains a high-confidence secret.",
      );
    }
    const approval = new ApprovalRegistry().approveScript(
      path,
      configBytes,
      scriptRequest.scriptName,
      profile.imageDigest,
      "codebridge-adapter-1",
    );
    profile = { ...profile, scriptApproval: approval };
  } else if (scriptRequest) {
    throw new CodeBridgeError(
      "CONFIG_INVALID",
      "scriptApproval is only valid for project-script-sandboxed.",
    );
  }
  stderr.write(
    `${JSON.stringify(profile, null, 2)}\nType exactly: APPROVE ${profile.id} ${profile.imageDigest}\n`,
  );
  const readline = createInterface({ input: stdin, output: stderr });
  let response: string;
  try {
    response = (await readline.question("> ")).trim();
  } finally {
    readline.close();
  }
  if (response !== `APPROVE ${profile.id} ${profile.imageDigest}`) {
    throw new CodeBridgeError("CHECK_NOT_ALLOWED", "Check profile was not approved.");
  }
  const checks = project.checks.filter((check) => check.id !== profile.id);
  checks.push(profile);
  await store.saveProject({ ...project, checks });
  writeLine(`Approved check profile ${profile.id} at immutable image ${profile.imageDigest}.`);
}

async function startMcpServer(): Promise<void> {
  const store = stateStore();
  const { project } = await store.loadActiveProject();
  const context = await createSessionContext(project, store);
  await runStdioServer(context);
}

async function run(): Promise<void> {
  const [command, argument, extra] = process.argv.slice(2);
  if (command === "--version" || command === "-v") {
    writeLine(CODEBRIDGE_VERSION);
    return;
  }
  switch (command) {
    case "init":
      if (!argument || extra !== undefined) return usage();
      await initializeProject(argument);
      return;
    case "select":
      if (!argument || extra !== undefined) return usage();
      await selectProject(argument);
      return;
    case "status":
      if (argument !== undefined) return usage();
      await printStatus();
      return;
    case "doctor":
      if (argument !== undefined) return usage();
      await doctor();
      return;
    case "checks":
      if (argument !== undefined) return usage();
      await listChecks();
      return;
    case "sessions":
      if (argument !== undefined) return usage();
      await listSessions();
      return;
    case "cleanup":
      if (argument !== undefined) return usage();
      await cleanupSessions();
      return;
    case "approve-requirements":
      if (!argument || extra !== undefined) return usage();
      await approveRequirements(argument);
      return;
    case "approve-check":
      if (!argument || extra !== undefined) return usage();
      await approveCheckProfile(argument);
      return;
    case "mcp":
      if (argument !== undefined) return usage();
      await startMcpServer();
      return;
    default:
      usage();
  }
}

try {
  await run();
} catch (error) {
  if (error instanceof CodeBridgeError) stderr.write(`${error.code}: ${error.message}\n`);
  else
    stderr.write(
      `INTERNAL_ERROR: ${error instanceof Error ? error.message : "Unknown failure."}\n`,
    );
  process.exitCode = 1;
}
