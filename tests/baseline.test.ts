import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import test from "node:test";

const execFileAsync = promisify(execFile);

void test("frozen specification matches the supplied contract digest", async () => {
  const spec = await readFile(resolve("CODEBRIDGE_SPEC.md"));
  const digest = createHash("sha256").update(spec).digest("hex");
  assert.equal(digest, "ff0cad4d79aed76f4bd1ab12804b87fd0f855558fd2c993eaded57308225c37b");
});

void test("compiled CLI reports the package version", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    resolve("dist/src/cli.js"),
    "--version",
  ]);
  assert.equal(stdout, "0.1.0\n");
  assert.equal(stderr, "");
});
