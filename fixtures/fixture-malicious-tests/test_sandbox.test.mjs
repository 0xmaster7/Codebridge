import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { connect } from "node:net";
import process from "node:process";
import { setImmediate } from "node:timers";
import test from "node:test";

test("runs with no uid, capabilities, or privilege escalation", () => {
  assert.equal(process.getuid(), 65532);
  const status = readFileSync("/proc/self/status", "utf8");
  assert.match(status, /^CapEff:\s+0+$/m);
  assert.match(status, /^NoNewPrivs:\s+1$/m);
  const limits = readFileSync("/proc/self/limits", "utf8");
  assert.match(limits, /^Max open files\s+64\s+64\s+files\s*$/m);
  assert.match(limits, /^Max core file size\s+0\s+0\s+bytes\s*$/m);
});

test("has the configured kernel resource and storage bounds", () => {
  assert.equal(readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(), String(256 * 1024 * 1024));
  assert.equal(readFileSync("/sys/fs/cgroup/memory.swap.max", "utf8").trim(), "0");
  assert.equal(readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim(), "32");
  assert.equal(readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(), "100000 100000");
  for (const [mount, maximumMb] of [
    ["/workspace", 16],
    ["/tmp", 8],
    ["/home/cb", 8],
  ]) {
    const storage = statfsSync(mount);
    assert.equal(storage.bsize * storage.blocks, maximumMb * 1024 * 1024);
  }
  const rootMount = readFileSync("/proc/mounts", "utf8")
    .split("\n")
    .find((line) => line.split(" ")[1] === "/");
  assert.ok(rootMount?.split(" ")[3]?.split(",").includes("ro"));
});

test("cannot write the captured source, image root, or host socket", async () => {
  for (const path of [
    "/source/codebridge-escape",
    "/etc/codebridge-escape",
    "/root/codebridge-escape",
  ]) {
    assert.throws(() => openSync(path, "wx"));
  }
  if (existsSync("/var/run/docker.sock")) {
    assert.throws(() => openSync("/var/run/docker.sock", "w"));
  }
  assert.deepEqual(readdirSync("/sys/class/net"), ["lo"]);
  await new Promise((resolve, reject) => {
    const socket = connect({ host: "1.1.1.1", port: 80 });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("external network connection succeeded"));
    });
    socket.once("error", () => resolve());
    socket.once("timeout", () => {
      socket.destroy();
      resolve();
    });
  });
  assert.equal(process.env["CODEBRIDGE_HOST_SECRET_CANARY"], undefined);
  assert.equal(process.env["OPENAI_API_KEY"], undefined);
  assert.equal(process.env["SSH_AUTH_SOCK"], undefined);
});

test("process count and writable workspace remain bounded", async () => {
  const children = [];
  try {
    for (let index = 0; index < 64; index += 1) {
      try {
        const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
        child.on("error", () => undefined);
        const done = new Promise((resolve) => child.once("close", resolve));
        children.push({ child, done });
      } catch {
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
      if (children.at(-1)?.child.pid === undefined) break;
    }
    assert.ok(children.length < 64, "the PID cap must reject additional processes");
  } finally {
    for (const entry of children) entry.child.kill("SIGKILL");
    await Promise.all(children.map((entry) => entry.done));
  }

  const path = "/workspace/codebridge-fill";
  const descriptor = openSync(path, "wx");
  const chunk = Buffer.alloc(1024 * 1024);
  let bytes = 0;
  let exhausted = false;
  try {
    while (bytes < 32 * 1024 * 1024) {
      try {
        bytes += writeSync(descriptor, chunk);
      } catch (error) {
        if (error.code !== "ENOSPC") throw error;
        exhausted = true;
        break;
      }
    }
  } finally {
    closeSync(descriptor);
    unlinkSync(path);
  }
  assert.ok(exhausted, "the workspace tmpfs must stop writes at its configured bound");
  assert.ok(bytes <= 16 * 1024 * 1024);
});
