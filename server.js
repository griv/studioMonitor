// The library lives in SQLite via node:sqlite, which is only available unflagged
// from Node 24. Fail here with something readable rather than deep in a require
// on a wall-mounted box whose only output is journalctl.
try {
  require('node:sqlite');
} catch {
  console.error(`Studio Monitor needs a Node that can load node:sqlite unflagged — running ${process.version}.`);
  console.error('It arrived in 22.5 behind --experimental-sqlite and is unflagged from 24.');
  console.error('On the display machine: re-run ./deploy/install.sh. Locally: nvm use.');
  process.exit(1);
}

const express = require('express');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const multer = require('multer');

const db = require('./lib/db');
const { scanLibrary, SUPPORTED } = require('./lib/scan');
const lib = require('./lib/library');
const { resolveSources, preserveOrder } = require('./lib/resolve');
const {
  pick, ValidationError, SAFE_NAME,
  ITEM_SPEC, BANK_SPEC, VIBE_SPEC, GROUP_SPEC, SETTINGS_SPEC,
} = require('./lib/validate');

const PORT = process.env.PORT || 3000;
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, 'media');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'studio.db');

const app = express();
app.use(express.json());

// Every mutating response carries the resulting library version, so the client
// that made the change can recognise the SSE broadcast it just caused and skip
// refetching — otherwise each tap would rebuild the whole thumbnail grid.
app.use((req, res, next) => {
  if (req.method === 'GET') return next();
  const json = res.json.bind(res);
  res.json = body => json(
    body && typeof body === 'object' && !Array.isArray(body)
      ? { ...body, libraryVersion: db.getLibraryVersion() }
      : body);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
// dotfiles: 'deny' keeps media/.trash and any in-flight upload scratch file out of
// the served surface. The scanner already ignores both, so nothing the display can
// reference lives behind a dot.
app.use('/media', express.static(MEDIA_DIR, { dotfiles: 'deny' }));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── State & SSE ───────────────────────────────────────────────────────────────

let state = {
  mode: null,
  currentBank: null,
  currentVibe: null,
  mediaList: [],
  settings: {
    dwellTime: 8000,
    transitionDuration: 2000,
    // Both the fade length and how early it starts, since for a video those are
    // the same number — see the display's scheduleVideoAdvance(). 0 restores the
    // old behaviour of waiting for the clip to end before fading.
    videoCrossfadeMs: 1500,
    shuffle: false,
    objectFit: 'blur-bg',
    captionMode: 'collection',   // consumed by the display in Step 4
    captionHoldMs: 6000,
  },
  libraryVersion: 0,
  // Bumped on every explicit bank/vibe selection, including re-selecting the one
  // already playing. The display keys its collection caption off this rather than
  // off the name — tapping Play is a request for something to happen.
  collectionEpoch: 0,
};

const clients = new Set();

function broadcast() {
  state.libraryVersion = db.getLibraryVersion();
  const msg = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
  clients.forEach(res => res.write(msg));
}

// mediaList is always in stable library order; `shuffle` is a playback setting the
// display acts on, not a permutation baked in here. Shuffling at selection time
// froze one random order for as long as the bank stayed up — so it did cover the
// whole bank before repeating, and then repeated that same sequence forever.
// It also fought preserveOrder, which exists to keep positions stable.

// What the current mode resolves to right now, unordered.
function currentSources() {
  if (state.mode === 'bank' && state.currentBank) return [{ type: 'bank', value: state.currentBank }];
  if (state.mode === 'vibe' && state.currentVibe) {
    const vibe = lib.getVibeByName(state.currentVibe);
    return vibe ? vibe.sources : null;
  }
  return null;
}

// Called after any library change. Deliberately does NOT reshuffle: the previous
// order is preserved for items that survive, with new ones appended. Reshuffling
// here would mean every file event — and every attribution edit — jumps the wall
// back to the start in a new random order.
function refreshMediaList() {
  const sources = currentSources();
  if (!sources) { broadcast(); return; }
  const { items } = resolveSources(sources);
  state.mediaList = preserveOrder(state.mediaList, items);
  broadcast();
}

function rescan(reason) {
  let summary;
  try {
    summary = scanLibrary(MEDIA_DIR);
  } catch (err) {
    // A failed scan leaves the previous library intact, so keep serving it rather
    // than crash-looping under Restart=always and taking the wall down with us.
    console.error(`[scan] ${reason} failed, keeping the existing library: ${err.message}`);
    return { added: 0, renamed: 0, updated: 0, missing: 0, returned: 0, warnings: [] };
  }
  for (const w of summary.warnings) console.warn(`[scan] ${w}`);
  const touched = summary.added || summary.renamed || summary.missing || summary.returned || summary.updated;
  if (touched) {
    console.log(`[scan] ${reason}: +${summary.added} added, ${summary.renamed} renamed, ` +
                `${summary.updated} updated, ${summary.missing} missing, ${summary.returned} returned`);
  }
  return summary;
}

// ── Upload ────────────────────────────────────────────────────────────────────
// The admin page sends one request per file. A dozen files used to arrive as a
// single multipart POST, and diskStorage writes each part to disk as it streams —
// so a connection that dropped halfway left the first few files written, one
// truncated, and the rest never sent. The route never ran, so there was no
// response either: the browser saw a rejected fetch and said nothing. That is
// what "half of them didn't upload, with no error" looked like from here.
//
// Bytes now land under a dot-prefixed scratch name and are renamed into place only
// once the whole request has arrived, so an interrupted transfer can never enter
// the library as a half-written image. scanLibrary skips dotfiles, so the scratch
// files are invisible to it even if a rescan lands mid-upload.

const PART_PREFIX = '.uploading-';
const TRASH_DIR = path.join(MEDIA_DIR, '.trash');
let partSeq = 0;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(MEDIA_DIR, req.params.bank);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return cb(new Error(`Cannot write to bank "${req.params.bank}": ${err.message}`));
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // basename() because originalname is client-supplied: "../../x.jpg" used to be
    // written verbatim.
    const temp = `${PART_PREFIX}${partSeq++}-${path.basename(file.originalname)}`;
    req.partFiles.push(path.join(MEDIA_DIR, req.params.bank, temp));
    cb(null, temp);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  // Rejections are recorded rather than dropped on the floor. Returning 200 with
  // fewer files than were sent is indistinguishable from a partial failure, and a
  // phone camera roll is full of .heic.
  fileFilter: (req, file, cb) => {
    if (SUPPORTED.test(file.originalname)) return cb(null, true);
    req.rejectedFiles.push(path.basename(file.originalname));
    cb(null, false);
  },
}).array('files');

