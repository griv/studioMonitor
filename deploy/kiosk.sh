#!/usr/bin/env bash
# Runs inside the X session, launched by ~/.config/autostart/studio-kiosk.desktop.
#
# Rotates the panel to portrait, kills every flavour of screen blanking, then
# holds a kiosk browser open on the display page — restarting it if it dies.
#
#   STUDIO_URL     page to show          (default http://localhost:3000/)
#   STUDIO_ROTATE  left | right | normal (default left)
#   STUDIO_OUTPUT  xrandr output name    (default: first connected)

set -uo pipefail

URL="${STUDIO_URL:-http://localhost:3000/}"
ROTATE="${STUDIO_ROTATE:-left}"
PROFILE="${HOME}/.config/studio-kiosk"

# ── Logging ─────────────────────────────────────────────────────────────────
# An autostart entry's stdout goes to nowhere in particular, which is exactly
# why "the browser didn't come up" is impossible to diagnose on a box whose
# only interface is the wall it failed to draw. Keep it somewhere findable.
LOG_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/studio-kiosk.log"
mkdir -p "$(dirname "$LOG_FILE")"

# Truncate rather than rotate. This loops for months and the browser is chatty on
# stderr; nobody is ever going to want the second-most-recent boot. Appending
# (>>) means truncation is safe while the redirect is live.
trim_log() { [ -f "$LOG_FILE" ] && [ "$(wc -c <"$LOG_FILE")" -gt 2000000 ] && : >"$LOG_FILE"; }
trim_log

# Run by hand — checking rotation, say — you want to see it happen. Run by the
# autostart entry there is no terminal to see it on, only the file.
if [ -t 1 ]; then exec > >(tee -a "$LOG_FILE") 2>&1; else exec >>"$LOG_FILE" 2>&1; fi

log() { echo "[kiosk $(date '+%F %H:%M:%S')] $*"; }
log "── starting ── url=$URL rotate=$ROTATE session=${XDG_SESSION_TYPE:-unknown} display=${DISPLAY:-unset}"

# ── Portrait ────────────────────────────────────────────────────────────────
# Rotating a 1920x1080 panel gives a 1080x1920 framebuffer. `left` vs `right`
# depends on which way the monitor is physically turned — flip it if the image
# is upside down.
OUTPUT="${STUDIO_OUTPUT:-$(xrandr --query | awk '/ connected/ {print $1; exit}')}"
if [ -n "$OUTPUT" ]; then
  log "rotating $OUTPUT $ROTATE"
  xrandr --output "$OUTPUT" --auto --rotate "$ROTATE" \
    || log "WARNING: rotation failed — see the NVIDIA note in deploy/README.md"
else
  log "WARNING: no connected output found"
fi

# ── Never blank ─────────────────────────────────────────────────────────────
xset s off
xset s noblank
xset -dpms

# XFCE's power manager and screensaver will happily override xset, so turn
# those off too. Missing keys are fine — hence the discarded errors.
xfconf-query -c xfce4-power-manager -p /xfce4-power-manager/dpms-enabled     -s false 2>/dev/null
xfconf-query -c xfce4-power-manager -p /xfce4-power-manager/blank-on-ac      -s 0     2>/dev/null
xfconf-query -c xfce4-power-manager -p /xfce4-power-manager/brightness-on-ac -s 0     2>/dev/null
xfconf-query -c xfce4-screensaver   -p /saver/enabled                        -s false 2>/dev/null
xfconf-query -c xfce4-screensaver   -p /lock/enabled                         -s false 2>/dev/null

# Hide the pointer once it stops moving.
if command -v unclutter >/dev/null; then
  pgrep -x unclutter >/dev/null || unclutter -idle 1 &
fi

# ── Wait for the server ─────────────────────────────────────────────────────
log "waiting for $URL"
served=0
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "$URL"; then served=1; break; fi
  sleep 1
done
# Carry on either way — the browser's own retry loop is a better place to wait
# than here — but say so, because "blank screen" and "blank page" look identical
# on the wall and have completely different causes.
[ "$served" -eq 1 ] || log "WARNING: $URL never answered in 60s (systemctl status studio-monitor)"

# ── Pick a browser ──────────────────────────────────────────────────────────
BROWSER=""
for b in chromium-browser chromium google-chrome-stable google-chrome; do
  if command -v "$b" >/dev/null; then BROWSER="$b"; break; fi
done

if [ -z "$BROWSER" ]; then
  if command -v firefox >/dev/null; then
    log "no chromium found, falling back to firefox"
    while true; do
      firefox --kiosk "$URL"
      log "firefox exited; restarting in 3s"
      sleep 3
    done
  fi
  log "FATAL: no browser installed"
  exit 1
fi

log "using $BROWSER"
mkdir -p "$PROFILE"

while true; do
  trim_log

  # Suppress the "Chrome didn't shut down correctly" restore bar after a power cut.
  sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' \
    "$PROFILE/Default/Preferences" 2>/dev/null || true

  "$BROWSER" \
    --kiosk \
    --user-data-dir="$PROFILE" \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-translate \
    --disable-pinch \
    --overscroll-history-navigation=0 \
    --autoplay-policy=no-user-gesture-required \
    --check-for-update-interval=31536000 \
    --password-store=basic \
    "$URL"

  log "browser exited; restarting in 3s"
  sleep 3
done
