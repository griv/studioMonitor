# Studio Monitor

A self-hosted slideshow for a wall-mounted display in the studio — a portrait
**1080×1920** monitor showing my own work alongside work I'm inspired by.

A small Express server watches a media directory, holds the current playlist in memory,
and pushes it to the display over Server-Sent Events. The display is a single full-screen
page with no controls; everything is driven from a phone, either through the admin page or
through Home Assistant.

```
  phone ──▶ /admin ──┐
                     ├──▶ server.js ──SSE──▶ / (display on the wall)
  Home Assistant ────┘         │
                               └── watches media/ for changes
```

## Running it

```sh
npm install
npm start
```

| | |
|---|---|
| Display | http://localhost:3000 |
| Admin | http://localhost:3000/admin |

Environment: `PORT` (default `3000`), `MEDIA_DIR` (default `./media`).

The server binds `0.0.0.0` and has **no authentication** — that's what makes the Home
Assistant integration a two-line `rest_command`. It assumes a trusted LAN. Don't port-forward it.

## Concepts

### Banks

A bank is just a directory under `media/`. Drop files in, they appear — a `chokidar` watcher
picks up changes and re-broadcasts to the display without a restart.

```
media/
  invisibleOutfields/     ← a bank
    IMG_1720_edit.jpg.webp
    IMG_1694.mov
  inspiration/            ← another bank
```

Supported: `jpg` `jpeg` `png` `webp` `gif` `mp4` `mov` `webm`. Dotfiles are skipped.
Uploads through the admin page are capped at 500 MB per file.

Media is gitignored — it's content, not code.

### Vibes

A vibe is a named preset combining one or more banks with their own playback settings.
Defined in [`vibes.json`](vibes.json):

```json
{
  "vibes": [
    {
      "name": "studio",
      "banks": ["invisibleOutfields"],
      "dwellTime": 8000,
      "transitionDuration": 2000,
      "shuffle": false,
      "defaultFit": "contain"
    }
  ]
}
```

Selecting a vibe loads every enabled item from all its banks and applies its settings.
Everything except `name` and `banks` is optional and falls back to the current session settings.

> The fit key is **`defaultFit`**, not `objectFit`. The admin UI writes the right one;
> hand-edited files sometimes don't, and the wrong key fails silently.

### Fits

How an item fills the frame. This matters more than it sounds in portrait — at `contain`,
a 3:2 landscape photo covers barely a third of a 1080×1920 screen.

| Fit | Behaviour |
|---|---|
| `blur-bg` | Blurred, darkened copy fills the frame; the image sits contained on top. Best default for mixed-aspect content in portrait. |
| `contain` | Whole image, letterboxed. |
| `cover` | Fills the frame, centre-cropped. |
| `ken-burns` | Slow zoom/drift over a cover-cropped image, timed to the dwell duration. |

Resolved most-specific-first: **per item → bank default → session setting → `contain`**.

### Playback

Images advance after `dwellTime` (default 8 s), cross-fading over `transitionDuration`
(default 2 s). Videos play muted and advance when they end, with a 90 s fallback. A broken
file skips itself rather than stalling the wall. The bank/vibe name appears briefly on each
change, then fades out — nothing static is left burning into the panel.

## Admin

Phone-first, at `/admin`.

- Switch bank or vibe; live "now playing" status over SSE
- Toggle individual items in or out of rotation
- Cycle per-item fit, or set a bank-wide default
- Drag-and-drop upload, including onto a new bank
- Create and edit vibes — pick banks, set dwell, transition, shuffle, fit

Item state written here lands in [`media-config.json`](media-config.json):

```json
{
  "banks": {
    "invisibleOutfields": {
      "defaultFit": "blur-bg",
      "items": { "IMG_1694.mov": { "enabled": true, "fit": "cover" } }
    }
  }
}
```

Items are enabled unless explicitly set to `false`, so the file only records deviations
from the default — an untouched bank has no entry at all.

## API

Enough surface to drive everything from Home Assistant or `curl`.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/events` | SSE stream; emits `state` on every change |
| `GET` | `/api/status` | Current state snapshot |
| `GET` | `/api/banks` | Banks with all items, including disabled ones |
| `GET`&nbsp;/&nbsp;`PUT` | `/api/vibes` | Read / replace `vibes.json` |
| `GET`&nbsp;/&nbsp;`PUT` | `/api/config` | Read / replace `media-config.json` |
| `POST` | `/api/bank/:name` | Play a bank |
| `POST` | `/api/vibe/:name` | Play a vibe |
| `POST` | `/api/settings` | Patch `dwellTime`, `transitionDuration`, `shuffle`, `objectFit` |
| `POST` | `/api/upload/:bank` | Multipart upload, field `files`; creates the bank if new |

```sh
curl -X POST http://studio:3000/api/vibe/studio
curl -X POST http://studio:3000/api/settings \
  -H 'Content-Type: application/json' -d '{"dwellTime": 15000}'
```

State lives in memory only — a restart falls back to the first bank alphabetically.

## Deployment

The wall runs on an ASUS GR6 mini PC under Xubuntu. Clone, install, reboot:

```sh
git clone https://github.com/griv/studioMonitor.git
cd studioMonitor
./deploy/install.sh    # as your normal user, not with sudo
sudo reboot
```

That installs Node, the systemd service, the portrait kiosk autostart and LightDM
auto-login — so the box goes from power-on to slideshow with nothing attached. Updates
afterwards are `./deploy/update.sh` over SSH.

Full setup, rotation, driver caveats and troubleshooting: **[deploy/README.md](deploy/README.md)**.

[`home-assistant.yaml`](home-assistant.yaml) has copy-paste `rest_command`, `input_select`
and automation snippets that turn bank and vibe switching into dropdowns on a dashboard.
Set `UBUNTU_IP` to the server's address.

## Layout

| | |
|---|---|
| [`server.js`](server.js) | Express server, SSE broadcast, file watcher, upload handling |
| [`public/index.html`](public/index.html) | The display — slide building, transitions, Ken Burns |
| [`public/admin.html`](public/admin.html) | Admin UI |
| [`deploy/`](deploy/) | systemd unit, kiosk script, install and update scripts |
| `vibes.json` | Vibe definitions — device state, gitignored, seeded from `vibes.example.json` |
| `media-config.json` | Per-item enable/fit state — same, from `media-config.example.json` |
| [`media/`](media/) | Banks — gitignored |

`vibes.json` and `media-config.json` are rewritten by the admin UI, so they're kept out of
git; otherwise every `git pull` on the display machine collides with them.

Planned work and known rough edges: [TODO.md](TODO.md).