function discardParts(req) {
  for (const p of req.partFiles || []) {
    try { fs.rmSync(p, { force: true }); } catch { /* the disk problem is elsewhere */ }
  }
  req.partFiles = [];
}

// Scratch files from a transfer that died mid-flight — a closed laptop lid, a power
// cut. They were never in the library, being dot-prefixed; this just takes the
// space back, which for a 61MB clip off a phone is worth doing.
function sweepPartFiles() {
  let swept = 0;
  // A missing media directory is rescan()'s story to tell, not this one's.
  if (!fs.existsSync(MEDIA_DIR)) return 0;
  try {
    for (const bank of fs.readdirSync(MEDIA_DIR, { withFileTypes: true })) {
      if (!bank.isDirectory() || bank.name.startsWith('.')) continue;
      const dir = path.join(MEDIA_DIR, bank.name);
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith(PART_PREFIX)) continue;
        try { fs.rmSync(path.join(dir, f), { force: true }); swept++; } catch { /* leave it */ }
      }
    }
  } catch (err) {
    console.warn(`[upload] could not sweep interrupted uploads: ${err.message}`);
  }
  return swept;
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.add(res);
  state.libraryVersion = db.getLibraryVersion();
  res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  req.on('close', () => clients.delete(res));
});

app.get('/api/status', (req, res) => {
  state.libraryVersion = db.getLibraryVersion();
  res.json(state);
});

app.get('/api/banks', (req, res) => res.json(lib.listBanksForAdmin()));
app.get('/api/artists', (req, res) => res.json(lib.listArtists()));
app.get('/api/groups', (req, res) => res.json(lib.listGroups()));
app.get('/api/vibes', (req, res) => res.json({ vibes: lib.listVibes() }));
app.get('/api/export', (req, res) => res.json(lib.exportAll()));

// Small wrapper so every mutating route reports validation failures the same way.
function validated(spec, handler) {
  return (req, res) => {
    let fields;
    try {
      fields = pick(req.body, spec);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      throw err;
    }
    return handler(req, res, fields);
  };
}

const asId = v => (/^\d+$/.test(String(v)) ? Number(v) : null);

// ── Items ─────────────────────────────────────────────────────────────────────
// Per-field PATCH, so two phones editing different items no longer overwrite each
// other the way the whole-document PUT did.

