import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ConfigStore } from "../../src/config/store.js";
import type { ProjectConfig } from "../../src/config/schema.js";

async function findGit(): Promise<string> {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "git");
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Try the next PATH component.
    }
  }
  throw new Error("Git was not found for MCP fixture setup.");
}

function projectConfig(root: string, git: string): ProjectConfig {
  return {
    version: 1,
    project: {
      id: "cb-0123456789abcdef",
      canonicalWorktreeRoot: root,
      approvedGitMetadataRoots: [],
      approvedRequirementPaths: [],
    },
    runtime: { nodeMajor: 24 },
    executables: { git, docker: null },
    limits: {
      maxSnapshotBytes: 1024 * 1024,
      maxFiles: 100,
      maxSingleReadableFileBytes: 1024,
      maxSecretScanBytes: 2048,
      maxReadResponseBytes: 4096,
      maxSearchResults: 20,
      maxConcurrentReads: 2,
      maxConcurrentChecks: 1,
      maxQueuedChecks: 2,
      maxRetainedOutputBytes: 8192,
    },
    sandbox: {
      memoryMb: 512,
      cpus: 1,
      pids: 64,
      timeoutSeconds: 60,
      writableWorkspaceMb: 64,
      tmpMb: 16,
      homeMb: 16,
      nofileSoft: 128,
      nofileHard: 128,
    },
    checks: [],
  };
}

