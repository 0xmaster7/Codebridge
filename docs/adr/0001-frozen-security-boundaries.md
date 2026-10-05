# ADR 0001: Preserve the frozen v0.1 security boundaries

- Status: Accepted
- Date: 2026-10-05
- Authority: `CODEBRIDGE_SPEC.md` (FINAL / FROZEN)

## Decision

Implement CodeBridge as a local MCP stdio server bound at startup to one explicitly approved repository. At session creation, create an immutable worktree snapshot and an independently owned Git mirror. Source and history inspection operate only on those snapshots. Repository-defined checks run only in an offline, non-root, resource-bounded disposable container using an externally approved immutable image. Authorization lives in CodeBridge-owned user configuration and is never granted by repository content or MCP arguments.

The server exposes only the fourteen read, history, approved-check, and job-control tools enumerated in Section 43. It has no generic command interface, write API, network-enablement API, or repository-switching API.

## Frozen invariants

This decision preserves INV-001 through INV-016 in the authoritative specification:

1. One externally approved repository per server process.
2. Explicit host-path authorization; no generic access to Git metadata.
3. No audit Git command against the live repository.
4. No mutation of the live repository, index, metadata, refs, or caches.
5. No arbitrary host command execution and no shell interpretation.
6. Repository Git configuration and scripts cannot expand host execution authority.
7. Fail closed on uncertain authorization, consistency, screening, approval, image, or cleanup state.
8. Repository execution is offline and receives no host credentials.
9. Every run has wall-time, CPU, memory, swap, process, descriptor, storage, and output limits.
10. Git operations are session-local and read-only with optional locks disabled.
11. Whole-object secret screening precedes all partial file or historical blob exposure.
12. Checks are externally approved; script approvals bind to content digests.
13. Provenance identifies the exact snapshot, history, configuration, checks, and images.

## Consequences

- A session cannot follow changes made to the live worktree after snapshot creation.
- Linked worktrees require explicit approval of the exact external Git metadata path.
- Symlink content, hardlinked files, unsupported Git layouts, unavailable images, and objects beyond screening limits may be unavailable.
- CodeBridge's own source, user-owned configuration, operating system, and approved immutable images remain in the trusted computing base.
- Prompt-injection defenses preserve provenance and workflow rules; they do not claim that a model is immune to prompt injection.
- Runtime and filesystem limitations must be reported honestly and cannot be hidden by weakening tests.

## Alternatives rejected

- Running Git against the live repository was rejected because repository configuration and metadata may trigger behavior or mutate live state.
- Host execution of project tests, linters, or build scripts was rejected because plugins and repository scripts are executable code.
- A generic command tool or model-supplied Docker arguments were rejected because they would grant broad host authority.
- Fetching missing Git objects or installing project dependencies during an audit was rejected because it introduces network access and authorization expansion.
