import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { clearTimeout as clearTimer, setTimeout as setTimer } from "node:timers";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const portablePluginSchema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const portableMcpSchema = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const expectedTools = [
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
];

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function waitFor(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimer(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimer(timer));
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

async function validateInstalledPortablePlugin(portableServer) {
  const workspace = await mkdtemp(join(tmpdir(), "codebridge-plugin-install-"));
  const home = join(workspace, "home");
  const repository = join(workspace, "repository");
  const installedRoot = join(workspace, "cache", "codebridge-local", "codebridge", "0.1.0");
  const env = {
    HOME: home,
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    PLUGIN_ROOT: installedRoot,
  };

  try {
    await mkdir(home, { recursive: true });
    await mkdir(repository);
    await mkdir(installedRoot, { recursive: true });
    for (const name of ["plugin.json", "mcp.json", "package.json"]) {
      await cp(join(repositoryRoot, name), join(installedRoot, name));
    }
    for (const name of ["dist", "sandbox", "skills"]) {
      await cp(join(repositoryRoot, name), join(installedRoot, name), { recursive: true });
    }
    await symlink(join(repositoryRoot, "node_modules"), join(installedRoot, "node_modules"), "dir");

    await writeFile(join(repository, "README.md"), "Disposable plugin wiring smoke fixture.\n");
    execFileSync("git", ["init", "--quiet"], { cwd: repository, env });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=CodeBridge plugin smoke",
        "-c",
        "user.email=plugin-smoke@example.invalid",
        "add",
        "README.md",
      ],
      { cwd: repository, env },
    );
    execFileSync(
      "git",
      [
        "-c",
        "user.name=CodeBridge plugin smoke",
        "-c",
        "user.email=plugin-smoke@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "plugin smoke fixture",
      ],
      { cwd: repository, env },
    );

    const cliPath = join(installedRoot, "dist/src/cli.js");
    const initialized = execFileSync(process.execPath, [cliPath, "init", repository], {
      cwd: installedRoot,
      env,
      encoding: "utf8",
    });
    const projectId = /Initialized (cb-[a-f0-9]{16})\./.exec(initialized)?.[1];
    assert.ok(
      projectId,
      `Installed CodeBridge CLI did not initialize the smoke fixture: ${initialized}`,
    );
    execFileSync(process.execPath, [cliPath, "select", projectId], {
      cwd: installedRoot,
      env,
      encoding: "utf8",
    });

    const cwd =
      portableServer.cwd === "${PLUGIN_ROOT}"
        ? installedRoot
        : resolve(installedRoot, portableServer.cwd);
    const child = spawn(portableServer.command, portableServer.args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const closed = new Promise((resolveClose, rejectClose) => {
      child.once("error", rejectClose);
      child.once("close", (code, signal) => resolveClose({ code, signal }));
    });
    const response = async (requestId) => {
      while (true) {
        const next = await waitFor(
          iterator.next(),
          10_000,
          "Timed out waiting for MCP stdio response.",
        );
        assert.equal(next.done, false, `Installed MCP server closed early. stderr: ${stderr}`);
        let message;
        assert.doesNotThrow(
          () => (message = JSON.parse(next.value)),
          `Installed MCP server wrote non-protocol stdout: ${next.value}`,
        );
        if (message.id === requestId) return message;
      }
    };

    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "codebridge-portable-package-smoke", version: "0.1.0" },
          },
        })}\n`,
      );
      const initializedResult = await response(1);
      assert.equal(
        initializedResult.error,
        undefined,
        `MCP initialization failed: ${JSON.stringify(initializedResult)}`,
      );
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
      );
      const listed = await response(2);
      assert.equal(listed.error, undefined, `MCP tools/list failed: ${JSON.stringify(listed)}`);
      const tools = listed.result?.tools;
      assert.ok(Array.isArray(tools), "Installed MCP server did not return a tools array.");
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [...expectedTools].sort());
      assert.equal(tools.length, expectedTools.length);
    } finally {
      child.stdin.end();
      let result;
      try {
        result = await waitFor(
          closed,
          5_000,
          "Installed MCP server did not exit after stdio closed.",
        );
      } catch {
        child.kill("SIGTERM");
        result = await waitFor(closed, 5_000, "Installed MCP server could not be stopped.");
      }
      lines.close();
      assert.equal(result.code, 0, `Installed MCP server exited unsuccessfully. stderr: ${stderr}`);
    }
  } finally {
    await makeRemovable(workspace);
    await rm(workspace, { recursive: true, force: true });
  }
}

const manifest = await readJson(join(repositoryRoot, "plugin.json"));
const mcpManifest = await readJson(join(repositoryRoot, "mcp.json"));
const codexManifest = await readJson(join(repositoryRoot, ".codex-plugin/plugin.json"));
const codexMcpManifest = await readJson(join(repositoryRoot, ".mcp.json"));
const marketplace = await readJson(join(repositoryRoot, ".claude-plugin/marketplace.json"));
const agentsMarketplace = await readJson(join(repositoryRoot, ".agents/plugins/marketplace.json"));
const packageManifest = await readJson(join(repositoryRoot, "package.json"));

assert.equal(manifest.$schema, portablePluginSchema);
assert.deepEqual(Object.keys(manifest).sort(), [
  "$schema",
  "author",
  "description",
  "keywords",
  "license",
  "name",
  "repository",
  "version",
]);
assert.match(manifest.name, /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
assert.ok(manifest.name.length <= 64);
assert.equal(typeof manifest.version, "string");
assert.equal(typeof manifest.description, "string");
assert.equal(typeof manifest.author, "object");
assert.deepEqual(Object.keys(manifest.author), ["name"]);
assert.equal(typeof manifest.author?.name, "string");
assert.equal(typeof manifest.repository, "string");
assert.equal(typeof manifest.license, "string");
assert.ok(Array.isArray(manifest.keywords));
assert.ok(manifest.keywords.every((keyword) => typeof keyword === "string"));
assert.equal("skills" in manifest, false);
assert.equal("mcpServers" in manifest, false);

assert.equal(mcpManifest.$schema, portableMcpSchema);
assert.deepEqual(Object.keys(mcpManifest).sort(), ["$schema", "mcpServers"]);
const portableServer = mcpManifest.mcpServers?.codebridge;
assert.equal(typeof portableServer, "object");
assert.deepEqual(Object.keys(portableServer).sort(), ["args", "command", "cwd", "type"]);
assert.equal(portableServer.type, "stdio");
assert.equal(portableServer.command, "node");
assert.ok(Array.isArray(portableServer.args));
assert.ok(portableServer.args.every((argument) => typeof argument === "string"));
assert.deepEqual(portableServer.args, ["dist/src/cli.js", "mcp"]);
assert.match(
  portableServer.cwd,
  /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/,
  "Portable mcp.json cwd must be package-relative or rooted at PLUGIN_ROOT/PLUGIN_DATA per the Agent Plugins MCP schema.",
);
assert.equal(portableServer.cwd, "${PLUGIN_ROOT}");
assert.ok(packageManifest.files.includes("mcp.json"));
assert.ok(packageManifest.files.includes("dist/"));

assert.equal(codexManifest.name, manifest.name);
assert.equal(codexManifest.version, manifest.version);
assert.equal(codexManifest.skills, "./skills/");
assert.equal(codexManifest.mcpServers, "./.mcp.json");
assert.equal(codexManifest.interface.displayName, "CodeBridge");
assert.ok(codexManifest.interface.shortDescription.length <= 30);
assert.deepEqual(Object.keys(codexMcpManifest), ["mcpServers"]);
const codexServer = codexMcpManifest.mcpServers?.codebridge;
assert.equal(codexServer.type, portableServer.type);
assert.equal(codexServer.command, portableServer.command);
assert.deepEqual(codexServer.args, portableServer.args);
assert.equal(codexServer.cwd, "./");

for (const catalog of [marketplace, agentsMarketplace]) {
  assert.equal(catalog.name, "codebridge-local");
  assert.equal(catalog.interface.displayName, "CodeBridge local");
  assert.equal(catalog.plugins.length, 1);
  const entry = catalog.plugins[0];
  assert.equal(entry.name, "codebridge");
  assert.deepEqual(entry.source, { source: "local", path: "./" });
  assert.deepEqual(entry.policy, { installation: "AVAILABLE", authentication: "ON_INSTALL" });
  assert.equal(entry.category, "Productivity");
}
assert.deepEqual(agentsMarketplace, marketplace);

const projectPluginConfig = await readFile(join(repositoryRoot, ".codex/config.toml"), "utf8");
assert.match(projectPluginConfig, /\[plugins\."codebridge@codebridge-local"\]/);
assert.match(projectPluginConfig, /enabled = true/);
await readFile(join(repositoryRoot, "skills/codebridge-audit/SKILL.md"), "utf8");

await validateInstalledPortablePlugin(portableServer);
process.stdout.write(
  "Portable package, local marketplaces, installed stdio wiring, and all 14 CodeBridge MCP tools are valid.\n",
);
