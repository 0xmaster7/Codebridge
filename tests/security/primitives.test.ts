import assert from "node:assert/strict";
import test from "node:test";
import { PathGuard } from "../../src/security/path-guard.js";
import { classifySecretPath, normalizeSecurityPath } from "../../src/security/secret-policy.js";
import { SecretScanner } from "../../src/security/secret-scanner.js";
import { StreamingRedactor } from "../../src/security/streaming-redactor.js";
import { EnvironmentSanitizer } from "../../src/security/environment-sanitizer.js";
import { LimitPolicy } from "../../src/security/limit-policy.js";
import { ApprovalRegistry } from "../../src/security/approval-registry.js";
import type { CheckProfile } from "../../src/config/schema.js";

void test("PathGuard accepts normalized repository paths and the explicit root marker", () => {
  const guard = new PathGuard();
  assert.equal(guard.normalizeRelativePath("src/main.ts"), "src/main.ts");
  assert.equal(guard.normalizeRelativePath(".", { allowDot: true }), ".");
  assert.equal(guard.normalizeRelativePath("cafe\u0301/file.ts"), "café/file.ts");
});

void test("PathGuard rejects traversal, absolute paths, shell-like control text, and malformed components", () => {
  const guard = new PathGuard();
  for (const path of [
    "",
    "\0bad",
    "../secret",
    "../../etc/passwd",
    "/absolute/path",
    "~/.ssh/id_rsa",
    "foo/../../../bar",
    "foo//bar",
    "foo/./bar",
    "foo\\bar",
    "C:/Users/secret",
    "foo\nbar",
    "foo\rbar",
    "   /x",
    "foo/   /bar",
  ]) {
    assert.throws(() => guard.normalizeRelativePath(path), { name: "CodeBridgeError" }, path);
  }
  assert.equal(guard.normalizeRelativePath("$(touch pwned)"), "$(touch pwned)");
  assert.throws(() => guard.normalizeRelativePath(42 as unknown as string), {
    code: "INVALID_PATH",
  });
});

void test("secret path policy folds ASCII case and keeps templates subject to content screening", () => {
  assert.equal(
    normalizeSecurityPath("C:\u0301onfig/Ä"),
    "C:\u0301onfig/Ä".normalize("NFC").replace(/[A-Z]/g, (letter) => letter.toLowerCase()),
  );
  assert.equal(classifySecretPath(".env"), "environment-file");
  assert.equal(classifySecretPath(".ENV.local"), "environment-file");
  assert.equal(classifySecretPath("keys/PRIVATE.PEM"), "private-key");
  assert.equal(classifySecretPath("id_ed25519"), "ssh-material");
  assert.equal(classifySecretPath(".SSH/config"), "ssh-material");
  assert.equal(classifySecretPath(".aws/credentials"), "cloud-credentials");
  assert.equal(classifySecretPath("credentials.json"), "credential-file");
  assert.equal(classifySecretPath("service-account-prod.json"), "credential-file");
  assert.equal(classifySecretPath(".docker/config.json"), "docker-auth");
  assert.equal(classifySecretPath(".npmrc"), "package-manager-auth");
  assert.equal(classifySecretPath(".env.example"), null);
  for (const [path, expected] of [
    ["config.pem", "private-key"],
    ["config.key", "private-key"],
    ["id_rsa.pub", "ssh-material"],
    ["id_ed25519-cert.pub", "ssh-material"],
    [".aws/config", "cloud-credentials"],
    ["service-account.json", "credential-file"],
    ["service-account-foo.JSON", "credential-file"],
    [".docker/config", "docker-auth"],
    [".yarnrc.yml", "package-manager-auth"],
    [".pypirc", "package-manager-auth"],
    ["regular.txt", null],
  ] as const)
    assert.equal(classifySecretPath(path), expected, path);
});

void test("PathGuard denies sensitive path variants but leaves .env.example to full content scanning", () => {
  const guard = new PathGuard();
  for (const path of [
    ".ENV",
    ".env.local",
    "keys/PRIVATE.PEM",
    ".ssh/config",
    ".AWS/credentials",
  ]) {
    assert.throws(() => guard.assertNotSecretPath(path), { name: "CodeBridgeError" });
  }
  assert.equal(guard.assertNotSecretPath(".env.example"), ".env.example");
});

