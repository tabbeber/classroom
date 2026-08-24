// ===================================================================
// core.js - datamodell (rom + klasse), plasseringsalgoritme, lagring
// Rom (bordgrupper, soner, vend-vising) er skilt frå klasse (elevar,
// plassering, historikk) slik at fleire klassar kan dele same rom.
// ===================================================================

// -- Konstantar --
const ZONES = ['framme', 'bak', 'vindauge'];
const ZONE_COLORS = { framme: '#f2c744', bak: '#5b8def', vindauge: '#4caf7d' };
const SEAT_W = 132, SEAT_H = 88, SEAT_GAP = 6;
const ROOM_GROUP_GAP = 40;
const CLASS_VERSION = 4, ROOM_VERSION = 1;
const BLACKLIST_WEIGHT = 100000, REPEAT_WEIGHT = 12, ZONE_WEIGHT = 3, GENDER_WEIGHT = 25;

// -- Tomme objekt --
function newRoomData() {
  return { version: ROOM_VERSION, groups: {}, seat_zones: {}, view_flipped: true };
}
function newClassData() {
  return {
    version: CLASS_VERSION, room_id: null, students: [], locked: {}, arrangement: {},
    sessions: [], blacklist: [], genders: {}, gender_weight_mode: 'ingen',
  };
}

// -- Rom-hjelparar (bordgrupper/plassar) --
function allSeatIds(r) { return Object.values(r.groups).flatMap(g => g.seats); }
function zonesFor(r, sid) { return r.seat_zones[sid] || []; }
function groupOf(r, sid) {
  for (const [gid, g] of Object.entries(r.groups)) if (g.seats.includes(sid)) return gid;
  return null;
}
function neighbours(r, sid) {
  const gid = groupOf(r, sid);
  if (!gid) return [];
  return r.groups[gid].seats.filter(s => s !== sid);
}
function nextGroupId(r) {
  let n = 1;
  while (r.groups['g' + n]) n++;
  return 'g' + n;
}
function addGroup(r, x, y, nSeats = 2, cols = 2) {
  const gid = nextGroupId(r);
  const seats = [];
  for (let i = 1; i <= nSeats; i++) seats.push(`${gid}-${i}`);
  r.groups[gid] = { x: Math.round(x), y: Math.round(y), cols: Math.max(1, cols), seats };
  return gid;
}
function removeGroup(r, cls, gid) {
  const g = r.groups[gid];
  if (!g) return;
  const ids = new Set(g.seats);
  delete r.groups[gid];
  for (const sid of ids) {
    delete r.seat_zones[sid];
    if (cls) { delete cls.locked[sid]; delete cls.arrangement[sid]; }
  }
}
function moveGroup(r, gid, x, y) {
  if (r.groups[gid]) { r.groups[gid].x = Math.round(x); r.groups[gid].y = Math.round(y); }
}
function resizeGroup(r, cls, gid, nSeats, cols) {
  const g = r.groups[gid];
  if (!g) return;
  nSeats = Math.max(1, nSeats);
  if (nSeats < g.seats.length) {
    const removed = g.seats.slice(nSeats);
    g.seats = g.seats.slice(0, nSeats);
    for (const sid of removed) {
      delete r.seat_zones[sid];
      if (cls) { delete cls.locked[sid]; delete cls.arrangement[sid]; }
    }
  } else if (nSeats > g.seats.length) {
    for (let i = g.seats.length + 1; i <= nSeats; i++) g.seats.push(`${gid}-${i}`);
  }
  g.cols = Math.max(1, cols);
}
// Slå saman fleire grupper til éi (posisjon frå den fyrste, seter samla).
function mergeGroups(r, cls, gids) {
  if (gids.length < 2) return gids[0] || null;
  const first = r.groups[gids[0]];
  if (!first) return null;
  const mergedSeats = [];
  for (const gid of gids) {
    const g = r.groups[gid];
    if (g) mergedSeats.push(...g.seats);
  }
  const newGid = nextGroupId(r);
  const cols = first.cols || 2;
  r.groups[newGid] = { x: first.x, y: first.y, cols, seats: mergedSeats };
  for (const gid of gids) delete r.groups[gid];
  return newGid;
}
// Bryt valde plassar ut av gruppa si til ei ny, eiga gruppe.
function splitSeatsOut(r, sids) {
  const bygroup = {};
  for (const sid of sids) {
    const gid = groupOf(r, sid);
    if (!gid) continue;
    (bygroup[gid] = bygroup[gid] || []).push(sid);
  }
  const newGids = [];
  for (const [gid, seatsOut] of Object.entries(bygroup)) {
    const g = r.groups[gid];
    if (!g || seatsOut.length >= g.seats.length) continue; // heile gruppa - inga endring
    g.seats = g.seats.filter(s => !seatsOut.includes(s));
    const newGid = nextGroupId(r);
    r.groups[newGid] = { x: g.x + ROOM_GROUP_GAP, y: g.y, cols: Math.min(g.cols, seatsOut.length), seats: seatsOut };
    newGids.push(newGid);
  }
  return newGids;
}
// Fyll romet med parbord (2 og 2), tilpassa elevtal. Brukt ved oppretting.
function autoPopulateRoom(r, studentCount) {
  const n = Math.max(1, studentCount || 0);
  const tables = Math.max(1, Math.ceil(n / 2));
  const cols = Math.max(1, Math.ceil(Math.sqrt(tables)));
  const tableW = 2 * (SEAT_W + SEAT_GAP) - SEAT_GAP, tableH = SEAT_H;
  let created = 0;
  for (let row = 0; created < tables; row++) {
    for (let c = 0; c < cols && created < tables; c++) {
      addGroup(r, 20 + c * (tableW + ROOM_GROUP_GAP), 20 + row * (tableH + ROOM_GROUP_GAP), 2, 2);
      created++;
    }
  }
}

