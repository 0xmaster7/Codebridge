import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitRunner } from "../../src/git/runner.js";

void test("GitRunner fixes execution context, strips host environment, and bounds errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-git-runner-"));
  try {
    const executable = join(root, "fake-git");
    await writeFile(
      executable,
      "#!/bin/sh\n" +
        'for arg in "$@"; do\n' +
        "  [ \"$arg\" = '--emit-large' ] && { yes x | head -c 1048576; exit 0; }\n" +
        "  [ \"$arg\" = '--fail' ] && { echo ordinary-failure >&2; exit 9; }\n" +
        "done\n" +
        'printf \'{"home":"%s","inherited":"%s","gitDir":"%s","args":"%s"}\' "$HOME" "${CODEBRIDGE_TEST_SECRET-}" "$GIT_DIR" "$*"\n',
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const runner = new GitRunner(
      executable,
      join(root, "mirror.git"),
      join(root, "index"),
      root,
      1024,
    );
    process.env["CODEBRIDGE_TEST_SECRET"] = "must-not-cross-boundary";
    try {
      const result = await runner.run(["status", "--short"]);
      const parsed = JSON.parse(result.stdout) as {
        home: string;
        inherited: string;
        gitDir: string;
        args: string;
      };
      assert.equal(parsed.home, root);
      assert.equal(parsed.inherited, "");
      assert.equal(parsed.gitDir, join(root, "mirror.git"));
      assert.match(parsed.args, /--no-optional-locks/);
      assert.match(parsed.args, /status/);
      const expectedFailure = await runner.run(["--fail"], { allowFailure: true });
      assert.equal(expectedFailure.exitCode, 9);
      assert.equal(expectedFailure.stderr.trim(), "ordinary-failure");
      await assert.rejects(runner.run(["--fail"]), { code: "GIT_FAILED" });
      await assert.rejects(runner.run(["--emit-large"]), { code: "GIT_FAILED" });
    } finally {
      delete process.env["CODEBRIDGE_TEST_SECRET"];
    }
    await assert.rejects(runner.run([]), { code: "INVALID_ARGUMENT" });
    await assert.rejects(runner.run(["bad\0arg"]), { code: "INVALID_ARGUMENT" });
    await assert.rejects(
      new GitRunner(join(root, "missing"), root, join(root, "index"), root).run(["status"]),
      { code: "GIT_FAILED" },
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runner.run(["status"], { signal: controller.signal }));
    const slow = join(root, "slow-git");
    await writeFile(slow, "#!/bin/sh\nkill -TERM $$\n", { mode: 0o700 });
    await chmod(slow, 0o700);
    const signaled = await new GitRunner(slow, root, join(root, "index"), root).run(["status"], {
      allowFailure: true,
    });
    assert.equal(signaled.exitCode, 128);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
