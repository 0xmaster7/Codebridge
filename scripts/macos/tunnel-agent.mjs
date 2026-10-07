import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const LABEL = "com.codebridge.secure-mcp-tunnel";

function xml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function renderLaunchAgentPlist(runnerPath, stateDirectory) {
  if (!runnerPath.startsWith("/") || !stateDirectory.startsWith("/")) {
    throw new Error("LaunchAgent paths must be absolute");
  }
  if (/\0|[\r\n]/.test(runnerPath + stateDirectory)) {
    throw new Error("LaunchAgent paths must not contain control characters");
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(runnerPath)}</string></array>
  <key>WorkingDirectory</key><string>${xml(stateDirectory)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
`;
}

export function validateProfileForAgent(profileText) {
  const required = [
    /tunnel_id:\s*["']?tunnel_[A-Za-z0-9_-]+/,
    /api_key:\s*["']?env:CONTROL_PLANE_API_KEY/,
    /listen_addr:\s*["']?127\.0\.0\.1:0/,
    /channel:\s*["']?main/,
    /command:\s*["'][^\r\n]*\/usr\/bin\/env -u CONTROL_PLANE_API_KEY [^\r\n]*dist\/src\/cli\.js mcp["']/,
  ];
  if (!required.every((pattern) => pattern.test(profileText))) {
    throw new Error(
      "profile must bind one tunnel, use the runtime Keychain environment reference, loopback health, and scrub the runtime key from the CodeBridge MCP stdio command",
    );
  }
  if (/cloudflared|allow-remote-ui|log\.http-raw-unsafe/i.test(profileText)) {
    throw new Error("profile contains a prohibited public tunnel or remote/debug surface");
  }
  const channels = profileText.match(/^\s*-\s*channel:/gm) ?? [];
  const mainChannels = profileText.match(/^\s*-\s*channel:\s*["']?main\b/gm) ?? [];
  if (
    channels.length !== 1 ||
    mainChannels.length !== 1 ||
    /open_browser:\s*true/i.test(profileText)
  ) {
    throw new Error("profile must configure one main MCP command and must not open the admin UI");
  }
  return true;
}

if (process.argv[2] === "render-plist") {
  try {
    const content = renderLaunchAgentPlist(process.argv[3] ?? "", process.argv[4] ?? "");
    writeFileSync(1, content);
  } catch (error) {
    process.stderr.write(`CodeBridge tunnel agent: ${error.message}\n`);
    process.exitCode = 1;
  }
} else if (process.argv[2] === "validate-profile") {
  try {
    validateProfileForAgent(readFileSync(process.argv[3] ?? "", "utf8"));
  } catch (error) {
    process.stderr.write(`CodeBridge tunnel agent: ${error.message}\n`);
    process.exitCode = 1;
  }
}
