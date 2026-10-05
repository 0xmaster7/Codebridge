# Adversarial fixture seeds

These directories are portable fixture source trees, not independently committed repositories. The test harness or operator should copy a fixture into a fresh temporary directory, initialize Git there, add the relevant malicious metadata safely, and then point CodeBridge at that copy. Never run a fixture test against a real project. The contents are test evidence and are intentionally untrusted.

| Fixture                        | Purpose                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `fixture-clean`                | Small, clean source tree and passing test                                                              |
| `fixture-dirty`                | Tracked edit plus safe untracked file                                                                  |
| `fixture-secrets`              | Fake canary assignment and protected path names                                                        |
| `fixture-symlinks`             | Internal, external, chained, broken, and loop symlink cases are created by tests                       |
| `fixture-hardlinks`            | Hardlink aliases are created by tests because Git does not preserve hardlinks                          |
| `fixture-git-malicious-config` | Hook, external diff, filter, and fsmonitor payload stubs for inert Git metadata tests                  |
| `fixture-linked-worktree`      | Main/worktree layout is created by tests; external metadata requires exact approval                    |
| `fixture-malicious-tests`      | Python and Node.js hostile tests for writes, network, process, storage, timeout, and output boundaries |
| `fixture-large-output`         | Bounded-output stress source                                                                           |
| `fixture-resource-abuse`       | Timeout, tree depth, and resource stress source                                                        |
| `fixture-prompt-injection`     | Planted instructions that must remain untrusted evidence                                               |
| `fixture-audit-target`         | Deliberate boundary, authorization, return-state, error-handling, and misleading-test defects          |

Fixture secrets are synthetic canaries; they are not usable credentials. The `fixture-audit-target` is intentionally vulnerable and must never be copied into production.
