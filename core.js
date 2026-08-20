// ===================================================================
// core.js - datamodell, plasseringsalgoritme, og localStorage-lagring
// ===================================================================

// -- Konstantar --
const ZONES = ['framme', 'bak', 'vindauge'];
const ZONE_COLORS = { framme: '#f2c744', bak: '#5b8def', vindauge: '#4caf7d' };
const SEAT_W = 132, SEAT_H = 88, SEAT_GAP = 6;
const DATA_VERSION = 3;
const BLACKLIST_WEIGHT = 100000, REPEAT_WEIGHT = 12, ZONE_WEIGHT = 3, GENDER_WEIGHT = 25;

// -- Tom klasse --
function newClassData() {
  return {
    version: DATA_VERSION, students: [], groups: {}, seat_zones: {}, locked: {},
    arrangement: {}, sessions: [], blacklist: [], view_flipped: false,
    genders: {}, gender_weight_mode: 'ingen',
  };
}

// -- Sete/gruppe-hjelparar --
function allSeatIds(d) { return Object.values(d.groups).flatMap(g => g.seats); }
function zonesFor(d, sid) { return d.seat_zones[sid] || []; }
function groupOf(d, sid) {
  for (const [gid, g] of Object.entries(d.groups)) if (g.seats.includes(sid)) return gid;
  return null;
}
function neighbours(d, sid) {
  const gid = groupOf(d, sid);
  if (!gid) return [];
  return d.groups[gid].seats.filter(s => s !== sid);
}
function studentSeat(d, name) {
  return Object.keys(d.arrangement).find(sid => d.arrangement[sid] === name) || null;
}
function unseatedStudents(d) {
  const seated = new Set(Object.values(d.arrangement));
  return d.students.filter(s => !seated.has(s));
}

function nextGroupId(d) {
  let n = 1;
  while (d.groups['g' + n]) n++;
  return 'g' + n;
}
function addGroup(d, x, y, nSeats = 2, cols = 2) {
  const gid = nextGroupId(d);
  const seats = [];
  for (let i = 1; i <= nSeats; i++) seats.push(`${gid}-${i}`);
  d.groups[gid] = { x: Math.round(x), y: Math.round(y), cols: Math.max(1, cols), seats };
  return gid;
}
function removeGroup(d, gid) {
  const g = d.groups[gid];
  if (!g) return;
  const ids = new Set(g.seats);
  delete d.groups[gid];
  for (const sid of ids) { delete d.seat_zones[sid]; delete d.locked[sid]; delete d.arrangement[sid]; }
}
function moveGroup(d, gid, x, y) {
  if (d.groups[gid]) { d.groups[gid].x = Math.round(x); d.groups[gid].y = Math.round(y); }
}
function resizeGroup(d, gid, nSeats, cols) {
  const g = d.groups[gid];
  if (!g) return;
  nSeats = Math.max(1, nSeats);
  if (nSeats < g.seats.length) {
    const removed = g.seats.slice(nSeats);
    g.seats = g.seats.slice(0, nSeats);
    for (const sid of removed) { delete d.seat_zones[sid]; delete d.locked[sid]; delete d.arrangement[sid]; }
  } else if (nSeats > g.seats.length) {
    for (let i = g.seats.length + 1; i <= nSeats; i++) g.seats.push(`${gid}-${i}`);
  }
  g.cols = Math.max(1, cols);
}

// -- Konsistens / fjerning --
function ensureConsistency(d) {
  const valid = new Set(allSeatIds(d));
  for (const k of Object.keys(d.seat_zones)) if (!valid.has(k)) delete d.seat_zones[k];
  for (const k of Object.keys(d.locked)) if (!valid.has(k)) delete d.locked[k];
  for (const k of Object.keys(d.arrangement))
    if (!valid.has(k) || !d.students.includes(d.arrangement[k])) delete d.arrangement[k];
  const students = new Set(d.students);
  d.blacklist = d.blacklist.filter(([a, b]) => students.has(a) && students.has(b));
  for (const k of Object.keys(d.genders)) if (!students.has(k)) delete d.genders[k];
}
function removeStudent(d, name) {
  d.students = d.students.filter(s => s !== name);
  for (const [sid, n] of Object.entries(d.arrangement)) if (n === name) delete d.arrangement[sid];
  d.blacklist = d.blacklist.filter(p => !p.includes(name));
  delete d.genders[name];
}

// -- Svarteliste --
function blacklistSet(d) { return new Set(d.blacklist.map(([a, b]) => [a, b].sort().join('||'))); }
function addBlacklistPair(d, a, b) {
  if (a === b) return false;
  const key = [a, b].sort().join('||');
  if (blacklistSet(d).has(key)) return false;
  d.blacklist.push([a, b].sort());
  return true;
}
function removeBlacklistPair(d, a, b) {
  const key = [a, b].sort().join('||');
  d.blacklist = d.blacklist.filter(([x, y]) => [x, y].sort().join('||') !== key);
}
function blacklistPairsFor(d, name) {
  const out = [];
  for (const [a, b] of d.blacklist) { if (a === name) out.push(b); else if (b === name) out.push(a); }
  return out;
}

