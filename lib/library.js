const fs = require('fs');
const path = require('path');
const { getDb, tx, bumpLibraryVersion } = require('./db');

// ── The one item mapper ──────────────────────────────────────────────────────
// getBankMedia() and GET /api/banks used to hand-build two divergent item shapes,
// which is why a new field had to be added in two places or it silently never
// reached the display. Everything goes through here now.

// The display and the admin want different halves of the inheritance. The wall
// needs the effective value — what to actually show. The editor needs the item's
// own value, so a blank field reads as "inheriting from the bank" instead of
// baking the bank default into the item the first time it's saved.
function toItem(row, { forAdmin = false } = {}) {
  if (!forAdmin) {
    return {
      id: row.id,
      name: row.filename,
      bank: row.bank,
      type: row.kind,                                // 'image' | 'video'
      file: `/media/${encodeURIComponent(row.bank)}/${encodeURIComponent(row.filename)}`,
      fit: row.fit || null,
      bankKind: row.bank_kind,                       // drives caption emphasis
      title: row.title || null,
      artist: row.artist || null,
      year: row.year || null,
      medium: row.medium || null,
      // source is deliberately absent: it isn't rendered, and the whole mediaList
      // is rebroadcast on every state change.
    };
  }

  return {
    id: row.id,
    name: row.filename,
    bank: row.bank,
    type: row.kind,
    file: `/media/${encodeURIComponent(row.bank)}/${encodeURIComponent(row.filename)}`,
    enabled: row.enabled === 1,
    missing: row.missing_since !== null,
    objectPosition: row.object_position || null,
    fit: row.own_fit || null,
    title: row.title || null,
    artist: row.own_artist || null,
    year: row.own_year || null,
    medium: row.own_medium || null,
    source: row.own_source || null,
    // What the item resolves to once bank defaults apply — for showing the
    // inherited value as placeholder text next to an empty field.
    effective: {
      fit: row.fit || null,
      artist: row.artist || null,
      year: row.year || null,
      medium: row.medium || null,
      source: row.source || null,
    },
  };
}

const PLAYABLE = `enabled = 1 AND missing_since IS NULL`;
const ITEM_ORDER = `ORDER BY bank COLLATE NOCASE, filename COLLATE NOCASE`;

// ── Reads ────────────────────────────────────────────────────────────────────

function listBankNames() {
  return getDb().prepare(`SELECT name FROM bank WHERE missing_since IS NULL
                          ORDER BY sort_order, name COLLATE NOCASE`).all().map(r => r.name);
}

function bankMedia(bankName) {
  return getDb().prepare(`SELECT * FROM item_effective WHERE bank = ? AND ${PLAYABLE} ${ITEM_ORDER}`)
    .all(bankName).map(r => toItem(r));
}

function listBanksForAdmin() {
  const db = getDb();
  const banks = db.prepare(`SELECT * FROM bank WHERE missing_since IS NULL
                            ORDER BY sort_order, name COLLATE NOCASE`).all();
  const items = db.prepare(`SELECT * FROM item_effective ${ITEM_ORDER}`).all();

  const byBank = new Map();
  for (const row of items) {
    if (!byBank.has(row.bank)) byBank.set(row.bank, []);
    byBank.get(row.bank).push(toItem(row, { forAdmin: true }));
  }

  return banks.map(b => ({
    name: b.name,
    kind: b.kind,
    defaultFit: b.default_fit || null,
    defaultArtist: b.default_artist || null,
    defaultYear: b.default_year || null,
    defaultMedium: b.default_medium || null,
    defaultSource: b.default_source || null,
    captionMode: b.caption_mode || null,
    items: byBank.get(b.name) || [],
  }));
}

function listArtists() {
  return getDb().prepare(`
    SELECT artist, COUNT(*) AS count FROM item_effective
    WHERE artist IS NOT NULL AND TRIM(artist) <> '' AND missing_since IS NULL
    GROUP BY LOWER(TRIM(artist)) ORDER BY artist COLLATE NOCASE`).all();
}

function listGroups() {
  const db = getDb();
  const groups = db.prepare('SELECT * FROM grp ORDER BY sort_order, name COLLATE NOCASE').all();
  const stmt = db.prepare(`SELECT b.name FROM group_bank gb JOIN bank b ON b.id = gb.bank_id
                           WHERE gb.group_id = ? ORDER BY gb.position`);
  return groups.map(g => ({ id: g.id, name: g.name, banks: stmt.all(g.id).map(r => r.name) }));
}

