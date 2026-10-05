import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { CodeBridgeError } from "../errors.js";
import {
  ActiveProjectSchema,
  ProjectConfigSchema,
  type ActiveProject,
  type ProjectConfig,
} from "./schema.js";

const SENSITIVE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

function permissionError(target: string): CodeBridgeError {
  return new CodeBridgeError(
    "CONFIG_PERMISSION_UNSAFE",
    `CodeBridge state has unsafe ownership, type, or permissions: ${target}`,
  );
}

export class ConfigStore {
  public readonly root: string;
  private readonly projectsDirectory: string;
  private readonly sessionsDirectory: string;
  private readonly tempDirectory: string;

  public constructor(root: string) {
    this.root = resolve(root);
    this.projectsDirectory = join(this.root, "projects");
    this.sessionsDirectory = join(this.root, "sessions");
    this.tempDirectory = join(this.root, "tmp");
  }

  public async initialize(): Promise<void> {
    await this.ensurePrivateDirectory(this.root);
    await this.ensurePrivateDirectory(this.projectsDirectory);
    await this.ensurePrivateDirectory(this.sessionsDirectory);
    await this.ensurePrivateDirectory(this.tempDirectory);
  }

  public async saveProject(config: ProjectConfig): Promise<void> {
    const validated = this.validateProject(config);
    await this.initialize();
    await this.writeSecureJson(this.projectPath(validated.project.id), validated);
  }

  public async loadProject(projectId: string): Promise<ProjectConfig> {
    await this.initialize();
    const raw = await this.readSecureJson(this.projectPath(projectId));
    return this.validateProject(raw);
  }

  public async listProjects(): Promise<ProjectConfig[]> {
    await this.initialize();
    const names = await readdir(this.projectsDirectory);
    const configs: ProjectConfig[] = [];
    for (const name of names.sort()) {
      if (!/^cb-[a-f0-9]{16}\.json$/.test(name)) continue;
      configs.push(await this.loadProject(name.slice(0, -5)));
    }
    return configs;
  }

  public async selectProject(projectId: string): Promise<void> {
    await this.loadProject(projectId);
    await this.writeSecureJson(join(this.root, "active-project.json"), {
      version: 1,
      projectId,
    });
  }

  public async loadActiveProject(): Promise<{ active: ActiveProject; project: ProjectConfig }> {
    await this.initialize();
    const active = ActiveProjectSchema.parse(
      await this.readSecureJson(join(this.root, "active-project.json")),
    );
    const project = await this.loadProject(active.projectId);
    return { active, project };
  }

  public async listSessionIds(): Promise<string[]> {
    await this.initialize();
    const entries = await readdir(this.sessionsDirectory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  public async createOwnedSessionDirectory(
    sessionId: string,
    ownerPid = process.pid,
  ): Promise<string> {
    if (!/^[a-f0-9-]{36}$/.test(sessionId)) {
      throw new CodeBridgeError("INVALID_ARGUMENT", "Invalid session identifier.");
    }
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
      throw new CodeBridgeError("INVALID_ARGUMENT", "Invalid session owner process identifier.");
    }
    await this.initialize();
    const directory = join(this.sessionsDirectory, sessionId);
    await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
    await chmod(directory, PRIVATE_DIRECTORY_MODE);
    await this.writeSecureJson(join(directory, ".codebridge-owned.json"), {
      version: 1,
      sessionId,
      managed: true,
      ownerPid,
      createdAt: new Date().toISOString(),
    });
    return directory;
  }

  public async removeOwnedSessionDirectory(sessionId: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(sessionId)) {
      throw new CodeBridgeError("INVALID_ARGUMENT", "Invalid session identifier.");
    }
    await this.initialize();
    const target = join(this.sessionsDirectory, sessionId);
    const marker = join(target, ".codebridge-owned.json");
    await this.readSecureJson(marker);
    const markerData = (await this.readSecureJson(marker)) as Record<string, unknown>;
    if (markerData["sessionId"] !== sessionId || markerData["managed"] !== true) {
      throw permissionError(target);
    }
    const entry = await lstat(target);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw permissionError(target);
    await this.makeOwnedTreeRemovable(target);
    await rm(target, { recursive: true, force: false });
  }

