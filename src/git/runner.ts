import { spawn } from "node:child_process";
import { CodeBridgeError } from "../errors.js";
import { EnvironmentSanitizer } from "../security/environment-sanitizer.js";
import { StreamingRedactor } from "../security/streaming-redactor.js";

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class GitRunner {
  private readonly environment = new EnvironmentSanitizer();

  public constructor(
    private readonly executable: string,
    private readonly gitDirectory: string,
    private readonly indexFile: string,
    private readonly home: string,
    private readonly maxOutputBytes = 2 * 1024 * 1024,
  ) {}

  public run(
    args: readonly string[],
    options: { allowFailure?: boolean; signal?: AbortSignal } = {},
  ): Promise<GitResult> {
    if (args.length === 0 || args.some((arg) => arg.includes("\0"))) {
      return Promise.reject(
        new CodeBridgeError("INVALID_ARGUMENT", "Git arguments must be fixed non-empty data."),
      );
    }
    const fixedArgs = [
      "--no-pager",
      "--no-optional-locks",
      `--git-dir=${this.gitDirectory}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "diff.external=",
      "-c",
      "core.pager=cat",
      ...args,
    ];
    const env = {
      ...this.environment.forGit({ home: this.home, xdgConfigHome: `${this.home}/config` }),
      GIT_DIR: this.gitDirectory,
      GIT_INDEX_FILE: this.indexFile,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      PAGER: "cat",
    };
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, fixedArgs, {
        cwd: this.home,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        signal: options.signal,
      });
      const stdoutRedactor = new StreamingRedactor(this.maxOutputBytes);
      const stderrRedactor = new StreamingRedactor(this.maxOutputBytes);
      let stdout = "";
      let stderr = "";
      let outputFailed = false;
      const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
        if (outputFailed) return;
        try {
          const redactor = target === "stdout" ? stdoutRedactor : stderrRedactor;
          const safeChunk = redactor.push(chunk);
          if (target === "stdout") stdout += safeChunk;
          else stderr += safeChunk;
        } catch {
          outputFailed = true;
          child.kill("SIGKILL");
        }
      };
      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.once("error", (error) => {
        reject(
          new CodeBridgeError("GIT_FAILED", "The registered Git executable could not run.", {
            cause: error,
          }),
        );
      });
      child.once("close", (code, signal) => {
        if (outputFailed) {
          reject(
            new CodeBridgeError("GIT_FAILED", "Git output exceeded the safe retention limit."),
          );
          return;
        }
        stdout += stdoutRedactor.flush();
        stderr += stderrRedactor.flush();
        const exitCode = code ?? (signal ? 128 : 1);
        if (exitCode !== 0 && options.allowFailure !== true) {
          reject(
            new CodeBridgeError(
              "GIT_FAILED",
              `Session Git command failed with exit code ${exitCode}.`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr, exitCode });
      });
    });
  }
}