// -- Klasse-hjelparar --
function studentSeat(cls, name) {
  return Object.keys(cls.arrangement).find(sid => cls.arrangement[sid] === name) || null;
}
function unseatedStudents(cls) {
  const seated = new Set(Object.values(cls.arrangement));
  return cls.students.filter(s => !seated.has(s));
}
function removeStudent(cls, name) {
  cls.students = cls.students.filter(s => s !== name);
  for (const [sid, n] of Object.entries(cls.arrangement)) if (n === name) delete cls.arrangement[sid];
  cls.blacklist = cls.blacklist.filter(p => !p.includes(name));
  delete cls.genders[name];
}

// -- Konsistens (rom+klasse) --
function ensureConsistency(r, cls) {
  const valid = new Set(allSeatIds(r));
  for (const k of Object.keys(r.seat_zones)) if (!valid.has(k)) delete r.seat_zones[k];
  for (const k of Object.keys(cls.locked)) if (!valid.has(k)) delete cls.locked[k];
  for (const k of Object.keys(cls.arrangement))
    if (!valid.has(k) || !cls.students.includes(cls.arrangement[k])) delete cls.arrangement[k];
  const students = new Set(cls.students);
  cls.blacklist = cls.blacklist.filter(([a, b]) => students.has(a) && students.has(b));
  for (const k of Object.keys(cls.genders)) if (!students.has(k)) delete cls.genders[k];
}

// -- Svarteliste (klasse) --
function blacklistSet(cls) { return new Set(cls.blacklist.map(([a, b]) => [a, b].sort().join('||'))); }
function addBlacklistPair(cls, a, b) {
  if (a === b) return false;
  const key = [a, b].sort().join('||');
  if (blacklistSet(cls).has(key)) return false;
  cls.blacklist.push([a, b].sort());
  return true;
}
function removeBlacklistPair(cls, a, b) {
  const key = [a, b].sort().join('||');
  cls.blacklist = cls.blacklist.filter(([x, y]) => [x, y].sort().join('||') !== key);
}
function blacklistPairsFor(cls, name) {
  const out = [];
  for (const [a, b] of cls.blacklist) { if (a === name) out.push(b); else if (b === name) out.push(a); }
  return out;
}

