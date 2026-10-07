#!/bin/bash
# Install and control the per-user CodeBridge Secure MCP Tunnel LaunchAgent.
set -eu
umask 077

LABEL='com.codebridge.secure-mcp-tunnel'
STATE_DIR="${HOME:?HOME must be set}/.codebridge/tunnel-client"
BIN_DIR="$STATE_DIR/bin"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RUNNER="$BIN_DIR/run-codebridge-tunnel"
DOMAIN="gui/$(/usr/bin/id -u)"
TARGET="$DOMAIN/$LABEL"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd -P)"
NODE_BIN="$(command -v node 2>/dev/null || true)"

fail() { printf 'CodeBridge tunnel agent: %s\n' "$1" >&2; exit 1; }
loaded() { /bin/launchctl print "$TARGET" >/dev/null 2>&1; }

owned_existing_agent() {
  [ -f "$PLIST" ] && [ ! -L "$PLIST" ] && [ -f "$RUNNER" ] && [ ! -L "$RUNNER" ] || return 1
  /usr/bin/plutil -lint "$PLIST" >/dev/null 2>&1 || return 1
  [ "$(/usr/libexec/PlistBuddy -c 'Print :Label' "$PLIST" 2>/dev/null || true)" = "$LABEL" ] || return 1
  [ "$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$PLIST" 2>/dev/null || true)" = "$RUNNER" ] || return 1
  /usr/bin/grep -Fq 'KEYCHAIN_SERVICE="com.codebridge.m15.secure-mcp-tunnel.runtime-key"' "$RUNNER" &&
    /usr/bin/grep -Fq 'KEYCHAIN_ACCOUNT="codebridge-m15"' "$RUNNER" &&
    /usr/bin/grep -Fq 'PROFILE="codebridge-m15"' "$RUNNER"
}

installed_agent() {
  [ -f "$PLIST" ] && [ ! -L "$PLIST" ] &&
    [ "$(/usr/libexec/PlistBuddy -c 'Print :Label' "$PLIST" 2>/dev/null || true)" = "$LABEL" ] &&
    [ "$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$PLIST" 2>/dev/null || true)" = "$RUNNER" ] &&
    [ -f "$RUNNER" ] && [ ! -L "$RUNNER" ] && /usr/bin/cmp -s "$RUNNER" "$SOURCE_DIR/tunnel-agent-runner.sh"
}

