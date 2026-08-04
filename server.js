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

const PORT = process.env.PORT || 3000;
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, 'media');
const VIBES_FILE = path.join(__dirname, 'vibes.json');
const CONFIG_FILE = path.join(__dirname, 'media-config.json');

const SUPPORTED = /\.(jpg|jpeg|png|webp|gif|mp4|mov|webm)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm)$/i;
const SAFE_NAME = /^[a-zA-Z0-9_\-. ]+$/;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(MEDIA_DIR));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── Persistence helpers ───────────────────────────────────────────────────────

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadVibes() { return loadJSON(VIBES_FILE, { vibes: [] }); }
function loadConfig() { return loadJSON(CONFIG_FILE, { banks: {} }); }

// ── Media helpers ─────────────────────────────────────────────────────────────

function getBanks() {
  try {
    return fs.readdirSync(MEDIA_DIR)
      .filter(f => fs.statSync(path.join(MEDIA_DIR, f)).isDirectory() && !f.startsWith('.'));
  } catch { return []; }
}

function getBankMedia(bankName, config) {
  const bankConfig = config?.banks?.[bankName] || {};
  const itemConfigs = bankConfig.items || {};
  const bankDefaultFit = bankConfig.defaultFit || null;
  const bankDir = path.join(MEDIA_DIR, bankName);

  try {
    return fs.readdirSync(bankDir)
      .filter(f => SUPPORTED.test(f) && !f.startsWith('.'))
      .filter(f => itemConfigs[f]?.enabled !== false)
      .map(f => ({
        file: `/media/${bankName}/${encodeURIComponent(f)}`,
        type: VIDEO_EXT.test(f) ? 'video' : 'image',
        name: f,
        bank: bankName,
        fit: itemConfigs[f]?.fit || bankDefaultFit || null,
      }));
  } catch { return []; }
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── State & SSE ───────────────────────────────────────────────────────────────

let state = {
  mode: null,
  currentBank: null,
  currentVibe: null,
  mediaList: [],
  settings: { dwellTime: 8000, transitionDuration: 2000, shuffle: false, objectFit: 'blur-bg' },
};

const clients = new Set();

function broadcast(data) {
  const msg = `event: state\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => res.write(msg));
}

function refreshMediaList() {
  const config = loadConfig();
  if (state.mode === 'bank' && state.currentBank) {
    let media = getBankMedia(state.currentBank, config);
    if (state.settings.shuffle) media = shuffle(media);
    state.mediaList = media;
    broadcast(state);
  } else if (state.mode === 'vibe' && state.currentVibe) {
    const vibes = loadVibes();
    const vibe = vibes.vibes.find(v => v.name === state.currentVibe);
    if (vibe) {
      let media = vibe.banks.flatMap(b => getBankMedia(b, config));
      if (state.settings.shuffle) media = shuffle(media);
      state.mediaList = media;
      broadcast(state);
    }
  }
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
  res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  req.on('close', () => clients.delete(res));
});

app.get('/api/status', (req, res) => res.json(state));

app.get('/api/banks', (req, res) => {
  const config = loadConfig();
  res.json(getBanks().map(name => {
    const all = (() => {
      try {
        return fs.readdirSync(path.join(MEDIA_DIR, name))
          .filter(f => SUPPORTED.test(f) && !f.startsWith('.'));
      } catch { return []; }
    })();
    const bankConfig = config.banks?.[name] || {};
    const itemConfigs = bankConfig.items || {};
    return {
      name,
      defaultFit: bankConfig.defaultFit || null,
      items: all.map(f => ({
        name: f,
        type: VIDEO_EXT.test(f) ? 'video' : 'image',
        file: `/media/${name}/${encodeURIComponent(f)}`,
        enabled: itemConfigs[f]?.enabled !== false,
        fit: itemConfigs[f]?.fit || null,
      })),
    };
  }));
});

app.get('/api/vibes', (req, res) => res.json(loadVibes()));

app.put('/api/vibes', (req, res) => {
  const { vibes } = req.body;
  if (!Array.isArray(vibes)) return res.status(400).json({ error: 'vibes must be array' });
  saveJSON(VIBES_FILE, { vibes });
  refreshMediaList();
  res.json({ ok: true });
});

app.get('/api/config', (req, res) => res.json(loadConfig()));

app.put('/api/config', (req, res) => {
  saveJSON(CONFIG_FILE, req.body);
  refreshMediaList();
  res.json({ ok: true });
});

app.post('/api/bank/:name', (req, res) => {
  const { name } = req.params;
  const config = loadConfig();
  let media = getBankMedia(name, config);
  if (!media.length) return res.status(404).json({ error: 'Bank not found or empty' });
  if (state.settings.shuffle) media = shuffle(media);
  state.mode = 'bank';
  state.currentBank = name;
  state.currentVibe = null;
  state.mediaList = media;
  broadcast(state);
  res.json({ ok: true, state });
});

app.post('/api/vibe/:name', (req, res) => {
  const vibes = loadVibes();
  const vibe = vibes.vibes.find(v => v.name === req.params.name);
  if (!vibe) return res.status(404).json({ error: 'Vibe not found' });
  const config = loadConfig();
  let media = vibe.banks.flatMap(b => getBankMedia(b, config));
  if (!media.length) return res.status(400).json({ error: 'No media in vibe banks' });
  const doShuffle = vibe.shuffle ?? state.settings.shuffle;
  if (doShuffle) media = shuffle(media);
  state.mode = 'vibe';
  state.currentVibe = vibe.name;
  state.currentBank = null;
  state.mediaList = media;
  state.settings = {
    ...state.settings,
    dwellTime: vibe.dwellTime ?? state.settings.dwellTime,
    transitionDuration: vibe.transitionDuration ?? state.settings.transitionDuration,
    shuffle: doShuffle,
    objectFit: vibe.defaultFit ?? state.settings.objectFit,
  };
  broadcast(state);
  res.json({ ok: true, state });
});

app.post('/api/settings', (req, res) => {
  state.settings = { ...state.settings, ...req.body };
  broadcast(state);
  res.json({ ok: true, settings: state.settings });
});

app.post('/api/upload/:bank', upload.array('files'), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });
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
    watchTimer = setTimeout(refreshMediaList, 500);
  });

// ── Boot ──────────────────────────────────────────────────────────────────────

const banks = getBanks();
if (banks.length) {
  const config = loadConfig();
  state.mode = 'bank';
  state.currentBank = banks[0];
  state.mediaList = getBankMedia(banks[0], config);
  console.log(`Auto-loaded bank: ${banks[0]} (${state.mediaList.length} items)`);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Studio Monitor → http://0.0.0.0:${PORT}`);
  console.log(`Admin          → http://0.0.0.0:${PORT}/admin`);
});
