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
  if command -v snap >/dev/null && snap list chromium >/dev/null 2>&1; then
    ok "$BROWSER installed (snap)"
  else
    ok "$BROWSER installed"
  fi
else
  bad "no browser installed" "sudo apt-get install -y chromium-browser"
fi

# A snap-confined chromium can only write non-hidden paths under $HOME, so a
# profile in a dotdir aborts every launch. kiosk.sh defaults correctly; this
# catches a STUDIO_PROFILE override that would reintroduce it.
PROFILE="${STUDIO_PROFILE:-$HOME/studio-kiosk}"
case "${PROFILE#"$HOME"/}" in
  .*) if command -v snap >/dev/null && snap list chromium >/dev/null 2>&1; then
        bad "profile $PROFILE is a hidden path the chromium snap cannot write to" \
            "unset STUDIO_PROFILE, or set one without a leading dot"
      fi ;;
esac

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

  if pgrep -f 'deploy/kiosk.sh' >/dev/null; then
    ok "kiosk.sh is running"

    # bash read the script at login, so the running copy is a snapshot. If it
    # started before the file was last written it is executing old code — which
    # is what makes an update look like it changed nothing at all.
    KPID="$(pgrep -f 'deploy/kiosk.sh' | head -1)"
    ETIMES="$(ps -o etimes= -p "$KPID" 2>/dev/null | tr -d ' ')"
    MTIME="$(stat -c %Y "$REPO_DIR/deploy/kiosk.sh" 2>/dev/null \
             || stat -f %m "$REPO_DIR/deploy/kiosk.sh" 2>/dev/null)"
    # Validate separately: concatenating them hides an empty ETIMES behind a
    # numeric MTIME, and an empty value is 0 in arithmetic — which would report
    # a stale process as current, the one answer worse than saying nothing.
    case "$ETIMES" in ''|*[!0-9]*) ETIMES="" ;; esac
    case "$MTIME"  in ''|*[!0-9]*) MTIME=""  ;; esac

    if [ -z "$ETIMES" ] || [ -z "$MTIME" ]; then
      skip "can't tell how long kiosk.sh has been running"
    elif [ "$(( $(date +%s) - ETIMES ))" -lt "$MTIME" ]; then
      bad "the running kiosk.sh predates the file on disk — it's executing old code" \
          "cd $REPO_DIR && ./deploy/update.sh --kiosk"
    else
      ok "running the current kiosk.sh"
    fi
  else
    bad "kiosk.sh is not running" \
        "cd $REPO_DIR && ./deploy/update.sh --kiosk"
  fi

  pgrep -f 'user-data-dir.*studio-kiosk' >/dev/null \
    && ok "kiosk browser is up" \
    || warn "no kiosk browser process" "tail -40 $LOG_FILE"
fi

# ── Log ─────────────────────────────────────────────────────────────────────
head_ "Kiosk log"
if [ -f "$LOG_FILE" ]; then
  ok "$LOG_FILE"

  # Read it, don't just print it. Printing the log and then reporting "All good"
  # over a browser that had been restarting every 3 seconds is precisely the
  # failure this script exists to prevent.
  #
  # Scoped to the current run — kiosk.sh writes a banner at each launch — so a
  # fault that has since been fixed stops being reported instead of lingering
  # until it scrolls out of the file.
  SESSION="$(awk '/── starting ──/ {buf = ""} {buf = buf $0 ORS} END {printf "%s", buf}' "$LOG_FILE")"
  [ -n "$SESSION" ] || SESSION="$(tail -60 "$LOG_FILE")"

  restarts="$(printf '%s' "$SESSION" | grep -c 'browser exited; restarting')"
  if [ "$restarts" -ge 3 ]; then
    bad "browser is crash-looping — $restarts restarts this session" \
        "the errors printed just above each restart say why"
  fi

  # The specific one worth naming, because the message chromium prints describes
  # a consequence and not the cause: snap's home interface grants @{HOME}/[^.]**,
  # so a profile under ~/.config can never be locked.
  if printf '%s' "$SESSION" | grep -q 'SingletonLock.*Permission denied'; then
    bad "chromium can't lock its profile — the snap is denied hidden paths under \$HOME" \
        "cd $REPO_DIR && ./deploy/update.sh --kiosk    # moves the profile out of ~/.config"
  fi

  if printf '%s' "$SESSION" | grep -q 'never answered in 60s'; then
    warn "the kiosk gave up waiting for the server" "journalctl -u studio-monitor -n 50"
  fi

  if [ "$QUIET" -eq 0 ]; then
    printf '%s' "$SESSION" | tail -12 | sed 's/^/        /'
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
