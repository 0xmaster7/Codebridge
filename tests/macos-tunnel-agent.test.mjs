import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { URL } from "node:url";
import { renderLaunchAgentPlist, validateProfileForAgent } from "../scripts/macos/tunnel-agent.mjs";

const runner = await readFile(
  new URL("../scripts/macos/tunnel-agent-runner.sh", import.meta.url),
  "utf8",
);
const controller = await readFile(
  new URL("../scripts/macos/tunnel-agent.sh", import.meta.url),
  "utf8",
);

test("LaunchAgent plist is user-scoped, backgrounded, restart-throttled, and secret-free", () => {
  const plist = renderLaunchAgentPlist(
    "/Users/example/Code Bridge/runner.sh",
    "/Users/example/.codebridge/state",
  );
  assert.match(plist, /com\.codebridge\.secure-mcp-tunnel/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>30<\/integer>/);
  assert.match(plist, /<key>ProcessType<\/key><string>Background<\/string>/);
  assert.match(plist, /Code Bridge/);
  assert.doesNotMatch(plist, /API_KEY|CONTROL_PLANE|secret|token/i);
  assert.throws(() => renderLaunchAgentPlist("relative/runner", "/state"), /absolute/);
  assert.throws(() => renderLaunchAgentPlist("/runner\nBAD", "/state"), /control characters/);
});

test("profile validation accepts only private loopback stdio configuration with Keychain env reference", () => {
  const profile = `control_plane:\n  tunnel_id: "tunnel_0123456789abcdef0123456789abcdef"\n  api_key: "env:CONTROL_PLANE_API_KEY"\nhealth:\n  listen_addr: "127.0.0.1:0"\nmcp:\n  commands:\n    - channel: main\n      command: "/usr/bin/env -u CONTROL_PLANE_API_KEY /opt/node /work/Codebridge/dist/src/cli.js mcp"\n`;
  assert.equal(validateProfileForAgent(profile), true);
  assert.throws(
    () => validateProfileForAgent(profile.replace("127.0.0.1:0", "0.0.0.0:8080")),
    /loopback/,
  );
  assert.throws(
    () => validateProfileForAgent(profile.replace("env:CONTROL_PLANE_API_KEY", "/tmp/key")),
    /Keychain/,
  );
  assert.throws(
    () => validateProfileForAgent(profile.replace("env -u CONTROL_PLANE_API_KEY", "env")),
    /scrub the runtime key/,
  );
  assert.throws(() => validateProfileForAgent(`${profile}\ncloudflared: true`), /prohibited/);
  assert.throws(() => validateProfileForAgent(`${profile}\n    - channel: extra`), /one main/);
  assert.throws(() => validateProfileForAgent(`${profile}\n  open_browser: true`), /must not open/);
});

test("runner retrieves the runtime key only from Keychain and never sends client output to persistent logs", () => {
  assert.match(runner, /security find-generic-password[\s\\\S]*-w/);
  assert.match(runner, /com\.codebridge\.m15\.secure-mcp-tunnel\.runtime-key/);
  assert.match(runner, /CONTROL_PLANE_API_KEY="\$api_key"/);
  assert.match(runner, /run --profile "\$PROFILE"[\s\\\S]*>\/dev\/null 2>&1/);
  assert.match(runner, /65536/);
  assert.match(runner, /-L "\$LOG_DIR"/);
  assert.match(runner, /links.*= 1/);
  assert.match(controller, /launchctl bootstrap "\$DOMAIN"/);
  assert.match(controller, /http:\/\/127\.0\.0\.1:\*/);
  assert.match(controller, /CONTROL_PLANE_API_KEY="\$api_key"/);
  assert.match(controller, /security find-generic-password/);
  assert.match(controller, /refusing to overwrite existing LaunchAgent plist/);
  assert.match(controller, /unexpected label/);
  assert.match(controller, /owned_existing_agent/);
  assert.match(
    controller,
    /existing LaunchAgent\/runner are not the recognized CodeBridge installation/,
  );
});

test("macOS service shell helpers parse successfully", () => {
  for (const script of ["scripts/macos/tunnel-agent.sh", "scripts/macos/tunnel-agent-runner.sh"]) {
    const result = spawnSync("/bin/bash", ["-n", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});
