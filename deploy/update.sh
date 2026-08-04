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
# change needs nothing further. Changes to public/*.html need a browser reload —
# killing it is enough, the loop in kiosk.sh brings it straight back.
if [ "${1:-}" = "--kiosk" ]; then
  echo "==> Restarting kiosk browser"
  pkill -f 'user-data-dir.*studio-kiosk' || echo "    (browser wasn't running)"
fi

echo "==> Done: $(git log --oneline -1)"