// -- Historikk --
function recordSession(d, label = '') {
  d.sessions.push({ timestamp: new Date().toISOString(), label, arrangement: { ...d.arrangement } });
  if (d.sessions.length > 300) d.sessions = d.sessions.slice(-300);
}
function buildPairHistory(d) {
  const counts = {};
  for (const sess of d.sessions) {
    const arr = sess.arrangement, seen = new Set();
    for (const [sid, name] of Object.entries(arr)) {
      for (const nb of neighbours(d, sid)) {
        const other = arr[nb];
        if (!other || other === name) continue;
        const key = [name, other].sort().join('||');
        if (seen.has(key)) continue;
        seen.add(key);
        counts[key] = (counts[key] || 0) + 1;
      }
    }
  }
  return counts;
}
function buildZoneHistory(d) {
  const counts = {};
  for (const sess of d.sessions) {
    for (const [sid, name] of Object.entries(sess.arrangement)) {
      const zs = d.seat_zones[sid] || [];
      const rec = counts[name] || (counts[name] = { framme: 0, bak: 0, vindauge: 0 });
      for (const z of zs) rec[z] = (rec[z] || 0) + 1;
    }
  }
  return counts;
}
function neighbourHistoryFor(d, name) {
  const info = {};
  for (const sess of d.sessions) {
    const arr = sess.arrangement;
    const sid = Object.keys(arr).find(s => arr[s] === name);
    if (!sid) continue;
    for (const nb of neighbours(d, sid)) {
      const other = arr[nb];
      if (!other || other === name) continue;
      const rec = info[other] || (info[other] = { name: other, count: 0, last: null });
      rec.count++; rec.last = sess.timestamp;
    }
  }
  return Object.values(info).sort((a, b) => (b.last || '').localeCompare(a.last || ''));
}
function zoneHistoryFor(d, name) { return buildZoneHistory(d)[name] || { framme: 0, bak: 0, vindauge: 0 }; }

// -- Plasseringsalgoritme --
function scoreArrangement(arr, d, pairHist, zoneHist, blSet, genders, genderMode) {
  let score = 0;
  const counted = new Set();
  for (const [sid, name] of Object.entries(arr)) {
    for (const nb of neighbours(d, sid)) {
      const other = arr[nb];
      if (!other || other === name) continue;
      const key = [name, other].sort().join('||');
      if (counted.has(key)) continue;
      counted.add(key);
      if (blSet.has(key)) score += BLACKLIST_WEIGHT;
      score += (pairHist[key] || 0) * REPEAT_WEIGHT;
      if (genderMode === 'ulikt' || genderMode === 'likt') {
        const ga = genders[name], gb = genders[other];
        if (ga && gb) {
          const same = ga === gb;
          if (genderMode === 'ulikt' && same) score += GENDER_WEIGHT;
          else if (genderMode === 'likt' && !same) score += GENDER_WEIGHT;
        }
      }
    }
  }
  for (const [sid, name] of Object.entries(arr)) {
    const zh = zoneHist[name] || {};
    for (const z of zonesFor(d, sid)) score += (zh[z] || 0) * ZONE_WEIGHT;
  }
  return score;
}

function generateArrangement(d, opts = {}) {
  const restarts = opts.restarts ?? 300, polish = opts.polish ?? 400, keepLocked = opts.keepLocked ?? true;
  const genders = opts.genders ?? d.genders, genderMode = opts.genderMode ?? d.gender_weight_mode;
  const pairHist = buildPairHistory(d), zoneHist = buildZoneHistory(d), blSet = blacklistSet(d);

  const lockedArr = {};
  if (keepLocked) for (const [sid, isL] of Object.entries(d.locked))
    if (isL && d.arrangement[sid]) lockedArr[sid] = d.arrangement[sid];

  const allSeats = allSeatIds(d);
  const freeSeats = allSeats.filter(s => !(s in lockedArr));
  const lockedStudents = new Set(Object.values(lockedArr));
  let freeStudents = d.students.filter(s => !lockedStudents.has(s));
  if (freeStudents.length > freeSeats.length) freeStudents = freeStudents.slice(0, freeSeats.length);

  let best = null, bestScore = null;
  for (let i = 0; i < Math.max(1, restarts); i++) {
    const students = shuffle([...freeStudents]);
    const seats = shuffle([...freeSeats]);
    const cand = { ...lockedArr };
    for (let j = 0; j < students.length; j++) cand[seats[j]] = students[j];
    const sc = scoreArrangement(cand, d, pairHist, zoneHist, blSet, genders, genderMode);
    if (bestScore === null || sc < bestScore) { best = cand; bestScore = sc; }
    if (bestScore === 0) break;
  }
  const swappable = freeSeats.filter(s => s in (best || {}));
  for (let i = 0; i < Math.max(0, polish); i++) {
    if (bestScore === 0 || swappable.length < 2) break;
    const [s1, s2] = sample2(swappable);
    const cand = { ...best };
    const t = cand[s1]; cand[s1] = cand[s2]; cand[s2] = t;
    if (cand[s1] === undefined) delete cand[s1];
    if (cand[s2] === undefined) delete cand[s2];
    const sc = scoreArrangement(cand, d, pairHist, zoneHist, blSet, genders, genderMode);
    if (sc < bestScore) { best = cand; bestScore = sc; }
  }
  return best || lockedArr;
}