app.patch('/api/items/:id', validated(ITEM_SPEC, (req, res, fields) => {
  const id = asId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Invalid item id' });
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'No recognised fields' });
  if (!lib.patchItem(id, fields)) return res.status(404).json({ error: 'Item not found' });
  refreshMediaList();
  res.json({ ok: true, item: lib.getItem(id) });
}));

// scanLibrary never deletes a row — a file that vanishes is only flagged missing,
// because an unmounted volume must not destroy hand-typed attribution. An explicit
// delete is the one case where that rule is wrong: leaving the row behind would
// park a permanent MISSING tile in the grid that nothing can clear.
//
// The file moves to media/.trash rather than being unlinked. This is driven from a
// phone, one tap from the enable toggle, and the media is often the only copy. The
// scanner skips dot-directories, so the trash is out of the library while still
// being reachable over ssh or a file manager.
app.delete('/api/items/:id', (req, res) => {
  const id = asId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Invalid item id' });

  const item = lib.getItem(id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const bankDir = path.join(MEDIA_DIR, item.bank);
  const source = path.join(bankDir, item.name);
  if (path.dirname(source) !== bankDir) {
    return res.status(400).json({ error: 'Refusing to delete outside the media directory' });
  }

  // An item already flagged missing has no file to move. Dropping the row is still
  // the right answer — it is the only way to clear the tile.
  if (fs.existsSync(source)) {
    const dir = path.join(TRASH_DIR, item.bank);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(source, path.join(dir, `${Date.now()}-${item.name}`));
    } catch (err) {
      return res.status(500).json({ error: `Could not move the file to the trash: ${err.message}` });
    }
  }

  lib.deleteItem(id);
  refreshMediaList();
  res.json({ ok: true, deleted: `${item.bank}/${item.name}` });
});

// ── Banks ─────────────────────────────────────────────────────────────────────

app.patch('/api/banks/:name', validated(BANK_SPEC, (req, res, fields) => {
  const { name } = req.params;
  if (!SAFE_NAME.test(name)) return res.status(400).json({ error: 'Invalid bank name' });
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'No recognised fields' });
  if (!lib.patchBank(name, fields)) return res.status(404).json({ error: 'Bank not found' });
  refreshMediaList();
  res.json({ ok: true });
}));

// ── Vibes ─────────────────────────────────────────────────────────────────────
// Mutations key on id so renaming isn't a delete-and-recreate. Playback keys on
// name, because that is what Home Assistant sends.

app.post('/api/vibes', validated(VIBE_SPEC, (req, res, fields) => {
  if (!fields.name) return res.status(400).json({ error: 'name is required' });
  try {
    const id = lib.upsertVibe(fields);
    res.json({ ok: true, vibe: lib.listVibes().find(v => v.id === id) });
  } catch (err) {
    res.status(409).json({ error: `A vibe called "${fields.name}" already exists` });
  }
}));

app.patch('/api/vibes/:id', validated(VIBE_SPEC, (req, res, fields) => {
  const id = asId(req.params.id);
  const existing = id === null ? null : lib.listVibes().find(v => v.id === id);
  if (!existing) return res.status(404).json({ error: 'Vibe not found' });

  const merged = { ...existing, ...fields, id };
  try {
    lib.upsertVibe(merged);
  } catch {
    return res.status(409).json({ error: `A vibe called "${fields.name}" already exists` });
  }

  // Keep the wall in step if the vibe being edited is the one playing.
  if (state.mode === 'vibe' && state.currentVibe === existing.name) {
    state.currentVibe = merged.name;
    refreshMediaList();
  }
  res.json({ ok: true, vibe: lib.listVibes().find(v => v.id === id) });
}));

app.delete('/api/vibes/:id', (req, res) => {
  const id = asId(req.params.id);
  if (id === null || !lib.deleteVibe(id)) return res.status(404).json({ error: 'Vibe not found' });
  res.json({ ok: true });
});

// ── Groups ────────────────────────────────────────────────────────────────────

app.post('/api/groups', validated(GROUP_SPEC, (req, res, fields) => {
  if (!fields.name) return res.status(400).json({ error: 'name is required' });
  try {
    const id = lib.upsertGroup(fields);
    res.json({ ok: true, group: lib.listGroups().find(g => g.id === id) });
  } catch {
    res.status(409).json({ error: `A group called "${fields.name}" already exists` });
  }
}));

