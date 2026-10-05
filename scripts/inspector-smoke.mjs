import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const workspace = await mkdtemp(join(tmpdir(), "codebridge-inspector-"));
const home = join(workspace, "home");
const repository = join(workspace, "repository");
const env = {
  HOME: home,
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
};

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: repository,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed (${args.join(" ")}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function stopInspectorOwnedServers() {
  const listed = runNode([join(process.cwd(), "dist/src/cli.js"), "sessions"]);
  const sessionIds = listed.match(/[a-f0-9-]{36}/g) ?? [];
  for (const sessionId of sessionIds) {
    const marker = JSON.parse(
      await readFile(
        join(home, ".codebridge", "sessions", sessionId, ".codebridge-owned.json"),
        "utf8",
      ),
    );
    const pid = marker.ownerPid;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid smoke session owner PID.");
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") continue;
      throw error;
    }
    const command = execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
    assert.match(command, /dist\/src\/cli\.js mcp(?:\s|$)/);
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") break;
        throw error;
      }
      await delay(50);
    }
  }
}

async function makeRemovable(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await makeRemovable(path);
      await chmod(path, 0o700);
    } else if (entry.isFile() && !entry.isSymbolicLink()) {
      await chmod(path, 0o600);
    }
  }
  await chmod(directory, 0o700);
}

try {
  await mkdir(home);
  await mkdir(repository);
  await writeFile(join(repository, "README.md"), "Inspector smoke fixture.\n");
  execFileSync("git", ["init", "--quiet"], { cwd: repository, env });
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", "README.md"],
    { cwd: repository, env },
  );
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: repository, env },
  );

  const initialized = runNode([join(process.cwd(), "dist/src/cli.js"), "init", repository]);
  const projectId = /Initialized (cb-[a-f0-9]{16})\./.exec(initialized)?.[1];
  assert.ok(projectId, `CodeBridge did not initialize the fixture: ${initialized}`);
  const projectConfig = join(home, ".codebridge", "projects", `${projectId}.json`);
  const config = JSON.parse(await readFile(projectConfig, "utf8"));
  config.executables.docker = null;
  await writeFile(projectConfig, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(projectConfig, 0o600);
  runNode([join(process.cwd(), "dist/src/cli.js"), "select", projectId]);

  const inspected = spawnSync(
    "npx",
    [
      "--yes",
      "@modelcontextprotocol/inspector@2.5.0",
      "--cli",
      process.execPath,
      join(process.cwd(), "dist/src/cli.js"),
      "mcp",
      "--method",
      "tools/list",
      "--format",
      "json",
    ],
    { cwd: repository, env, encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
  );
  assert.equal(
    inspected.status,
    0,
    `MCP Inspector failed: ${inspected.stderr || inspected.stdout}`,
  );
  assert.match(inspected.stdout, /"name"\s*:\s*"repo_tree"/);
  assert.match(inspected.stdout, /"name"\s*:\s*"read_file"/);
  await stopInspectorOwnedServers();
  const cleanup = runNode([join(process.cwd(), "dist/src/cli.js"), "cleanup"]);
  assert.match(cleanup, /Removed 1 stale CodeBridge-owned session/);
  process.stdout.write("MCP Inspector successfully listed the CodeBridge stdio tools.\n");
} finally {
  await makeRemovable(workspace);
  await rm(workspace, { recursive: true, force: true });
}
