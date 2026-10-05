import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";

const requirements = new Map([
  ["src/security/path-guard.ts", 95],
  ["src/security/secret-policy.ts", 95],
  ["src/security/secret-scanner.ts", 95],
  ["src/git/mirror.ts", 95],
  ["src/git/runner.ts", 95],
  ["src/security/environment-sanitizer.ts", 95],
  ["src/checks/docker-args.ts", 95],
  ["src/security/approval-registry.ts", 95],
  ["src/security/snapshot-guard.ts", 95],
]);

const report = await readFile(new URL("../coverage/lcov.info", import.meta.url), "utf8");
const records = new Map();
for (const record of report.split("end_of_record")) {
  const source = /^SF:(.+)$/m.exec(record)?.[1];
  if (!source) continue;
  const branchFound = Number(/^BRF:(\d+)$/m.exec(record)?.[1] ?? 0);
  const branchHit = Number(/^BRH:(\d+)$/m.exec(record)?.[1] ?? 0);
  const relativeSource = source.replaceAll("\\", "/");
  records.set(relativeSource, { branchFound, branchHit });
}

const failures = [];
for (const [source, minimum] of requirements) {
  const record = records.get(source);
  assert.ok(record, `Coverage report is missing ${source}`);
  const percent = record.branchFound === 0 ? 100 : (record.branchHit / record.branchFound) * 100;
  process.stdout.write(`${source}: ${percent.toFixed(2)}% branch coverage\n`);
  if (percent < minimum) failures.push(`${source} is below ${minimum}% (${percent.toFixed(2)}%)`);
}
if (failures.length > 0) {
  throw new Error(`Security-critical branch coverage gate failed:\n${failures.join("\n")}`);
}