app.patch('/api/groups/:id', validated(GROUP_SPEC, (req, res, fields) => {
  const id = asId(req.params.id);
  const existing = id === null ? null : lib.listGroups().find(g => g.id === id);
  if (!existing) return res.status(404).json({ error: 'Group not found' });
  try {
    lib.upsertGroup({ ...existing, ...fields, id });
  } catch {
    return res.status(409).json({ error: `A group called "${fields.name}" already exists` });
  }
  refreshMediaList();
  res.json({ ok: true, group: lib.listGroups().find(g => g.id === id) });
}));

app.delete('/api/groups/:id', (req, res) => {
  const id = asId(req.params.id);
  if (id === null || !lib.deleteGroup(id)) return res.status(404).json({ error: 'Group not found' });
  refreshMediaList();
  res.json({ ok: true });
});

// ── Source preview ────────────────────────────────────────────────────────────
// Lets the vibe editor show a live item count. Artist resolution can't be done
// client-side, and the difference between "12 items" and guessing is the
// difference between confidently editing a vibe and not.

app.post('/api/resolve/preview', (req, res) => {
  let sources;
  try {
    ({ sources } = pick(req.body, { sources: VIBE_SPEC.sources }));
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    throw err;
  }
  const { items, unresolved } = resolveSources(sources || []);
  res.json({ count: items.length, unresolved });
});

app.post('/api/bank/:name', (req, res) => {
  const { name } = req.params;
  if (!SAFE_NAME.test(name)) return res.status(400).json({ error: 'Invalid bank name' });

  const { items } = resolveSources([{ type: 'bank', value: name }]);
  if (!items.length) return res.status(404).json({ error: 'Bank not found or empty' });

  state.mode = 'bank';
  state.currentBank = name;
  state.currentVibe = null;
  state.mediaList = items;
  state.collectionEpoch++;
  broadcast();
  res.json({ ok: true, state });
});

app.post('/api/vibe/:name', (req, res) => {
  const vibe = lib.getVibeByName(req.params.name);
  if (!vibe) return res.status(404).json({ error: 'Vibe not found' });

  const { items, unresolved } = resolveSources(vibe.sources);
  if (!items.length) return res.status(400).json({ error: 'No media in vibe sources', unresolved });

  const doShuffle = vibe.shuffle ?? state.settings.shuffle;

  state.mode = 'vibe';
  state.currentVibe = vibe.name;
  state.currentBank = null;
  state.mediaList = items;
  state.collectionEpoch++;
  state.settings = {
    ...state.settings,
    dwellTime: vibe.dwellTime ?? state.settings.dwellTime,
    transitionDuration: vibe.transitionDuration ?? state.settings.transitionDuration,
    videoCrossfadeMs: vibe.videoCrossfadeMs ?? state.settings.videoCrossfadeMs,
    shuffle: doShuffle,
    objectFit: vibe.defaultFit ?? state.settings.objectFit,
    captionMode: vibe.captionMode ?? state.settings.captionMode,
    captionHoldMs: vibe.captionHoldMs ?? state.settings.captionHoldMs,
  };
  broadcast();
  res.json({ ok: true, state, unresolved });
});

// Flash the caption for whatever is on the wall right now, without changing the
// caption mode. Not part of `state` — it's a one-shot event, not a fact.
app.post('/api/caption/reveal', (req, res) => {
  clients.forEach(r => r.write('event: reveal\ndata: {}\n\n'));
  res.json({ ok: true, clients: clients.size });
});

app.post('/api/settings', validated(SETTINGS_SPEC, (req, res, fields) => {
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'No recognised settings' });
  state.settings = { ...state.settings, ...fields };
  broadcast();
  res.json({ ok: true, settings: state.settings });
}));

