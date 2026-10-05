# CodeBridge

CodeBridge v0.1 is a local MCP bridge for independent security and correctness audits of one explicitly approved Git repository. Its authoritative architecture, security invariants, trust model, tool contract, milestones, and acceptance gates are frozen in [CODEBRIDGE_SPEC.md](./CODEBRIDGE_SPEC.md).

> Do not point CodeBridge at repositories containing secrets that should never enter an AI model context. Secret detection and redaction are defense in depth, not a substitute for repository hygiene.

## What it is

CodeBridge exposes a bounded set of source, snapshot, and Git inspection tools over MCP stdio. Each process is bound to one approved project and serves an immutable source snapshot plus a CodeBridge-owned Git mirror. Approved project checks execute in disposable offline containers.

## What it is not

CodeBridge does not provide a terminal, arbitrary command execution, repository editing, Git writes, network access to checks, model-controlled authorization, or automatic project switching. Repository content and execution output are untrusted evidence.

## Security design

See [the frozen specification](./CODEBRIDGE_SPEC.md) and [ADR 0001](./docs/adr/0001-frozen-security-boundaries.md) for the full threat model and invariants. The implementation targets Node.js 24 LTS or a later supported LTS, TypeScript, MCP over stdio, and Docker-compatible isolation on macOS and Linux.

The M00 scaffold establishes the contract, package baseline, and local plugin shape. Installation, project authorization, snapshot creation, Git mirror behavior, tools, checks, sandboxing, and complete operational guidance are delivered through the milestones in the specification.

## Development

```sh
npm ci
npm run build
npm run format:check
npm run lint
npm run typecheck
npm test
```

Use Node.js 24 LTS or another supported LTS release. The complete verification and local acceptance procedures will be documented as those capabilities are implemented.

## License

MIT. See [LICENSE](./LICENSE).