install_agent() {
  [ "$(/usr/bin/uname -s)" = Darwin ] || fail 'install is supported only on macOS'
  [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || fail 'Node.js 24 or later is required on PATH to install the LaunchAgent'
  node_major=$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')
  [ "$node_major" -ge 24 ] 2>/dev/null || fail 'Node.js 24 or later is required to install the LaunchAgent'
  [ -x "$STATE_DIR/bin/tunnel-client" ] || fail "verified tunnel-client is missing at $STATE_DIR/bin/tunnel-client"
  [ ! -L "$STATE_DIR/bin/tunnel-client" ] || fail 'tunnel-client must be a regular installed binary, not a symlink'
  [ -f "$STATE_DIR/profiles/codebridge-m15.yaml" ] || fail "profile is missing at $STATE_DIR/profiles/codebridge-m15.yaml"
  [ ! -L "$STATE_DIR/profiles/codebridge-m15.yaml" ] || fail 'profile must be a regular file, not a symlink'
  "$NODE_BIN" "$SOURCE_DIR/tunnel-agent.mjs" validate-profile "$STATE_DIR/profiles/codebridge-m15.yaml" ||
    fail 'profile does not satisfy the private CodeBridge stdio tunnel requirements'
  /bin/mkdir -p "$BIN_DIR" "$HOME/Library/LaunchAgents" || fail 'cannot create per-user service directories'
  /bin/chmod 700 "$STATE_DIR" "$BIN_DIR"
  if [ -e "$RUNNER" ] && ! /usr/bin/cmp -s "$RUNNER" "$SOURCE_DIR/tunnel-agent-runner.sh"; then
    fail "refusing to overwrite existing runner: $RUNNER"
  fi
  if [ -e "$PLIST" ]; then
    fail "refusing to overwrite existing LaunchAgent plist: $PLIST; inspect it and remove it explicitly if it belongs to CodeBridge"
  fi
  /bin/cp "$SOURCE_DIR/tunnel-agent-runner.sh" "$RUNNER"
  /bin/chmod 700 "$RUNNER"

  "$NODE_BIN" "$SOURCE_DIR/tunnel-agent.mjs" render-plist "$RUNNER" "$STATE_DIR" > "$PLIST"
  /bin/chmod 600 "$PLIST"
  /usr/bin/plutil -lint "$PLIST" >/dev/null || fail 'generated LaunchAgent plist is invalid'
  printf 'Installed per-user LaunchAgent at %s (not started).\n' "$PLIST"
  printf 'Review it, then run: %s start\n' "$0"
}

upgrade_agent() {
  owned_existing_agent || fail 'existing LaunchAgent/runner are not the recognized CodeBridge installation; inspect them and leave unrelated state untouched'
  stop_agent
  /bin/rm "$PLIST" "$RUNNER"
  install_agent
}

start_agent() {
  installed_agent || fail 'LaunchAgent is not the verified CodeBridge installation; run install/upgrade after reviewing its ownership'
  /usr/bin/plutil -lint "$PLIST" >/dev/null || fail 'LaunchAgent plist is invalid'
  /bin/launchctl enable "$TARGET"
  if loaded; then
    /bin/launchctl kickstart "$TARGET"
  else
    /bin/launchctl bootstrap "$DOMAIN" "$PLIST"
  fi
  printf 'Started %s\n' "$TARGET"
}

stop_agent() {
  if loaded && ! installed_agent && ! owned_existing_agent; then
    fail 'refusing to stop a LaunchAgent that is not the recognized CodeBridge installation'
  fi
  if loaded; then /bin/launchctl bootout "$TARGET"; fi
  /bin/rm -f "$STATE_DIR/health-url"
  printf 'Stopped %s\n' "$TARGET"
}

case "${1:-}" in
  install) install_agent ;;
  upgrade) upgrade_agent ;;
  start) start_agent ;;
  stop) stop_agent ;;
  restart) stop_agent; start_agent ;;
  status)
    if ! loaded; then printf 'LaunchAgent not loaded\n'; exit 3; fi
    /bin/launchctl print "$TARGET" 2>/dev/null |
      /usr/bin/awk '/state =/ || /pid =/ || /last exit code =/ { print }'
    url_file="$STATE_DIR/health-url"
    [ -f "$url_file" ] || { printf 'Tunnel health: not ready\n'; exit 4; }
    url=$(/bin/cat "$url_file")
    case "$url" in http://127.0.0.1:*) ;; *) fail 'health URL is not loopback; refusing to query it' ;; esac
    if /usr/bin/curl --silent --show-error --fail --max-time 3 "$url/readyz" -o /dev/null; then
      printf 'Tunnel health: ready (loopback)\n'
    else
      printf 'Tunnel health: not ready\n'; exit 4
    fi
    ;;
  doctor)
    [ -x "$STATE_DIR/bin/tunnel-client" ] || fail 'tunnel-client binary is missing'
    [ -f "$STATE_DIR/profiles/codebridge-m15.yaml" ] || fail 'profile is missing'
    api_key=$(/usr/bin/security find-generic-password \
      -s com.codebridge.m15.secure-mcp-tunnel.runtime-key -a codebridge-m15 -w 2>/dev/null) ||
      fail 'runtime credential is not available in Keychain'
    [ -n "$api_key" ] || fail 'runtime credential is empty in Keychain'
    CONTROL_PLANE_API_KEY="$api_key" "$STATE_DIR/bin/tunnel-client" doctor \
      --profile codebridge-m15 --profile-dir "$STATE_DIR/profiles" --explain
    result=$?
    unset api_key
    exit "$result"
    ;;
  disable)
    if [ -e "$PLIST" ] || loaded; then
      owned_existing_agent || installed_agent || fail 'refusing to disable a LaunchAgent that is not the recognized CodeBridge installation'
    fi
    /bin/launchctl disable "$TARGET"
    stop_agent
    printf 'Autostart disabled; LaunchAgent retained at %s\n' "$PLIST"
    ;;
  uninstall)
    if [ -e "$PLIST" ] || loaded; then
      owned_existing_agent || installed_agent || fail 'refusing to remove a LaunchAgent that is not the recognized CodeBridge installation'
    fi
    /bin/launchctl disable "$TARGET"
    stop_agent
    if [ -f "$PLIST" ]; then
      /usr/bin/plutil -lint "$PLIST" >/dev/null || fail 'refusing to remove invalid plist'
      label=$(/usr/libexec/PlistBuddy -c 'Print :Label' "$PLIST" 2>/dev/null || true)
      [ "$label" = "$LABEL" ] || fail 'refusing to remove plist with an unexpected label'
      /bin/rm "$PLIST"
    fi
    if [ -f "$RUNNER" ] && /usr/bin/cmp -s "$RUNNER" "$SOURCE_DIR/tunnel-agent-runner.sh"; then /bin/rm "$RUNNER"; fi
    printf 'LaunchAgent removed. Profile, tunnel-client, Keychain item, and logs were retained.\n'
    ;;
  *)
    printf 'Usage: %s {install|upgrade|doctor|status|start|stop|restart|disable|uninstall}\n' "$0" >&2
    exit 64
    ;;
esac
