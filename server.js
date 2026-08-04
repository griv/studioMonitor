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

const PORT = process.env.PORT || 3000;
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, 'media');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'studio.db');

const SAFE_NAME = /^[a-zA-Z0-9_\-. ]+$/;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(MEDIA_DIR));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── State & SSE ───────────────────────────────────────────────────────────────

let state = {
  mode: null,
  currentBank: null,
  currentVibe: null,
  mediaList: [],
  settings: { dwellTime: 8000, transitionDuration: 2000, shuffle: false, objectFit: 'blur-bg' },
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

// Whole-document endpoints, kept only so admin.html is untouched while the store
// changes underneath it. Step 2 replaces them with per-field PATCH and deletes these.
app.get('/api/vibes', (req, res) => res.json(lib.vibesDoc()));

app.put('/api/vibes', (req, res) => {
  const { vibes } = req.body;
  if (!Array.isArray(vibes)) return res.status(400).json({ error: 'vibes must be array' });
  lib.applyVibesDoc({ vibes });
  refreshMediaList();
  res.json({ ok: true });
});

app.get('/api/config', (req, res) => res.json(lib.configDoc()));

app.put('/api/config', (req, res) => {
  lib.applyConfigDoc(req.body);
  refreshMediaList();
  res.json({ ok: true });
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
  };
  broadcast();
  res.json({ ok: true, state, unresolved });
});

app.post('/api/settings', (req, res) => {
  state.settings = { ...state.settings, ...req.body };
  broadcast();
  res.json({ ok: true, settings: state.settings });
});

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
