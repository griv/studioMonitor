# Deploying to the studio box

Target: an ASUS GR6 mini PC running **Xubuntu**, driving a 1080×1920 portrait
monitor. Xubuntu gives us X11 + LightDM + XFCE, which is the easy path here —
`xrandr` handles rotation and LightDM handles auto-login.

## First install

### 1. Clone and install

The repo is public, so the box needs no credentials — nothing to expire or lose on
a machine you'll rarely log into.

```sh
sudo apt update && sudo apt install -y git
git clone https://github.com/griv/studioMonitor.git ~/studioMonitor
cd ~/studioMonitor
./deploy/install.sh          # as your normal user, NOT with sudo
```

### 2. Get the media across

`media/` is gitignored, so the clone arrives empty. Bulk-copy it once from the Mac:

```sh
rsync -av --progress ~/Projects/studioMonitor/media/ steve@<gr6-ip>:~/studioMonitor/media/
```

The watcher picks the files up within a second and the scan indexes them — no
restart needed. After this, adding work is drag-and-drop in the admin page.

The database is not copied. It's device state, and it rebuilds itself from whatever
is on disk; only hand-typed attribution is worth carrying over, via `/api/export`.

### 3. Reboot — that's the actual test

```sh
sudo reboot
```

The box should go: power on → auto-login → XFCE session → portrait rotation →
kiosk browser on the slideshow, with no keyboard touched. Everything before the
reboot only proves the pieces install.

Then, from your phone on the same network: `http://<gr6-ip>:3000/admin`.

`install.sh` is idempotent — safe to re-run after a config change.

### `file:/cdrom ... no longer has a Release file`

The installer's CD-ROM entry, left in apt's sources after a desktop install. It has
nothing to do with this project, but it makes `apt-get update` exit non-zero. Find
and disable it:

```sh
grep -rn cdrom /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null
```

If it's a `deb cdrom:` line in `sources.list`, comment it out. If it's a `.sources`
file in `sources.list.d/`, add `Enabled: no` to the stanza or delete the file. Then
`sudo apt update` should come back clean.

### If the install fails

Almost always Node. The requirement is a capability, not a version: `node:sqlite`
has to load without a flag. Check directly:

```sh
node -e 'require("node:sqlite"); console.log("ok")'
which npm
```

If that prints `ok`, the distro's Node is fine and `install.sh` will use it —
which is the better outcome, since security updates then arrive through apt with
no third-party repository on a machine that runs for years. Ubuntu's package
sometimes omits npm; the installer adds it.

If it fails, the installer falls back to Node 24 from NodeSource. When *that*
doesn't take, apt couldn't read the repository — check in this order:

```sh
sudo apt update                 # any Err: or E: lines?
apt-cache policy nodejs         # which repos offer it, at what versions?
ls /etc/apt/sources.list.d/     # is nodesource listed at all?
```

Node 20 and earlier can't do this at all, and no flag helps — `node:sqlite`
simply isn't there.

## What it sets up

| | |
|---|---|
| Node.js | The distro's own, if it can load `node:sqlite`; otherwise NodeSource |
| `studio-monitor.service` | The server, `Restart=always`, enabled at boot |
| `~/.config/autostart/studio-kiosk.desktop` | Launches `kiosk.sh` with the XFCE session |
| LightDM auto-login | So a power cut doesn't leave the wall on a login prompt |
| `/etc/sudoers.d/studio-monitor` | Lets `update.sh` restart the service without a password |

The installer verifies the autostart entry before reporting success — it's the
one step whose failure is silent on the wall, since the box still boots, logs in
and rotates while never launching a browser.

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
explicitly if the box has more than one plugged in), `STUDIO_URL`, and
`STUDIO_PROFILE` (the browser profile directory — see the snap note below before
moving it).

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

Start here rather than guessing. It walks the whole chain — server, browser,
autostart entry, auto-login, X session — and names the broken link:

```sh
cd ~/studioMonitor && ./deploy/doctor.sh
./deploy/doctor.sh --repair     # also fixes what lives in $HOME
```

It works over SSH; the checks that need a display are skipped rather than
reported as failures. `--repair` rewrites the autostart entry and makes the
scripts executable, but deliberately won't install a systemd unit or touch
LightDM — if those are missing the answer is to re-run `install.sh`, and quietly
half-installing from here would hide that.

### The rotation is right but no browser appears

The most common shape of this, and the most misleading: the panel is portrait,
so the session is clearly starting, yet nothing launches. The rotation is *not*
evidence that `kiosk.sh` ran — XFCE persists display settings itself, so the
panel comes up rotated whether or not anything else did.

`install.sh` writes the autostart entry near the end, after Node, `npm ci` and
the systemd unit. Anything that aborts it earlier leaves a box that boots, logs
in and rotates, and never launches a browser. Check for the entry directly:

```sh
ls -l ~/.config/autostart/studio-kiosk.desktop
```

`doctor.sh --repair` writes it without re-running the whole install. Other ways
this same symptom shows up, all of which `doctor.sh` names: an `Exec=` line
still containing a literal `__DIR__`, an `Exec=` pointing at a checkout that has
since moved, or `Hidden=true` — which is what XFCE's *Session and Startup* adds
when the entry is unchecked there, leaving a file that looks perfectly correct
while doing nothing.

### The browser restarts every 3 seconds

```
Failed to create ~/.config/studio-kiosk/SingletonLock: Permission denied (13)
Failed to create a ProcessSingleton for your profile directory. Aborting now.
```

Snap confinement. On 22.04+ `chromium-browser` is a transitional package for the
snap, and snap's `home` interface grants `@{HOME}/[^.]**` — **non-hidden paths
only**. A profile anywhere under a dotdir can't be locked, and chromium aborts
rather than risk corrupting it, so `kiosk.sh` faithfully restarts it forever.

The permission is not a Unix permission and `chmod` won't touch it: the
directory is yours and the denial comes from AppArmor.

`kiosk.sh` therefore keeps the profile at `~/studio-kiosk`, without the dot,
which works for the snap and the `.deb` alike. If you override `STUDIO_PROFILE`,
keep it out of a hidden directory. The old `~/.config/studio-kiosk` is orphaned
after this change and can be deleted.

### Logs

```sh
systemctl status studio-monitor      # is the server up
journalctl -u studio-monitor -f      # server logs
tail -f ~/.local/state/studio-kiosk.log   # rotation, server wait, browser restarts
curl -s localhost:3000/api/status    # what it thinks it's playing
xrandr --query                       # output names and current rotation
```

`kiosk.sh` writes to `~/.local/state/studio-kiosk.log` (`$XDG_STATE_HOME` if set),
capturing the browser's stderr as well as its own. An autostart entry's stdout
goes nowhere in particular, which is precisely why a browser that never launched
used to leave no trace. Run by hand it prints to the terminal as well.

To get a normal desktop back for debugging, kill the browser — but note the
loop in `kiosk.sh` will restart it in 3s. Rename the autostart entry and log out
instead:

```sh
mv ~/.config/autostart/studio-kiosk.desktop{,.off}
```
