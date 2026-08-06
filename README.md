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

Needs a Node that can load **`node:sqlite`** without a flag — that's where the library
lives. In practice: **22.5 or newer**, though 22.x prints an experimental warning on
startup and 24+ doesn't. Verified on both. There's an `.nvmrc` pinning 24 for development.

```sh
nvm use
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

Everything the filesystem doesn't say — which items are enabled, what fits them, who made
them — lives in `data/studio.db`. The filesystem stays the source of truth for what media
*exists*; the database only annotates it, and reconciles on boot and on every change.

### Vibes

A vibe is a named preset combining one or more **sources** with its own playback settings.
A source is a bank, a group of banks, or an artist:

```json
{
  "name": "studio",
  "sources": [
    { "type": "group",  "value": "inspiration" },
    { "type": "bank",   "value": "invisibleOutfields" },
    { "type": "artist", "value": "Agnes Martin" }
  ],
  "dwellTime": 8000,
  "transitionDuration": 2000,
  "videoCrossfadeMs": 1500,
  "shuffle": false,
  "defaultFit": "contain"
}
```

Sources resolve in order and are deduplicated by item, so a bank named directly *and*
reached through a group contributes once. An artist source matches across every bank,
including items that inherit the artist from their bank's default.

Everything except `name` and `sources` is optional and falls back to the session settings.
A source whose target no longer exists resolves to nothing and is reported as unresolved —
it never makes a vibe unplayable.

### Attribution

Each item carries `title`, `artist`, `year`, `medium` and `source` (a URL, stored but never
shown on the wall). Banks carry defaults for the same fields, which items inherit unless
they set their own — useful when a whole bank is one artist.

The distinction matters in two directions: the display resolves to the effective value,
while the admin editor shows the item's own value, so an empty field reads as "inheriting"
rather than baking the bank default in the first time you save.

### Fits

How an item fills the frame. This matters more than it sounds in portrait — at `contain`,
a 3:2 landscape photo covers barely a third of a 1080×1920 screen.

| Fit | Behaviour |
|---|---|
| `blur-bg` | Blurred, darkened copy fills the frame; the image sits contained on top. Best default for mixed-aspect content in portrait. |
| `contain` | Whole image, letterboxed. |
| `cover` | Fills the frame, centre-cropped. |
| `cover-random` | Fills the frame, cropped from a random offset that changes each time the piece comes round — so a photo that has to lose something doesn't lose the same thing every time. |
| `ken-burns` | Slow zoom/drift over a cover-cropped image, timed to the dwell duration — or, on a video, to the length of the clip. |

Resolved most-specific-first: **per item → bank default → session setting → `contain`**.

The offset for `cover-random` lands between 15% and 85% on both axes, never hard
against an edge — past that it stops reading as a crop and starts reading as a
mistake. Only the axis that actually overflows can move, so a landscape photo in
a portrait frame shifts sideways and ignores the vertical component entirely. An
item with an explicit `objectPosition` keeps it: that's a decision someone made
about that piece, and random is for the ones where nobody has.

### Playback

Images advance after `dwellTime` (default 8 s), cross-fading over `transitionDuration`
(default 2 s). A broken file skips itself rather than stalling the wall.

### Order

`shuffle` picks between **sequential** and **random**. Random plays a shuffled pass
over the whole collection and then reshuffles for the next one, so every piece gets
a turn before any piece gets a second, and no piece opens a pass having just closed
the previous one.

Picking independently at random each slide would be simpler and worse: with seven
items you'd see a repeat within three slides about half the time, which reads as the
wall being stuck rather than as randomness.

The order lives in the display, not in `mediaList` — the server keeps that in stable
library order so it can match items across a rescan. Shuffling once at selection time,
which is what this replaced, did cover the bank before repeating and then repeated
that same sequence for as long as the bank stayed up.

Videos play muted and run to their own length — `dwellTime` has nothing to say about how
long a clip is, at any fit. The crossfade out of one starts `videoCrossfadeMs` (default
1.5 s) *before* the clip ends, so the picture is still moving as the next piece comes up
underneath it; waiting for the end instead leaves the last frame frozen on the wall for
the length of the fade, which reads as a stall rather than a transition. That one number
is both the fade length and the head start, because for a video they are necessarily the
same thing. Set it to `0` to wait for the last frame.

The schedule is recomputed as the clip plays rather than fixed once from its duration, so
buffering or a slow decode moves the fade with it. A clip shorter than the crossfade gives
up at most half its length. `ended` and a 90 s stall timer remain as fallbacks for a video
that never reports a duration.

### Captions

Bottom of the frame, over a gradient scrim, sized for a 1080×1920 panel read from across a
room — roughly 28 px for the headline, not the 10 px a laptop would suggest. Emphasis
follows the bank's kind: `inspiration` credits the artist first, `mine` leads with the title.

| Mode | Behaviour |
|---|---|
| `collection` | Appears when the bank or vibe changes, holds, fades. The default — the wall stays pure image. |
| `item` | Appears for every piece. Its hold is clamped to `dwellTime - 1.5 s`, or it never clears and quietly becomes `always`. |
| `always` | Permanently on screen. For an opening or a visitor, not for every day. |

`POST /api/caption/reveal` — the **Caption** button in the admin header — flashes the
caption for whatever is on the wall right now, without changing the mode. With
`collection` as the default, that's the answer to "I like that, what is it?"

Every few minutes the whole frame, caption included, shifts a few pixels. It's invisible in
motion and it's the cheap half of burn-in mitigation; the other half is not leaving
`always` on all day.

## Admin

Phone-first, at `/admin`.

- Switch bank or vibe; live "now playing" status over SSE
- Toggle individual items in or out of rotation
- Cycle per-item fit, or set a bank-wide default
- Drag-and-drop upload, including onto a new bank
- Create and edit vibes — pick banks, set dwell, transition, shuffle, fit

Every edit is a PATCH of just the field that changed, so two tabs — or a phone and a
laptop — no longer overwrite each other's work.

## API

Enough surface to drive everything from Home Assistant or `curl`.

**Playback** — these are the Home Assistant contract and key on *name*:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/events` | SSE stream; emits `state` on every change |
| `GET` | `/api/status` | Current state snapshot |
| `POST` | `/api/bank/:name` | Play a bank |
| `POST` | `/api/vibe/:name` | Play a vibe |
| `POST` | `/api/settings` | Patch `dwellTime`, `transitionDuration`, `videoCrossfadeMs`, `shuffle`, `objectFit`, `captionMode`, `captionHoldMs` |

