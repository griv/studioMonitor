#!/usr/bin/env bash
# One-shot setup for the display machine (Xubuntu / XFCE / LightDM / X11).
#
# Run it as the desktop user — NOT with sudo. It asks for sudo where it needs it,
# because the autostart entry and browser profile have to land in your home
# directory, not root's.
#
#   git clone https://github.com/griv/studioMonitor.git
#   cd studioMonitor
#   ./deploy/install.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME="$(id -un)"
NODE_MAJOR=24   # node:sqlite is only unflagged from 24

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as your normal user, not with sudo." >&2
  exit 1
fi

step() { echo; echo "==> $*"; }

# ── Packages ────────────────────────────────────────────────────────────────
step "Base packages"

# The Ubuntu installer leaves a dead file:/cdrom source behind on a fresh install.
# It makes every apt-get update exit non-zero, which in turn stops NodeSource's
# setup script from registering its repository — so apt quietly falls back to
# Ubuntu's nodejs, which is too old and has no npm. Comment it out rather than
# delete it, so the change is obvious and trivially reversible.
if grep -qs '^[^#].*cdrom' /etc/apt/sources.list; then
  echo "    disabling the installer's dead file:/cdrom source"
  sudo sed -i '/cdrom/s/^[^#]/#&/' /etc/apt/sources.list
fi

# Still tolerate a non-zero exit — there may be other stale sources we shouldn't
# touch. The Node check below is what actually catches the consequences.
sudo apt-get update -qq || echo "    (apt update reported errors — continuing)"
sudo apt-get install -y curl git ca-certificates unclutter x11-xserver-utils

step "Node.js"

# The requirement isn't a version number, it's whether node:sqlite loads without
# a flag. It arrived in 22.5 behind --experimental-sqlite and is unflagged from
# 24, but distro builds vary — and if the distro's own Node can do it, that's the
# better answer: security updates arrive through apt, with no third-party repo on
# a machine that sits powered on for years.
has_sqlite() { command -v node >/dev/null && node -e 'require("node:sqlite")' >/dev/null 2>&1; }
node_ok()    { has_sqlite && command -v npm >/dev/null; }

if has_sqlite && ! command -v npm >/dev/null; then
  echo "    $(node --version) can do node:sqlite; installing npm alongside it"
  sudo apt-get install -y npm || true
fi

if ! node_ok; then
  echo "    installing Node ${NODE_MAJOR} from NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# Verify rather than assume. If apt can't read the NodeSource repo it silently
# leaves the distro's Node in place, and the first symptom used to be
# "npm: command not found" several steps later, which points nowhere useful.
if ! node_ok; then
  cat <<EOF

This needs a Node that can load node:sqlite unflagged, plus npm.

  node:     $(node --version 2>/dev/null || echo "not installed")
  npm:      $(npm --version 2>/dev/null || echo "not installed")
  sqlite:   $(has_sqlite && echo "available" || echo "NOT available")

Node ${NODE_MAJOR} from NodeSource satisfies this. If it didn't install, apt
probably couldn't read the NodeSource repository. Worth checking, in order:

  sudo apt update                 # any Err: or E: lines?
  apt-cache policy nodejs         # which repos offer it, at what versions?
  ls /etc/apt/sources.list.d/     # is nodesource listed at all?

Fix whatever that turns up and re-run this script.
EOF
  exit 1
fi
echo "    $(node --version), npm $(npm --version) — node:sqlite available"

step "Browser"
if ! command -v chromium-browser >/dev/null && ! command -v chromium >/dev/null; then
  # On 22.04+ the apt package is a transitional shim for the snap. That works
  # fine here — the kiosk profile lives under $HOME, so confinement isn't a problem.
  sudo apt-get install -y chromium-browser || sudo apt-get install -y chromium
fi

# ── App ─────────────────────────────────────────────────────────────────────
step "Dependencies"
cd "$REPO_DIR"
npm ci --omit=dev