void test("whole-object SecretScanner blocks common credential formats without revealing values", () => {
  const scanner = new SecretScanner();
  assert.deepEqual(scanner.scan("").kinds, []);
  assert.deepEqual(scanner.scan(Buffer.from("ordinary bytes", "utf8")).kinds, []);
  const sample = [
    "OPENAI_API_KEY=sk-proj-0123456789abcdefghijklmnopqrstuv",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    "AKIA1234567890ABCDEF",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
    "password = 'correct-horse-battery-staple'",
  ].join("\n");
  const result = scanner.scan(sample);
  assert.equal(result.blocked, true);
  assert.ok(result.kinds.includes("openai-key"));
  assert.ok(result.kinds.includes("github-token"));
  assert.ok(result.kinds.includes("aws-key"));
  assert.ok(result.kinds.includes("bearer-token"));
  assert.ok(result.kinds.includes("secret-assignment"));
  const redacted = scanner.redact(sample);
  assert.ok(!redacted.includes("sk-proj-0123456789abcdefghijklmnopqrstuv"));
  assert.ok(!redacted.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD"));
  assert.ok(!redacted.includes("correct-horse-battery-staple"));
  assert.equal(scanner.redact("no credentials here"), "no credentials here");
});

void test("whole-object SecretScanner detects PEM blocks and permits ordinary source", () => {
  const scanner = new SecretScanner();
  assert.equal(scanner.scan("const greeting = 'hello world';").blocked, false);
  const key = "-----BEGIN PRIVATE KEY-----\nMIIExampleSecretMaterial\n-----END PRIVATE KEY-----";
  assert.equal(scanner.scan(key).blocked, true);
  assert.equal(scanner.redact(key), "[REDACTED_PRIVATE_KEY]");
  const otherKeys = [
    "-----BEGIN RSA PRIVATE KEY-----\\nmaterial\\n-----END RSA PRIVATE KEY-----",
    "-----BEGIN EC PRIVATE KEY-----\\nmaterial\\n-----END EC PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----\\nmaterial\\n-----END OPENSSH PRIVATE KEY-----",
    "-----BEGIN DSA PRIVATE KEY-----\\nmaterial\\n-----END DSA PRIVATE KEY-----",
  ];
  for (const value of otherKeys)
    assert.equal(scanner.scan(value.replaceAll("\\n", "\n")).blocked, true);
  assert.equal(scanner.scan("-----BEGIN PRIVATE KEY-----\ntruncated").blocked, false);
  assert.deepEqual(scanner.scan(Buffer.from([0xff, 0xfe])).kinds, []);
});

void test("SecretScanner detects every supported token family including repeated matches", () => {
  const scanner = new SecretScanner();
  const inputs = [
    "sk-0123456789abcdefghijklmnopqrstuv",
    "gho_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    "github_pat_abcdefghijklmnopqrstuvwxyz0123456789ABCDE_12345678901234567890",
    "ASIA1234567890ABCDEF",
    "private-key: 'private-material-123'",
    "access_token=token-material-123",
  ];
  for (const value of inputs) assert.equal(scanner.scan(value).blocked, true, value);
  const multiple = scanner.scan("secret=secretmaterial123; password=passwordmaterial123");
  assert.equal(multiple.matchCount, 2);
  assert.deepEqual(multiple.kinds, ["secret-assignment"]);
  const clean = scanner.scan("ordinary source text");
  assert.deepEqual(clean, { blocked: false, kinds: [], matchCount: 0 });
});

void test("StreamingRedactor protects tokens and PEM blocks split at arbitrary chunk boundaries", () => {
  const token = "sk-proj-0123456789abcdefghijklmnopqrstuv";
  const key = "-----BEGIN RSA PRIVATE KEY-----\nabc123secret\n-----END RSA PRIVATE KEY-----";
  const redactor = new StreamingRedactor(4096);
  for (const chunk of [
    `prefix ${token.slice(0, 12)}`,
    `${token.slice(12)}\n${key.slice(0, 24)}`,
    key.slice(24),
  ]) {
    assert.equal(redactor.push(chunk), "");
  }
  const result = redactor.flush();
  assert.ok(!result.includes(token));
  assert.ok(!result.includes("abc123secret"));
  assert.ok(result.includes("[REDACTED_OPENAI_KEY]"));
  assert.ok(result.includes("[REDACTED_PRIVATE_KEY]"));
});

void test("StreamingRedactor fails closed when bounded output retention is exceeded", () => {
  const redactor = new StreamingRedactor(4);
  assert.equal(redactor.push("1234"), "");
  assert.throws(() => redactor.push("5"), RangeError);
  const closed = new StreamingRedactor(16);
  assert.equal(closed.push("safe text"), "");
  assert.equal(closed.flush(), "safe text");
  assert.equal(closed.flush(), "");
  assert.throws(() => closed.push("late"), /closed/);
  const unclosedKey = new StreamingRedactor(128);
  unclosedKey.push("safe\n-----BEGIN PRIVATE KEY-----\nsecret fragment");
  assert.equal(unclosedKey.flush(), "safe\n[REDACTED_PRIVATE_KEY]");
  const invalidUtf8 = new StreamingRedactor(16);
  invalidUtf8.push(Buffer.from([0xff]));
  assert.equal(invalidUtf8.flush(), "�");
});

void test("EnvironmentSanitizer never copies parent secrets into child environments", () => {
  const sanitizer = new EnvironmentSanitizer();
  const git = sanitizer.forGit({ home: "/session/home", xdgConfigHome: "/session/config" });
  assert.equal(git["HOME"], "/session/home");
  assert.equal(git["GIT_OPTIONAL_LOCKS"], "0");
  assert.equal(git["OPENAI_API_KEY"], undefined);
  assert.equal(git["SSH_AUTH_SOCK"], undefined);

  const docker = sanitizer.forDocker("/usr/local/bin/docker", {
    CI: "true",
    OPENAI_API_KEY: "TEST_DO_NOT_LEAK",
    AWS_SECRET_ACCESS_KEY: "TEST_DO_NOT_LEAK",
    CUSTOM_VALUE: "allowed by external profile only",
  });
  assert.equal(docker["CI"], "true");
  assert.equal(docker["OPENAI_API_KEY"], undefined);
  assert.equal(docker["AWS_SECRET_ACCESS_KEY"], undefined);
  assert.equal(docker["HOME"], "/nonexistent");
  assert.deepEqual(Object.keys(docker).sort(), [
    "CI",
    "CUSTOM_VALUE",
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
  ]);
  const filtered = sanitizer.forDocker("/opt/docker/bin/docker", {
    good_KEYLESS: "1",
    _bad: "2",
    KEY_MATERIAL: "secret",
    HUGE: "x".repeat(513),
    LOW: "safe",
  });
  assert.deepEqual(filtered, {
    HOME: "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    PATH: "/opt/docker/bin:/usr/bin:/bin",
    LOW: "safe",
  });
});

void test("LimitPolicy bounds reads/search and rejects invalid or over-budget snapshots", () => {
  const policy = new LimitPolicy({
    maxSnapshotBytes: 1024,
    maxFiles: 10,
    maxSingleReadableFileBytes: 128,
    maxSecretScanBytes: 256,
    maxReadResponseBytes: 100,
    maxSearchResults: 20,
    maxConcurrentReads: 2,
    maxConcurrentChecks: 1,
    maxQueuedChecks: 2,
    maxRetainedOutputBytes: 512,
  });
  assert.equal(policy.boundedReadResponse(1000), 100);
  assert.equal(policy.boundedSearchResults(100), 20);
  assert.throws(() => policy.requireSnapshotBytes(1025), { name: "CodeBridgeError" });
  assert.throws(() => policy.requireFileCount(11), { name: "CodeBridgeError" });
  assert.throws(() => policy.requireSecretScanBytes(257), { name: "CodeBridgeError" });
  assert.throws(() => policy.boundedSearchResults(0), { name: "CodeBridgeError" });
  for (const invalid of [-1, 1.25, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => policy.boundedReadResponse(invalid), { name: "CodeBridgeError" });
    assert.throws(() => policy.boundedSearchResults(invalid), { name: "CodeBridgeError" });
    assert.throws(() => policy.requireFileCount(invalid), { name: "CodeBridgeError" });
    assert.throws(() => policy.requireSnapshotBytes(invalid), { name: "CodeBridgeError" });
    assert.throws(() => policy.requireSecretScanBytes(invalid), { name: "CodeBridgeError" });
  }
  assert.equal(policy.boundedReadResponse(0), 0);
  assert.equal(policy.boundedSearchResults(1), 1);
});

void test("ApprovalRegistry binds project-script execution to exact script, file, image, and adapter", () => {
  const registry = new ApprovalRegistry();
  const manifestBytes = Buffer.from(JSON.stringify({ scripts: { test: "node tests/run.js" } }));
  const imageDigest = `sha256:${"a".repeat(64)}`;
  const approval = registry.approveScript(
    "package.json",
    manifestBytes,
    "test",
    imageDigest,
    "codebridge-adapter-1",
  );
  const profile: CheckProfile = {
    id: "project.test",
    adapter: "project-script-sandboxed",
    imageDigest,
    executable: "/usr/bin/node",
    fixedArgs: [],
    targetMode: "none",
    allowedTargetSuffixes: [],
    allowedTargetPaths: [],
    timeoutSeconds: 60,
    stdoutLimitBytes: 1024,
    stderrLimitBytes: 1024,
    environmentAllowlist: ["CI"],
    workingDirectory: "/workspace",
    dependencyMode: "image-contained",
    enabled: true,
    scriptApproval: approval,
  };
  registry.assertScriptCurrent(profile, manifestBytes, "node tests/run.js", "codebridge-adapter-1");
  assert.equal(
    registry.approveScript(
      "package.json",
      Buffer.from('{"scripts":{"test":"  node tests/run.js  "}}'),
      "test",
      imageDigest,
      "codebridge-adapter-1",
    ).scriptValue,
    "  node tests/run.js  ",
  );
  assert.throws(
    () =>
      registry.assertScriptCurrent(
        profile,
        manifestBytes,
        "node tests/evil.js",
        "codebridge-adapter-1",
      ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "CHECK_APPROVAL_STALE");
      return true;
    },
  );
  assert.throws(
    () =>
      registry.assertScriptCurrent(
        profile,
        manifestBytes,
        "node tests/run.js",
        "codebridge-adapter-2",
      ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "CHECK_APPROVAL_STALE");
      return true;
    },
  );
  assert.throws(
    () =>
      registry.assertScriptCurrent(
        { ...profile, imageDigest: `sha256:${"b".repeat(64)}` },
        manifestBytes,
        "node tests/run.js",
        "codebridge-adapter-1",
      ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "CHECK_APPROVAL_STALE");
      return true;
    },
  );
  assert.throws(
    () =>
      registry.assertScriptCurrent(
        { ...profile, scriptApproval: undefined },
        manifestBytes,
        "node tests/run.js",
        "codebridge-adapter-1",
      ),
    { code: "CHECK_NOT_ALLOWED" },
  );
  assert.throws(
    () => registry.approveScript("package.json", manifestBytes, "test", "latest", "v1"),
    { code: "INVALID_ARGUMENT" },
  );
  assert.throws(
    () => registry.approveScript("package.json", manifestBytes, "test", imageDigest, ""),
    { code: "INVALID_ARGUMENT" },
  );
});

void test("ApprovalRegistry refuses missing or non-string project scripts", () => {
  const registry = new ApprovalRegistry();
  const imageDigest = `sha256:${"a".repeat(64)}`;
  for (const bytes of [
    Buffer.from("{}"),
    Buffer.from('{"scripts":{"test":42}}'),
    Buffer.from("not json"),
  ]) {
    assert.throws(() => registry.approveScript("package.json", bytes, "test", imageDigest, "v1"));
  }
});
