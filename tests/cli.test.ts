import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function invoke(home: string, args: readonly string[]) {
  return spawnSync(process.execPath, [join(process.cwd(), "dist", "src", "cli.js"), ...args], {
    encoding: "utf8",
    env: { HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
  });
}

void test("CLI supports project setup, selection, status, authorization, doctor, and cleanup", async () => {
  const base = await mkdtemp(join(tmpdir(), "codebridge-cli-"));
  const home = join(base, "home");
  const repository = join(base, "repository");
  try {
    await mkdir(home);
    await mkdir(repository);
    await writeFile(join(repository, "README.md"), "approved fixture requirements\n");
    execFileSync("git", ["init", "--quiet"], { cwd: repository });

    const noProject = invoke(home, ["status"]);
    assert.equal(noProject.status, 0);
    assert.match(noProject.stdout, /No active CodeBridge project/);
    const doctorEmpty = invoke(home, ["doctor"]);
    assert.equal(doctorEmpty.status, 0);
    assert.match(doctorEmpty.stdout, /Node\.js .* supported/);
    assert.match(doctorEmpty.stdout, /No project selected/);

    const init = invoke(home, ["init", repository]);
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /Requirement candidates \(not approved\): README\.md/);
    const match = /Initialized (cb-[a-f0-9]{16})\./.exec(init.stdout);
    assert.ok(match?.[1]);
    const projectId = match[1];
    assert.equal(invoke(home, ["checks"]).status, 1);

    const selected = invoke(home, ["select", projectId]);
    assert.equal(selected.status, 0, selected.stderr);
    const status = invoke(home, ["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`Active project: ${projectId}`));
    assert.match(status.stdout, /Approved requirements: 0/);

    const requirement = invoke(home, ["approve-requirements", "README.md"]);
    assert.equal(requirement.status, 0, requirement.stderr);
    assert.match(requirement.stdout, /Approved requirement path README\.md at SHA-256/);
    const checks = invoke(home, ["checks"]);
    assert.equal(checks.status, 0, checks.stderr);
    assert.match(checks.stdout, /No externally approved check profiles/);
    assert.match(invoke(home, ["sessions"]).stdout, /No CodeBridge-owned sessions/);
    assert.match(invoke(home, ["cleanup"]).stdout, /Removed 0 stale CodeBridge-owned sessions/);

    assert.equal(invoke(home, ["init", repository]).status, 1);
    assert.equal(invoke(home, ["select", "cb-0000000000000000"]).status, 1);
    const nonInteractiveApproval = invoke(home, ["approve-check", "profile.json"]);
    assert.equal(nonInteractiveApproval.status, 1);
    assert.match(nonInteractiveApproval.stderr, /requires an interactive terminal/);
    assert.match(invoke(home, ["--version"]).stdout, /0\.1\.0/);
    assert.equal(invoke(home, ["unknown"]).status, 0);
    assert.equal(invoke(home, ["status", "unexpected"]).status, 0);
    assert.equal(invoke(home, ["doctor", "unexpected"]).status, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