function listVibes() {
  const db = getDb();
  const vibes = db.prepare('SELECT * FROM vibe ORDER BY sort_order, name COLLATE NOCASE').all();
  const stmt = db.prepare('SELECT type, value FROM vibe_source WHERE vibe_id = ? ORDER BY position');
  return vibes.map(v => ({
    id: v.id,
    name: v.name,
    sources: stmt.all(v.id),
    dwellTime: v.dwell_ms,
    transitionDuration: v.transition_ms,
    shuffle: v.shuffle === null ? null : v.shuffle === 1,
    defaultFit: v.default_fit,
    captionMode: v.caption_mode,
    captionHoldMs: v.caption_hold_ms,
  }));
}

function getVibeByName(name) {
  return listVibes().find(v => v.name === name) || null;
}

function getItem(id) {
  const row = getDb().prepare('SELECT * FROM item_effective WHERE id = ?').get(id);
  return row ? toItem(row, { forAdmin: true }) : null;
}

// Everything, in one JSON document. Attribution is hand-typed and can't be
// regenerated from the media, so it needs a way off this machine.
function exportAll() {
  return {
    exportedAt: new Date().toISOString(),
    banks: listBanksForAdmin(),
    groups: listGroups(),
    vibes: listVibes(),
  };
}

// ── Writes ───────────────────────────────────────────────────────────────────

const ITEM_FIELDS = {
  enabled: 'enabled', fit: 'fit', objectPosition: 'object_position',
  title: 'title', artist: 'artist', year: 'year', medium: 'medium', source: 'source',
};

function patchItem(id, fields) {
  const sets = [], values = [];
  for (const [key, column] of Object.entries(ITEM_FIELDS)) {
    if (!(key in fields)) continue;
    sets.push(`${column} = ?`);
    values.push(key === 'enabled' ? (fields[key] ? 1 : 0) : (fields[key] ?? null));
  }
  if (!sets.length) return false;

  values.push(Date.now(), id);
  const res = getDb().prepare(`UPDATE item SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values);
  if (res.changes) bumpLibraryVersion();
  return res.changes > 0;
}

const BANK_FIELDS = {
  kind: 'kind', defaultFit: 'default_fit', defaultArtist: 'default_artist',
  defaultYear: 'default_year', defaultMedium: 'default_medium',
  defaultSource: 'default_source', captionMode: 'caption_mode',
};

function patchBank(name, fields) {
  const sets = [], values = [];
  for (const [key, column] of Object.entries(BANK_FIELDS)) {
    if (!(key in fields)) continue;
    sets.push(`${column} = ?`);
    values.push(fields[key] ?? null);
  }
  if (!sets.length) return false;

  values.push(name);
  const res = getDb().prepare(`UPDATE bank SET ${sets.join(', ')} WHERE name = ?`).run(...values);
  if (res.changes) bumpLibraryVersion();
  return res.changes > 0;
}

function upsertVibe({ id, name, sources = [], dwellTime, transitionDuration, shuffle, defaultFit,
                      captionMode, captionHoldMs }) {
  const db = getDb();
  return tx(() => {
    const values = [name, dwellTime ?? null, transitionDuration ?? null,
                    shuffle === null || shuffle === undefined ? null : (shuffle ? 1 : 0),
                    defaultFit ?? null, captionMode ?? null, captionHoldMs ?? null];

    let vibeId = id;
    if (vibeId) {
      db.prepare(`UPDATE vibe SET name = ?, dwell_ms = ?, transition_ms = ?, shuffle = ?,
                  default_fit = ?, caption_mode = ?, caption_hold_ms = ? WHERE id = ?`)
        .run(...values, vibeId);
    } else {
      vibeId = Number(db.prepare(`INSERT INTO vibe (name, dwell_ms, transition_ms, shuffle,
                                  default_fit, caption_mode, caption_hold_ms)
                                  VALUES (?, ?, ?, ?, ?, ?, ?)`).run(...values).lastInsertRowid);
    }

    db.prepare('DELETE FROM vibe_source WHERE vibe_id = ?').run(vibeId);
    const ins = db.prepare('INSERT INTO vibe_source (vibe_id, type, value, position) VALUES (?, ?, ?, ?)');
    sources.forEach((s, i) => ins.run(vibeId, s.type, s.value, i));

    bumpLibraryVersion();
    return vibeId;
  });
}

function deleteVibe(id) {
  const res = getDb().prepare('DELETE FROM vibe WHERE id = ?').run(id);
  if (res.changes) bumpLibraryVersion();
  return res.changes > 0;
}

function upsertGroup({ id, name, banks = [] }) {
  const db = getDb();
  return tx(() => {
    let groupId = id;
    if (groupId) db.prepare('UPDATE grp SET name = ? WHERE id = ?').run(name, groupId);
    else groupId = Number(db.prepare('INSERT INTO grp (name) VALUES (?)').run(name).lastInsertRowid);

    db.prepare('DELETE FROM group_bank WHERE group_id = ?').run(groupId);
    const ins = db.prepare(`INSERT INTO group_bank (group_id, bank_id, position)
                            SELECT ?, id, ? FROM bank WHERE name = ?`);
    banks.forEach((b, i) => ins.run(groupId, i, b));

    bumpLibraryVersion();
    return groupId;
  });
}

function deleteGroup(id) {
  const res = getDb().prepare('DELETE FROM grp WHERE id = ?').run(id);
  if (res.changes) bumpLibraryVersion();
  return res.changes > 0;
}

// ── One-time import of the pre-SQLite files ──────────────────────────────────
// The whole-document shims are gone; only the importer remains, and it runs once.

function applyConfigDoc(doc) {
  const db = getDb();
  tx(() => {
    // Faithful to the old semantics: the document is the whole truth, and an
    // absent item means enabled with no fit override.
    db.prepare('UPDATE bank SET default_fit = NULL').run();
    db.prepare('UPDATE item SET enabled = 1, fit = NULL').run();

    for (const [bankName, bankCfg] of Object.entries(doc?.banks || {})) {
      db.prepare('UPDATE bank SET default_fit = ? WHERE name = ?').run(bankCfg?.defaultFit ?? null, bankName);
      for (const [filename, itemCfg] of Object.entries(bankCfg?.items || {})) {
        db.prepare(`UPDATE item SET enabled = ?, fit = ?, updated_at = ?
                    WHERE filename = ? AND bank_id = (SELECT id FROM bank WHERE name = ?)`)
          .run(itemCfg?.enabled === false ? 0 : 1, itemCfg?.fit ?? null, Date.now(), filename, bankName);
      }
    }
    bumpLibraryVersion();
  });
}

function upsertVibeInner(db, v) {
  const vibeId = Number(db.prepare(`INSERT INTO vibe (name, dwell_ms, transition_ms, shuffle,
                                    default_fit, caption_mode, caption_hold_ms)
                                    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(v.name, v.dwellTime ?? null, v.transitionDuration ?? null,
         v.shuffle === undefined || v.shuffle === null ? null : (v.shuffle ? 1 : 0),
         // Read both keys: hand-edited vibes.json carried objectFit, which the
         // server never read. Migrating is the moment that stops mattering.
         v.defaultFit ?? v.objectFit ?? null, v.captionMode ?? null, v.captionHoldMs ?? null)
    .lastInsertRowid);

  const ins = db.prepare('INSERT INTO vibe_source (vibe_id, type, value, position) VALUES (?, ?, ?, ?)');
  const sources = v.sources?.length ? v.sources : (v.banks || []).map(b => ({ type: 'bank', value: b }));
  sources.forEach((s, i) => ins.run(vibeId, s.type, s.value, i));
  return vibeId;
}

