#!/usr/bin/env bash
# Why isn't the wall showing anything?
#
# Walks the chain — server, browser, autostart entry, auto-login — and says which
# link is broken rather than which one you suspected. Run it on the box, either
# in the session or over SSH; session-only checks are skipped, not failed, when
# there's no display to look at.
#
#   ./deploy/doctor.sh            report
#   ./deploy/doctor.sh --repair   also fix what lives in $HOME
#   ./deploy/doctor.sh --quiet    only print problems, for checking it over SSH
#
# --repair deliberately stops at the boundary of things install.sh owns: it will
# rewrite the autostart entry, but it won't install a systemd unit or touch
# LightDM. If those are missing the answer is to re-run install.sh, and quietly
# half-installing from here would hide that.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUTOSTART="$HOME/.config/autostart/studio-kiosk.desktop"
LOG_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/studio-kiosk.log"
URL="${STUDIO_URL:-http://localhost:3000/}"

REPAIR=0; QUIET=0
for arg in "$@"; do
  case "$arg" in
    --repair) REPAIR=1 ;;
    --quiet)  QUIET=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

fails=0; warns=0
declare -a ADVICE=()

ok()   { [ "$QUIET" -eq 1 ] || printf '  \033[32mok\033[0m    %s\n' "$1"; return 0; }
bad()  { fails=$((fails + 1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"
         [ $# -gt 1 ] && ADVICE+=("$2"); return 0; }
warn() { warns=$((warns + 1)); printf '  \033[33mwarn\033[0m  %s\n' "$1"
         [ $# -gt 1 ] && ADVICE+=("$2"); return 0; }
skip() { [ "$QUIET" -eq 1 ] || printf '  ----  %s\n' "$1"; }
head_() { [ "$QUIET" -eq 1 ] || { echo; echo "$1"; }; }

# ── Server ──────────────────────────────────────────────────────────────────
head_ "Server"

if [ -f /etc/systemd/system/studio-monitor.service ]; then
  ok "unit installed"
  if systemctl is-enabled --quiet studio-monitor 2>/dev/null; then
    ok "starts at boot"
  else
    bad "unit is not enabled — it won't come back after a power cut" \
        "sudo systemctl enable studio-monitor"
  fi
  if systemctl is-active --quiet studio-monitor 2>/dev/null; then
    ok "running"
  else
    bad "unit is not running" "journalctl -u studio-monitor -n 50"
  fi
else
  bad "no systemd unit — the server isn't installed to start at boot" \
      "cd $REPO_DIR && ./deploy/install.sh"
fi

if curl -sf -o /dev/null --max-time 5 "$URL"; then
  ok "answering on $URL"
else
  bad "nothing answering on $URL" "journalctl -u studio-monitor -n 50"
fi

# ── Browser ─────────────────────────────────────────────────────────────────
head_ "Browser"

BROWSER=""
for b in chromium-browser chromium google-chrome-stable google-chrome firefox; do
  if command -v "$b" >/dev/null; then BROWSER="$b"; break; fi
done
if [ -n "$BROWSER" ]; then
  ok "$BROWSER installed"
else
  bad "no browser installed" "sudo apt-get install -y chromium-browser"
fi

# ── Kiosk autostart ─────────────────────────────────────────────────────────
# The most likely thing to be missing, and the least likely to announce itself:
# install.sh writes this near the end, so anything that aborts it earlier — a
# stale apt source, the wrong Node, a failed npm ci — leaves a box that boots,
# logs in and rotates the panel while never launching a browser.
head_ "Kiosk autostart"

repair_autostart() {
  mkdir -p "$(dirname "$AUTOSTART")"
  sed -e "s|__DIR__|$REPO_DIR|g" "$REPO_DIR/deploy/studio-kiosk.desktop" > "$AUTOSTART"
  chmod +x "$REPO_DIR/deploy/kiosk.sh" "$REPO_DIR/deploy/update.sh" "$REPO_DIR/deploy/doctor.sh"
  echo "        repaired: $AUTOSTART"
}

if [ -f "$AUTOSTART" ]; then
  ok "entry exists"

  EXEC_LINE="$(sed -n 's/^Exec=//p' "$AUTOSTART" | head -1)"
  EXEC_BIN="${EXEC_LINE%% *}"
  if [ -z "$EXEC_BIN" ]; then
    bad "entry has no Exec line" "re-run with --repair"
    [ "$REPAIR" -eq 1 ] && repair_autostart
  elif [ ! -x "$EXEC_BIN" ]; then
    # Covers both an unsubstituted __DIR__ and a checkout that has since moved.
    bad "Exec points at something missing or non-executable: $EXEC_BIN" \
        "cd $REPO_DIR && ./deploy/doctor.sh --repair"
    [ "$REPAIR" -eq 1 ] && repair_autostart
  elif [ "$EXEC_BIN" != "$REPO_DIR/deploy/kiosk.sh" ]; then
    warn "Exec points at another checkout: $EXEC_BIN" \
         "cd $REPO_DIR && ./deploy/doctor.sh --repair"
    [ "$REPAIR" -eq 1 ] && repair_autostart
  else
    ok "Exec → $EXEC_BIN"
  fi

  # Unchecking the entry in XFCE's Session and Startup doesn't delete it, it sets
  # Hidden=true. The file looks perfectly correct while doing nothing.
  if grep -qi '^Hidden=true' "$AUTOSTART"; then
    bad "entry is disabled (Hidden=true) — XFCE's Session and Startup can do this" \
        "cd $REPO_DIR && ./deploy/doctor.sh --repair"
    [ "$REPAIR" -eq 1 ] && repair_autostart
  fi
else
  bad "no autostart entry — nothing launches the browser at login" \
      "cd $REPO_DIR && ./deploy/doctor.sh --repair"
  if [ "$REPAIR" -eq 1 ]; then repair_autostart; fi
fi

[ -x "$REPO_DIR/deploy/kiosk.sh" ] && ok "kiosk.sh is executable" \
  || { bad "kiosk.sh is not executable" "chmod +x $REPO_DIR/deploy/kiosk.sh"
       [ "$REPAIR" -eq 1 ] && chmod +x "$REPO_DIR/deploy/kiosk.sh"; }

# ── Auto-login ──────────────────────────────────────────────────────────────
head_ "Auto-login"
if grep -rqs 'autologin-user' /etc/lightdm/lightdm.conf.d/ /etc/lightdm/lightdm.conf 2>/dev/null; then
  ok "LightDM logs in without a keyboard"
else
  warn "no LightDM auto-login — the wall will sit on a login prompt after a power cut" \
       "cd $REPO_DIR && ./deploy/install.sh"
fi

# ── Live session ────────────────────────────────────────────────────────────
# Only meaningful from inside the session. Over SSH there is no display to
# inspect, and reporting that as a failure would be worse than saying nothing.
head_ "Session"
if [ -z "${DISPLAY:-}" ]; then
  skip "not in a desktop session — run this on the box's own screen to check the rest"
else
  if [ "${XDG_SESSION_TYPE:-x11}" = "wayland" ]; then
    bad "session is Wayland; kiosk.sh rotates with xrandr, which needs X11" \
        "pick 'Xubuntu Session' (not Wayland) at the login screen"
  else
    ok "X11 session"
  fi

  pgrep -f 'deploy/kiosk.sh' >/dev/null \
    && ok "kiosk.sh is running" \
    || bad "kiosk.sh is not running — start it now with: $REPO_DIR/deploy/kiosk.sh &" \
           "log out and back in, or reboot, to confirm it starts by itself"

  pgrep -f 'user-data-dir.*studio-kiosk' >/dev/null \
    && ok "kiosk browser is up" \
    || warn "no kiosk browser process" "tail -40 $LOG_FILE"
fi

# ── Log ─────────────────────────────────────────────────────────────────────
head_ "Kiosk log"
if [ -f "$LOG_FILE" ]; then
  ok "$LOG_FILE"
  if [ "$QUIET" -eq 0 ]; then
    sed 's/^/        /' "$LOG_FILE" | tail -12
  fi
else
  # Absence is itself the finding: kiosk.sh writes this the moment it starts, so
  # no file means it has never run since the logging change landed.
  warn "no log at $LOG_FILE — kiosk.sh has not run since the last update" \
       "cd $REPO_DIR && ./deploy/update.sh"
fi

# ── Verdict ─────────────────────────────────────────────────────────────────
echo
if [ "$fails" -eq 0 ] && [ "$warns" -eq 0 ]; then
  [ "$QUIET" -eq 1 ] || echo "All good — reboot is the only real test."
  exit 0
fi

echo "$fails problem(s), $warns warning(s)."
if [ "${#ADVICE[@]}" -gt 0 ]; then
  echo "Try, in order:"
  printf '  %s\n' "${ADVICE[@]}" | awk '!seen[$0]++'
fi
[ "$fails" -gt 0 ] && exit 1
exit 0
