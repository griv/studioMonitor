# Studio Monitor — TODO

**Target:** a portrait 1080×1920 monitor mounted in the studio, running continuously,
showing (a) my own work and (b) work I'm inspired by. Controlled from my phone.

Ordered roughly by how much each unblocks that goal.

---

## 1. Portrait-first display

The display CSS is orientation-agnostic, so it *works* at 1080×1920 — but the defaults
were chosen for landscape and look wrong in a 9:16 frame.

- [ ] **Make `blur-bg` the real default.** At `contain`, a 3:2 landscape photo fills only
      ~37% of a 1080×1920 screen — two thirds of the wall is black bars. `blur-bg` is the
      only fit that reads well for mixed-aspect content in portrait.
- [ ] **Fix the `studio` vibe's stale key.** [vibes.json](vibes.json) sets `objectFit`,
      but the server ([server.js:218](server.js#L218)) and admin UI both read `defaultFit`
      — so that `contain` setting does nothing right now. One-word fix.
- [ ] **Orientation-aware Ken Burns.** The current keyframes
      ([index.html:62-67](public/index.html#L62-L67)) are zoom + *vertical* drift. On a
      portrait screen a landscape source is cropped hard on the sides — a slow *horizontal*
      pan reveals the composition instead of hiding it. Pick the pan axis from the image's
      aspect ratio vs. the viewport's.
- [ ] **Per-item focal point.** For portraits/tall crops, `cover` centre-crops and cuts
      heads off. Add an `objectPosition` (e.g. `50% 30%`) to the per-item config, settable
      from the admin thumbnail.
- [ ] Verify the admin UI is usable one-handed on a phone — it's the primary remote.

## 2. Attribution — needed before showing anyone else's work

Right now the only on-screen text is the bank/vibe name
([index.html:249](public/index.html#L249)). If the wall is showing work that inspires me,
it needs to credit whoever made it — both as basic courtesy and so I remember who it was.

- [ ] **Per-item metadata:** `title`, `artist`, `year`, `source` (URL). `media-config.json`
      already has a per-item slot (`banks[bank].items[file]`) — extend it there.
- [ ] **Caption rendering** on the display: discreet, bottom-aligned, fades like the
      existing label. Show artist prominently for inspiration; title-only for my own work.
- [ ] **Mark banks as `mine` vs `inspiration`** so the caption style can differ, and so a
      vibe can't accidentally mix them when I don't want it to.
- [ ] **Capture provenance at upload time.** A source URL typed months later is a source URL
      never typed. Prompt for it in the drop-zone flow.

## 3. Transport controls

There are none — no pause, no skip, no back. For a studio wall this is the thing I'll want
most: something good comes up and I want to hold it, or a dud appears and I want it gone.

- [ ] `POST /api/next`, `/api/prev`, `/api/pause` (toggle) driving the display over SSE.
- [ ] Big tap targets for them in the admin header, above the fold.
- [ ] **"Hold this"** — pin the current item indefinitely until unpinned.
- [ ] **"Not this one"** — disable the current item from the display, one tap, no hunting
      for it in the bank grid.

## 4. Always-on reliability

It's a device on a wall, not a page I'm babysitting. Failures need to be self-healing.

- [ ] **Persist state across restarts.** State is in-memory
      ([server.js:76](server.js#L76)); a reboot drops back to whichever bank sorts first
      ([server.js:243](server.js#L243)). Write last mode/bank/vibe to disk, restore on boot.
- [ ] **SSE heartbeat.** No keepalive is sent, so an idle connection can be dropped silently
      without firing `onerror` — the display then sits on stale state forever. Send a
      `:ping` comment every ~20 s, and have the client reload if it hears nothing for ~60 s.
- [x] **Debounce the file watcher** — 500 ms trailing edge. Verified: 5 simultaneous files
      now produce one broadcast, not five.
- [x] **Stop reshuffling on every file event.** `refreshMediaList` reshuffled the whole list
      on every chokidar event, so each file touch — and attribution editing is write-heavy —
      jumped the wall back to the start in a new random order. Surviving items now keep
      their position and new ones are appended.
- [ ] **Stop restarting the slideshow on every change** (client half). `applyState`
      ([index.html:260](public/index.html#L260)) resets to index 0 whenever the media list
      differs. Metadata-only edits no longer change it, but an upload still restarts the
      show. Preserve position where the current item still exists.
- [ ] Client-side watchdog: if no slide has advanced in ~5 min, reload the page.

## 5. Kiosk / deployment

Target box: ASUS GR6 mini PC, Xubuntu. See [deploy/README.md](deploy/README.md).

- [x] systemd unit with real values, rendered by `deploy/install.sh`.
- [x] Kiosk autostart: portrait rotation, blanking disabled, browser relaunched if it
      dies, LightDM auto-login so a power cut doesn't strand the wall on a login prompt.
- [x] `deploy/update.sh` for `git pull` + restart over SSH.
- [ ] **Reboot test.** Everything above is untested on the actual hardware — pull the
      power and confirm it comes back to the slideshow unattended.
- [ ] Fill in `UBUNTU_IP` in [home-assistant.yaml](home-assistant.yaml).
- [ ] Check GPU acceleration on the GR6 (`chrome://gpu`). A full-screen 28px blur at
      1080×1920 on decade-old hardware is fine on the GPU and painful on llvmpipe.
- [ ] **Scheduled on/off** via Home Assistant — dark overnight. Saves the panel and stops
      the studio glowing at 3am.
- [ ] **Burn-in mitigation.** A static image on a panel for hours is the risk case. Cap the
      max dwell time, and consider a few-pixel periodic shift of the whole stage. (The
      auto-hiding label at [index.html:253](public/index.html#L253) already avoids the worst
      offender — persistent static UI.)

## 6. Ingest pipeline

- [ ] **Transcode on upload.** `IMG_1694.mov` is 61 MB straight off a phone; the display
      only ever needs ~1080×1920. Re-encode to H.264, strip the audio track (it's muted
      anyway), cap the bitrate.
- [ ] **Resize/re-encode images** to fit 1080×1920 at upload, keeping an original if I want
      to re-derive later.
- [ ] **Honour EXIF orientation** — phone photos will otherwise show up sideways.
- [ ] **Don't silently overwrite.** Uploads keep `file.originalname` verbatim
      ([server.js:120](server.js#L120)), so a second `IMG_1234.jpg` replaces the first.
      De-duplicate the filename or hash the contents.
- [ ] **Delete from the admin UI.** Currently items can only be disabled, never removed —
      so the disk fills with things I've already rejected.

## 7. Curation

- [ ] **Scheduled vibes** — different content by time of day (quiet in the morning, the
      inspiration wall during working hours).
- [ ] **Better shuffle.** Plain Fisher-Yates on load
      ([server.js:65](server.js#L65)) happily repeats an item soon after itself across
      reshuffles. Track recent history and avoid replaying within N slides.
- [ ] **Recently-shown list** in admin — "what was that one?" is a question I'll ask often,
      and right now there's no way to answer it.
- [ ] Per-item dwell override, so a dense piece can hold longer than a simple one.

## 8. Data store

Now `data/studio.db` (SQLite, WAL) via `node:sqlite` — no dependency, no native build on
the GR6. See [lib/](lib/).

- [x] **Durability.** Superseded rather than patched: `saveJSON` was a bare `writeFileSync`
      and `loadJSON` silently swallowed parse errors, so a power cut mid-write wiped every
      setting with no error anywhere. WAL handles this properly; the atomic-write fix was
      no longer needed.
- [x] **Stop replacing whole documents.** Per-field `PATCH` with validation. Verified two
      concurrent clients editing different items both survive.
- [x] **Move to SQLite** — done early, precisely because there was nothing to migrate.
- [x] **Survive a rename.** Surrogate item id plus a head+tail fingerprint used only to
      match a vanished path to an appeared one, so attribution follows a file across
      renames and across banks. The scanner never deletes — a vanished file gets
      `missing_since` — and refuses to flag anything when over half a bank disappears at
      once, which means an unmounted volume rather than a deletion.
- [ ] **Back up the attribution.** `GET /api/export` dumps the library as JSON; still needs
      a timer writing `data/attribution-backup.json` and something pushing it off-box. Once
      artist data is hand-typed it's the only part of the system that can't be regenerated.
- [ ] **Play history table** for no-repeat shuffle and the recently-shown list (§7).
- [ ] **Persist last played** in `kv` and restore on boot (§4).

## 9. Housekeeping

- [x] **README** — what it is, how to run it, how banks and vibes relate.
- [x] **Validate `:name` on bank/vibe routes**, plus every request body. Unknown keys are
      dropped so a stale client doesn't break; bad values for known keys are rejected with
      a reason.
- [ ] **Decide on network exposure.** The server binds `0.0.0.0` with no auth, which is
      what makes the Home Assistant integration simple — fine on a trusted LAN, but worth a
      conscious decision rather than a default. At minimum, don't port-forward it.
- [ ] Consider git-lfs if I ever want the media itself versioned — it's gitignored today.
