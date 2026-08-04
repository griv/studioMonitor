const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { migrate } = require('./schema');

let db = null;

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);

  // WAL so a power cut at the wall socket can't corrupt the file — the failure
  // mode the JSON store had, where a truncated write silently read back empty.
  // synchronous=NORMAL can lose the last transaction on power loss, which is a
  // fit toggle, not the library.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous  = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  // Returned so the caller can tell a fresh database from an existing one —
  // legacy JSON seeding must happen once and only on 0 -> 1.
  return migrate(db);
}

function getDb() {
  if (!db) throw new Error('db.open() has not been called');
  return db;
}

function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

// ── Library version ──────────────────────────────────────────────────────────
// A monotonic counter the admin can compare against to notice its cached view is
// stale — after a rename on disk, an upload from another device, or a second tab
// editing. Rides along in the SSE state so the library itself isn't broadcast.

function getLibraryVersion() {
  const row = db.prepare(`SELECT value FROM kv WHERE key = 'libraryVersion'`).get();
  return row ? Number(row.value) : 0;
}

function bumpLibraryVersion() {
  const next = getLibraryVersion() + 1;
  db.prepare(`INSERT INTO kv (key, value) VALUES ('libraryVersion', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(next));
  return next;
}

// ── Small kv helpers ─────────────────────────────────────────────────────────

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

function setSetting(key, value) {
  db.prepare(`INSERT INTO kv (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, JSON.stringify(value));
}

module.exports = { open, getDb, tx, getLibraryVersion, bumpLibraryVersion, getSetting, setSetting };
