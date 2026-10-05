import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { CodeBridgeError } from "../errors.js";
import type { CheckProfile } from "../config/schema.js";

const packageManifest = z.object({ scripts: z.record(z.string(), z.string()).optional() });

export interface ScriptApproval {
  readonly configPath: string;
  readonly configSha256: string;
  readonly scriptName: string;
  readonly scriptValue: string;
  readonly normalizedScriptSha256: string;
  readonly imageDigest: string;
  readonly adapterVersion: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeScript(value: string): string {
  return value.normalize("NFC").replace(/\r\n/g, "\n").trim();
}

export class ApprovalRegistry {
  public approveScript(
    configPath: string,
    configBytes: Uint8Array,
    scriptName: string,
    imageDigest: string,
    adapterVersion: string,
  ): ScriptApproval {
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(configBytes),
      ) as unknown;
    } catch (error) {
      throw new CodeBridgeError(
        "CONFIG_INVALID",
        "The script configuration file is not valid UTF-8 JSON.",
        {
          cause: error,
        },
      );
    }
    const parsed = packageManifest.safeParse(decoded);
    const scriptValue = parsed.success ? parsed.data.scripts?.[scriptName] : undefined;
    if (typeof scriptValue !== "string") {
      throw new CodeBridgeError(
        "CHECK_NOT_ALLOWED",
        "The requested script is not a string in the approved manifest.",
      );
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest) || adapterVersion.length === 0) {
      throw new CodeBridgeError(
        "INVALID_ARGUMENT",
        "Script approval requires a pinned image and adapter version.",
      );
    }
    return {
      configPath,
      configSha256: sha256(configBytes),
      scriptName,
      scriptValue,
      normalizedScriptSha256: sha256(normalizeScript(scriptValue)),
      imageDigest,
      adapterVersion,
    };
  }

  public assertScriptCurrent(
    profile: CheckProfile,
    configBytes: Uint8Array,
    currentScriptValue: string | undefined,
    adapterVersion: string,
  ): void {
    const approval = profile.scriptApproval;
    if (!approval) {
      throw new CodeBridgeError(
        "CHECK_NOT_ALLOWED",
        "This project script has no external user approval.",
      );
    }
    const valid =
      sha256(configBytes) === approval.configSha256 &&
      currentScriptValue === approval.scriptValue &&
      sha256(normalizeScript(currentScriptValue ?? "")) === approval.normalizedScriptSha256 &&
      profile.imageDigest === approval.imageDigest &&
      adapterVersion === approval.adapterVersion;
    if (!valid) {
      throw new CodeBridgeError(
        "CHECK_APPROVAL_STALE",
        "The approved script definition or execution profile has changed.",
      );
    }
  }
}
