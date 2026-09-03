#!/usr/bin/env bash
# dev-net.sh — after a network switch, repoint the dev stack to the Mac's new LAN IP.
#
# Run this whenever your Wi-Fi/LAN IP changes. By default it does everything:
#   1. rewrites the host IP in the .env files
#   2. restarts the local Supabase Docker stack (picks up the new network)
#   3. restarts the server and Expo IN the Terminal windows already running them
#      (reuses the existing tab; only opens a new window if none is found)
#   4. (re)connects the phone over adb and reverses the dev ports
#
# Files it rewrites:
#   ~/kwill/.env         EXPO_PUBLIC_SUPABASE_URL (:54331), EXPO_PUBLIC_API_URL (:3000)
#   ~/kwill-server/.env  STORAGE_PUBLIC_HOST
#
# Usage:
#   ./scripts/dev-net.sh                              full run: env + supabase + services + adb
#   ./scripts/dev-net.sh 10.157.209.26               force a specific host IP (else auto-detect)
#   ./scripts/dev-net.sh --device 192.168.1.4:40835  also `adb connect` this wireless phone first
#   ./scripts/dev-net.sh --env-only                  only rewrite the .env files
#   ./scripts/dev-net.sh --adb-only                  only (re)wire adb
#   ./scripts/dev-net.sh --no-supabase               skip the Supabase restart
#   ./scripts/dev-net.sh --no-services               don't restart server / Expo
#   ./scripts/dev-net.sh --no-adb                    don't touch adb
#
# The wireless --device address is remembered in ~/.modakerati-adb-device and reused.

set -uo pipefail

APP_DIR="$HOME$HOME/kwill"
SERVER_DIR="$HOME$HOME/kwill-server"
APP_ENV="$APP_DIR/.env"
SERVER_ENV="$SERVER_DIR/.env"
DEVICE_MEMO="$HOME/.modakerati-adb-device"
SERVER_TTY_MEMO="$HOME/.modakerati-devnet-server.tty"
EXPO_TTY_MEMO="$HOME/.modakerati-devnet-expo.tty"
PORTS=(3000 8081 54331)
SB_DB_PORT=54332
SB_API_PORT=54331

HOST_IP=""
DEVICE_ADDR=""
DO_ENV=1; DO_SUPABASE=1; DO_SERVICES=1; DO_ADB=1

while [ $# -gt 0 ]; do
  case "$1" in
    --device|-d)   DEVICE_ADDR="${2:-}"; shift 2 ;;
    --env-only)    DO_SUPABASE=0; DO_SERVICES=0; DO_ADB=0; shift ;;
    --adb-only)    DO_ENV=0; DO_SUPABASE=0; DO_SERVICES=0; shift ;;
    --no-supabase) DO_SUPABASE=0; shift ;;
    --no-services) DO_SERVICES=0; shift ;;
    --no-adb)      DO_ADB=0; shift ;;
    -h|--help)     sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)            echo "unknown flag: $1" >&2; exit 2 ;;
    *)             HOST_IP="$1"; shift ;;
  esac
done

# ---------------------------------------------------- detect the Mac's LAN IP ---
if [ -z "$HOST_IP" ]; then
  IFACE=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
  [ -n "${IFACE:-}" ] && HOST_IP=$(ipconfig getifaddr "$IFACE" 2>/dev/null || true)
  [ -z "$HOST_IP" ] && HOST_IP=$(ipconfig getifaddr en0 2>/dev/null || true)
  [ -z "$HOST_IP" ] && HOST_IP=$(ipconfig getifaddr en1 2>/dev/null || true)
