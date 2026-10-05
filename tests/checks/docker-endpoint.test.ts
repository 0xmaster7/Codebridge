import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakeDocker } from "./helpers.js";
import { resolveDockerHost } from "../../src/checks/docker-endpoint.js";

void test("Docker endpoint resolution pins only a local Unix socket", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-docker-endpoint-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const local = await createFakeDocker(root, { dockerHost: "unix:///tmp/codebridge.sock" });
  assert.equal(await resolveDockerHost(local.executable), "unix:///tmp/codebridge.sock");

  const remoteRoot = join(root, "remote");
  await mkdir(remoteRoot);
  const remote = await createFakeDocker(remoteRoot, { dockerHost: "tcp://example.invalid:2376" });
  await assert.rejects(resolveDockerHost(remote.executable), {
    code: "SANDBOX_UNAVAILABLE",
  });
});
