import { randomUUID } from "node:crypto";
import { CodeBridgeError } from "../errors.js";
import type { CheckProfile, ProjectConfig } from "../config/schema.js";
import type { WorktreeSnapshot } from "../snapshot/manager.js";
import { DockerSandboxRunner, type SandboxResult } from "./docker-runner.js";

export type CheckJobState =
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "cleanup_failed";

export interface CheckJobView {
  readonly runId: string;
  readonly checkId: string;
  readonly state: CheckJobState;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly truncated?: boolean;
  readonly errorCode?: string;
  readonly snapshotId: string;
}

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

interface CheckJob extends Mutable<CheckJobView> {
  readonly profile: CheckProfile;
  readonly targets: readonly string[];
  readonly controller: AbortController;
}

function publicView(job: CheckJob): CheckJobView {
  return {
    runId: job.runId,
    checkId: job.checkId,
    state: job.state,
    createdAt: job.createdAt,
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }),
    ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
    ...(job.stdout === undefined ? {} : { stdout: job.stdout }),
    ...(job.stderr === undefined ? {} : { stderr: job.stderr }),
    ...(job.truncated === undefined ? {} : { truncated: job.truncated }),
    ...(job.errorCode === undefined ? {} : { errorCode: job.errorCode }),
    snapshotId: job.snapshotId,
  };
}

export class CheckJobManager {
  private readonly jobs = new Map<string, CheckJob>();
  private readonly queue: string[] = [];
  private activeId: string | null = null;
  private readonly runner: DockerSandboxRunner;

  public constructor(
    private readonly project: ProjectConfig,
    private readonly snapshot: WorktreeSnapshot,
    sessionId: string,
  ) {
    this.runner = new DockerSandboxRunner(project, sessionId);
  }

  public async submit(profile: CheckProfile, targets: readonly string[]): Promise<CheckJobView> {
    if (this.jobs.size >= 1024) {
      for (const [runId, job] of this.jobs) {
        if (
          ["completed", "failed", "timed_out", "cancelled", "cleanup_failed"].includes(job.state)
        ) {
          this.jobs.delete(runId);
          if (this.jobs.size < 1024) break;
        }
      }
    }
    if (this.jobs.size >= 1024) {
      throw new CodeBridgeError(
        "CHECK_NOT_ALLOWED",
        "Session check history is full; restart the MCP session.",
      );
    }
    const queuedCount = this.queue.length;
    if (this.activeId !== null && queuedCount >= this.project.limits.maxQueuedChecks) {
      throw new CodeBridgeError("CHECK_NOT_ALLOWED", "The approved check queue is full.");
    }
    const runId = randomUUID();
    const job: CheckJob = {
      runId,
      checkId: profile.id,
      state: "queued",
      createdAt: new Date().toISOString(),
      profile,
      targets,
      controller: new AbortController(),
      snapshotId: this.snapshot.snapshotId,
    };
    this.jobs.set(runId, job);
    this.queue.push(runId);
    this.dispatch();
    await Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, 150)),
      this.waitForJob(job),
    ]);
    return publicView(job);
  }

  public status(runId: string): CheckJobView {
    const job = this.jobs.get(runId);
    if (!job)
      throw new CodeBridgeError("RUN_NOT_FOUND", "No such check run exists in this session.");
    return publicView(job);
  }

  public cancel(runId: string): CheckJobView {
    const job = this.jobs.get(runId);
    if (!job)
      throw new CodeBridgeError("RUN_NOT_FOUND", "No such check run exists in this session.");
    if (job.state === "queued") {
      const index = this.queue.indexOf(runId);
      if (index >= 0) this.queue.splice(index, 1);
      this.finish(job, "cancelled", { errorCode: "RUN_CANCELLED" });
      this.dispatch();
    } else if (job.state === "starting" || job.state === "running") {
      job.controller.abort();
    }
    return publicView(job);
  }

  public async close(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.state === "queued") {
        const index = this.queue.indexOf(job.runId);
        if (index >= 0) this.queue.splice(index, 1);
        this.finish(job, "cancelled", { errorCode: "RUN_CANCELLED" });
      } else if (job.state === "starting" || job.state === "running") {
        job.controller.abort();
      }
    }
    const deadline = Date.now() + 15000;
    while (this.activeId !== null && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  private waitForJob(job: CheckJob): Promise<void> {
    return new Promise((resolve) => {
      const poll = (): void => {
        if (["completed", "failed", "timed_out", "cancelled", "cleanup_failed"].includes(job.state))
          resolve();
        else setTimeout(poll, 10);
      };
      poll();
    });
  }

  private dispatch(): void {
    if (this.activeId !== null) return;
    const nextId = this.queue.shift();
    if (!nextId) return;
    const job = this.jobs.get(nextId);
    if (!job || job.state !== "queued") {
      this.dispatch();
      return;
    }
    this.activeId = nextId;
    job.state = "starting";
    job.startedAt = new Date().toISOString();
    void this.execute(job).finally(() => {
      this.activeId = null;
      this.dispatch();
    });
  }

  private async execute(job: CheckJob): Promise<void> {
    if (job.controller.signal.aborted) {
      this.finish(job, "cancelled", { errorCode: "RUN_CANCELLED" });
      return;
    }
    job.state = "running";
    try {
      const result = await this.runner.run(job.profile, this.snapshot, job.targets, {
        signal: job.controller.signal,
      });
      if (job.controller.signal.aborted) {
        this.finish(job, "cancelled", { errorCode: "RUN_CANCELLED" });
      } else if (result.cleanupFailed) {
        this.finish(job, "cleanup_failed", this.resultFields(result));
      } else if (result.exitCode === 0) {
        this.finish(job, "completed", this.resultFields(result));
      } else {
        this.finish(job, "failed", this.resultFields(result));
      }
    } catch (error) {
      const code = error instanceof CodeBridgeError ? error.code : "INTERNAL_ERROR";
      if (code === "RUN_TIMEOUT") this.finish(job, "timed_out", { errorCode: code });
      else if (code === "RUN_CANCELLED") this.finish(job, "cancelled", { errorCode: code });
      else this.finish(job, "failed", { errorCode: code });
    }
  }

  private resultFields(
    result: SandboxResult,
  ): Pick<CheckJobView, "exitCode" | "stdout" | "stderr" | "truncated"> {
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
    };
  }

  private finish(job: CheckJob, state: CheckJobState, fields: Partial<CheckJobView>): void {
    job.state = state;
    job.completedAt = new Date().toISOString();
    Object.assign(job, fields);
  }
}
