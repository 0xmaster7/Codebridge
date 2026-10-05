import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupStaleSessionContainers } from "../../src/cleanup/stale-containers.js";

async function fakeDocker(root: string, options: { sessionId: string; labelsMatch?: boolean }) {
  const executable = join(root, "docker-cleanup-fixture");
  const calls = join(root, "calls.jsonl");
  const state = join(root, "container.json");
  const labels = {
    "io.codebridge.managed": options.labelsMatch === false ? "false" : "true",
    "io.codebridge.session": options.sessionId,
  };
  await writeFile(state, JSON.stringify(labels));
  await writeFile(
    executable,
    `#!${process.execPath}\n` +
      `const fs = require("node:fs");\n` +
      `const args = process.argv.slice(2);\n` +
      `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");\n` +
      `if (args[0] === "context" && args[1] === "show") process.stdout.write("default\\n");\n` +
      `else if (args[0] === "context" && args[1] === "inspect") process.stdout.write("unix:///tmp/codebridge-cleanup.sock\\n");\n` +
      `else if (args[0] === "ps") process.stdout.write("0123456789abcdef\\n");\n` +
      `else if (args[0] === "inspect") process.stdout.write(fs.readFileSync(${JSON.stringify(state)}, "utf8"));\n` +
      `else if (args[0] === "rm") fs.writeFileSync(${JSON.stringify(state + ".removed")}, "yes");\n`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return { executable, calls, state };
}

void test("stale container cleanup verifies filtered and inspected CodeBridge ownership before removal", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-stale-cleanup-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const sessionId = "00000000-0000-4000-8000-000000000123";
  const docker = await fakeDocker(root, { sessionId });
  assert.equal(await cleanupStaleSessionContainers(docker.executable, sessionId), 1);
  await readFile(`${docker.state}.removed`, "utf8");
  const calls = (await readFile(docker.calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["context", "context", "ps", "inspect", "rm"],
  );
  const listCall = calls.find((args) => args[0] === "ps");
  const removeCall = calls.find((args) => args[0] === "rm");
  assert.ok(listCall?.some((arg) => arg === `label=io.codebridge.session=${sessionId}`));
  assert.ok(removeCall?.includes("0123456789abcdef"));
  await assert.rejects(cleanupStaleSessionContainers(docker.executable, "not-a-session"), {
    code: "INVALID_ARGUMENT",
  });
});

void test("stale container cleanup refuses changed ownership labels and unsafe IDs", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-stale-cleanup-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const sessionId = "00000000-0000-4000-8000-000000000124";
  const mismatch = await fakeDocker(root, { sessionId, labelsMatch: false });
  await assert.rejects(cleanupStaleSessionContainers(mismatch.executable, sessionId), {
    code: "SANDBOX_UNAVAILABLE",
  });
  const mismatchCalls = (await readFile(mismatch.calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(
    mismatchCalls.map((args) => args[0]),
    ["context", "context", "ps", "inspect"],
  );

  const unsafe = join(root, "unsafe-docker");
  await writeFile(
    unsafe,
    `#!${process.execPath}\n` +
      `const args = process.argv.slice(2);\n` +
      `if (args[0] === "context" && args[1] === "show") process.stdout.write("default\\n");\n` +
      `else if (args[0] === "context" && args[1] === "inspect") process.stdout.write("unix:///tmp/codebridge-cleanup.sock\\n");\n` +
      `else process.stdout.write("--privileged\\n");\n`,
    { mode: 0o700 },
  );
  await chmod(unsafe, 0o700);
  await assert.rejects(cleanupStaleSessionContainers(unsafe, sessionId), {
    code: "SANDBOX_LIMIT_UNAVAILABLE",
  });
});
