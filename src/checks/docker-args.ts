import { randomUUID } from "node:crypto";
import type { CheckProfile, ProjectConfig } from "../config/schema.js";

export interface DockerSandboxPlan {
  readonly runId: string;
  readonly containerName: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly createArgs: readonly string[];
  readonly startArgs: readonly string[];
  readonly inspectArgs: readonly string[];
  readonly removeArgs: readonly string[];
}

function mb(value: number): string {
  return `${value}m`;
}

export function buildDockerSandboxPlan(options: {
  readonly project: ProjectConfig;
  readonly profile: CheckProfile;
  readonly snapshotRoot: string;
  readonly sessionId: string;
  readonly targets: readonly string[];
  readonly runId?: string;
}): DockerSandboxPlan {
  const runId = options.runId ?? randomUUID();
  const containerName = `codebridge-${runId}`;
  const labels = {
    "io.codebridge.managed": "true",
    "io.codebridge.session": options.sessionId,
    "io.codebridge.run": runId,
  };
  const labelArgs = Object.entries(labels).flatMap(([key, value]) => [
    "--label",
    `${key}=${value}`,
  ]);
  const tmpfsArgs = [
    "--tmpfs",
    `/workspace:rw,nosuid,nodev,size=${mb(options.project.sandbox.writableWorkspaceMb)},mode=700,uid=65532,gid=65532`,
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=${mb(options.project.sandbox.tmpMb)},mode=700,uid=65532,gid=65532`,
    "--tmpfs",
    `/home/cb:rw,nosuid,nodev,size=${mb(options.project.sandbox.homeMb)},mode=700,uid=65532,gid=65532`,
  ];
  const launcherArgs = [
    "--source",
    "/source",
    "--workspace",
    options.profile.workingDirectory,
    "--home",
    "/home/cb",
    "--tmp",
    "/tmp",
    "--clean-env",
    "--",
    options.profile.executable,
    ...options.profile.fixedArgs,
    ...(options.targets.length > 0 ? ["--", ...options.targets] : []),
  ];
  const createArgs = [
    "create",
    "--name",
    containerName,
    ...labelArgs,
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
    String(options.project.sandbox.pids),
    "--memory",
    mb(options.project.sandbox.memoryMb),
    "--memory-swap",
    mb(options.project.sandbox.memoryMb),
    "--cpus",
    String(options.project.sandbox.cpus),
    "--ulimit",
    `nofile=${options.project.sandbox.nofileSoft}:${options.project.sandbox.nofileHard}`,
    "--ulimit",
    "core=0:0",
    "--init",
    "--rm",
    ...tmpfsArgs,
    "--mount",
    `type=bind,src=${options.snapshotRoot},dst=/source,readonly`,
    "--workdir",
    "/workspace",
    "--entrypoint",
    "/usr/libexec/codebridge-launch",
    options.profile.imageDigest,
    ...launcherArgs,
  ];
  return {
    runId,
    containerName,
    labels,
    createArgs,
    startArgs: ["start", "--attach", containerName],
    inspectArgs: ["inspect", "--format", "{{json .Config.Labels}}", containerName],
    removeArgs: ["rm", "--force", containerName],
  };
}
