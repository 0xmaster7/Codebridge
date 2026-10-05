import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigStore } from "../src/config/store.js";
import { createFakeDocker, fixtureProject } from "./checks/helpers.js";

void test("CLI cleanup removes only dead sessions and their verified CodeBridge containers", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-cli-cleanup-"));
  context.after(async () => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  await mkdir(home);
  const store = new ConfigStore(join(home, ".codebridge"));
  const docker = await createFakeDocker(base);
  const staleSession = "00000000-0000-4000-8000-000000000401";
  const activeSession = "00000000-0000-4000-8000-000000000402";
  const exited = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const stalePid = exited.pid;
  await new Promise<void>((resolve, reject) => {
    exited.once("error", reject);
    exited.once("close", () => resolve());
  });
  assert.ok(stalePid);
  await store.createOwnedSessionDirectory(staleSession, stalePid);
  await store.createOwnedSessionDirectory(activeSession, process.pid);
  const labels = {
    "io.codebridge.managed": "true",
    "io.codebridge.session": staleSession,
    "io.codebridge.run": "00000000-0000-4000-8000-000000000499",
  };
  await writeFile(docker.statePath, JSON.stringify({ labels, autoRemove: false }));
  await store.saveProject(
    fixtureProject(base, {
      executables: { git: "/usr/bin/git", docker: docker.executable },
    }),
  );

  const result = spawnSync(
    process.execPath,
    [join(process.cwd(), "dist", "src", "cli.js"), "cleanup"],
    {
      encoding: "utf8",
      env: { HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Removed 1 stale CodeBridge-owned session and 1 stale container/);
  assert.deepEqual(await store.listOwnedSessionDirectories(), [activeSession]);
  await readFile(`${docker.statePath}.removed`, "utf8");
  const calls = (await readFile(docker.callsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["ps", "inspect", "rm"],
  );
  assert.ok(calls[0]?.includes(`label=io.codebridge.session=${staleSession}`));
  assert.ok(calls[2]?.includes("c".repeat(64)));
});
