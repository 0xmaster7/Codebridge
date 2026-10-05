import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";

const manifest = JSON.parse(await readFile(new URL("../plugin.json", import.meta.url), "utf8"));
const mcpManifest = JSON.parse(await readFile(new URL("../mcp.json", import.meta.url), "utf8"));
const codexManifest = JSON.parse(
  await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8"),
);
const codexMcpManifest = JSON.parse(
  await readFile(new URL("../.mcp.json", import.meta.url), "utf8"),
);
const marketplace = JSON.parse(
  await readFile(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"),
);
const agentsMarketplace = JSON.parse(
  await readFile(new URL("../.agents/plugins/marketplace.json", import.meta.url), "utf8"),
);

assert.equal(manifest.name, "codebridge");
assert.equal(manifest.version, "0.1.0");
assert.equal(typeof manifest.description, "string");
assert.equal("skills" in manifest, false);
assert.equal("mcpServers" in manifest, false);
assert.equal(typeof mcpManifest.mcpServers?.codebridge, "object");
assert.equal(mcpManifest.mcpServers.codebridge.type, "stdio");
assert.equal(mcpManifest.mcpServers.codebridge.command, "node");
assert.deepEqual(mcpManifest.mcpServers.codebridge.args, ["dist/src/cli.js", "mcp"]);
assert.equal(mcpManifest.mcpServers.codebridge.cwd, ".");
assert.equal(codexManifest.name, "codebridge");
assert.equal(codexManifest.version, "0.1.0");
assert.equal(codexManifest.skills, "./skills/");
assert.equal(codexManifest.mcpServers, "./.mcp.json");
assert.equal(codexManifest.interface.displayName, "CodeBridge");
assert.ok(codexManifest.interface.shortDescription.length <= 30);
assert.equal(codexMcpManifest.mcpServers.codebridge.type, "stdio");
assert.equal(codexMcpManifest.mcpServers.codebridge.command, "node");
assert.deepEqual(codexMcpManifest.mcpServers.codebridge.args, ["dist/src/cli.js", "mcp"]);
assert.equal(codexMcpManifest.mcpServers.codebridge.cwd, ".");
assert.equal(marketplace.plugins[0].name, "codebridge");
assert.equal(marketplace.plugins[0].source.path, "./");
assert.equal(agentsMarketplace.name, marketplace.name);
assert.deepEqual(agentsMarketplace.plugins, marketplace.plugins);
await readFile(new URL("../skills/codebridge-audit/SKILL.md", import.meta.url), "utf8");
const projectPluginConfig = await readFile(
  new URL("../.codex/config.toml", import.meta.url),
  "utf8",
);
assert.match(projectPluginConfig, /\[plugins\."codebridge@codebridge-local"\]/);
assert.match(projectPluginConfig, /enabled = true/);

process.stdout.write("Plugin manifests are valid for the CodeBridge local stdio package.\n");