// One-shot import of the pre-SQLite files. Runs only on a fresh database, and
// only after scanLibrary() has created rows for what is on disk — so it is a pure
// UPDATE and never has to invent items for files that don't exist.
function seedFromLegacyJSON(repoDir) {
  const db = getDb();
  const results = [];

  const configFile = path.join(repoDir, 'media-config.json');
  const vibesFile = path.join(repoDir, 'vibes.json');

  if (fs.existsSync(configFile)) {
    try {
      applyConfigDoc(JSON.parse(fs.readFileSync(configFile, 'utf8')));
      fs.renameSync(configFile, `${configFile}.migrated`);
      results.push('media-config.json');
    } catch (err) {
      results.push(`media-config.json FAILED: ${err.message}`);
    }
  }

  if (fs.existsSync(vibesFile)) {
    try {
      const doc = JSON.parse(fs.readFileSync(vibesFile, 'utf8'));
      tx(() => { for (const v of doc?.vibes || []) upsertVibeInner(db, v); });
      fs.renameSync(vibesFile, `${vibesFile}.migrated`);
      results.push(`vibes.json (${doc?.vibes?.length || 0})`);
    } catch (err) {
      results.push(`vibes.json FAILED: ${err.message}`);
    }
  }

  if (results.length) bumpLibraryVersion();
  return results;
}

module.exports = {
  toItem, listBankNames, bankMedia, listBanksForAdmin, listArtists, listGroups, listVibes,
  getVibeByName, getItem, exportAll,
  patchItem, patchBank, upsertVibe, deleteVibe, upsertGroup, deleteGroup,
  seedFromLegacyJSON, PLAYABLE, ITEM_ORDER,
};
