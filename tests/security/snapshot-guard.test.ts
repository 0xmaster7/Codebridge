import assert from "node:assert/strict";
import {
  appendFile,
  link,
  lstat,
  mkdtemp,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SnapshotGuard, type SnapshotGuardIo } from "../../src/security/snapshot-guard.js";

void test("SnapshotGuard reads a stable regular file and returns its verified digest and metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-guard-"));
  try {
    const path = join(root, "safe.txt");
    await writeFile(path, "bounded contents\n", { mode: 0o600 });
    const result = await new SnapshotGuard().readRegularFile(path, { maxBytes: 100 });
    assert.equal(result.bytes.toString(), "bounded contents\n");
    assert.equal(result.size, result.bytes.length);
    assert.equal(result.mode & 0o777, 0o600);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.ok(result.inode > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("SnapshotGuard rejects missing, nonregular, oversized, symlinked, and hardlinked files", async () => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-guard-"));
  try {
    const guard = new SnapshotGuard();
    await assert.rejects(guard.readRegularFile(join(root, "missing"), { maxBytes: 10 }), {
      code: "FILE_NOT_FOUND",
    });
    const directory = join(root, "directory");
    await mkdir(directory);
    await assert.rejects(guard.readRegularFile(directory, { maxBytes: 10 }), {
      code: "UNSUPPORTED_FILE_TYPE",
    });
    const large = join(root, "large");
    await writeFile(large, "0123456789");
    await assert.rejects(guard.readRegularFile(large, { maxBytes: 9 }), {
      code: "SECRET_SCAN_LIMIT",
    });
    const linkPath = join(root, "link");
    await symlink(large, linkPath);
    await assert.rejects(guard.readRegularFile(linkPath, { maxBytes: 100 }), {
      code: "UNSUPPORTED_FILE_TYPE",
    });
    const alias = join(root, "alias");
    const source = await realpath(large);
    await link(source, alias);
    await assert.rejects(guard.readRegularFile(alias, { maxBytes: 100 }), {
      code: "HARDLINK_BLOCKED",
    });
    assert.equal(
      (
        await guard.readRegularFile(alias, { maxBytes: 100, rejectHardlinks: false })
      ).bytes.toString(),
      "0123456789",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("SnapshotGuard prevents parent and leaf symlink traversal inside snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-guard-"));
  const outside = await mkdtemp(join(tmpdir(), "codebridge-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "do not follow");
    await symlink(outside, join(root, "parent-link"));
    await symlink(join(outside, "secret.txt"), join(root, "leaf-link"));
    const guard = new SnapshotGuard();
    await assert.rejects(guard.assertNoSymlinkComponents(root, "parent-link/secret.txt"), {
      code: "SYMLINK_BLOCKED",
    });
    await assert.rejects(guard.assertNoSymlinkComponents(root, "leaf-link"), {
      code: "SYMLINK_BLOCKED",
    });
    await assert.rejects(guard.assertNoSymlinkComponents(root, "../outside/secret.txt"), {
      code: "OUTSIDE_ROOT",
    });
    await assert.rejects(guard.assertNoSymlinkComponents(root, "missing/secret.txt"));
    await mkdir(join(root, "parent-file"));
    await rm(join(root, "parent-file"), { recursive: true });
    await writeFile(join(root, "parent-file"), "x");
    await assert.rejects(guard.assertNoSymlinkComponents(root, "parent-file/child"), {
      code: "UNSUPPORTED_FILE_TYPE",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

void test("SnapshotGuard accepts the approved root and rejects symlinked or non-directory roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-guard-root-"));
  const outside = await mkdtemp(join(tmpdir(), "codebridge-guard-outside-"));
  try {
    const guard = new SnapshotGuard();
    await guard.assertNoSymlinkComponents(root, ".");
    await assert.rejects(guard.assertNoSymlinkComponents(join(root, "missing"), "."));
    const file = join(outside, "file");
    await writeFile(file, "not a directory");
    await assert.rejects(guard.assertNoSymlinkComponents(file, "."), {
      code: "OUTSIDE_ROOT",
    });
    const alias = join(outside, "root-alias");
    await symlink(root, alias);
    await assert.rejects(guard.assertNoSymlinkComponents(alias, "safe.txt"), {
      code: "OUTSIDE_ROOT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

void test("SnapshotGuard fails closed on lstat and no-follow open errors", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-guard-errors-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "safe.txt");
  await writeFile(path, "safe");
  const accessError = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const failingStat: SnapshotGuardIo = {
    lstat: (): Promise<Stats> => Promise.reject(accessError),
    open,
    realpath,
  };
  await assert.rejects(new SnapshotGuard(failingStat).readRegularFile(path, { maxBytes: 10 }), {
    code: "EACCES",
  });
  const noFollowError = Object.assign(new Error("link race"), { code: "ELOOP" });
  const failingOpen: SnapshotGuardIo = {
    lstat,
    open: (): Promise<FileHandle> => Promise.reject(noFollowError),
    realpath,
  };
  await assert.rejects(new SnapshotGuard(failingOpen).readRegularFile(path, { maxBytes: 10 }), {
    code: "SNAPSHOT_RACE_DETECTED",
  });
});

void test("SnapshotGuard catches descriptor identity and post-read path replacement races", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-guard-races-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "safe.txt");
  await writeFile(path, "before");
  const mismatchIo: SnapshotGuardIo = {
    lstat,
    realpath,
    open: async (target, flags) => {
      const handle = await open(target, flags);
      return new Proxy(handle, {
        get(object, property) {
          if (property === "stat") {
            return async () => {
              const stats = await object.stat();
              const mismatch = Object.create(stats) as Stats;
              Object.defineProperty(mismatch, "ino", { value: stats.ino + 1 });
              return mismatch;
            };
          }
          const value = Reflect.get(object, property, object) as unknown;
          return (typeof value === "function" ? value.bind(object) : value) as never;
        },
      });
    },
  };
  await assert.rejects(new SnapshotGuard(mismatchIo).readRegularFile(path, { maxBytes: 10 }), {
    code: "SNAPSHOT_RACE_DETECTED",
  });

  let replaced = false;
  const replacePathIo: SnapshotGuardIo = {
    lstat,
    realpath,
    open: async (target, flags) => {
      const handle = await open(target, flags);
      return new Proxy(handle, {
        get(object, property) {
          if (property === "readFile") {
            return async () => {
              const bytes = await object.readFile();
              if (!replaced) {
                replaced = true;
                const filePath = String(target);
                await rename(filePath, `${filePath}.old`);
                await writeFile(filePath, "replacement");
              }
              return bytes;
            };
          }
          const value = Reflect.get(object, property, object) as unknown;
          return (typeof value === "function" ? value.bind(object) : value) as never;
        },
      });
    },
  };
  await assert.rejects(new SnapshotGuard(replacePathIo).readRegularFile(path, { maxBytes: 100 }), {
    code: "SNAPSHOT_RACE_DETECTED",
  });
});

void test("SnapshotGuard rechecks size and approved-root identity at the read boundary", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codebridge-guard-recheck-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "safe.txt");
  await writeFile(path, "x");
  const growingFileIo: SnapshotGuardIo = {
    lstat,
    realpath,
    open: async (target, flags) => {
      await appendFile(target, "growing");
      return open(target, flags);
    },
  };
  await assert.rejects(new SnapshotGuard(growingFileIo).readRegularFile(path, { maxBytes: 4 }), {
    code: "SECRET_SCAN_LIMIT",
  });

  let statCount = 0;
  const changedRootIo: SnapshotGuardIo = {
    realpath: () => Promise.resolve(root),
    open,
    lstat: async (target: string) => {
      const stats = await lstat(target);
      statCount += 1;
      if (statCount !== 2) return stats;
      const changed = Object.create(stats) as Stats;
      Object.defineProperty(changed, "dev", { value: stats.dev + 1 });
      return changed;
    },
  };
  await assert.rejects(new SnapshotGuard(changedRootIo).assertNoSymlinkComponents(root, "."), {
    code: "OUTSIDE_ROOT",
  });

  let rootCheckCount = 0;
  const invalidatedRootIo: SnapshotGuardIo = {
    realpath: () => Promise.resolve(root),
    open,
    lstat: async (target: string) => {
      const stats = await lstat(target);
      if (target === root) {
        rootCheckCount += 1;
        if (rootCheckCount === 3) {
          const invalidated = Object.create(stats) as Stats;
          Object.defineProperty(invalidated, "isDirectory", { value: () => false });
          return invalidated;
        }
      }
      return stats;
    },
  };
  await assert.rejects(new SnapshotGuard(invalidatedRootIo).assertNoSymlinkComponents(root, "."), {
    code: "OUTSIDE_ROOT",
  });
});