function repeatNeighbourSeats(d, arr) {
  const pairHist = buildPairHistory(d), out = {};
  for (const [sid, name] of Object.entries(arr)) {
    let c = 0;
    for (const nb of neighbours(d, sid)) {
      const other = arr[nb];
      if (other && other !== name) c += pairHist[[name, other].sort().join('||')] || 0;
    }
    if (c) out[sid] = c;
  }
  return out;
}
function blacklistViolationSeats(d, arr) {
  const blSet = blacklistSet(d);
  if (!blSet.size) return {};
  const out = {};
  for (const [sid, name] of Object.entries(arr)) {
    const hits = [];
    for (const nb of neighbours(d, sid)) {
      const other = arr[nb];
      if (other && other !== name && blSet.has([name, other].sort().join('||'))) hits.push(other);
    }
    if (hits.length) out[sid] = hits;
  }
  return out;
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function sample2(a) { const i = Math.floor(Math.random() * a.length); let j = Math.floor(Math.random() * a.length); while (j === i) j = Math.floor(Math.random() * a.length); return [a[i], a[j]]; }

// -- Migrering frå gamalt rutenett-format (v1) --
function migrateGridToGroups(d) {
  const rows = d.rows || 4, cols = d.cols || 6, groups = {};
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const sid = `${r}-${c}`, gid = `gm${r}_${c}`;
    groups[gid] = { x: c * (SEAT_W + SEAT_GAP + 12), y: r * (SEAT_H + SEAT_GAP + 12), cols: 1, seats: [sid] };
  }
  return groups;
}
function normalizeClassData(raw) {
  const d = newClassData();
  d.students = raw.students || [];
  const version = raw.version || 1;
  if (version >= 2 && raw.groups) d.groups = raw.groups;
  else d.groups = migrateGridToGroups(raw);
  d.seat_zones = raw.seat_zones || {};
  d.locked = raw.locked || {};
  d.arrangement = raw.arrangement || {};
  d.sessions = raw.sessions || [];
  d.blacklist = raw.blacklist || [];
  d.view_flipped = !!raw.view_flipped;
  d.genders = raw.genders || {};
  d.gender_weight_mode = raw.gender_weight_mode || 'ingen';
  return d;
}

// ===================================================================
// LocalStorage: fleire klassar, aktiv/standard-klasse, innstillingar
// ===================================================================
const LS_INDEX = 'krp.index', LS_CLASS = 'krp.class.', LS_SETTINGS = 'krp.settings', LS_LANG = 'krp.lang';

function loadIndex() {
  try { return JSON.parse(localStorage.getItem(LS_INDEX)) || { order: [], names: {}, defaultId: null }; }
  catch { return { order: [], names: {}, defaultId: null }; }
}
function saveIndex(idx) { localStorage.setItem(LS_INDEX, JSON.stringify(idx)); }

const Store = {
  listClasses() { const idx = loadIndex(); return idx.order.map(id => ({ id, name: idx.names[id] })); },
  getDefaultId() { const idx = loadIndex(); return idx.defaultId || idx.order[0] || null; },
  setDefaultId(id) { const idx = loadIndex(); idx.defaultId = id; saveIndex(idx); },
  createClass(name) {
    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const idx = loadIndex();
    idx.order.push(id); idx.names[id] = name; if (!idx.defaultId) idx.defaultId = id;
    saveIndex(idx);
    this.saveClass(id, newClassData());
    return id;
  },
  renameClass(id, name) { const idx = loadIndex(); idx.names[id] = name; saveIndex(idx); },
  deleteClass(id) {
    const idx = loadIndex();
    idx.order = idx.order.filter(x => x !== id); delete idx.names[id];
    if (idx.defaultId === id) idx.defaultId = idx.order[0] || null;
    saveIndex(idx);
    localStorage.removeItem(LS_CLASS + id);
  },
  loadClass(id) {
    try { const raw = JSON.parse(localStorage.getItem(LS_CLASS + id)); return raw ? normalizeClassData(raw) : null; }
    catch { return null; }
  },
  saveClass(id, data) { localStorage.setItem(LS_CLASS + id, JSON.stringify({ ...data, version: DATA_VERSION })); },
  getSettings() {
    try { return { ...defaultSettings(), ...JSON.parse(localStorage.getItem(LS_SETTINGS)) }; }
    catch { return defaultSettings(); }
  },
  saveSettings(s) { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); },
  getLang() { return localStorage.getItem(LS_LANG) || 'nn'; },
  setLang(l) { localStorage.setItem(LS_LANG, l); },
};

function defaultSettings() {
  return { accent: '#2563eb', radius: 12, bgImage: null, blur: 8, opacity: 0.85,
           uiScale: 1, fontScale: 1, theme: 'lys' };
}
