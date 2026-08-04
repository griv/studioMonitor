# Deploying to the studio box

Target: an ASUS GR6 mini PC running **Xubuntu**, driving a 1080×1920 portrait
monitor. Xubuntu gives us X11 + LightDM + XFCE, which is the easy path here —
`xrandr` handles rotation and LightDM handles auto-login.

## First install

```sh
git clone https://github.com/griv/studioMonitor.git
cd studioMonitor
./deploy/install.sh          # as your normal user, NOT with sudo
sudo reboot
```

After the reboot the box should go: power on → auto-login → XFCE session →
portrait rotation → kiosk browser on the slideshow, with no keyboard touched.
The reboot is the actual test; everything before it only proves the pieces
install.

`install.sh` is idempotent — safe to re-run after a config change.

## What it sets up

| | |
|---|---|
| Node.js | Current LTS from NodeSource (Ubuntu's own package is usually too old) |
| `studio-monitor.service` | The server, `Restart=always`, enabled at boot |
| `~/.config/autostart/studio-kiosk.desktop` | Launches `kiosk.sh` with the XFCE session |
| LightDM auto-login | So a power cut doesn't leave the wall on a login prompt |
| `/etc/sudoers.d/studio-monitor` | Lets `update.sh` restart the service without a password |

The two layers are deliberately separate: the **server** is a systemd service
that comes up with the machine, and the **browser** is a session process that
comes up with the desktop. The server doesn't need X, and the kiosk waits up to
60s for the server before launching, so boot order doesn't matter.

## Updating

```sh
cd ~/studioMonitor
./deploy/update.sh           # server-side changes
./deploy/update.sh --kiosk   # also reload the browser, for public/*.html changes
```

Run it over SSH from the studio Mac — no need to touch the box.

It pulls with `--ff-only`, so if the checkout has diverged it stops rather than
opening a merge you'd have to resolve on a machine with no keyboard attached.

A server restart alone is enough for back-end changes: the display's SSE stream
drops, reconnects within ~3s and re-fetches state. Front-end changes need the
browser to reload the page, hence `--kiosk`.

### Why `vibes.json` and `media-config.json` are gitignored

They're rewritten by the admin UI, so tracking them would mean every `git pull`
on the box hits "your local changes would be overwritten" — exactly when you're
least able to deal with it. `install.sh` seeds them from the `.example` files
once and then leaves them alone.

The tradeoff: they're device-local and not backed up. See the note on the data
store in [TODO.md](../TODO.md).

## Rotation

`kiosk.sh` rotates the first connected output `left`. If the image is upside
down, flip it:

```sh
STUDIO_ROTATE=right ./deploy/kiosk.sh
```

and put the same value in the `Exec=` line of
`~/.config/autostart/studio-kiosk.desktop`, or export it from `~/.profile`.

Other knobs: `STUDIO_OUTPUT` (defaults to the first connected output — set it
explicitly if the box has more than one plugged in) and `STUDIO_URL`.

**If rotation fails**, it's almost always the graphics driver. The GR6 has a
discrete NVIDIA GPU, and the proprietary driver doesn't always expose RandR
rotation the way `xrandr` expects. Two ways out: use the open `nouveau` driver,
which handles a single 1080p output fine and rotates cleanly, or set the
rotation in `nvidia-settings` and write it into `/etc/X11/xorg.conf`
(`Option "Rotate" "left"` in the Device section) instead of doing it per-session.

## Performance

This is decade-old hardware being asked to composite a full-screen 28px blur
(the `blur-bg` fit) and animate transforms at 1080×1920. It should be fine with
working GPU acceleration and painful without it.

Check `chrome://gpu` — if it says software rendering, try adding
`--ignore-gpu-blocklist --enable-gpu-rasterization` to the flags in `kiosk.sh`.
If it's still heavy, `contain` and `cover` cost almost nothing; `blur-bg` and
`ken-burns` are the expensive ones.

The 61 MB phone video in `media/` is also worth transcoding — see the ingest
section of [TODO.md](../TODO.md).

## Troubleshooting

```sh
systemctl status studio-monitor      # is the server up
journalctl -u studio-monitor -f      # server logs
curl -s localhost:3000/api/status    # what it thinks it's playing
xrandr --query                       # output names and current rotation
```

Kiosk output goes to the X session log, `~/.xsession-errors`, prefixed `[kiosk]`.

To get a normal desktop back for debugging, kill the browser — but note the
loop in `kiosk.sh` will restart it in 3s. Rename the autostart entry and log out
instead:

```sh
mv ~/.config/autostart/studio-kiosk.desktop{,.off}
```
