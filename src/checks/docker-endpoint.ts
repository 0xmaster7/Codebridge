import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { CodeBridgeError } from "../errors.js";

const resolvedHosts = new Map<string, Promise<string>>();

function runDockerConfigCommand(executable: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      env: {
        HOME: process.env["HOME"] ?? "/nonexistent",
        LANG: "C",
        LC_ALL: "C",
        PATH: `${dirname(executable)}:/usr/bin:/bin`,
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4096) child.kill("SIGKILL");
      else chunks.push(Buffer.from(chunk));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new CodeBridgeError("SANDBOX_UNAVAILABLE", "Docker context could not be inspected.", {
          cause: error,
        }),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (bytes > 4096) {
        reject(
          new CodeBridgeError(
            "SANDBOX_LIMIT_UNAVAILABLE",
            "Docker context output exceeded its bound.",
          ),
        );
      } else if (code !== 0) {
        reject(
          new CodeBridgeError("SANDBOX_UNAVAILABLE", "Docker context could not be inspected."),
        );
      } else resolve(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}

async function inspectLocalDockerHost(executable: string): Promise<string> {
  const context = await runDockerConfigCommand(executable, ["context", "show"]);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(context)) {
    throw new CodeBridgeError("SANDBOX_UNAVAILABLE", "The active Docker context name is invalid.");
  }
  const host = await runDockerConfigCommand(executable, [
    "context",
    "inspect",
    context,
    "--format",
    "{{ .Endpoints.docker.Host }}",
  ]);
  if (!/^unix:\/\/\/[^\0\r\n?#]+$/.test(host)) {
    throw new CodeBridgeError(
      "SANDBOX_UNAVAILABLE",
      "CodeBridge requires an active Docker context that uses a local Unix socket.",
    );
  }
  return host;
}

/** Resolve and pin the active local Docker context without forwarding its config or credentials. */
export function resolveDockerHost(executable: string): Promise<string> {
  let result = resolvedHosts.get(executable);
  if (!result) {
    result = inspectLocalDockerHost(executable);
    resolvedHosts.set(executable, result);
    void result.catch(() => resolvedHosts.delete(executable));
  }
  return result;
}
