#!/bin/bash
# CodeBridge Secure MCP Tunnel LaunchAgent child. Runtime credentials never
# enter this file, the LaunchAgent plist, command arguments, or its logs.
set -u
umask 077

STATE_DIR="${HOME:?HOME must be set}/.codebridge/tunnel-client"
LOG_DIR="$STATE_DIR/logs"
LOG_FILE="$LOG_DIR/launchagent.log"
HEALTH_URL_FILE="$STATE_DIR/health-url"
KEYCHAIN_SERVICE="com.codebridge.m15.secure-mcp-tunnel.runtime-key"
KEYCHAIN_ACCOUNT="codebridge-m15"
TUNNEL_CLIENT="$STATE_DIR/bin/tunnel-client"
PROFILE="codebridge-m15"
PROFILE_DIR="$STATE_DIR/profiles"

if [ -L "$HOME/.codebridge" ] || [ -L "$STATE_DIR" ] || [ -L "$LOG_DIR" ] ||
  [ -L "$LOG_FILE" ] || [ -L "$LOG_FILE.1" ]; then
  exit 70
fi
/bin/mkdir -p "$LOG_DIR" || exit 70
/bin/chmod 700 "$STATE_DIR" "$LOG_DIR" || exit 70
if [ -f "$LOG_FILE" ]; then
  size=$(/usr/bin/stat -f%z "$LOG_FILE" 2>/dev/null || printf '0')
  links=$(/usr/bin/stat -f%l "$LOG_FILE" 2>/dev/null || printf '0')
  case "$size" in *[!0-9]*|'') size=0;; esac
  [ "$links" = 1 ] || exit 70
  if [ "$size" -ge 65536 ]; then
    /bin/rm -f "$LOG_FILE.1" || exit 70
    /bin/mv "$LOG_FILE" "$LOG_FILE.1" || exit 70
  fi
fi
: >> "$LOG_FILE" || exit 70
/bin/chmod 600 "$LOG_FILE" || exit 70

log_event() {
  printf '%s %s\n' "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >> "$LOG_FILE"
}

if [ -L "$TUNNEL_CLIENT" ] || [ -L "$PROFILE_DIR" ] || [ -L "$PROFILE_DIR/$PROFILE.yaml" ] ||
  [ ! -x "$TUNNEL_CLIENT" ] || [ ! -f "$PROFILE_DIR/$PROFILE.yaml" ]; then
  log_event 'launch blocked: configured client or profile is missing'
  exit 78
fi

/bin/rm -f "$HEALTH_URL_FILE"
log_event "starting OpenAI Secure MCP Tunnel profile=$PROFILE"
if ! api_key=$(/usr/bin/security find-generic-password \
  -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w 2>/dev/null); then
  log_event 'launch blocked: Keychain credential unavailable'
  exit 78
fi
if [ -z "$api_key" ]; then
  unset api_key
  log_event 'launch blocked: Keychain credential unavailable'
  exit 78
fi

CONTROL_PLANE_API_KEY="$api_key"
export CONTROL_PLANE_API_KEY
unset api_key

child_pid=''
terminate_client() {
  if [ -n "$child_pid" ]; then
    /bin/kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
    child_pid=''
  fi
  /bin/rm -f "$HEALTH_URL_FILE"
  log_event 'stopped by launchd'
  exit 0
}
trap terminate_client TERM INT HUP

"$TUNNEL_CLIENT" run --profile "$PROFILE" --profile-dir "$PROFILE_DIR" \
  >/dev/null 2>&1 &
child_pid=$!
wait "$child_pid"
exit_code=$?
child_pid=''
/bin/rm -f "$HEALTH_URL_FILE"
log_event "tunnel-client exited status=$exit_code"
exit "$exit_code"