**Library** — these key on *id*, so renaming isn't a delete-and-recreate:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/banks` | Banks with all items, including disabled ones |
| `PATCH` | `/api/items/:id` | Partial: `enabled`, `fit`, `objectPosition`, `title`, `artist`, `year`, `medium`, `source` |
| `PATCH` | `/api/banks/:name` | Partial: `kind`, `defaultFit`, `default{Artist,Year,Medium,Source}`, `captionMode` |
| `GET` | `/api/artists` | Distinct artists with counts |
| `GET` `POST` `PATCH` `DELETE` | `/api/vibes[/:id]` | Vibe CRUD; PATCH may replace `sources` |
| `GET` `POST` `PATCH` `DELETE` | `/api/groups[/:id]` | Group CRUD |
| `POST` | `/api/resolve/preview` | `{sources}` → `{count, unresolved}`, for a live count while editing |
| `POST` | `/api/upload/:bank` | Multipart upload, field `files`; creates the bank if new |
| `GET` | `/api/export` | The whole library as JSON — back this up |

```sh
curl -X POST http://studio:3000/api/vibe/studio
curl -X POST http://studio:3000/api/settings \
  -H 'Content-Type: application/json' -d '{"dwellTime": 15000}'
curl -X PATCH http://studio:3000/api/items/42 \
  -H 'Content-Type: application/json' -d '{"artist": "Agnes Martin", "year": "1973"}'
```

Unknown keys are ignored — a slightly stale client shouldn't fail — but bad values for
known keys are rejected with a reason.

Every mutating response carries the resulting `libraryVersion`, which also rides in the SSE
state. That's how a client tells its own write apart from someone else's and knows when its
cached view has gone stale.

Playback position lives in memory only — a restart falls back to the first bank
alphabetically.

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
| [`lib/`](lib/) | `db` · `schema` · `scan` (reconciliation) · `library` · `resolve` · `validate` |
| [`deploy/`](deploy/) | systemd unit, kiosk script, install and update scripts |
| `data/studio.db` | The library — device state, gitignored |
| [`media/`](media/) | Banks — gitignored |

`data/` and `media/` are device state and stay out of git, so `git pull` on the display
machine never collides with them. Any pre-SQLite `vibes.json` / `media-config.json` is
imported automatically on first run and renamed to `.migrated`.

**Back up `data/`.** The media can be re-copied from anywhere; hand-typed attribution
can't. `GET /api/export` dumps the lot as JSON.

Planned work and known rough edges: [TODO.md](TODO.md).
