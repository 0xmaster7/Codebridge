export type SecretPathReason =
  | "environment-file"
  | "private-key"
  | "ssh-material"
  | "cloud-credentials"
  | "credential-file"
  | "docker-auth"
  | "package-manager-auth";

export function normalizeSecurityPath(path: string): string {
  return path.normalize("NFC").replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

export function classifySecretPath(path: string): SecretPathReason | null {
  const normalized = normalizeSecurityPath(path);
  const components = normalized.split("/");
  const basename = components.at(-1) ?? "";
  if (basename === ".env" || (basename.startsWith(".env.") && basename !== ".env.example")) {
    return "environment-file";
  }
  if (basename.endsWith(".pem") || basename.endsWith(".key")) return "private-key";
  if (/^id_(?:rsa|ed25519)(?:[.-]|$)/.test(basename) || components.includes(".ssh")) {
    return "ssh-material";
  }
  if (components.includes(".aws")) return "cloud-credentials";
  if (
    basename === ".netrc" ||
    basename === "credentials.json" ||
    /^service-account.*\.json$/.test(basename)
  ) {
    return "credential-file";
  }
  if (components.includes(".docker") && (basename === "config.json" || basename === "config")) {
    return "docker-auth";
  }
  if (basename === ".npmrc" || basename === ".yarnrc.yml" || basename === ".pypirc") {
    return "package-manager-auth";
  }
  return null;
}
