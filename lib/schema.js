// Schema and migrations, versioned with PRAGMA user_version.
//
// Migration 1 carries every column the roadmap needs, including the attribution
// and caption fields that nothing reads yet. There is no deployed data, so one
// migration is cheaper than a chain of them — and adding columns later to a
// table holding hand-typed attribution is exactly the risk worth avoiding.

const MIGRATIONS = [
  db => db.exec(`
    CREATE TABLE bank (
      id              INTEGER PRIMARY KEY,
      name            TEXT    NOT NULL UNIQUE,   -- directory name under media/
      kind            TEXT    NOT NULL DEFAULT 'inspiration',  -- 'mine' | 'inspiration'
      default_fit     TEXT,
      default_artist  TEXT,
      default_year    TEXT,
      default_medium  TEXT,
      default_source  TEXT,
      caption_mode    TEXT,                      -- NULL = inherit session
      sort_order      INTEGER NOT NULL DEFAULT 0,
      missing_since   INTEGER
    );

    CREATE TABLE item (
      id              INTEGER PRIMARY KEY,       -- stable across rename; the only id the API exposes
      bank_id         INTEGER NOT NULL REFERENCES bank(id) ON DELETE CASCADE,
      filename        TEXT    NOT NULL,
      kind            TEXT    NOT NULL,          -- 'image' | 'video'
      size_bytes      INTEGER NOT NULL,
      mtime_ms        INTEGER NOT NULL,
      fingerprint     TEXT    NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 1,
      fit             TEXT,
      object_position TEXT,
      title           TEXT,
      artist          TEXT,
      year            TEXT,                      -- TEXT: "c. 1972", "1968-71", "n.d." are real answers
      medium          TEXT,
      source          TEXT,
      missing_since   INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      UNIQUE (bank_id, filename)
    );
    CREATE INDEX item_fingerprint ON item(fingerprint);
    CREATE INDEX item_bank        ON item(bank_id);

    -- GROUP is a reserved word; naming the table grp beats quoting it everywhere.
    CREATE TABLE grp (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE group_bank (
      group_id INTEGER NOT NULL REFERENCES grp(id)  ON DELETE CASCADE,
      bank_id  INTEGER NOT NULL REFERENCES bank(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (group_id, bank_id)
    );

    CREATE TABLE vibe (
      id              INTEGER PRIMARY KEY,
      name            TEXT NOT NULL UNIQUE,
      dwell_ms        INTEGER,
      transition_ms   INTEGER,
      shuffle         INTEGER,   -- tri-state: NULL means inherit the session setting
      default_fit     TEXT,
      caption_mode    TEXT,
      caption_hold_ms INTEGER,
      sort_order      INTEGER NOT NULL DEFAULT 0
    );

    -- value is a NAME, not a foreign key, so a new source type costs one resolver
    -- function and no schema change. The price is danglers when a group is deleted;
    -- those resolve to zero items and are reported as unresolved, never fatal.
    CREATE TABLE vibe_source (
      id       INTEGER PRIMARY KEY,
      vibe_id  INTEGER NOT NULL REFERENCES vibe(id) ON DELETE CASCADE,
      type     TEXT    NOT NULL,   -- 'bank' | 'group' | 'artist'
      value    TEXT    NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX vibe_source_v ON vibe_source(vibe_id, position);

    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    -- Items inherit attribution from their bank. This has to live in one place:
    -- an 'artist' playlist source must match items that inherit the bank default,
    -- not only items that state it themselves.
    --
    -- Both the resolved value and the item's own value are exposed, because they
    -- serve different readers. The display wants the effective value. The admin
    -- wants the raw one, so an empty field can mean "inheriting" rather than
    -- silently baking the bank default into every item the first time one is saved.
    CREATE VIEW item_effective AS
    SELECT i.id, i.bank_id, b.name AS bank, b.kind AS bank_kind,
           i.filename, i.kind, i.enabled, i.missing_since, i.object_position,
           i.fingerprint, i.title,
           COALESCE(NULLIF(i.fit,    ''), b.default_fit)    AS fit,
           COALESCE(NULLIF(i.artist, ''), b.default_artist) AS artist,
           COALESCE(NULLIF(i.year,   ''), b.default_year)   AS year,
           COALESCE(NULLIF(i.medium, ''), b.default_medium) AS medium,
           COALESCE(NULLIF(i.source, ''), b.default_source) AS source,
           i.fit    AS own_fit,
           i.artist AS own_artist,
           i.year   AS own_year,
           i.medium AS own_medium,
           i.source AS own_source
    FROM item i JOIN bank b ON b.id = i.bank_id;
  `),
];

function migrate(db) {
  const from = db.prepare('PRAGMA user_version').get().user_version;

  for (let v = from; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      MIGRATIONS[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${v + 1} failed: ${err.message}`, { cause: err });
    }
  }

  return { from, to: MIGRATIONS.length };
}

module.exports = { migrate, LATEST: MIGRATIONS.length };
