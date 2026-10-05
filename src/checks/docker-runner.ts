import { spawn } from "node:child_process";
import { CodeBridgeError } from "../errors.js";
import { EnvironmentSanitizer } from "../security/environment-sanitizer.js";
import { StreamingRedactor } from "../security/streaming-redactor.js";
import type { CheckProfile, ProjectConfig } from "../config/schema.js";
import { buildDockerSandboxPlan } from "./docker-args.js";
import { validateTargets } from "./target-policy.js";
import type { WorktreeSnapshot } from "../snapshot/manager.js";

export interface SandboxResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly cleanupFailed?: boolean;
}

function runCommand(options: {
  executable: string;
  args: readonly string[];
  stdoutMaxBytes: number;
  stderrMaxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  environment: NodeJS.ProcessEnv;
}): Promise<SandboxResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable, options.args, {
      shell: false,
      env: options.environment,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });
    const stdoutRedactor = new StreamingRedactor(options.stdoutMaxBytes);
    const stderrRedactor = new StreamingRedactor(options.stderrMaxBytes);
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let outputError = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    const accept = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const redactor = target === "stdout" ? stdoutRedactor : stderrRedactor;
      try {
        const value = redactor.push(chunk);
        if (target === "stdout") stdout += value;
        else stderr += value;
      } catch {
        outputError = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => accept("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => accept("stderr", chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new CodeBridgeError("SANDBOX_START_FAILED", "Docker command failed to start.", {
          cause: error,
        }),
      );
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (outputError) {
        reject(
          new CodeBridgeError(
            "SANDBOX_LIMIT_UNAVAILABLE",
            "Sandbox output exceeded its configured cap.",
          ),
        );
        return;
      }
      try {
        stdout += stdoutRedactor.flush();
        stderr += stderrRedactor.flush();
      } catch (error) {
        reject(
          new CodeBridgeError(
            "SANDBOX_LIMIT_UNAVAILABLE",
            "Sandbox output could not be redacted safely.",
            { cause: error },
          ),
        );
        return;
      }
      if (signal === "SIGKILL" && code === null) truncated = true;
      resolve({ exitCode: code ?? 128, stdout, stderr, truncated });
    });
  });
}

export class DockerSandboxRunner {
  public constructor(
    private readonly project: ProjectConfig,
    private readonly sessionId: string,
  ) {}

  public async run(
    profile: CheckProfile,
    snapshot: WorktreeSnapshot,
    targets: readonly string[],
    options: { signal: AbortSignal },
  ): Promise<SandboxResult> {
    const docker = this.project.executables.docker;
    if (!docker)
      throw new CodeBridgeError(
        "SANDBOX_UNAVAILABLE",
        "No Docker-compatible executable is registered.",
      );
    const validatedTargets = validateTargets(targets, profile, snapshot);
    const plan = buildDockerSandboxPlan({
      project: this.project,
      profile,
      snapshotRoot: snapshot.root,
      sessionId: this.sessionId,
      targets: validatedTargets,
    });
    const environment = new EnvironmentSanitizer().forDocker(docker, {});
    let containerId = "";
    let containerMayExist = false;
    let timedOut = false;
    let result: SandboxResult | undefined;
    let cleanupFailed = false;
    const controller = new AbortController();
    const propagateCancellation = (): void => controller.abort();
    options.signal.addEventListener("abort", propagateCancellation, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, profile.timeoutSeconds * 1000);
    try {
      if (controller.signal.aborted)
        throw new CodeBridgeError("RUN_CANCELLED", "Check run was cancelled.");
      containerMayExist = true;
      const created = await runCommand({
        executable: docker,
        args: plan.createArgs,
        stdoutMaxBytes: 4096,
        stderrMaxBytes: 4096,
        timeoutMs: 30000,
        signal: controller.signal,
        environment,
      });
      if (created.exitCode !== 0) {
        containerMayExist = false;
        throw new CodeBridgeError(
          "SANDBOX_START_FAILED",
          "Docker could not create the isolated check container.",
        );
      }
      const createdId = created.stdout.trim();
      if (!/^[a-f0-9]{12,64}$/i.test(createdId)) {
        throw new CodeBridgeError(
          "SANDBOX_START_FAILED",
          "Docker returned an invalid container identifier.",
        );
      }
      containerId = createdId;
      const running = await runCommand({
        executable: docker,
        args: ["start", "--attach", containerId],
        stdoutMaxBytes: profile.stdoutLimitBytes,
        stderrMaxBytes: profile.stderrLimitBytes,
        timeoutMs: profile.timeoutSeconds * 1000 + 5000,
        signal: controller.signal,
        environment,
      });
      if (timedOut)
        throw new CodeBridgeError("RUN_TIMEOUT", "Check exceeded its approved wall-clock timeout.");
      result = running;
    } catch (error) {
      if (controller.signal.aborted && !timedOut)
        throw new CodeBridgeError("RUN_CANCELLED", "Check run was cancelled.");
      if (timedOut)
        throw new CodeBridgeError("RUN_TIMEOUT", "Check exceeded its approved wall-clock timeout.");
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", propagateCancellation);
      if (containerMayExist)
        cleanupFailed = !(await this.cleanupOwnedContainer(
          docker,
          containerId || plan.containerName,
          plan.labels,
          environment,
        ));
    }
    if (!result)
      throw new CodeBridgeError("SANDBOX_START_FAILED", "Check did not produce a result.");
    return { ...result, cleanupFailed };
  }

  private async cleanupOwnedContainer(
    docker: string,
    containerId: string,
    labels: Readonly<Record<string, string>>,
    environment: NodeJS.ProcessEnv,
  ): Promise<boolean> {
    try {
      const presence = await runCommand({
        executable: docker,
        args: ["ps", "--all", "--filter", `id=${containerId}`, "--format", "{{.ID}}"],
        stdoutMaxBytes: 4096,
        stderrMaxBytes: 4096,
        timeoutMs: 10000,
        environment,
      });
      if (presence.exitCode !== 0) return false;
      if (presence.stdout.trim() === "") return true;
      if (presence.stdout.trim() !== containerId && !containerId.startsWith(presence.stdout.trim()))
        return false;
      const inspected = await runCommand({
        executable: docker,
        args: ["inspect", "--format", "{{json .Config.Labels}}", containerId],
        stdoutMaxBytes: 16 * 1024,
        stderrMaxBytes: 16 * 1024,
        timeoutMs: 10000,
        environment,
      });
      if (inspected.exitCode !== 0) return false;
      const observed = JSON.parse(inspected.stdout) as Record<string, string>;
      if (Object.entries(labels).some(([key, value]) => observed[key] !== value)) return false;
      const removed = await runCommand({
        executable: docker,
        args: ["rm", "--force", containerId],
        stdoutMaxBytes: 16 * 1024,
        stderrMaxBytes: 16 * 1024,
        timeoutMs: 10000,
        environment,
      });
      return removed.exitCode === 0;
    } catch {
      // A failed proof of ownership must never broaden cleanup.
      return false;
    }
  }
}