fi
if ! [[ "$HOST_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "✗ Could not determine a valid host IP (got '${HOST_IP:-empty}')." >&2
  echo "  Pass one explicitly:  $0 <ip>" >&2
  exit 1
fi
echo "→ Host IP: $HOST_IP"

# ---------------------------------------------------------------- env rewrite ---
if [ "$DO_ENV" -eq 1 ]; then
  if [ -f "$APP_ENV" ]; then
    sed -i '' -E \
      -e "s|^(EXPO_PUBLIC_SUPABASE_URL=http://)[^:/]+(:[0-9]+)|\1${HOST_IP}\2|" \
      -e "s|^(EXPO_PUBLIC_API_URL=http://)[^:/]+(:[0-9]+)|\1${HOST_IP}\2|" \
      "$APP_ENV"
    echo "  ✓ env  $APP_ENV"
  else
    echo "  ⚠ not found, skipped: $APP_ENV" >&2
  fi
  if [ -f "$SERVER_ENV" ]; then
    sed -i '' -E "s|^(STORAGE_PUBLIC_HOST=).*|\1${HOST_IP}|" "$SERVER_ENV"
    echo "  ✓ env  $SERVER_ENV"
  else
    echo "  ⚠ not found, skipped: $SERVER_ENV" >&2
  fi
fi

# --------------------------------------------------------- restart Supabase ----
# config.toml has no LAN-IP in it, so this is really just bouncing the containers
# so Docker re-establishes networking cleanly after the host changed networks.
if [ "$DO_SUPABASE" -eq 1 ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "  ⚠ docker not found — skipping Supabase restart" >&2
  else
    names=$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep 'modakerati-server$' || true)
    if [ -z "$names" ]; then
      echo "  ⚠ no Supabase containers found — start them with:" >&2
      echo "      (cd $SERVER_DIR && supabase start)" >&2
    else
      echo "→ Restarting Supabase (modakerati-server)"
      # db first so the API/auth/storage services reconnect to a live Postgres
      db=$(printf '%s\n' "$names" | grep '_db_' || true)
      [ -n "$db" ] && docker restart $db >/dev/null 2>&1
      rest=$(printf '%s\n' "$names" | grep -v '_db_')
      [ -n "$rest" ] && docker restart $rest >/dev/null 2>&1
      printf '  … waiting for Supabase'
      for _ in $(seq 1 30); do
        if nc -z 127.0.0.1 "$SB_DB_PORT" >/dev/null 2>&1 \
           && nc -z 127.0.0.1 "$SB_API_PORT" >/dev/null 2>&1; then
          printf ' ready\n'; break
        fi
        printf '.'; sleep 1
      done
    fi
  fi
fi

# ------------------------------------ restart server + Expo (reuse their tabs) --
# A running command's controlling tty IS the Terminal tab it lives in, so we note
# it before killing and then re-run the command in that same tab. (Metro's port
# listener is a detached child with no tty, so we scan the `expo start` parent too.)
first_real_tty() {  # args: candidate pids; echo the first /dev/ttys* among them
  local pid t
  for pid in "$@"; do
    [ -z "$pid" ] && continue
    t=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ')
    if [ -n "$t" ] && [ "$t" != "??" ]; then printf '/dev/%s\n' "$t"; return 0; fi
  done
}

relaunch_service() {  # $1 wanted-tty (may be empty)  $2 memo-file  $3 command  $4 label
  local want="$1" memo="$2" cmd="$3" label="$4" out
  [ -z "$want" ] && [ -f "$memo" ] && want=$(cat "$memo" 2>/dev/null)
  out=$(osascript <<OSA
tell application "Terminal"
  activate
  set target to missing value
  set wantTty to "$want"
  if wantTty is not "" then
    repeat with w in windows
      repeat with tb in tabs of w
        try
          if tty of tb is wantTty then
            set target to tb
            exit repeat
          end if
        end try
      end repeat
      if target is not missing value then exit repeat
    end repeat
  end if
  if target is missing value then
    set target to do script "$cmd"
  else
    do script "$cmd" in target
  end if
  return tty of target
end tell
OSA
)
  out=$(printf '%s' "$out" | tr -d '[:space:]')
  if [ -n "$out" ]; then
    printf '%s\n' "$out" > "$memo"
    if [ -n "$want" ] && [ "$out" = "$want" ]; then
      echo "  ✓ $label → reused $out"
    else
      echo "  ✓ $label → new window ($out)"
    fi
  else
    echo "  ⚠ $label → couldn't drive Terminal.app" >&2
  fi
}

if [ "$DO_SERVICES" -eq 1 ]; then
  echo "→ Restarting server + Expo"
  # which tab is each currently running in? (captured before we kill them)
  server_tty=$(first_real_tty $(lsof -ti tcp:3000 2>/dev/null) $(pgrep -f "tsx watch src/index.ts" 2>/dev/null))
  expo_tty=$(first_real_tty $(lsof -ti tcp:8081 2>/dev/null) $(pgrep -f "expo start" 2>/dev/null))
  # stop them
  pkill -f "tsx watch src/index.ts" >/dev/null 2>&1
  s=$(lsof -ti tcp:3000 2>/dev/null); [ -n "$s" ] && kill $s 2>/dev/null
  pkill -f "expo start" >/dev/null 2>&1
  m=$(lsof -ti tcp:8081 2>/dev/null); [ -n "$m" ] && kill $m 2>/dev/null
  # wait for the ports to free so those tabs' shells are back at a prompt
  printf '  … stopping'
  for _ in 1 2 3 4 5 6; do
    s=$(lsof -ti tcp:3000 2>/dev/null); m=$(lsof -ti tcp:8081 2>/dev/null)
    [ -z "$s" ] && [ -z "$m" ] && break
    printf '.'; sleep 1
  done
  printf '\n'
  # re-run each command in its own tab (new window only if none was found)
  relaunch_service "$server_tty" "$SERVER_TTY_MEMO" "cd ${SERVER_DIR} && npm run dev" "server"
  relaunch_service "$expo_tty" "$EXPO_TTY_MEMO" "cd ${APP_DIR} && npx expo start --clear" "Expo"
fi

# ----------------------------------------------------------------------- adb ---
if [ "$DO_ADB" -eq 1 ]; then
  if ! command -v adb >/dev/null 2>&1; then
    echo "✗ adb not on PATH — install Android platform-tools." >&2
    exit 1
  fi
  if [ -n "$DEVICE_ADDR" ]; then
    echo "$DEVICE_ADDR" > "$DEVICE_MEMO"
  elif [ -f "$DEVICE_MEMO" ]; then
    DEVICE_ADDR=$(cat "$DEVICE_MEMO")
  fi
  if [ -n "$DEVICE_ADDR" ]; then
    echo "→ adb connect $DEVICE_ADDR"
    adb connect "$DEVICE_ADDR" || true
  fi
  if ! adb get-state >/dev/null 2>&1; then
    printf '  … waiting for a device'
    for _ in 1 2 3 4 5; do
      adb get-state >/dev/null 2>&1 && break
      printf '.'; sleep 1
    done
    printf '\n'
  fi
  if adb get-state >/dev/null 2>&1; then
    for p in "${PORTS[@]}"; do
      if adb reverse "tcp:$p" "tcp:$p" >/dev/null 2>&1; then
        echo "  ✓ reverse tcp:$p → tcp:$p"
      else
        echo "  ✗ reverse tcp:$p failed" >&2
      fi
    done
  else
    echo "✗ No adb device. Plug in USB, or pass --device <ip:port> for wireless." >&2
    exit 1
  fi
fi

echo "✓ Done."
