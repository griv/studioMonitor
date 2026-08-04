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
NODE_MAJOR=22

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as your normal user, not with sudo." >&2
  exit 1
fi

step() { echo; echo "==> $*"; }

# ── Packages ────────────────────────────────────────────────────────────────
step "Base packages"
sudo apt-get update -qq
sudo apt-get install -y curl git ca-certificates unclutter x11-xserver-utils

step "Node.js"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  # Ubuntu's packaged node is usually too old; NodeSource tracks current LTS.
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "    $(node --version) at $(command -v node)"

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

step "Runtime config"
# These are gitignored device state; seed them once, then leave them alone so
# `git pull` never fights with what the admin UI has written.
for f in vibes media-config; do
  if [ -f "$f.json" ]; then
    echo "    $f.json exists, leaving it"
  else
    cp "$f.example.json" "$f.json"
    echo "    seeded $f.json"
  fi
done
mkdir -p media

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
chmod +x deploy/kiosk.sh deploy/update.sh
mkdir -p "$HOME/.config/autostart"
sed -e "s|__DIR__|$REPO_DIR|g" \
  deploy/studio-kiosk.desktop > "$HOME/.config/autostart/studio-kiosk.desktop"
echo "    $HOME/.config/autostart/studio-kiosk.desktop"

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

Logs:

  journalctl -u studio-monitor -f
────────────────────────────────────────────────────────────
EOF
