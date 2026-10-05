import { spawn } from "node:child_process";
import { CodeBridgeError } from "../errors.js";
import { EnvironmentSanitizer } from "../security/environment-sanitizer.js";
import { resolveDockerHost } from "../checks/docker-endpoint.js";

interface CommandResult {
  readonly stdout: string;
  readonly exitCode: number;
}

async function runDocker(executable: string, args: readonly string[]): Promise<CommandResult> {
  const dockerHost = await resolveDockerHost(executable);
  const environment = new EnvironmentSanitizer().forDocker(executable, {}, dockerHost);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      env: environment,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) child.kill("SIGKILL");
      else chunks.push(Buffer.from(chunk));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new CodeBridgeError("SANDBOX_UNAVAILABLE", "Docker cleanup could not start.", {
          cause: error,
        }),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (bytes > 64 * 1024) {
        reject(
          new CodeBridgeError(
            "SANDBOX_LIMIT_UNAVAILABLE",
            "Docker cleanup output exceeded its bound.",
          ),
        );
      } else if (code !== 0) {
        reject(
          new CodeBridgeError(
            "SANDBOX_UNAVAILABLE",
            "Docker cleanup could not verify resource ownership.",
          ),
        );
      } else resolve({ stdout: Buffer.concat(chunks).toString("utf8"), exitCode: code ?? 0 });
    });
  });
}

export async function cleanupStaleSessionContainers(
  executable: string,
  sessionId: string,
): Promise<number> {
  if (!/^[a-f0-9-]{36}$/.test(sessionId)) {
    throw new CodeBridgeError("INVALID_ARGUMENT", "Invalid stale session identifier.");
  }
  const listed = await runDocker(executable, [
    "ps",
    "--all",
    "--filter",
    "label=io.codebridge.managed=true",
    "--filter",
    `label=io.codebridge.session=${sessionId}`,
    "--format",
    "{{.ID}}",
  ]);
  const ids = listed.stdout
    .split(/\r?\n/)
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length > 1024 || ids.some((id) => !/^[a-f0-9]{12,64}$/i.test(id))) {
    throw new CodeBridgeError(
      "SANDBOX_LIMIT_UNAVAILABLE",
      "Docker returned unsafe cleanup identifiers.",
    );
  }
  let removed = 0;
  for (const id of [...new Set(ids)]) {
    const inspected = await runDocker(executable, [
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      id,
    ]);
    let labels: Record<string, unknown>;
    try {
      labels = JSON.parse(inspected.stdout) as Record<string, unknown>;
    } catch (error) {
      throw new CodeBridgeError("SANDBOX_UNAVAILABLE", "Docker returned invalid cleanup labels.", {
        cause: error,
      });
    }
    if (
      labels["io.codebridge.managed"] !== "true" ||
      labels["io.codebridge.session"] !== sessionId
    ) {
      throw new CodeBridgeError(
        "SANDBOX_UNAVAILABLE",
        "Docker resource ownership labels do not match.",
      );
    }
    await runDocker(executable, ["rm", "--force", id]);
    removed += 1;
  }
  return removed;
}
