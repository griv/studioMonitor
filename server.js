// The library lives in SQLite via node:sqlite, which is only available unflagged
// from Node 24. Fail here with something readable rather than deep in a require
// on a wall-mounted box whose only output is journalctl.
try {
  require('node:sqlite');
} catch {
  console.error(`Studio Monitor needs Node 24 or newer — running ${process.version}.`);
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
const { resolveSources, shuffle, preserveOrder } = require('./lib/resolve');
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
app.use('/media', express.static(MEDIA_DIR));
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
    shuffle: false,
    objectFit: 'blur-bg',
    captionMode: 'collection',   // consumed by the display in Step 4
    captionHoldMs: 6000,
  },
  libraryVersion: 0,
};

const clients = new Set();

function broadcast() {
  state.libraryVersion = db.getLibraryVersion();
  const msg = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
  clients.forEach(res => res.write(msg));
}

// What the current mode resolves to right now, unshuffled and unordered.
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

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const bank = req.params.bank;
    if (!SAFE_NAME.test(bank)) return cb(new Error('Invalid bank name'));
    const dir = path.join(MEDIA_DIR, bank);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, file.originalname),
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, SUPPORTED.test(file.originalname)),
});

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

  let { items } = resolveSources([{ type: 'bank', value: name }]);
  if (!items.length) return res.status(404).json({ error: 'Bank not found or empty' });
  if (state.settings.shuffle) items = shuffle(items);

  state.mode = 'bank';
  state.currentBank = name;
  state.currentVibe = null;
  state.mediaList = items;
  broadcast();
  res.json({ ok: true, state });
});

app.post('/api/vibe/:name', (req, res) => {
  const vibe = lib.getVibeByName(req.params.name);
  if (!vibe) return res.status(404).json({ error: 'Vibe not found' });

  let { items, unresolved } = resolveSources(vibe.sources);
  if (!items.length) return res.status(400).json({ error: 'No media in vibe sources', unresolved });

  const doShuffle = vibe.shuffle ?? state.settings.shuffle;
  if (doShuffle) items = shuffle(items);

  state.mode = 'vibe';
  state.currentVibe = vibe.name;
  state.currentBank = null;
  state.mediaList = items;
  state.settings = {
    ...state.settings,
    dwellTime: vibe.dwellTime ?? state.settings.dwellTime,
    transitionDuration: vibe.transitionDuration ?? state.settings.transitionDuration,
    shuffle: doShuffle,
    objectFit: vibe.defaultFit ?? state.settings.objectFit,
    captionMode: vibe.captionMode ?? state.settings.captionMode,
    captionHoldMs: vibe.captionHoldMs ?? state.settings.captionHoldMs,
  };
  broadcast();
  res.json({ ok: true, state, unresolved });
});

app.post('/api/settings', validated(SETTINGS_SPEC, (req, res, fields) => {
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'No recognised settings' });
  state.settings = { ...state.settings, ...fields };
  broadcast();
  res.json({ ok: true, settings: state.settings });
}));

app.post('/api/upload/:bank', upload.array('files'), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });
  rescan('upload');
  refreshMediaList();
  res.json({ ok: true, uploaded: req.files.map(f => f.originalname) });
});

// ── File watcher ──────────────────────────────────────────────────────────────
// chokidar fires once per file, so a 12-file upload would otherwise mean 12
// rescans and 12 full-state broadcasts — and the broadcast carries the whole
// mediaList. Coalesce on a trailing edge.

let watchTimer = null;
chokidar.watch(MEDIA_DIR, { ignoreInitial: true, ignorePermissionErrors: true })
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Studio Monitor → http://0.0.0.0:${PORT}`);
  console.log(`Admin          → http://0.0.0.0:${PORT}/admin`);
});