step "Runtime directories"
# data/ holds the SQLite library (plus its WAL sidecars); media/ holds the banks.
# Both are gitignored device state, so `git pull` never fights with them. The
# .example JSON files are reference only — the database is created on first run,
# and any pre-SQLite vibes.json / media-config.json is imported automatically.
mkdir -p data media
echo "    data/ media/"

# ── Server on boot ──────────────────────────────────────────────────────────
step "systemd service"
sed -e "s|__USER__|$USER_NAME|g" -e "s|__DIR__|$REPO_DIR|g" \
  deploy/studio-monitor.service | sudo tee /etc/systemd/system/studio-monitor.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now studio-monitor
sleep 2
systemctl is-active --quiet studio-monitor \
  && echo "    running" \
  || { echo "    FAILED — journalctl -u studio-monitor -n 50"; exit 1; }

# Let update.sh restart the service over SSH without a password prompt. sudo matches
# on the resolved binary path, and systemctl lives in /usr/bin on merged-usr Ubuntu
# but is reached via /bin on older layouts — so allow both.
sudo tee /etc/sudoers.d/studio-monitor >/dev/null <<EOF
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/systemctl restart studio-monitor
$USER_NAME ALL=(root) NOPASSWD: /bin/systemctl restart studio-monitor
EOF
sudo chmod 0440 /etc/sudoers.d/studio-monitor
# A malformed sudoers file locks you out of sudo entirely — verify before trusting it.
sudo visudo -cf /etc/sudoers.d/studio-monitor >/dev/null \
  || { echo "    sudoers check FAILED, removing"; sudo rm -f /etc/sudoers.d/studio-monitor; }

# ── Kiosk on login ──────────────────────────────────────────────────────────
step "Kiosk autostart"
chmod +x deploy/kiosk.sh deploy/update.sh deploy/doctor.sh
mkdir -p "$HOME/.config/autostart"
sed -e "s|__DIR__|$REPO_DIR|g" \
  deploy/studio-kiosk.desktop > "$HOME/.config/autostart/studio-kiosk.desktop"

# Verify rather than assume. This is the one step whose failure is silent on the
# wall: the box still boots, logs in and rotates the panel, and simply never
# launches a browser — which looks like a browser problem and isn't one.
KIOSK_EXEC="$(sed -n 's/^Exec=//p' "$HOME/.config/autostart/studio-kiosk.desktop" | head -1)"
if [ -x "${KIOSK_EXEC%% *}" ]; then
  echo "    $HOME/.config/autostart/studio-kiosk.desktop → $KIOSK_EXEC"
else
  echo "    FAILED to write a usable autostart entry (Exec=$KIOSK_EXEC)" >&2
  exit 1
fi

# ── Auto-login ──────────────────────────────────────────────────────────────
step "LightDM auto-login"
# Without this the wall sits on a login prompt after a power cut.
sudo mkdir -p /etc/lightdm/lightdm.conf.d
printf '[Seat:*]\nautologin-user=%s\nautologin-user-timeout=0\n' "$USER_NAME" \
  | sudo tee /etc/lightdm/lightdm.conf.d/60-studio-autologin.conf >/dev/null
sudo groupadd -f autologin
sudo gpasswd -a "$USER_NAME" autologin >/dev/null

# ── Done ────────────────────────────────────────────────────────────────────
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

────────────────────────────────────────────────────────────
Installed.

  Display   http://localhost:3000        (this machine, kiosk)
  Admin     http://${IP:-<this-ip>}:3000/admin   (from your phone)

Reboot to check the whole chain comes up unattended:

  sudo reboot

If the image is upside down, flip the rotation:

  STUDIO_ROTATE=right ./deploy/kiosk.sh

then set the same value in ~/.config/autostart/studio-kiosk.desktop.

Updating later:

  cd $REPO_DIR && ./deploy/update.sh --kiosk

If anything doesn't come up after that reboot, ask what broke rather than
guessing — it checks the whole chain and repairs the autostart entry:

  cd $REPO_DIR && ./deploy/doctor.sh

Logs:

  journalctl -u studio-monitor -f
  tail -f ${XDG_STATE_HOME:-\$HOME/.local/state}/studio-kiosk.log
────────────────────────────────────────────────────────────
EOF
