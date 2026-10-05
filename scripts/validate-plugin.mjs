import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";

const manifest = JSON.parse(await readFile(new URL("../plugin.json", import.meta.url), "utf8"));
const mcpManifest = JSON.parse(await readFile(new URL("../mcp.json", import.meta.url), "utf8"));

assert.equal(manifest.name, "codebridge");
assert.equal(manifest.version, "0.1.0");
assert.equal(typeof manifest.description, "string");
assert.equal(typeof mcpManifest.mcpServers?.codebridge, "object");
assert.equal(mcpManifest.mcpServers.codebridge.type, "stdio");
assert.equal(mcpManifest.mcpServers.codebridge.command, "node");
assert.deepEqual(mcpManifest.mcpServers.codebridge.args, ["${PLUGIN_ROOT}/dist/src/cli.js", "mcp"]);

process.stdout.write("Plugin manifests are valid for the CodeBridge local stdio package.\n");