// -- Historikk (rom+klasse: naboskap kjem frå romet, øktene frå klassen) --
function recordSession(cls, label = '') {
  cls.sessions.push({ timestamp: new Date().toISOString(), label, arrangement: { ...cls.arrangement } });
  if (cls.sessions.length > 300) cls.sessions = cls.sessions.slice(-300);
}
function buildPairHistory(r, cls) {
  const counts = {};
  for (const sess of cls.sessions) {
    const arr = sess.arrangement, seen = new Set();
    for (const [sid, name] of Object.entries(arr)) {
      for (const nb of neighbours(r, sid)) {
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
function buildZoneHistory(r, cls) {
  const counts = {};
  for (const sess of cls.sessions) {
    for (const [sid, name] of Object.entries(sess.arrangement)) {
      const zs = r.seat_zones[sid] || [];
      const rec = counts[name] || (counts[name] = { framme: 0, bak: 0, vindauge: 0 });
      for (const z of zs) rec[z] = (rec[z] || 0) + 1;
    }
  }
  return counts;
}
function neighbourHistoryFor(r, cls, name) {
  const info = {};
  for (const sess of cls.sessions) {
    const arr = sess.arrangement;
    const sid = Object.keys(arr).find(s => arr[s] === name);
    if (!sid) continue;
    for (const nb of neighbours(r, sid)) {
      const other = arr[nb];
      if (!other || other === name) continue;
      const rec = info[other] || (info[other] = { name: other, count: 0, last: null });
      rec.count++; rec.last = sess.timestamp;
    }
  }
  return Object.values(info).sort((a, b) => (b.last || '').localeCompare(a.last || ''));
}
function zoneHistoryFor(r, cls, name) {
  return buildZoneHistory(r, cls)[name] || { framme: 0, bak: 0, vindauge: 0 };
}

// -- Plasseringsalgoritme --
function scoreArrangement(arr, r, pairHist, zoneHist, blSet, genders, genderMode) {
  let score = 0;
  const counted = new Set();
  for (const [sid, name] of Object.entries(arr)) {
    for (const nb of neighbours(r, sid)) {
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
    for (const z of zonesFor(r, sid)) score += (zh[z] || 0) * ZONE_WEIGHT;
  }
  return score;
}

function generateArrangement(r, cls, opts = {}) {
  const restarts = opts.restarts ?? 300, polish = opts.polish ?? 400, keepLocked = opts.keepLocked ?? true;
  const genders = opts.genders ?? cls.genders, genderMode = opts.genderMode ?? cls.gender_weight_mode;
  const pairHist = buildPairHistory(r, cls), zoneHist = buildZoneHistory(r, cls), blSet = blacklistSet(cls);

  const lockedArr = {};
  if (keepLocked) for (const [sid, isL] of Object.entries(cls.locked))
    if (isL && cls.arrangement[sid]) lockedArr[sid] = cls.arrangement[sid];

  const allSeats = allSeatIds(r);
  const freeSeats = allSeats.filter(s => !(s in lockedArr));
  const lockedStudents = new Set(Object.values(lockedArr));
  let freeStudents = cls.students.filter(s => !lockedStudents.has(s));
  if (freeStudents.length > freeSeats.length) freeStudents = freeStudents.slice(0, freeSeats.length);

  let best = null, bestScore = null;
  for (let i = 0; i < Math.max(1, restarts); i++) {
    const students = shuffle([...freeStudents]);
    const seats = shuffle([...freeSeats]);
    const cand = { ...lockedArr };
    for (let j = 0; j < students.length; j++) cand[seats[j]] = students[j];
    const sc = scoreArrangement(cand, r, pairHist, zoneHist, blSet, genders, genderMode);
    if (bestScore === null || sc < bestScore) { best = cand; bestScore = sc; }
    if (bestScore === 0) break;
  }
  const swappable = freeSeats.filter(s => s in (best || {}));
  for (let i = 0; i < Math.max(0, polish); i++) {
    if (bestScore === 0 || swappable.length < 2) break;
    const [s1, s2] = sample2(swappable);
    const cand = { ...best };
    const tmp = cand[s1]; cand[s1] = cand[s2]; cand[s2] = tmp;
    if (cand[s1] === undefined) delete cand[s1];
    if (cand[s2] === undefined) delete cand[s2];
    const sc = scoreArrangement(cand, r, pairHist, zoneHist, blSet, genders, genderMode);
    if (sc < bestScore) { best = cand; bestScore = sc; }
  }
  return best || lockedArr;
}

function repeatNeighbourSeats(r, cls, arr) {
  const pairHist = buildPairHistory(r, cls), out = {};
  for (const [sid, name] of Object.entries(arr)) {
    let c = 0;
    for (const nb of neighbours(r, sid)) {
      const other = arr[nb];
      if (other && other !== name) c += pairHist[[name, other].sort().join('||')] || 0;
    }
    if (c) out[sid] = c;
  }
  return out;
}
function blacklistViolationSeats(r, cls, arr) {
  const blSet = blacklistSet(cls);
  if (!blSet.size) return {};
  const out = {};
  for (const [sid, name] of Object.entries(arr)) {
    const hits = [];
    for (const nb of neighbours(r, sid)) {
      const other = arr[nb];
      if (other && other !== name && blSet.has([name, other].sort().join('||'))) hits.push(other);
    }
    if (hits.length) out[sid] = hits;
  }
  return out;
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function sample2(a) { const i = Math.floor(Math.random() * a.length); let j = Math.floor(Math.random() * a.length); while (j === i) j = Math.floor(Math.random() * a.length); return [a[i], a[j]]; }

// -- Migrering frå gamalt rutenett-format (v1, ingen bordgrupper) --
function migrateGridToGroups(d) {
  const rows = d.rows || 4, cols = d.cols || 6, groups = {};
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const sid = `${r}-${c}`, gid = `gm${r}_${c}`;
    groups[gid] = { x: c * (SEAT_W + SEAT_GAP + 12), y: r * (SEAT_H + SEAT_GAP + 12), cols: 1, seats: [sid] };
  }
  return groups;
}
// Les inn gamal (v1-v3, rom inni klassen) eller ny (v4, room_id) klassefil.
// Returnerer { classData, embeddedRoom } - embeddedRoom er sett viss data
// måtte hentast ut frå ei gamal fil og treng ei ny rom-lagring.
function normalizeClassData(raw) {
  const cls = newClassData();
  cls.students = raw.students || [];
  cls.locked = raw.locked || {};
  cls.arrangement = raw.arrangement || {};
  cls.sessions = raw.sessions || [];
  cls.blacklist = raw.blacklist || [];
  cls.genders = raw.genders || {};
  cls.gender_weight_mode = raw.gender_weight_mode || 'ingen';

  const version = raw.version || 1;
  if (version >= CLASS_VERSION) {
    // alt i nytt format - rom er skilt ut. room_id kan vere null (ikkje tilordna enno).
    cls.room_id = raw.room_id || null;
    return { classData: cls, embeddedRoom: null };
  }
  // gammalt format (v1-v3) - rom-data ligg inni sjølve klassen, må hentast ut
  const room = newRoomData();
  room.groups = (version >= 2 && raw.groups) ? raw.groups : migrateGridToGroups(raw);
  room.seat_zones = raw.seat_zones || {};
  room.view_flipped = raw.view_flipped !== undefined ? !!raw.view_flipped : true;
  return { classData: cls, embeddedRoom: room };
}

// ===================================================================
// LocalStorage: klassar, rom, innstillingar
// ===================================================================
const LS_INDEX = 'krp.index', LS_CLASS = 'krp.class.', LS_SETTINGS = 'krp.settings', LS_LANG = 'krp.lang';
const LS_ROOM_INDEX = 'krp.roomIndex', LS_ROOM = 'krp.room.';

function loadIndex() {
  try { return JSON.parse(localStorage.getItem(LS_INDEX)) || { order: [], names: {}, defaultId: null }; }
  catch { return { order: [], names: {}, defaultId: null }; }
}
function saveIndex(idx) { localStorage.setItem(LS_INDEX, JSON.stringify(idx)); }
function loadRoomIndex() {
  try { return JSON.parse(localStorage.getItem(LS_ROOM_INDEX)) || { order: [], names: {} }; }
  catch { return { order: [], names: {} }; }
}
function saveRoomIndex(idx) { localStorage.setItem(LS_ROOM_INDEX, JSON.stringify(idx)); }
function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

const Store = {
  // -- klassar --
  listClasses() { const idx = loadIndex(); return idx.order.map(id => ({ id, name: idx.names[id] })); },
  getDefaultId() { const idx = loadIndex(); return idx.defaultId || idx.order[0] || null; },
  setDefaultId(id) { const idx = loadIndex(); idx.defaultId = id; saveIndex(idx); },
  createClass(name, roomId) {
    const id = newId('c');
    const idx = loadIndex();
    idx.order.push(id); idx.names[id] = name; if (!idx.defaultId) idx.defaultId = id;
    saveIndex(idx);
    const cls = newClassData();
    cls.room_id = roomId || null;
    this.saveClass(id, cls);
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
    let raw;
    try { raw = JSON.parse(localStorage.getItem(LS_CLASS + id)); } catch { return null; }
    if (!raw) return null;
    const { classData, embeddedRoom } = normalizeClassData(raw);
    if (embeddedRoom) {
      const idx = loadIndex();
      const roomId = this.createRoom((idx.names[id] || 'Klasse') + ' - rom');
      this.saveRoom(roomId, embeddedRoom);
      classData.room_id = roomId;
      this.saveClass(id, classData);
    }
    return classData;
  },
  saveClass(id, data) { localStorage.setItem(LS_CLASS + id, JSON.stringify({ ...data, version: CLASS_VERSION })); },

  // -- rom --
  listRooms() { const idx = loadRoomIndex(); return idx.order.map(id => ({ id, name: idx.names[id] })); },
  createRoom(name, opts = {}) {
    const id = newId('r');
    const idx = loadRoomIndex();
    idx.order.push(id); idx.names[id] = name;
    saveRoomIndex(idx);
    const room = newRoomData();
    if (opts.autoPopulateFor !== undefined) autoPopulateRoom(room, opts.autoPopulateFor);
    this.saveRoom(id, room);
    return id;
  },
  renameRoom(id, name) { const idx = loadRoomIndex(); idx.names[id] = name; saveRoomIndex(idx); },
  deleteRoom(id) {
    const idx = loadRoomIndex();
    idx.order = idx.order.filter(x => x !== id); delete idx.names[id];
    saveRoomIndex(idx);
    localStorage.removeItem(LS_ROOM + id);
  },
  loadRoom(id) {
    try { const raw = JSON.parse(localStorage.getItem(LS_ROOM + id)); return raw || null; }
    catch { return null; }
  },
  saveRoom(id, room) { localStorage.setItem(LS_ROOM + id, JSON.stringify({ ...room, version: ROOM_VERSION })); },
  duplicateRoom(id, newName) {
    const room = this.loadRoom(id); if (!room) return null;
    const nid = this.createRoom(newName);
    this.saveRoom(nid, JSON.parse(JSON.stringify(room)));
    return nid;
  },
  roomsInUseBy(roomId) {
    const idx = loadIndex(); const out = [];
    for (const id of idx.order) {
      const c = this.loadClass(id);
      if (c && c.room_id === roomId) out.push({ id, name: idx.names[id] });
    }
    return out;
  },

  // -- innstillingar / språk --
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
           uiScale: 1, fontScale: 1, theme: 'lys', seatSizeOverride: null,
           exportDate: false, exportTime: false, exportWeek: false, exportClassName: false,
           poolCollapsed: false, infoCollapsed: false };
}
