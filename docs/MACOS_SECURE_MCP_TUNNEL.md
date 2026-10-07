# macOS setup: normal ChatGPT through Secure MCP Tunnel

This runbook connects the local CodeBridge MCP stdio server to a normal ChatGPT chat using OpenAI Secure MCP Tunnel. The tunnel client makes an outbound HTTPS connection to OpenAI and forwards MCP requests to CodeBridge over local stdio. It opens no inbound port and does not make CodeBridge public. CodeBridge repository approval, immutable snapshot, check approval, offline sandbox, provenance, and output screening remain unchanged.

This workflow is separate from the local CodeBridge marketplace package. The local package is useful in supported local plugin hosts; in the tested ChatGPT Desktop setup it showed package metadata without registering the stdio tools. For normal ChatGPT, create and use the custom MCP app from the Secure MCP Tunnel.

Current account permissions, supported UI labels, and tunnel-client installation details can change. Before setup, check the [official Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [latest tunnel-client release](https://github.com/openai/tunnel-client/releases/latest), and your Platform/ChatGPT workspace policies.

## Security rules

- Use only OpenAI Secure MCP Tunnel. Do not use ngrok, Cloudflare Tunnel, another reverse proxy, port forwarding, or inbound firewall rules.
- Store the runtime API key only in the macOS login Keychain. Never put it in the repository, profile, LaunchAgent plist, script, shell history, environment file, command arguments, or logs.
- The launch wrapper reads the Keychain item and exposes its value only to the `tunnel-client` child process as `CONTROL_PLANE_API_KEY`.
- The sole MCP command starts with `/usr/bin/env -u CONTROL_PLANE_API_KEY`, so the CodeBridge stdio process does not inherit the tunnel runtime credential.
- The profile contains the tunnel ID, MCP command, and the literal Keychain-backed reference `env:CONTROL_PLANE_API_KEY`; it contains no credential.
- ChatGPT's CodeBridge MCP target uses **No authentication** because the app-level endpoint is OpenAI's tunnel endpoint and authentication to the tunnel control plane is handled by `tunnel-client`. Do not put the runtime key into the ChatGPT app configuration.
- Health uses an ephemeral `127.0.0.1` port. The embedded UI is not opened in a browser or exposed remotely. Logs contain only bounded lifecycle events, not child stdout/stderr or environment values.
- The MCP process still has only CodeBridge's existing permissions. The tunnel does not add repository writes, host shell access, Docker access, or network access to check containers.

## Prerequisites

- A Mac with a supported macOS version, Git, and Node.js 24 or later.
- A ChatGPT account/workspace allowed to create custom MCP apps and use Secure MCP Tunnel.
- A Platform organization where you can create/select the tunnel and create a restricted runtime key.
- Platform permissions: Tunnels Read + Manage to create/edit the tunnel; Tunnels Read + Use to run `tunnel-client` and select the tunnel in ChatGPT. ChatGPT custom MCP app permissions are separate.
- A local Docker-compatible daemon and already approved immutable check image if you need to run project checks. Docker is not needed merely to expose the read-only tools.
- Keep the CodeBridge checkout at a stable path. The MCP profile points at that checkout and its compiled `dist/src/cli.js`.

## New Mac: install and configure from scratch

### 1. Clone, build, and select CodeBridge

Use the repository's trusted HTTPS clone URL and install the lockfile-pinned dependencies:

```sh
git clone https://github.com/0xmaster7/Codebridge.git "$HOME/Codebridge"
cd "$HOME/Codebridge"
npm ci
npm run build
npm run doctor
```

Initialize and select only the repository you intend to audit. Requirements and check profiles must still be approved separately through the CodeBridge CLI:

```sh
node dist/src/cli.js init "$HOME/Codebridge"
node dist/src/cli.js select cb-<project-id-printed-by-init>
node dist/src/cli.js status
node dist/src/cli.js doctor
```

Do not approve secrets or content you do not want sent to the model. A selected project does not itself approve requirements or check execution.

### 2. Create and associate a Secure MCP Tunnel

In [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels), create or select a tunnel. Save its ID as `<TUNNEL_ID>`. Associate it with both:

1. The Platform organization that owns/manages it.
2. The ChatGPT workspace in which the custom MCP app will be created and used.

For enterprise workspaces, ensure the workspace association is explicit. A Platform organization association alone may not make the tunnel selectable in ChatGPT. Do not paste the tunnel ID into public issues or treat it as a credential.

### 3. Install and verify `tunnel-client`

Use the Platform tunnel settings download link or the latest official [OpenAI tunnel-client release](https://github.com/openai/tunnel-client/releases/latest). Select the macOS binary for the Mac's CPU architecture. Verify the downloaded artifact against the checksum published with that same release before installing it. Do not use a cached version URL from this document. Install only the `tunnel-client` executable at:

```text
$HOME/.codebridge/tunnel-client/bin/tunnel-client
```

Use a private CodeBridge-owned directory and executable permissions for your account only. Do not install or configure the archive's `cloudflared` companion. Confirm the binary version with:

```sh
"$HOME/.codebridge/tunnel-client/bin/tunnel-client" --version
```

### 4. Create the private profile

Create the private directories:

```sh
umask 077
mkdir -p "$HOME/.codebridge/tunnel-client/profiles" \
  "$HOME/.codebridge/tunnel-client/bin" \
  "$HOME/.codebridge/tunnel-client/logs"
chmod 700 "$HOME/.codebridge" "$HOME/.codebridge/tunnel-client" \
  "$HOME/.codebridge/tunnel-client/profiles" \
  "$HOME/.codebridge/tunnel-client/bin" \
  "$HOME/.codebridge/tunnel-client/logs"
```

Resolve the absolute Node and checkout paths, replace the tunnel ID placeholder, then create the profile. The command contains no key:

```sh
TUNNEL_CLIENT="$HOME/.codebridge/tunnel-client/bin/tunnel-client"
PROFILE_DIR="$HOME/.codebridge/tunnel-client/profiles"
REPO_ROOT="$(cd "$HOME/Codebridge" && pwd -P)"
NODE_BIN="$(command -v node)"
TUNNEL_ID='<TUNNEL_ID>' # Replace with the tunnel ID from Platform.
MCP_COMMAND="$(printf '%q -u CONTROL_PLANE_API_KEY %q %q mcp' \
  /usr/bin/env "$NODE_BIN" "$REPO_ROOT/dist/src/cli.js")"

"$TUNNEL_CLIENT" init \
  --sample sample_mcp_stdio_local \
  --profile codebridge-m15 \
  --profile-dir "$PROFILE_DIR" \
  --tunnel-id "$TUNNEL_ID" \
  --mcp-command "$MCP_COMMAND" \
  --control-plane-api-key-ref env:CONTROL_PLANE_API_KEY \
  --health-listen-addr 127.0.0.1:0
```

If your checkout or Node executable is not at the example location, set `REPO_ROOT` and `NODE_BIN` to their actual resolved paths. `tunnel-client init` refuses an existing profile unless explicitly forced; do not use `--force` to overwrite a profile you have not reviewed. Edit the generated profile and set `health.url_file` to `$HOME/.codebridge/tunnel-client/health-url`. Keep the profile private (`chmod 600`).

The profile must contain:

- Tunnel ID `<TUNNEL_ID>`.
- Key reference exactly `env:CONTROL_PLANE_API_KEY` (never the key value).
- Local health address `127.0.0.1:0` with a URL file at `$HOME/.codebridge/tunnel-client/health-url`.
- Admin UI browser opening disabled.
- Exactly one `main` stdio MCP command that starts with `/usr/bin/env -u CONTROL_PLANE_API_KEY`, then runs the selected CodeBridge checkout's `dist/src/cli.js mcp` with its absolute Node.js 24+ executable path.
- No HTTP MCP targets, Cloudflare settings, extra poll channels, remote UI option, or raw HTTP debug logging.

The generated MCP command quotes paths with spaces using the shell's `%q` formatter. Use the repository helper for doctor so it retrieves the key from Keychain for that command only; never export the key into your shell:

```sh
"$HOME/Codebridge/scripts/macos/tunnel-agent.sh" doctor
```

Confirm the report names the expected tunnel and the sole CodeBridge stdio target. A successful doctor result does not prove the live ChatGPT connection; continue through the runtime and tool checks below.

### 5. Create a restricted runtime key and store it in Keychain

In Platform API key settings, create a **runtime** key for the `tunnel-client`, not an admin key. Grant only **Tunnels Read** and **Tunnels Use**. Do not grant Tunnels Manage to the runtime key. If your account offers narrower resource restrictions, scope it to the selected tunnel. The current OpenAI guide distinguishes these runtime permissions from the Tunnels Read + Manage permissions needed by the human who creates/edits tunnels.

Add the key to the macOS login Keychain with the command below. macOS prompts for the value without echoing it; the key is not part of command arguments or shell history. Run it in Terminal and type the key only in the secure prompt:

```sh
/usr/bin/security add-generic-password \
  -s com.codebridge.m15.secure-mcp-tunnel.runtime-key \
  -a codebridge-m15 \
  -l "CodeBridge Secure MCP Tunnel runtime key" \
  -T /usr/bin/security \
  -w
```

Do not put a key after `-w`, in a command line, clipboard manager, chat, repository, plist, or profile. The `-T` setting limits the Keychain item's trusted application to Apple's `security` command used by the LaunchAgent wrapper. Check only that the Keychain item exists without displaying its value:

```sh
/usr/bin/security find-generic-password \
  -s com.codebridge.m15.secure-mcp-tunnel.runtime-key \
  -a codebridge-m15 >/dev/null
```

### 6. Install and enable the per-user LaunchAgent

The repository helper installs a `gui/<uid>` LaunchAgent under `$HOME/Library/LaunchAgents`; it is not a system LaunchDaemon. It installs a copy of the small credential-fetching runner under CodeBridge state, refuses to overwrite a different runner or any existing plist, and leaves the agent stopped until explicitly started.

From the repository root:

```sh
"$HOME/Codebridge/scripts/macos/tunnel-agent.sh" install
"$HOME/Codebridge/scripts/macos/tunnel-agent.sh" start
"$HOME/Codebridge/scripts/macos/tunnel-agent.sh" status
```

The agent starts at login. `KeepAlive` restarts an unexpected nonzero exit and `ThrottleInterval` sets a 30-second restart throttle. The process runs in the background without opening Terminal. The runner suppresses tunnel-client stdout/stderr and writes only bounded start/stop/exit events to `$HOME/.codebridge/tunnel-client/logs/launchagent.log` (maximum 64 KiB plus one rotated file).

Check readiness and the profile again:

```sh
"$HOME/Codebridge/scripts/macos/tunnel-agent.sh" status
"$HOME/Codebridge/scripts/macos/tunnel-agent.sh" doctor
```

`status` queries `/readyz` only if the generated health URL begins `http://127.0.0.1:`. Do not change it to `0.0.0.0`, a LAN address, or a public URL.

### 7. Create and connect the normal ChatGPT custom MCP app

In the ChatGPT workspace associated with the tunnel:

1. Open **Plugins** (some versions label this **Apps** or **Connectors**) and choose **+** / **Add custom MCP server**.
2. Choose **Tunnel** as the connection type and select the intended tunnel. If it is absent, recheck workspace association and the operator's Tunnels Read + Use permission.
3. Configure **No authentication** for the CodeBridge MCP target. `tunnel-client` separately authenticates to the tunnel control plane using its Keychain-sourced runtime key.
4. Review and accept the ChatGPT custom MCP warning, then create/install the resulting plugin/app.
5. In a normal ChatGPT chat, select the **tunnel-backed CodeBridge app**. If a local marketplace entry is also present, do not select that local copy for this workflow.

Ask ChatGPT to list its available CodeBridge actions without calling a repository audit. It should expose these 14 tools:

`audit_snapshot`, `repo_tree`, `find_paths`, `search_repo`, `read_file`, `read_files`, `git_status`, `git_log`, `git_diff`, `git_show`, `list_checks`, `run_check`, `check_status`, and `cancel_check`.

If fewer or no tools appear, do not run the independent audit. Troubleshoot the local profile, health, tunnel association, app selection, and tool registration first.

## Existing Mac: install or update the background service

After pulling the reviewed CodeBridge version and rebuilding, confirm the selected repository and `dist/src/cli.js` exist. Verify the installed tunnel-client binary using the latest release's published checksum. Preserve the existing profile and Keychain item; do not retype, copy, or export the runtime key.

Run `tunnel-agent.sh install`. It will stop with an explicit error rather than replace an existing LaunchAgent plist or a runner whose contents differ. Review any existing file before removal. If the service was already installed from this repository version, use `restart` after reviewing the change. The profile should continue to point at the same checkout or be updated deliberately to the new canonical path, then re-run profile doctor.

## Daily operation and lifecycle

From any shell, use the helper in the current trusted CodeBridge checkout:

| Action                                      | Command                                   |
| ------------------------------------------- | ----------------------------------------- |
| Profile doctor using a Keychain-sourced key | `scripts/macos/tunnel-agent.sh doctor`    |
| Status and loopback health                  | `scripts/macos/tunnel-agent.sh status`    |
| Start                                       | `scripts/macos/tunnel-agent.sh start`     |
| Stop until next explicit start              | `scripts/macos/tunnel-agent.sh stop`      |
| Restart                                     | `scripts/macos/tunnel-agent.sh restart`   |
| Disable login autostart and stop            | `scripts/macos/tunnel-agent.sh disable`   |
| Remove LaunchAgent and its installed runner | `scripts/macos/tunnel-agent.sh uninstall` |

`disable` retains the plist, runner, profile, binary, logs, and Keychain item. `uninstall` removes only the CodeBridge-labeled per-user plist and the installed runner if it exactly matches the current repository runner. It retains the profile, tunnel-client binary, logs, and Keychain item.

## Troubleshooting

- **Install refuses an existing plist/runner:** inspect its contents and ownership. The helper does not silently overwrite unrelated state. If it is the old CodeBridge agent, stop/disable it and remove it only after confirming its label and exact paths.
- **LaunchAgent not loaded:** run `start`; check that the user is logged into the GUI session and that macOS did not reject the plist (`plutil -lint`). Use `launchctl print "gui/$(id -u)/com.codebridge.secure-mcp-tunnel"` for launchd state.
- **Health not ready:** run `scripts/macos/tunnel-agent.sh status`, then `scripts/macos/tunnel-agent.sh doctor`. Check the tunnel-client installation, profile, outbound HTTPS access, and Keychain item presence. The launch log contains safe lifecycle status only; it intentionally excludes client error output and secret environment values.
- **Keychain credential unavailable:** unlock the user's login Keychain and verify the exact service/account with `security find-generic-password` without `-w`. Rotate/re-add the item using the secure prompt below. Never debug by printing the value.
- **Tunnel absent from ChatGPT:** check that the tunnel is associated with the intended Platform organization and ChatGPT workspace and that the app creator has Tunnels Read + Use.
- **Plugin appears but has zero tools:** confirm that the selected item is the custom plugin created from the tunnel, not the local marketplace package; then check tunnel-client `status`, profile doctor, and the app's MCP registration details. Do not substitute a manually configured public endpoint.
- **Wrong tools:** verify the profile's sole `main` stdio command resolves to the selected built CodeBridge checkout; rebuild and restart. Expected tool count is 14.
- **Do not “fix” failures** by exposing a listener, adding a tunnel provider, granting a check container network access, or broadening CodeBridge permissions.

## Credential rotation and revocation

1. Create a replacement runtime key with Tunnels Read + Use only.
2. Stop the service: `scripts/macos/tunnel-agent.sh stop`.
3. Update the Keychain item with a no-echo prompt. The safest repeatable procedure is to delete the old exact service/account item, then rerun the `security add-generic-password ... -w` command in step 5. Never pass the key as a command argument.
4. Start the service and verify `status` and profile doctor.
5. Revoke the old key in Platform key settings after the new connection is healthy.

To revoke immediately, disable/stop the LaunchAgent, revoke the runtime key in Platform key settings, and delete only the exact Keychain item:

```sh
"$HOME/Codebridge/scripts/macos/tunnel-agent.sh" disable
/usr/bin/security delete-generic-password \
  -s com.codebridge.m15.secure-mcp-tunnel.runtime-key \
  -a codebridge-m15
```

## Migration to a new Mac

Do not copy the old Mac's login Keychain database or secrets. On the new Mac, follow **New Mac** from the beginning: install Node and dependencies, clone/build CodeBridge, select/approve the intended repository, install and checksum-verify the current tunnel-client, associate the tunnel with the destination ChatGPT workspace, generate a replacement runtime key, store it in the new Mac's login Keychain, create its local profile, install the LaunchAgent, and verify tool discovery. Revoke the old Mac's key after the new setup is verified.

## Complete removal

1. In ChatGPT, remove/uninstall the tunnel-backed CodeBridge app.
2. Revoke the runtime API key in Platform key settings.
3. Disable and remove the LaunchAgent:

   ```sh
   "$HOME/Codebridge/scripts/macos/tunnel-agent.sh" uninstall
   ```

4. Delete the exact CodeBridge Keychain item:

   ```sh
   /usr/bin/security delete-generic-password \
     -s com.codebridge.m15.secure-mcp-tunnel.runtime-key \
     -a codebridge-m15
   ```

5. After reviewing the exact target, remove only `$HOME/.codebridge/tunnel-client` if you also want to remove the profile, verified client binary, health URL, and bounded logs. CodeBridge project approvals and audit records may be elsewhere under `$HOME/.codebridge`; preserve or remove that state deliberately according to the regular CodeBridge cleanup procedure.
6. Delete the CodeBridge checkout only after preserving any project data you need. No inbound firewall setting needs removal because this setup creates none.
