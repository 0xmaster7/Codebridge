import * as z from "zod/v4";

const absolutePath = z
  .string()
  .min(1)
  .refine((value) => value.startsWith("/"), {
    message: "Expected an absolute Unix path",
  });

const approvedRequirement = z
  .object({
    path: z.string().min(1),
    approvedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const checkProfile = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    adapter: z.enum([
      "pytest",
      "ruff",
      "mypy",
      "pyright",
      "node-test",
      "node-lint",
      "node-typecheck",
      "project-script-sandboxed",
    ]),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    executable: z.string().regex(/^\/(?:[^\0\r\n]+)$/),
    fixedArgs: z.array(z.string().max(512)).max(64),
    targetMode: z.enum(["none", "paths"]),
    allowedTargetSuffixes: z.array(z.string().regex(/^\.[a-z0-9._-]+$/)).max(32),
    allowedTargetPaths: z.array(z.string().min(1)).max(256),
    timeoutSeconds: z.number().int().min(1).max(3600),
    stdoutLimitBytes: z
      .number()
      .int()
      .min(1024)
      .max(16 * 1024 * 1024),
    stderrLimitBytes: z
      .number()
      .int()
      .min(1024)
      .max(16 * 1024 * 1024),
    environmentAllowlist: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)).max(64),
    workingDirectory: z.string().min(1),
    dependencyMode: z.literal("image-contained"),
    enabled: z.boolean(),
    scriptApproval: z
      .object({
        configPath: z.string().min(1),
        configSha256: z.string().regex(/^[a-f0-9]{64}$/),
        scriptName: z.string().min(1),
        scriptValue: z.string(),
        normalizedScriptSha256: z.string().regex(/^[a-f0-9]{64}$/),
        imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        adapterVersion: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export const CheckProfileSchema = checkProfile;
export const CheckProfileApprovalInputSchema = checkProfile
  .omit({ scriptApproval: true })
  .extend({
    scriptApproval: z
      .object({ configPath: z.string().min(1), scriptName: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

export const ProjectConfigSchema = z
  .object({
    version: z.literal(1),
    project: z
      .object({
        id: z.string().regex(/^cb-[a-f0-9]{16}$/),
        canonicalWorktreeRoot: absolutePath,
        approvedGitMetadataRoots: z.array(absolutePath),
        approvedRequirementPaths: z.array(approvedRequirement),
      })
      .strict(),
    runtime: z.object({ nodeMajor: z.number().int().min(24) }).strict(),
    executables: z
      .object({
        git: absolutePath,
        docker: absolutePath.nullable(),
      })
      .strict(),
    limits: z
      .object({
        maxSnapshotBytes: z.number().int().positive(),
        maxFiles: z.number().int().positive(),
        maxSingleReadableFileBytes: z.number().int().positive(),
        maxSecretScanBytes: z.number().int().positive(),
        maxReadResponseBytes: z.number().int().positive(),
        maxSearchResults: z.number().int().positive(),
        maxConcurrentReads: z.number().int().positive(),
        maxConcurrentChecks: z.literal(1),
        maxQueuedChecks: z.number().int().nonnegative(),
        maxRetainedOutputBytes: z.number().int().positive(),
      })
      .strict(),
    sandbox: z
      .object({
        memoryMb: z.number().int().positive(),
        cpus: z.number().positive(),
        pids: z.number().int().positive(),
        timeoutSeconds: z.number().int().positive(),
        writableWorkspaceMb: z.number().int().positive(),
        tmpMb: z.number().int().positive(),
        homeMb: z.number().int().positive(),
        nofileSoft: z.number().int().positive(),
        nofileHard: z.number().int().positive(),
      })
      .strict(),
    checks: z.array(checkProfile).max(128),
  })
  .strict();

export const ActiveProjectSchema = z
  .object({ version: z.literal(1), projectId: z.string().regex(/^cb-[a-f0-9]{16}$/) })
  .strict();

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type CheckProfile = z.infer<typeof checkProfile>;
export type CheckProfileApprovalInput = z.infer<typeof CheckProfileApprovalInputSchema>;
export type ApprovedRequirement = z.infer<typeof approvedRequirement>;
export type ActiveProject = z.infer<typeof ActiveProjectSchema>;