  private async makeOwnedTreeRemovable(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        await this.makeOwnedTreeRemovable(path);
        await chmod(path, PRIVATE_DIRECTORY_MODE);
      } else if (info.isFile() && !info.isSymbolicLink()) {
        if (info.nlink !== 1) throw permissionError(path);
        await chmod(path, SENSITIVE_FILE_MODE);
      }
    }
    await chmod(directory, PRIVATE_DIRECTORY_MODE);
  }

  public async listOwnedSessionDirectories(): Promise<string[]> {
    const sessionIds = await this.listSessionIds();
    const owned: string[] = [];
    for (const sessionId of sessionIds) {
      try {
        const raw = (await this.readSecureJson(
          join(this.sessionsDirectory, sessionId, ".codebridge-owned.json"),
        )) as Record<string, unknown>;
        if (raw["managed"] === true && raw["sessionId"] === sessionId) owned.push(sessionId);
      } catch (error) {
        if (!(error instanceof CodeBridgeError) || error.code !== "FILE_NOT_FOUND") throw error;
      }
    }
    return owned;
  }

  public async listStaleOwnedSessionDirectories(): Promise<string[]> {
    const sessionIds = await this.listOwnedSessionDirectories();
    const stale: string[] = [];
    for (const sessionId of sessionIds) {
      const marker = (await this.readSecureJson(
        join(this.sessionsDirectory, sessionId, ".codebridge-owned.json"),
      )) as Record<string, unknown>;
      const ownerPid = marker["ownerPid"];
      if (!Number.isSafeInteger(ownerPid) || (ownerPid as number) <= 0) continue;
      try {
        process.kill(ownerPid as number, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") stale.push(sessionId);
      }
    }
    return stale;
  }

  private projectPath(projectId: string): string {
    if (!/^cb-[a-f0-9]{16}$/.test(projectId)) {
      throw new CodeBridgeError("INVALID_ARGUMENT", "Invalid CodeBridge project ID.");
    }
    return join(this.projectsDirectory, `${projectId}.json`);
  }

  private validateProject(value: unknown): ProjectConfig {
    const parsed = ProjectConfigSchema.safeParse(value);
    if (!parsed.success) {
      throw new CodeBridgeError("CONFIG_INVALID", "CodeBridge project configuration is malformed.");
    }
    return parsed.data;
  }

  private async ensurePrivateDirectory(directory: string): Promise<void> {
    try {
      const info = await lstat(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
        (typeof process.getuid === "function" && info.uid !== process.getuid())
      ) {
        throw permissionError(directory);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
      await chmod(directory, PRIVATE_DIRECTORY_MODE);
    }
  }

  private async readSecureJson(path: string): Promise<unknown> {
    const parent = resolve(path, "..");
    await this.ensurePrivateDirectory(parent);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CodeBridgeError(
          "FILE_NOT_FOUND",
          `CodeBridge state file is missing: ${basename(path)}`,
        );
      }
      throw error;
    }
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        (info.mode & 0o777) !== SENSITIVE_FILE_MODE ||
        (typeof process.getuid === "function" && info.uid !== process.getuid())
      ) {
        throw permissionError(path);
      }
      const contents = await handle.readFile({ encoding: "utf8" });
      try {
        return JSON.parse(contents) as unknown;
      } catch (error) {
        throw new CodeBridgeError(
          "CONFIG_INVALID",
          `Malformed CodeBridge state JSON: ${basename(path)}`,
          {
            cause: error,
          },
        );
      }
    } finally {
      await handle.close();
    }
  }

  private async writeSecureJson(path: string, value: unknown): Promise<void> {
    const parent = resolve(path, "..");
    await this.ensurePrivateDirectory(parent);
    try {
      const current = await lstat(path);
      if (!current.isFile() || current.isSymbolicLink()) throw permissionError(path);
      if (current.nlink !== 1 || (current.mode & 0o777) !== SENSITIVE_FILE_MODE)
        throw permissionError(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", SENSITIVE_FILE_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, SENSITIVE_FILE_MODE);
    await rename(temporary, path);
  }

  public async removeProject(projectId: string): Promise<void> {
    const path = this.projectPath(projectId);
    await this.readSecureJson(path);
    await rm(path, { force: false });
    try {
      const active = ActiveProjectSchema.parse(
        await this.readSecureJson(join(this.root, "active-project.json")),
      );
      if (active.projectId === projectId) {
        await rm(join(this.root, "active-project.json"), { force: false });
      }
    } catch (error) {
      if (!(error instanceof CodeBridgeError) || error.code !== "FILE_NOT_FOUND") throw error;
    }
  }
}
