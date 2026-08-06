// Request-body validation.
//
// Two rules, deliberately different:
//   Unknown keys are dropped silently — a PATCH from a slightly stale client
//   shouldn't fail just because it knows about a field this build doesn't.
//   Bad VALUES for known keys are rejected — that's a bug, and silence hides it.
//
// Replaces PUT /api/config, which wrote req.body to disk verbatim.

const FITS = new Set(['blur-bg', 'contain', 'cover', 'ken-burns']);
const CAPTION_MODES = new Set(['collection', 'item', 'always']);
const BANK_KINDS = new Set(['mine', 'inspiration']);
const SOURCE_TYPES = new Set(['bank', 'group', 'artist']);
const SAFE_NAME = /^[a-zA-Z0-9_\-. ]+$/;

class ValidationError extends Error {}

const blank = v => v === null || v === undefined || v === '';

const text = (max = 300) => v => {
  if (blank(v)) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > max) throw new ValidationError(`longer than ${max} characters`);
  return s;
};

const oneOf = set => v => {
  if (blank(v)) return null;
  const s = String(v);
  if (!set.has(s)) throw new ValidationError(`expected one of ${[...set].join(', ')}`);
  return s;
};

const int = (min, max) => v => {
  if (blank(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ValidationError('expected a number');
  return Math.round(Math.min(max, Math.max(min, n)));
};

const bool = () => v => !!v;

// Tri-state: null means "inherit the session setting", which vibe.shuffle relies on.
const triBool = () => v => (blank(v) ? null : !!v);

const safeName = () => v => {
  const s = text(80)(v);
  if (!s) throw new ValidationError('required');
  if (!SAFE_NAME.test(s)) throw new ValidationError('letters, numbers, spaces, dot, dash and underscore only');
  return s;
};

const sourceList = () => v => {
  if (!Array.isArray(v)) throw new ValidationError('expected an array');
  return v.map((s, i) => {
    if (!s || !SOURCE_TYPES.has(s.type)) {
      throw new ValidationError(`source ${i}: type must be one of ${[...SOURCE_TYPES].join(', ')}`);
    }
    const value = text(200)(s.value);
    if (!value) throw new ValidationError(`source ${i}: value is required`);
    return { type: s.type, value };
  });
};

function pick(body, spec) {
  const out = {};
  for (const [key, validate] of Object.entries(spec)) {
    if (!body || !(key in body)) continue;    // absent means "not being changed"
    try {
      out[key] = validate(body[key]);
    } catch (err) {
      throw new ValidationError(`${key}: ${err.message}`);
    }
  }
  return out;
}

const ITEM_SPEC = {
  enabled: bool(),
  fit: oneOf(FITS),
  objectPosition: text(40),
  title: text(300),
  artist: text(200),
  year: text(40),
  medium: text(200),
  source: text(1000),
};

const BANK_SPEC = {
  kind: oneOf(BANK_KINDS),
  defaultFit: oneOf(FITS),
  defaultArtist: text(200),
  defaultYear: text(40),
  defaultMedium: text(200),
  defaultSource: text(1000),
  captionMode: oneOf(CAPTION_MODES),
};

const VIBE_SPEC = {
  name: safeName(),
  sources: sourceList(),
  dwellTime: int(1000, 600000),
  transitionDuration: int(0, 20000),
  videoCrossfadeMs: int(0, 10000),
  shuffle: triBool(),
  defaultFit: oneOf(FITS),
  captionMode: oneOf(CAPTION_MODES),
  captionHoldMs: int(0, 120000),
};

const nameList = () => v => {
  if (!Array.isArray(v)) throw new ValidationError('expected an array');
  return v.map(n => safeName()(n));
};

const GROUP_SPEC = {
  name: safeName(),
  banks: nameList(),
};

const SETTINGS_SPEC = {
  dwellTime: int(1000, 600000),
  transitionDuration: int(0, 20000),
  videoCrossfadeMs: int(0, 10000),
  shuffle: bool(),
  objectFit: oneOf(FITS),
  captionMode: oneOf(CAPTION_MODES),
  captionHoldMs: int(0, 120000),
};

module.exports = {
  pick, ValidationError, SAFE_NAME,
  ITEM_SPEC, BANK_SPEC, VIBE_SPEC, GROUP_SPEC, SETTINGS_SPEC,
  FITS, CAPTION_MODES, BANK_KINDS, SOURCE_TYPES,
};
