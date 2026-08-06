// Turns a vibe's typed sources into a media list.
//
// Adding a source type is one entry in RESOLVERS and no schema change — which is
// the whole reason vibe_source.value is a name rather than a foreign key.

const { getDb } = require('./db');
const { toItem, PLAYABLE, ITEM_ORDER } = require('./library');

// Each resolver returns null when its referent doesn't exist (a deleted group),
// and [] when it exists but currently has nothing playable. The difference is what
// separates "your playlist is broken" from "that bank is empty right now".
const RESOLVERS = {
  bank(value) {
    const db = getDb();
    if (!db.prepare('SELECT 1 FROM bank WHERE name = ?').get(value)) return null;
    return db.prepare(`SELECT * FROM item_effective WHERE bank = ? AND ${PLAYABLE} ${ITEM_ORDER}`).all(value);
  },

  group(value) {
    const db = getDb();
    if (!db.prepare('SELECT 1 FROM grp WHERE name = ?').get(value)) return null;
    return db.prepare(`
      SELECT ie.* FROM item_effective ie
        JOIN group_bank gb ON gb.bank_id = ie.bank_id
        JOIN grp g         ON g.id = gb.group_id
      WHERE g.name = ? AND ie.enabled = 1 AND ie.missing_since IS NULL
      ORDER BY gb.position, ie.filename COLLATE NOCASE`).all(value);
  },

  artist(value) {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM item_effective
      WHERE LOWER(TRIM(COALESCE(artist, ''))) = LOWER(TRIM(?)) AND ${PLAYABLE} ${ITEM_ORDER}`).all(value);
    return rows.length ? rows : null;   // an artist only exists if something is by them
  },
};

function resolveSources(sources = []) {
  const out = new Map();          // item id -> item, first occurrence wins
  const unresolved = [];

  for (const src of sources) {
    const resolver = RESOLVERS[src?.type];
    const rows = resolver ? resolver(src.value) : null;
    if (rows === null) { unresolved.push({ type: src?.type, value: src?.value }); continue; }

    // Dedupe by item id, so a bank named directly and also reached through a group
    // contributes once, at its earliest position. Deliberately NOT by fingerprint —
    // the same photo copied into two banks is two files and should appear twice.
    for (const row of rows) if (!out.has(row.id)) out.set(row.id, toItem(row));
  }

  return { items: [...out.values()], unresolved };
}

// Keeps playback stable across a rescan: items still present hold their position,
// new ones land at the end. Without this, every file event reshuffles the whole
// list and the wall jumps back to the start — which attribution editing, being
// write-heavy, would trigger constantly.
function preserveOrder(previous, next) {
  const order = new Map(previous.map((item, i) => [item.id, i]));
  const known = next.filter(item => order.has(item.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
  const fresh = next.filter(item => !order.has(item.id));
  return [...known, ...fresh];
}

module.exports = { resolveSources, preserveOrder, RESOLVERS };
