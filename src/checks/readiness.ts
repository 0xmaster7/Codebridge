import { spawn } from "node:child_process";
import { CodeBridgeError } from "../errors.js";
import type { CheckProfile, ProjectConfig } from "../config/schema.js";
import { ApprovalRegistry } from "../security/approval-registry.js";
import { EnvironmentSanitizer } from "../security/environment-sanitizer.js";
import { SecretScanner } from "../security/secret-scanner.js";
import { SnapshotGuard } from "../security/snapshot-guard.js";
import type { WorktreeSnapshot } from "../snapshot/manager.js";
import { validateTargets } from "./target-policy.js";
import { resolveDockerHost } from "./docker-endpoint.js";

export type CheckReadinessState = "ready" | "image-missing" | "dependencies-not-ready" | "disabled";

export interface CheckReadiness {
  readonly checkId: string;
  readonly adapter: CheckProfile["adapter"];
  readonly imageDigest: string;
  readonly targetMode: CheckProfile["targetMode"];
  readonly timeoutSeconds: number;
  readonly approvalStatus: "approved" | "stale" | "not-required";
  readonly dependencyReadiness: CheckReadinessState;
}

interface ImageInfo {
  readonly Id?: string;
  readonly RepoDigests?: readonly string[];
  readonly Config?: {
    readonly Env?: readonly string[];
  };
}

async function runDocker(
  executable: string,
  args: readonly string[],
  timeoutMs = 15000,
): Promise<string> {
  const dockerHost = await resolveDockerHost(executable);
  const environment = new EnvironmentSanitizer().forDocker(executable, {}, dockerHost);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      env: environment,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const output: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) child.kill("SIGKILL");
      else output.push(Buffer.from(chunk));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new CodeBridgeError(
          "SANDBOX_UNAVAILABLE",
          "Docker-compatible runtime could not be started.",
          { cause: error },
        ),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (bytes > 1024 * 1024) {
        reject(
          new CodeBridgeError(
            "SANDBOX_LIMIT_UNAVAILABLE",
            "Docker inspection output exceeded the safe bound.",
          ),
        );
      } else if (code !== 0) {
        reject(
          new CodeBridgeError(
            "CHECK_IMAGE_MISSING",
            "The configured immutable check image is unavailable locally.",
          ),
        );
      } else resolve(Buffer.concat(output).toString("utf8"));
    });
  });
}

export class CheckReadinessService {
  private readonly scanner = new SecretScanner();
  private readonly approvals = new ApprovalRegistry();
  private readonly snapshotGuard = new SnapshotGuard();

  public constructor(
    private readonly project: ProjectConfig,
    private readonly snapshot: WorktreeSnapshot,
  ) {}