app.post('/api/upload/:bank',
  (req, res, next) => {
    if (!SAFE_NAME.test(req.params.bank)) return res.status(400).json({ error: 'Invalid bank name' });
    req.partFiles = [];
    req.rejectedFiles = [];
    // req.params is empty by the time an app-level error handler runs, so the bank
    // has to be carried on the request if the log line is going to name it.
    req.uploadBank = req.params.bank;
    // A dropped connection leaves multer's write half-finished and the route below
    // never runs, so the scratch file would otherwise sit in the bank directory
    // forever. writableFinished distinguishes that from a response we completed.
    res.on('close', () => { if (!res.writableFinished) discardParts(req); });
    next();
  },
  upload,
  (req, res) => {
    const uploaded = [];
    const failed = [];

    // Everything arrived. Publishing is a rename, which is atomic on the same
    // filesystem — no reader ever sees a partial file under its real name.
    for (const file of req.files || []) {
      const name = path.basename(file.originalname);
      try {
        fs.renameSync(file.path, path.join(path.dirname(file.path), name));
        uploaded.push(name);
      } catch (err) {
        failed.push({ name, error: err.message });
        try { fs.rmSync(file.path, { force: true }); } catch { /* already gone */ }
      }
    }
    req.partFiles = [];

    if (!uploaded.length) {
      const why = req.rejectedFiles.length
        ? `Unsupported file type: ${req.rejectedFiles.join(', ')}`
        : failed[0]?.error || 'No files uploaded';
      return res.status(400).json({ error: why, skipped: req.rejectedFiles, failed });
    }

    rescan('upload');
    refreshMediaList();
    res.json({ ok: true, uploaded, skipped: req.rejectedFiles, failed });
  });

// Multer failures — the size limit, an unwritable directory, a connection that died
// mid-part — would otherwise reach Express's default handler and come back as an
// HTML 500 the admin page can't parse. That is how a failed upload became a silent
// one. Answer in JSON, and clean up whatever was half-written.
app.use('/api/upload', (err, req, res, next) => {
  discardParts(req);
  const msg = err.code === 'LIMIT_FILE_SIZE'
    ? 'Larger than the 500 MB limit'
    : err.message || 'Upload failed';
  console.error(`[upload] ${req.uploadBank || '?'}: ${msg}`);
  if (res.headersSent) return next(err);
  res.status(400).json({ error: msg });
});

// ── File watcher ──────────────────────────────────────────────────────────────
// chokidar fires once per file, so a 12-file upload would otherwise mean 12
// rescans and 12 full-state broadcasts — and the broadcast carries the whole
// mediaList. Coalesce on a trailing edge.

let watchTimer = null;
chokidar.watch(MEDIA_DIR, {
  ignoreInitial: true,
  ignorePermissionErrors: true,
  // Dot-prefixed paths are exactly the ones the scanner already skips: upload
  // scratch files and .trash. Watching them meant every in-progress upload woke a
  // rescan that by definition could find nothing.
  ignored: p => path.basename(p).startsWith('.'),
})
  .on('all', () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => { rescan('watcher'); refreshMediaList(); }, 500);
  });

// ── Boot ──────────────────────────────────────────────────────────────────────

let migration;
try {
  migration = db.open(DB_FILE);
} catch (err) {
  // Refusing to start beats starting with an empty library and letting the admin
  // UI write into it. The wall keeps cycling its last received list either way —
  // playback is entirely client-side — so failing here is the safe option.
  console.error(`Cannot open the library database at ${DB_FILE}`);
  console.error(`  ${err.message}`);
  console.error('Your media files are untouched. Restore data/ from a backup, or move the');
  console.error('database aside to rebuild it from disk — that loses hand-typed attribution:');
  console.error(`  mv ${DB_FILE} ${DB_FILE}.broken`);
  process.exit(1);
}

if (migration.from !== migration.to) {
  console.log(`Database schema ${migration.from} → ${migration.to} (${DB_FILE})`);
}

const swept = sweepPartFiles();
if (swept) console.log(`[upload] cleared ${swept} interrupted upload${swept === 1 ? '' : 's'}`);

rescan('boot');

// Only on a genuinely fresh database, and only after the scan has created rows for
// what is on disk — which makes seeding a pure UPDATE that never invents items.
if (migration.from === 0) {
  const seeded = lib.seedFromLegacyJSON(__dirname);
  if (seeded.length) console.log(`Migrated legacy config: ${seeded.join(', ')}`);
}

const banks = lib.listBankNames();
if (banks.length) {
  state.mode = 'bank';
  state.currentBank = banks[0];
  state.mediaList = resolveSources([{ type: 'bank', value: banks[0] }]).items;
  console.log(`Auto-loaded bank: ${banks[0]} (${state.mediaList.length} items)`);
}
state.libraryVersion = db.getLibraryVersion();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Studio Monitor → http://0.0.0.0:${PORT}`);
  console.log(`Admin          → http://0.0.0.0:${PORT}/admin`);
});

// Node's 5-minute default is a sensible guard against a stalled client on the open
// internet. This is a LAN appliance, and 500 MB of phone video over wifi to a Pi can
// legitimately take longer than that — the request being cut off mid-body is the
// exact failure this uploader exists to stop.
server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 60 * 1000;