void test("stdio MCP exposes exactly the frozen tool set and produces protocol-only stdout", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-mcp-"));
  const home = join(base, "home");
  const repository = join(base, "repo");
  await mkdir(home, { recursive: true });
  await mkdir(repository);
  const git = await findGit();
  execFileSync(git, ["init", "--quiet"], {
    cwd: repository,
    env: { PATH: process.env["PATH"], HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
  });
  execFileSync(git, ["config", "user.name", "Fixture"], { cwd: repository });
  execFileSync(git, ["config", "user.email", "fixture@example.invalid"], { cwd: repository });
  await writeFile(join(repository, "safe.txt"), "immutable evidence\n");
  const requirement = "Requirement approved at initialization.\n";
  const staleRequirement = "Previously approved requirement.\n";
  await writeFile(join(repository, "requirements.md"), requirement);
  await writeFile(join(repository, "stale-requirements.md"), staleRequirement);
  execFileSync(git, ["add", "safe.txt", "requirements.md", "stale-requirements.md"], {
    cwd: repository,
  });
  execFileSync(git, ["commit", "--quiet", "-m", "initial"], { cwd: repository });

  const project = projectConfig(await realpath(repository), git);
  project.project.approvedRequirementPaths.push(
    {
      path: "requirements.md",
      approvedSha256: createHash("sha256").update(requirement).digest("hex"),
    },
    {
      path: "stale-requirements.md",
      approvedSha256: createHash("sha256").update(staleRequirement).digest("hex"),
    },
  );
  await writeFile(join(repository, "stale-requirements.md"), "Changed after approval.\n");
  const headSha = execFileSync(git, ["rev-parse", "HEAD"], { cwd: repository }).toString().trim();
  const store = new ConfigStore(join(home, ".codebridge"));
  let sessionIdForCleanup: string | undefined;
  context.after(async () => {
    if (sessionIdForCleanup) await store.removeOwnedSessionDirectory(sessionIdForCleanup);
    await rm(base, { recursive: true, force: true });
  });
  await store.saveProject(project);
  await store.selectProject(project.project.id);

  const cliPath = join(process.cwd(), "dist", "src", "cli.js");
  const child = spawn(process.execPath, [cliPath, "mcp"], {
    cwd: repository,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const send = async (message: Record<string, unknown>): Promise<Record<string, unknown>> => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    const next = await iterator.next();
    assert.equal(next.done, false, `MCP server ended early. stderr: ${stderr}`);
    const line = next.value;
    assert.doesNotThrow(() => JSON.parse(line), `stdout contained non-protocol output: ${line}`);
    return JSON.parse(line) as Record<string, unknown>;
  };
  try {
    const initialized = await send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "codebridge-test", version: "0.1.0" },
      },
    });
    assert.equal(initialized["id"], 1);
    const initializeResult = initialized["result"] as { instructions?: string };
    assert.match(initializeResult.instructions ?? "", /untrusted evidence/);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const listed = await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const result = listed["result"] as {
      tools: readonly {
        name: string;
        annotations?: {
          readOnlyHint?: boolean;
          destructiveHint?: boolean;
          idempotentHint?: boolean;
        };
      }[];
    };
    assert.deepEqual(result.tools.map((tool) => tool.name).sort(), [
      "audit_snapshot",
      "cancel_check",
      "check_status",
      "find_paths",
      "git_diff",
      "git_log",
      "git_show",
      "git_status",
      "list_checks",
      "read_file",
      "read_files",
      "repo_tree",
      "run_check",
      "search_repo",
    ]);
    assert.equal(result.tools.length, 14);
    assert.ok(
      result.tools
        .filter((tool) => !["run_check", "cancel_check"].includes(tool.name))
        .every((tool) => tool.annotations?.readOnlyHint === true),
    );
    assert.equal(
      result.tools.find((tool) => tool.name === "run_check")?.annotations?.readOnlyHint,
      false,
    );
    assert.equal(
      result.tools.find((tool) => tool.name === "cancel_check")?.annotations?.idempotentHint,
      true,
    );
    assert.ok(result.tools.every((tool) => tool.annotations?.destructiveHint === false));
    let requestId = 3;
    const call = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ response: Record<string, unknown>; payload?: Record<string, unknown> }> => {
      const response = await send({
        jsonrpc: "2.0",
        id: requestId++,
        method: "tools/call",
        params: { name, arguments: args },
      });
      const toolResult = response["result"] as
        { content?: readonly { text?: string }[] } | undefined;
      const text = toolResult?.content?.[0]?.text;
      return {
        response,
        ...(text === undefined ? {} : { payload: JSON.parse(text) as Record<string, unknown> }),
      };
    };

    const provenance = await call("audit_snapshot", {});
    assert.equal(provenance.response["error"], undefined);
    assert.equal(provenance.payload?.["sourceTrust"], "untrusted_repository_content");
    assert.equal((provenance.payload?.["approvedRequirementPaths"] as unknown[]).length, 2);
    assert.deepEqual(provenance.payload?.["checkProfiles"], []);
    const tree = await call("repo_tree", {});
    const paths = await call("find_paths", { pattern: "*.txt" });
    const search = await call("search_repo", { query: "immutable" });
    const file = await call("read_file", { path: "safe.txt" });
    const approvedRequirement = await call("read_file", { path: "requirements.md" });
    const changedRequirement = await call("read_file", { path: "stale-requirements.md" });
    const batch = await call("read_files", { paths: ["safe.txt"] });
    const status = await call("git_status", {});
    const log = await call("git_log", { count: 20 });
    const diff = await call("git_diff", { mode: "audit-working-tree" });
    const show = await call("git_show", { revision: headSha, path: "safe.txt" });
    const checks = await call("list_checks", {});
    const invalidArguments = await call("read_file", { path: "../etc/passwd" });
    const missingCheck = await call("run_check", { checkId: "missing", targets: [] });
    const missingStatus = await call("check_status", {
      runId: "00000000-0000-4000-8000-000000000000",
    });
    const missingCancel = await call("cancel_check", {
      runId: "00000000-0000-4000-8000-000000000000",
    });
    for (const item of [
      tree,
      paths,
      search,
      file,
      approvedRequirement,
      changedRequirement,
      batch,
      status,
      log,
      diff,
      show,
      checks,
    ]) {
      assert.equal(item.response["error"], undefined);
      assert.ok(item.payload?.["snapshotId"]);
    }
    assert.equal(file.payload?.["sourceTrust"], "untrusted_repository_content");
    assert.equal(approvedRequirement.payload?.["sourceTrust"], "user_approved_requirement");
    assert.equal(changedRequirement.payload?.["sourceTrust"], "untrusted_repository_content");
    assert.match(String(file.payload?.["content"]), /immutable evidence/);
    for (const item of [invalidArguments, missingCheck, missingStatus, missingCancel]) {
      const callResult = item.response["result"] as {
        isError?: boolean;
        content?: readonly { text?: string }[];
      };
      assert.equal(callResult.isError, true);
      assert.doesNotMatch(callResult.content?.[0]?.text ?? "", /stack|node_modules|\/Users\//i);
    }
    assert.match(String(tree.payload?.["snapshotId"]), /^[0-9a-f-]{36}$/);
    assert.ok(Array.isArray((status.payload?.["stagedChanges"] as unknown[] | undefined) ?? []));
    assert.ok(Array.isArray((log.payload?.["result"] as unknown[] | undefined) ?? []));
    assert.ok(String(diff.payload?.["diff"]).length >= 0);
    assert.match(String(show.payload?.["content"]), /^1: immutable evidence/);
    assert.deepEqual(checks.payload?.["checks"], []);
    const sessionId = String(provenance.payload?.["sessionId"]);
    sessionIdForCleanup = sessionId;
    const auditPath = join(home, ".codebridge", "sessions", sessionId, "audit.jsonl");
    const events = (await readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(events.length, 17);
    assert.deepEqual(
      events.map((event) => event["tool"]).sort(),
      [...result.tools.map((tool) => tool.name), "read_file", "read_file", "read_file"].sort(),
    );
    assert.ok(events.every((event) => event["snapshotId"] === tree.payload?.["snapshotId"]));
    assert.ok(events.every((event) => typeof event["requestId"] === "string"));
    assert.ok(events.every((event) => typeof event["durationMs"] === "number"));
    assert.ok(events.every((event) => typeof event["returnedBytes"] === "number"));
    assert.ok(events.every((event) => typeof event["decision"] === "string"));
    assert.ok(events.every((event) => !JSON.stringify(event).includes("immutable evidence")));
  } finally {
    child.stdin.end();
    lines.close();
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }
});