  public async list(): Promise<readonly CheckReadiness[]> {
    const results: CheckReadiness[] = [];
    for (const profile of this.project.checks) {
      let dependencyReadiness: CheckReadinessState = profile.enabled ? "ready" : "disabled";
      let approvalStatus: CheckReadiness["approvalStatus"] = "not-required";
      if (profile.enabled) {
        try {
          await this.assertImageReady(profile);
        } catch (error) {
          dependencyReadiness =
            error instanceof CodeBridgeError && error.code === "CHECK_IMAGE_MISSING"
              ? "image-missing"
              : "dependencies-not-ready";
        }
      }
      if (profile.adapter === "project-script-sandboxed") {
        approvalStatus = "approved";
        try {
          const approval = profile.scriptApproval;
          if (!approval)
            throw new CodeBridgeError("CHECK_NOT_ALLOWED", "Script approval is missing.");
          const configEntry = this.snapshot.entries.find(
            (entry) => entry.path === approval.configPath && entry.type === "file",
          );
          if (!configEntry || (configEntry.size ?? 0) > this.project.limits.maxSecretScanBytes) {
            throw new CodeBridgeError(
              "CHECK_APPROVAL_STALE",
              "The approved script file is unavailable in this snapshot.",
            );
          }
          const bytes = await this.readSnapshotFile(approval.configPath);
          const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
            scripts?: Record<string, unknown>;
          };
          const value = decoded.scripts?.[approval.scriptName];
          this.approvals.assertScriptCurrent(
            profile,
            bytes,
            typeof value === "string" ? value : undefined,
            "codebridge-adapter-1",
          );
        } catch {
          approvalStatus = "stale";
          dependencyReadiness = "dependencies-not-ready";
        }
      }
      results.push({
        checkId: profile.id,
        adapter: profile.adapter,
        imageDigest: profile.imageDigest,
        targetMode: profile.targetMode,
        timeoutSeconds: profile.timeoutSeconds,
        approvalStatus,
        dependencyReadiness,
      });
    }
    return results;
  }

  public async assertReady(
    checkId: string,
    targets: readonly string[],
  ): Promise<{
    profile: CheckProfile;
    targets: readonly string[];
  }> {
    const profile = this.project.checks.find((candidate) => candidate.id === checkId);
    if (!profile) throw new CodeBridgeError("CHECK_NOT_FOUND", "No check profile has that ID.");
    if (!profile.enabled)
      throw new CodeBridgeError("CHECK_NOT_ALLOWED", "The configured check profile is disabled.");
    const normalizedTargets = validateTargets(targets, profile, this.snapshot);
    await this.assertImageReady(profile);
    await this.assertScriptApproval(profile);
    return { profile, targets: normalizedTargets };
  }

  private async assertImageReady(profile: CheckProfile): Promise<void> {
    if (!this.project.executables.docker) {
      throw new CodeBridgeError(
        "SANDBOX_UNAVAILABLE",
        "No Docker-compatible executable is registered.",
      );
    }
    const output = await runDocker(this.project.executables.docker, [
      "image",
      "inspect",
      "--format",
      "{{json .}}",
      profile.imageDigest,
    ]);
    let image: ImageInfo;
    try {
      image = JSON.parse(output) as ImageInfo;
    } catch (error) {
      throw new CodeBridgeError(
        "CHECK_DEPENDENCIES_NOT_READY",
        "Docker returned invalid image metadata.",
        { cause: error },
      );
    }
    const imageText = JSON.stringify(image);
    if (this.scanner.scan(imageText).blocked) {
      throw new CodeBridgeError(
        "CHECK_DEPENDENCIES_NOT_READY",
        "Check image metadata contains a high-confidence secret.",
      );
    }
    const digest = profile.imageDigest.slice("sha256:".length);
    const repoDigests = image.RepoDigests ?? [];
    if (
      image.Id !== profile.imageDigest &&
      !repoDigests.some((item) => item.endsWith(`@sha256:${digest}`))
    ) {
      throw new CodeBridgeError(
        "CHECK_IMAGE_MISSING",
        "Image reference does not resolve to the approved immutable digest.",
      );
    }
    for (const variable of image.Config?.Env ?? []) {
      const separator = variable.indexOf("=");
      const key = separator < 0 ? variable : variable.slice(0, separator);
      const value = separator < 0 ? "" : variable.slice(separator + 1);
      if (/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) || this.scanner.scan(value).blocked) {
        throw new CodeBridgeError(
          "CHECK_DEPENDENCIES_NOT_READY",
          "Check image defines a secret-bearing environment value.",
        );
      }
    }
    const workingDirectory = profile.workingDirectory;
    if (
      !/^\/workspace(?:\/[A-Za-z0-9_.-]+)*$/.test(workingDirectory) ||
      workingDirectory.split("/").includes("..")
    ) {
      throw new CodeBridgeError(
        "CHECK_NOT_ALLOWED",
        "Check working directory must stay within /workspace.",
      );
    }
    const probeArgs = [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "65532:65532",
      "--pids-limit",
      String(this.project.sandbox.pids),
      "--memory",
      `${this.project.sandbox.memoryMb}m`,
      "--memory-swap",
      `${this.project.sandbox.memoryMb}m`,
      "--cpus",
      String(this.project.sandbox.cpus),
      "--ulimit",
      `nofile=${this.project.sandbox.nofileSoft}:${this.project.sandbox.nofileHard}`,
      "--ulimit",
      "core=0:0",
      "--entrypoint",
      "/usr/libexec/codebridge-launch",
      profile.imageDigest,
      "--probe-adapter",
      profile.adapter,
      profile.executable,
    ];
    try {
      await runDocker(this.project.executables.docker, probeArgs);
    } catch (error) {
      if (error instanceof CodeBridgeError && error.code === "SANDBOX_UNAVAILABLE") throw error;
      throw new CodeBridgeError(
        "CHECK_DEPENDENCIES_NOT_READY",
        "Approved image lacks the CodeBridge clean-env launcher or adapter dependencies.",
        { cause: error },
      );
    }
  }

  private async assertScriptApproval(profile: CheckProfile): Promise<void> {
    if (profile.adapter !== "project-script-sandboxed") return;
    const approval = profile.scriptApproval;
    if (!approval)
      throw new CodeBridgeError(
        "CHECK_NOT_ALLOWED",
        "Project script has not been approved outside MCP.",
      );
    if (
      profile.targetMode !== "none" ||
      profile.fixedArgs.length !== 2 ||
      profile.fixedArgs[0] !== "run" ||
      profile.fixedArgs[1] !== approval.scriptName ||
      profile.allowedTargetPaths.length !== 0 ||
      profile.allowedTargetSuffixes.length !== 0
    ) {
      throw new CodeBridgeError(
        "CHECK_NOT_ALLOWED",
        "Project-script adapter arguments must exactly match the approved script name.",
      );
    }
    try {
      const bytes = await this.readSnapshotFile(approval.configPath);
      const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
        scripts?: Record<string, unknown>;
      };
      const value = manifest.scripts?.[approval.scriptName];
      this.approvals.assertScriptCurrent(
        profile,
        bytes,
        typeof value === "string" ? value : undefined,
        "codebridge-adapter-1",
      );
    } catch (error) {
      if (error instanceof CodeBridgeError) throw error;
      throw new CodeBridgeError(
        "CHECK_APPROVAL_STALE",
        "Approved script definition changed in this snapshot.",
        { cause: error },
      );
    }
  }

  private async readSnapshotFile(path: string): Promise<Buffer> {
    const entry = this.snapshot.entries.find((candidate) => candidate.path === path);
    if (!entry || entry.type !== "file")
      throw new CodeBridgeError("CHECK_APPROVAL_STALE", "Approved script file is unavailable.");
    await this.snapshotGuard.assertNoSymlinkComponents(this.snapshot.root, path);
    const file = await this.snapshotGuard.readRegularFile(`${this.snapshot.root}/${path}`, {
      maxBytes: this.project.limits.maxSecretScanBytes,
    });
    if (file.size !== entry.size || file.sha256 !== entry.sha256)
      throw new CodeBridgeError("CHECK_APPROVAL_STALE", "Approved script file changed.");
    if (this.scanner.scan(file.bytes).blocked)
      throw new CodeBridgeError(
        "SECRET_BLOCKED",
        "Approved script configuration contains a secret.",
      );
    return file.bytes;
  }
}
