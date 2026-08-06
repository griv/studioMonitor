#!/usr/bin/env bash
# Pull the latest code and restart. Safe to run over SSH from anywhere.
#
#   ./deploy/update.sh          server only
#   ./deploy/update.sh --kiosk  also restart the browser (needed for front-end changes)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "==> Pulling"
# --ff-only so a diverged checkout fails loudly instead of opening a merge.
git pull --ff-only

echo "==> Dependencies"
npm ci --omit=dev

echo "==> Restarting server"
sudo systemctl restart studio-monitor
sleep 2
systemctl is-active --quiet studio-monitor \
  && echo "    server up" \
  || { echo "    FAILED — journalctl -u studio-monitor -n 50"; exit 1; }

# The display reconnects its SSE stream by itself within ~3s, so a server-only
# change needs nothing further. Changes to public/*.html need a browser reload.
if [ "${1:-}" = "--kiosk" ]; then
  echo "==> Restarting kiosk"

  # Restart kiosk.sh itself, not just the browser. bash read the script at login,
  # so a change to the profile path, the flags or the rotation is invisible to
  # the copy already running — and killing only the browser hands it straight
  # back to the old script, which relaunches it with the old settings. That looks
  # exactly like the update not working.
  pkill -f 'deploy/kiosk.sh'            || true
  pkill -f 'user-data-dir.*studio-kiosk' || true
  sleep 1

  # Same command works from a terminal on the box and over SSH. Over SSH there's
  # no DISPLAY, but the session is on :0 and we're the user who owns it.
  KIOSK_DISPLAY="${DISPLAY:-:0}"
  [ -n "${XAUTHORITY:-}" ] || [ ! -f "$HOME/.Xauthority" ] || export XAUTHORITY="$HOME/.Xauthority"

  if DISPLAY="$KIOSK_DISPLAY" xset q >/dev/null 2>&1; then
    # setsid so it survives this shell — over SSH the whole process group goes
    # when the connection closes, which would take the wall down on logout.
    DISPLAY="$KIOSK_DISPLAY" setsid "$REPO_DIR/deploy/kiosk.sh" </dev/null >/dev/null 2>&1 &
    sleep 3
    if pgrep -f 'deploy/kiosk.sh' >/dev/null; then
      echo "    kiosk restarted on $KIOSK_DISPLAY"
    else
      echo "    FAILED — see \${XDG_STATE_HOME:-~/.local/state}/studio-kiosk.log"
    fi
  else
    echo "    no X display at $KIOSK_DISPLAY — it will start at the next login"
    echo "    (log in on the box, or: sudo reboot)"
  fi
fi

echo "==> Done: $(git log --oneline -1)"
