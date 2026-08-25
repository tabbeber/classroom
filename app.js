// ===================================================================
// app.js - appstyring: tilstand, teikning av rom, drag, dialogar
// Rom (bordgrupper) og klasse (elevar/plassering) er skilde datasett;
// App.room + App.data held kvar sitt, kopla via App.data.room_id.
// ===================================================================

const MARGIN = 20, BOARD_H = 30, GROUP_GAP = 40, DRAG_T = 6, SNAP = 20;
const ACCENT_PRESETS = ['#2563eb', '#16a34a', '#7c3aed', '#ea580c', '#db2777', '#475569'];

const App = {
  classId: null, data: null,
  roomId: null, room: null,
  settings: null,
  zoomRoom: 1, zoomSeat: 1,
  selectedSeat: null, selectedStudent: null,
  multiSelected: new Set(), armedStudent: null,
  drag: null, ctxMenu: null,
  roomDirty: false,
  heatmapStudent: null, heatmapData: null,
};

// -- Tekstmåling og layout-utrekning --
let _measureCtx = null;
function measureCtx() {
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
  return _measureCtx;
}
function computeSeatSize(students) {
  const override = App.settings && App.settings.seatSizeOverride;
  if (override) return { w: override, h: Math.round(override / (SEAT_W / SEAT_H)) };
  const ctx = measureCtx();
  ctx.font = "bold 10pt 'Segoe UI'";
  let w = SEAT_W;
  if (students.length) {
    const longest = Math.max(...students.map(s => ctx.measureText(s).width));
    w = Math.max(100, Math.min(220, longest + 34));
  }
  return { w, h: Math.round(w / (SEAT_W / SEAT_H)) };
}
function computeLayout(r, seatW, seatH) {
  const raw = {}; let maxX = 0, maxY = 0;
  for (const g of Object.values(r.groups)) {
    const cols = Math.max(1, g.cols || 1);
    g.seats.forEach((sid, i) => {
      const row = Math.floor(i / cols), col = i % cols;
      const x = g.x + col * (seatW + SEAT_GAP), y = g.y + row * (seatH + SEAT_GAP);
      raw[sid] = [x, y];
      maxX = Math.max(maxX, x + seatW); maxY = Math.max(maxY, y + seatH);
    });
  }
  const contentW = Math.max(maxX, 260), contentH = maxY;
  const positions = {}; let boardRect, totalH;
  if (!r.view_flipped) {
    const offY = MARGIN + BOARD_H + 14;
    for (const [sid, [x, y]] of Object.entries(raw)) positions[sid] = [x + MARGIN, y + offY];
    boardRect = [MARGIN, MARGIN, contentW]; totalH = contentH + offY + MARGIN;
  } else {
    const offY = MARGIN;
    for (const [sid, [x, y]] of Object.entries(raw)) positions[sid] = [x + MARGIN, (contentH - y - seatH) + offY];
    boardRect = [MARGIN, offY + contentH + 14, contentW]; totalH = offY + contentH + 14 + BOARD_H + MARGIN;
  }
  return { positions, boardRect, totalW: contentW + MARGIN * 2, totalH: Math.max(totalH, 160) };
}
function groupBounds(g, positions, seatW, seatH) {
  const pts = g.seats.map(sid => positions[sid]).filter(Boolean);
  if (!pts.length) return null;
  const pad = 6;
  const minX = Math.min(...pts.map(p => p[0])) - pad, minY = Math.min(...pts.map(p => p[1])) - pad;
  const maxX = Math.max(...pts.map(p => p[0] + seatW)) + pad, maxY = Math.max(...pts.map(p => p[1] + seatH)) + pad;
  return { minX, minY, w: maxX - minX, h: maxY - minY };
}

// -- Teikning av klasserom (delt av Klasserom- og Plasserings-fana) --
function buildSeatEl(sid, mode, w, h, repeatWarn, blWarn) {
  const room = App.room, cls = App.data, student = cls.arrangement[sid], locked = !!cls.locked[sid], zones = zonesFor(room, sid);
  const el = document.createElement('div');
  el.className = 'seat' + (student ? '' : ' empty');
  if (locked) el.classList.add('locked');
  if (mode === 'layout') el.classList.add('layout-mode');
  if (App.multiSelected.has(sid)) el.classList.add('multi');
  else if (App.selectedSeat === sid) el.classList.add('selected');
  el.style.width = w + 'px'; el.style.height = h + 'px';
  el.dataset.sid = sid;

  if (mode === 'seating' && App.heatmapStudent && App.heatmapData && App.heatmapData[sid]) {
    const { count, recency } = App.heatmapData[sid];
    const hue = 120 * (1 - recency); // 120=grøn (lenge sidan), 0=raud (nyleg)
    const opacity = Math.min(0.85, 0.28 + count * 0.14);
    el.style.boxShadow = `inset 0 0 0 999px hsla(${hue}, 75%, 50%, ${opacity})`;
  }

  const top = document.createElement('div'); top.className = 'top-row';
  for (const z of zones) {
    const b = document.createElement('span'); b.className = 'zone-badge';
    b.style.background = ZONE_COLORS[z]; b.textContent = z[0].toUpperCase();
    top.appendChild(b);
  }
  if (locked) { const lb = document.createElement('span'); lb.className = 'lock-badge'; lb.textContent = t('locked'); top.appendChild(lb); }
  if (App.multiSelected.has(sid)) { const cb = document.createElement('span'); cb.className = 'check-badge'; cb.textContent = '\u2713'; top.appendChild(cb); }
  el.appendChild(top);

  const nameEl = document.createElement('div'); nameEl.className = 'name'; nameEl.textContent = student || t('empty');
  el.appendChild(nameEl);

  if (mode === 'seating') {
    const hits = blWarn[sid];
    if (hits) { const w2 = document.createElement('div'); w2.className = 'warn hard'; w2.textContent = t('blacklistWarn', { names: hits.join(', ') }); el.appendChild(w2); }
    else if (repeatWarn[sid]) { const w3 = document.createElement('div'); w3.className = 'warn soft'; w3.textContent = t('obsWarn'); el.appendChild(w3); }
  }
  return el;
}

const _seatElCache = { roomCanvasA: {}, roomCanvasB: {} };
const _boardElCache = {};
const _groupFrameCache = { roomCanvasA: {}, roomCanvasB: {} };

function renderRoom(containerId, mode, zoom) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  _seatElCache[containerId] = {};
  const room = App.room, cls = App.data, { w: seatW, h: seatH } = computeSeatSize(cls.students);
  App.heatmapData = (mode === 'seating' && App.heatmapStudent) ? seatHeatmapForStudent(room, cls, App.heatmapStudent) : null;
  const { positions, boardRect, totalW, totalH } = computeLayout(room, seatW, seatH);
  container.style.width = (totalW * zoom) + 'px'; container.style.height = (totalH * zoom) + 'px';

  const [bx, by, bw] = boardRect;
  const board = document.createElement('div'); board.className = 'board'; board.textContent = t('boardLabel');
  board.style.left = (bx * zoom) + 'px'; board.style.top = (by * zoom) + 'px';
  board.style.width = (bw * zoom) + 'px'; board.style.height = Math.max(18, BOARD_H * zoom) + 'px';
  container.appendChild(board);
  _boardElCache[containerId] = board;

  if (!Object.keys(room.groups).length) {
    const hint = document.createElement('p'); hint.className = 'hint';
    hint.style.position = 'absolute'; hint.style.left = (bx * zoom) + 'px'; hint.style.top = (by * zoom + BOARD_H * zoom + 16) + 'px';
    hint.style.width = Math.max(bw, 260) + 'px'; hint.textContent = t('roomEmptyHint');
    container.appendChild(hint);
    return;
  }
  const repeatWarn = mode === 'seating' ? repeatNeighbourSeats(room, cls, cls.arrangement) : {};
  const blWarn = mode === 'seating' ? blacklistViolationSeats(room, cls, cls.arrangement) : {};
  _groupFrameCache[containerId] = {};
  for (const [gid, g] of Object.entries(room.groups)) {
    const b = groupBounds(g, positions, seatW, seatH);
    if (b) {
      const frame = document.createElement('div'); frame.className = 'group-frame';
      frame.style.left = (b.minX * zoom) + 'px'; frame.style.top = (b.minY * zoom) + 'px';
      frame.style.width = (b.w * zoom) + 'px'; frame.style.height = (b.h * zoom) + 'px';
      container.appendChild(frame);
      _groupFrameCache[containerId][gid] = frame;
    }
    for (const sid of g.seats) {
      if (!positions[sid]) continue;
      const [px, py] = positions[sid];
      const el = buildSeatEl(sid, mode, seatW * zoom, seatH * zoom, repeatWarn, blWarn);
      el.style.left = (px * zoom) + 'px'; el.style.top = (py * zoom) + 'px';
      container.appendChild(el);
      attachSeatEvents(el, sid, mode);
      _seatElCache[containerId][sid] = el;
    }
  }
}
function repositionRoom(containerId, zoom) {
  const room = App.room, cls = App.data, { w: seatW, h: seatH } = computeSeatSize(cls.students);
  const { positions, boardRect, totalW, totalH } = computeLayout(room, seatW, seatH);
  const container = document.getElementById(containerId);
  container.style.width = (totalW * zoom) + 'px'; container.style.height = (totalH * zoom) + 'px';
  const board = _boardElCache[containerId];
  if (board) {
    const [bx, by, bw] = boardRect;
    board.style.left = (bx * zoom) + 'px'; board.style.top = (by * zoom) + 'px';
    board.style.width = (bw * zoom) + 'px'; board.style.height = Math.max(18, BOARD_H * zoom) + 'px';
  }
  const cache = _seatElCache[containerId] || {};
  for (const [sid, [px, py]] of Object.entries(positions)) {
    const el = cache[sid];
    if (!el) continue;
    el.style.left = (px * zoom) + 'px'; el.style.top = (py * zoom) + 'px';
    el.style.width = (seatW * zoom) + 'px'; el.style.height = (seatH * zoom) + 'px';
  }
  const gcache = _groupFrameCache[containerId] || {};
  for (const [gid, g] of Object.entries(room.groups)) {
    const b = groupBounds(g, positions, seatW, seatH), el = gcache[gid];
    if (b && el) {
      el.style.left = (b.minX * zoom) + 'px'; el.style.top = (b.minY * zoom) + 'px';
      el.style.width = (b.w * zoom) + 'px'; el.style.height = (b.h * zoom) + 'px';
    }
  }
}
function renderAllRoomViews() {
  renderRoom('roomCanvasA', 'layout', App.zoomRoom);
  renderRoom('roomCanvasB', 'seating', App.zoomSeat);
  document.getElementById('roomSeatCount').textContent = t('roomTotalSeats', { n: allSeatIds(App.room).length });
  updateStatusBar();
}

// -- Drag: flytt bordgruppe (rom-fana) / flytt elev (plasserings-fana) --
let ghostEl = null;
function startGhost(text) {
  ghostEl = document.createElement('div'); ghostEl.textContent = text;
  Object.assign(ghostEl.style, { position: 'fixed', zIndex: 1000, background: '#1f2937', color: 'white',
    padding: '6px 10px', borderRadius: '8px', fontWeight: '700', pointerEvents: 'none' });
  document.body.appendChild(ghostEl);
}
function moveGhost(x, y) { if (ghostEl) { ghostEl.style.left = (x + 14) + 'px'; ghostEl.style.top = (y + 10) + 'px'; } }
function destroyGhost() { if (ghostEl) { ghostEl.remove(); ghostEl = null; } }

const LONG_PRESS_MS = 500;
function clearLongPressTimer(drag) {
  if (drag && drag.longPressTimer) { clearTimeout(drag.longPressTimer); drag.longPressTimer = null; }
}
function attachSeatEvents(el, sid, mode) {
  el.addEventListener('pointerdown', e => onSeatPointerDown(e, sid, mode));
  el.addEventListener('contextmenu', e => { e.preventDefault(); openSeatContextMenu(e, sid); });
}
function onSeatPointerDown(e, sid, mode) {
  if (e.button !== 0) return;
  if (e.ctrlKey || e.metaKey) { toggleMultiSelect(sid); return; }
  e.preventDefault();
  const el = e.currentTarget, room = App.room, cls = App.data;
  let drag;
  if (mode === 'layout') {
    const gid = groupOf(room, sid); if (!gid) return;
    const g = room.groups[gid];
    drag = { kind: 'group', gid, sid, startX: e.clientX, startY: e.clientY, origX: g.x, origY: g.y, dragging: false, zoom: App.zoomRoom };
  } else {
    drag = { kind: 'seat', sid, startX: e.clientX, startY: e.clientY, dragging: false, locked: !!cls.locked[sid] };
  }
  // Halde inne (touch eller mus) markerer plassen for fleire-val, same som Ctrl+klikk.
  drag.longPressTriggered = false;
  drag.longPressTimer = setTimeout(() => { drag.longPressTriggered = true; toggleMultiSelect(sid); }, LONG_PRESS_MS);
  App.drag = drag;
  el.setPointerCapture(e.pointerId);
  el.addEventListener('pointermove', onSeatPointerMove);
  el.addEventListener('pointerup', onSeatPointerUp);
}
function onSeatPointerMove(e) {
  const drag = App.drag; if (!drag || drag.longPressTriggered) return;
  const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
  if (!drag.dragging && (Math.abs(dx) >= DRAG_T || Math.abs(dy) >= DRAG_T)) clearLongPressTimer(drag);
  if (drag.kind === 'group') {
    if (!drag.dragging) { if (Math.abs(dx) < DRAG_T && Math.abs(dy) < DRAG_T) return; drag.dragging = true; }
    const sign = App.room.view_flipped ? -1 : 1;
    const rawX = Math.max(0, drag.origX + dx / drag.zoom), rawY = Math.max(0, drag.origY + sign * (dy / drag.zoom));
    moveGroup(App.room, drag.gid, Math.round(rawX / SNAP) * SNAP, Math.round(rawY / SNAP) * SNAP);
    repositionRoom('roomCanvasA', App.zoomRoom);
    return;
  }
  if (drag.locked) return;
  if (!drag.dragging) {
    if (Math.abs(dx) < DRAG_T && Math.abs(dy) < DRAG_T) return;
    if (!App.data.arrangement[drag.sid]) return;
    drag.dragging = true; startGhost(App.data.arrangement[drag.sid]);
  }
  moveGhost(e.clientX, e.clientY);
}
function onSeatPointerUp(e) {
  const el = e.currentTarget;
  el.releasePointerCapture(e.pointerId);
  el.removeEventListener('pointermove', onSeatPointerMove);
  el.removeEventListener('pointerup', onSeatPointerUp);
  const drag = App.drag; App.drag = null; if (!drag) return;
  clearLongPressTimer(drag);
  if (drag.longPressTriggered) return; // halde-inne har alt gjort jobben

  if (drag.kind === 'group') {
    if (drag.dragging) { markRoomDirty(); renderAllRoomViews(); }
    else if (App.multiSelected.size > 0) { toggleMultiSelect(drag.sid); }
    else { App.selectedSeat = drag.sid; renderAllRoomViews(); }
    return;
  }
  destroyGhost();
  if (drag.locked) {
    if (App.multiSelected.size > 0) toggleMultiSelect(drag.sid);
    else { App.selectedSeat = drag.sid; renderInfoPanel(); renderAllRoomViews(); }
    return;
  }
  if (drag.dragging) {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const seatEl = target && target.closest('.seat');
    const poolEl = target && target.closest('.pool-list');
    handleSeatDrop(drag.sid, seatEl ? seatEl.dataset.sid : null, !!poolEl);
  } else if (App.multiSelected.size > 0) {
    // Når minst éin plass alt er markert, held vi fram i "marker fleire"-modus:
    // eit vanleg trykk/klikk legg til/fjernar denne plassen i utvalet.
    toggleMultiSelect(drag.sid);
  } else {
    handleSeatClick(drag.sid);
  }
}
function attachPoolEvents(el, name) { el.addEventListener('pointerdown', e => onPoolPointerDown(e, name)); }
function onPoolPointerDown(e, name) {
  if (e.button !== 0) return;
  e.preventDefault();
  const el = e.currentTarget;
  App.drag = { kind: 'pool', name, startX: e.clientX, startY: e.clientY, dragging: false };
  el.setPointerCapture(e.pointerId);
  el.addEventListener('pointermove', onPoolPointerMove);
  el.addEventListener('pointerup', onPoolPointerUp);
}
function onPoolPointerMove(e) {
  const drag = App.drag; if (!drag) return;
  const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
  if (!drag.dragging) { if (Math.abs(dx) < DRAG_T && Math.abs(dy) < DRAG_T) return; drag.dragging = true; startGhost(drag.name); }
  moveGhost(e.clientX, e.clientY);
}
function onPoolPointerUp(e) {
  const el = e.currentTarget;
  el.releasePointerCapture(e.pointerId);
  el.removeEventListener('pointermove', onPoolPointerMove);
  el.removeEventListener('pointerup', onPoolPointerUp);
  const drag = App.drag; App.drag = null; if (!drag) return;
  destroyGhost();
  if (drag.dragging) {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const seatEl = target && target.closest('.seat');
    if (seatEl) placeStudent(drag.name, seatEl.dataset.sid);
  } else handlePoolClick(drag.name);
}

function toggleMultiSelect(sid) {
  if (App.multiSelected.has(sid)) App.multiSelected.delete(sid); else App.multiSelected.add(sid);
  renderAllRoomViews();
}
function handleSeatClick(sid) {
  if (App.armedStudent) {
    if (App.data.locked[sid]) setStatus(t('lockSeat'));
    else { placeStudent(App.armedStudent, sid); App.armedStudent = null; }
  }
  App.selectedSeat = sid; App.selectedStudent = null;
  renderAllRoomViews(); renderPool(); renderInfoPanel();
}
function handlePoolClick(name) {
  App.armedStudent = (App.armedStudent === name) ? null : name;
  App.selectedStudent = name; App.selectedSeat = null;
  renderPool(); renderInfoPanel();
}
function wouldViolateBlacklist(student, targetSeat, excludeSid) {
  const room = App.room, cls = App.data, gid = groupOf(room, targetSeat); if (!gid) return [];
  const blSet = blacklistSet(cls); if (!blSet.size) return [];
  const hits = [];
  for (const sib of room.groups[gid].seats) {
    if (sib === targetSeat || sib === excludeSid) continue;
    const other = cls.arrangement[sib];
    if (other && blSet.has([student, other].sort().join('||'))) hits.push(other);
  }
  return hits;
}
function placeStudent(student, targetSeat) {
  const cls = App.data;
  if (cls.locked[targetSeat]) { setStatus(t('lockSeat')); return; }
  const hits = wouldViolateBlacklist(student, targetSeat);
  if (hits.length && !confirm(`${student} ${t('blacklistWith')} ${hits.join(', ')}. ${t('confirm')}?`)) return;
  const old = studentSeat(cls, student); if (old) delete cls.arrangement[old];
  cls.arrangement[targetSeat] = student;
  saveCurrentClass(); renderAllRoomViews(); renderPool(); renderInfoPanel();
}
function moveOrSwap(sourceSid, targetSeat) {
  const cls = App.data;
  if (cls.locked[targetSeat]) { setStatus(t('lockSeat')); return; }
  const moving = cls.arrangement[sourceSid];
  const hits = wouldViolateBlacklist(moving, targetSeat, sourceSid);
  if (hits.length && !confirm(`${moving} ${t('blacklistWith')} ${hits.join(', ')}. ${t('confirm')}?`)) return;
  const other = cls.arrangement[targetSeat];
  if (other) cls.arrangement[sourceSid] = other; else delete cls.arrangement[sourceSid];
  cls.arrangement[targetSeat] = moving;
  saveCurrentClass(); renderAllRoomViews(); renderPool(); renderInfoPanel();
}
function handleSeatDrop(sourceSid, targetSid, inPool) {
  const cls = App.data, student = cls.arrangement[sourceSid]; if (!student) return;
  if (targetSid && targetSid !== sourceSid) moveOrSwap(sourceSid, targetSid);
  else if (inPool) { delete cls.arrangement[sourceSid]; saveCurrentClass(); renderAllRoomViews(); renderPool(); renderInfoPanel(); }
}

// -- Høgreklikk-meny --
function closeContextMenu() { if (App.ctxMenu) { App.ctxMenu.remove(); App.ctxMenu = null; } }
function onDocMouseDownCloseMenu(e) {
  if (App.ctxMenu && App.ctxMenu.contains(e.target)) return;
  document.removeEventListener('mousedown', onDocMouseDownCloseMenu);
  closeContextMenu();
}
function buildSeatMenuItems(sid) {
  const room = App.room, cls = App.data;
  const items = [];
  if (App.multiSelected.size > 0) {
    items.push([t('clearSelection'), clearSelection]);
  }
  if (App.multiSelected.size > 1 && App.multiSelected.has(sid)) {
    items.push([t('editZonesBulk', { n: App.multiSelected.size }), openBulkZonesModal]);
    if (groupsRepresentedBy(App.multiSelected).length > 1) items.push([t('mergeGroups'), doMergeSelectedGroups]);
    items.push([t('splitGroups'), doSplitSelectedSeats]);
  }
  const locked = !!cls.locked[sid];
  items.push([locked ? t('unlockSeat') : t('lockSeat'), () => { cls.locked[sid] = !locked; saveCurrentClass(); renderAllRoomViews(); }]);
  items.push([t('editZones'), () => openEditZonesModal(sid)]);
  if (cls.arrangement[sid]) items.push([t('clearSeat'), () => { delete cls.arrangement[sid]; saveCurrentClass(); renderAllRoomViews(); renderPool(); }]);
  const gid = groupOf(room, sid);
  if (gid) {
    items.push([t('selectGroup'), () => { App.multiSelected = new Set(room.groups[gid].seats); renderAllRoomViews(); }]);
    if (room.groups[gid].seats.length > 1) {
      items.push([t('splitThisSeat'), () => { splitSeatsOut(room, [sid]); markRoomDirty(); renderAllRoomViews(); }]);
    }
    items.push([t('editGroup'), () => openEditGroupModal(gid)]);
    items.push([t('removeGroupBtn'), () => { if (confirm(t('confirmRemoveGroup'))) { removeGroup(room, null, gid); markRoomDirty(); renderAllRoomViews(); renderPool(); } }]);
  }
  return items;
}
function showMenuAt(x, y, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'panel';
  Object.assign(menu.style, { position: 'fixed', left: x + 'px', top: y + 'px', zIndex: 200, minWidth: '230px', padding: '.3rem' });
  for (const [label, fn] of items) {
    const b = document.createElement('button'); b.textContent = label;
    Object.assign(b.style, { display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', borderRadius: '6px' });
    b.onmouseenter = () => b.style.background = '#f3f4f6'; b.onmouseleave = () => b.style.background = 'transparent';
    b.onclick = () => { closeContextMenu(); fn(); };
    menu.appendChild(b);
  }
  document.body.appendChild(menu); App.ctxMenu = menu;
  // hald menyen innanfor vindauget
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = Math.max(4, window.innerWidth - r.width - 4) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top = Math.max(4, window.innerHeight - r.height - 4) + 'px';
  setTimeout(() => document.addEventListener('mousedown', onDocMouseDownCloseMenu), 0);
}
function openSeatContextMenu(e, sid) {
  App.selectedSeat = sid;
  showMenuAt(e.clientX, e.clientY, buildSeatMenuItems(sid));
}
// Opnar same meny via ein knapp i verktøylinja (touch-vennleg, treng ikkje
// høgreklikk/halde-inne). Verkar på det som alt er valt: fleire-val vinn,
// elles einskild valt plass.
function openMenuForSelection() {
  const sid = App.multiSelected.size ? [...App.multiSelected][0] : App.selectedSeat;
  if (!sid) { setStatus(t('noSelectionHint')); return; }
  const btn = document.getElementById('btnSeatMenu');
  const r = btn.getBoundingClientRect();
  showMenuAt(r.left, r.bottom + 4, buildSeatMenuItems(sid));
}
function clearSelection() {
  App.multiSelected = new Set();
  App.selectedSeat = null;
  renderAllRoomViews(); renderInfoPanel();
}

// -- Slå saman / skil ut bordgrupper (multi-val) --
function groupsRepresentedBy(sidSet) {
  const gids = new Set();
  for (const sid of sidSet) { const gid = groupOf(App.room, sid); if (gid) gids.add(gid); }
  return [...gids];
}
function doMergeSelectedGroups() {
  const gids = groupsRepresentedBy(App.multiSelected);
  if (gids.length < 2) { alert(t('mergeNeedTwo')); return; }
  mergeGroups(App.room, App.data, gids);
  App.multiSelected = new Set();
  markRoomDirty(); renderAllRoomViews();
}
function doSplitSelectedSeats() {
  const sids = [...App.multiSelected];
  if (!sids.length) { alert(t('splitNeedSelection')); return; }
  splitSeatsOut(App.room, sids);
  App.multiSelected = new Set();
  markRoomDirty(); renderAllRoomViews();
}

// -- Modal-dialogar (generisk) --
function openModal(html) {
  const root = document.getElementById('modalRoot');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
  root.querySelector('.modal-backdrop').addEventListener('mousedown', e => { if (e.target.classList.contains('modal-backdrop')) closeModal(); });
  return root.querySelector('.modal');
}
function closeModal() { document.getElementById('modalRoot').innerHTML = ''; }

function zoneCheckboxesHtml(current) {
  return ZONES.map(z => `<label style="display:block"><input type="checkbox" data-z="${z}" ${current.has(z) ? 'checked' : ''}> ${t('zone' + z[0].toUpperCase() + z.slice(1))}</label>`).join('');
}
function openEditZonesModal(sid) {
  const room = App.room, cls = App.data, current = new Set(zonesFor(room, sid));
  const modal = openModal(`
    <h2>${t('editZones')}</h2>${zoneCheckboxesHtml(current)}
    <label style="display:block;margin-top:.5rem"><input type="checkbox" id="ezLock" ${cls.locked[sid] ? 'checked' : ''}> ${t('lockSeat')}</label>
    <div class="actions"><button id="ezCancel">${t('cancel')}</button><button id="ezOk" class="primary">${t('save')}</button></div>`);
  modal.querySelector('#ezCancel').onclick = closeModal;
  modal.querySelector('#ezOk').onclick = () => {
    const zones = [...modal.querySelectorAll('input[data-z]')].filter(c => c.checked).map(c => c.dataset.z);
    if (zones.length) room.seat_zones[sid] = zones; else delete room.seat_zones[sid];
    cls.locked[sid] = modal.querySelector('#ezLock').checked;
    saveCurrentClass(); markRoomDirty(); closeModal(); renderAllRoomViews();
  };
}
function openBulkZonesModal() {
  const sids = [...App.multiSelected].filter(s => groupOf(App.room, s));
  if (!sids.length) { alert(t('roomHint')); return; }
  const modal = openModal(`
    <h2>${t('editZonesBulk', { n: sids.length })}</h2><p>${t('zonesForSeats')}</p>${zoneCheckboxesHtml(new Set())}
    <div class="actions"><button id="bzCancel">${t('cancel')}</button><button id="bzOk" class="primary">${t('confirm')}</button></div>`);
  modal.querySelector('#bzCancel').onclick = closeModal;
  modal.querySelector('#bzOk').onclick = () => {
    const zones = [...modal.querySelectorAll('input[data-z]')].filter(c => c.checked).map(c => c.dataset.z);
    for (const sid of sids) { if (zones.length) App.room.seat_zones[sid] = [...zones]; else delete App.room.seat_zones[sid]; }
    markRoomDirty(); closeModal(); App.multiSelected = new Set(); renderAllRoomViews();
  };
}
function openAddGroupModal() {
  const modal = openModal(`
    <h2>${t('addGroupTitle')}</h2>
    <div class="row"><label>${t('seatsInGroup')}</label><input type="number" id="mgSeats" value="2" min="1" max="10"></div>
    <div class="row"><label>${t('seatsPerRow')}</label><input type="number" id="mgCols" value="2" min="1" max="6"></div>
    <div class="actions"><button id="mgCancel">${t('cancel')}</button><button id="mgOk" class="primary">${t('add')}</button></div>`);
  modal.querySelector('#mgCancel').onclick = closeModal;
  modal.querySelector('#mgOk').onclick = () => {
    const n = parseInt(modal.querySelector('#mgSeats').value) || 1, cols = parseInt(modal.querySelector('#mgCols').value) || 1;
    const count = Object.keys(App.room.groups).length;
    const { w: seatW, h: seatH } = computeSeatSize(App.data.students);
    const perRow = 4, stepX = seatW * 2 + GROUP_GAP, stepY = seatH * 2 + GROUP_GAP;
    const x = 20 + (count % perRow) * stepX, y = 20 + Math.floor(count / perRow) * stepY;
    addGroup(App.room, x, y, n, cols);
    markRoomDirty(); closeModal(); renderAllRoomViews();
  };
}
function openEditGroupModal(gid) {
  const g = App.room.groups[gid];
  const modal = openModal(`
    <h2>${t('editGroupTitle')}</h2>
    <div class="row"><label>${t('seatsInGroup')}</label><input type="number" id="egSeats" value="${g.seats.length}" min="1" max="10"></div>
    <div class="row"><label>${t('seatsPerRow')}</label><input type="number" id="egCols" value="${g.cols}" min="1" max="6"></div>
    <div class="actions"><button id="egRemove" class="danger">${t('removeGroupBtn')}</button><button id="egCancel">${t('cancel')}</button><button id="egOk" class="primary">${t('save')}</button></div>`);
  modal.querySelector('#egCancel').onclick = closeModal;
  modal.querySelector('#egRemove').onclick = () => { if (confirm(t('confirmRemoveGroup'))) { removeGroup(App.room, null, gid); markRoomDirty(); closeModal(); renderAllRoomViews(); renderPool(); } };
  modal.querySelector('#egOk').onclick = () => {
    resizeGroup(App.room, null, gid, parseInt(modal.querySelector('#egSeats').value) || 1, parseInt(modal.querySelector('#egCols').value) || 1);
    markRoomDirty(); closeModal(); renderAllRoomViews();
  };
}
function openQuickGridModal() {
  const modal = openModal(`
    <h2>${t('gridTitle')}</h2>
    <div class="row"><label>${t('gridRows')}</label><input type="number" id="qgRows" value="3" min="1" max="12"></div>
    <div class="row"><label>${t('gridCols')}</label><input type="number" id="qgCols" value="4" min="1" max="12"></div>
    <p><b>${t('gridStyle')}</b></p>
    <label style="display:block"><input type="radio" name="qgStyle" value="enkelt"> ${t('gridSingle')}</label>
    <label style="display:block"><input type="radio" name="qgStyle" value="par" checked> ${t('gridPair')}</label>
    <label style="display:block"><input type="radio" name="qgStyle" value="firar"> ${t('gridQuad')}</label>
    <button id="qgFitStudents" style="margin-top:.4rem">${t('gridFitStudents', { n: App.data.students.length })}</button>
    <label style="display:block;margin-top:.4rem"><input type="checkbox" id="qgExactFit"> ${t('gridExactFit')}</label>
    <p><b>${t('gridWindow')}</b></p>
    <label style="display:block"><input type="radio" name="qgWin" value="ingen" checked> ${t('winNone')}</label>
    <label style="display:block"><input type="radio" name="qgWin" value="venstre"> ${t('winLeft')}</label>
    <label style="display:block"><input type="radio" name="qgWin" value="hoyre"> ${t('winRight')}</label>
    <label style="display:block"><input type="radio" name="qgWin" value="begge"> ${t('winBoth')}</label>
    <div class="actions"><button id="qgCancel">${t('cancel')}</button><button id="qgOk" class="primary">${t('confirm')}</button></div>`);
  modal.querySelector('#qgFitStudents').onclick = () => {
    const style = modal.querySelector('input[name=qgStyle]:checked').value;
    const seatsPerTable = { enkelt: 1, par: 2, firar: 4 }[style];
    const n = Math.max(1, App.data.students.length);
    const tables = Math.max(1, Math.ceil(n / seatsPerTable));
    const cols = Math.max(1, Math.ceil(Math.sqrt(tables)));
    const rows = Math.max(1, Math.ceil(tables / cols));
    modal.querySelector('#qgRows').value = rows;
    modal.querySelector('#qgCols').value = cols;
    modal.querySelector('#qgExactFit').checked = true;
  };
  modal.querySelector('#qgCancel').onclick = closeModal;
  modal.querySelector('#qgOk').onclick = () => {
    const room = App.data, r = App.room;
    if (Object.keys(r.groups).length && !confirm(t('confirmOverwriteGrid'))) return;
    const rows = parseInt(modal.querySelector('#qgRows').value) || 1, cols = parseInt(modal.querySelector('#qgCols').value) || 1;
    const style = modal.querySelector('input[name=qgStyle]:checked').value, win = modal.querySelector('input[name=qgWin]:checked').value;
    const exactFit = modal.querySelector('#qgExactFit').checked;
    const [nSeats, colsInGroup] = { enkelt: [1, 1], par: [2, 2], firar: [4, 2] }[style];
    const { w: seatW, h: seatH } = computeSeatSize(App.data.students);
    const tableRows = Math.ceil(nSeats / colsInGroup);
    const tableW = colsInGroup * (seatW + SEAT_GAP) - SEAT_GAP, tableH = tableRows * (seatH + SEAT_GAP) - SEAT_GAP;
    const maxTables = exactFit ? Math.max(1, Math.ceil(App.data.students.length / nSeats)) : rows * cols;
    r.groups = {};
    const placed = [];
    outer:
    for (let tr = 0; tr < rows; tr++) for (let tc = 0; tc < cols; tc++) {
      if (placed.length >= maxTables) break outer;
      const gid = addGroup(r, 20 + tc * (tableW + GROUP_GAP), 20 + tr * (tableH + GROUP_GAP), nSeats, colsInGroup);
      placed.push({ gid, tr, tc });
    }
    const lastRow = Math.max(...placed.map(p => p.tr));
    for (const { gid, tr, tc } of placed) {
      const zones = [];
      if (tr === 0) zones.push('framme');
      if (tr === lastRow && lastRow > 0) zones.push('bak');
      if ((win === 'venstre' || win === 'begge') && tc === 0) zones.push('vindauge');
      if ((win === 'hoyre' || win === 'begge') && tc === cols - 1 && !zones.includes('vindauge')) zones.push('vindauge');
      if (zones.length) for (const sid of r.groups[gid].seats) r.seat_zones[sid] = zones;
    }
    markRoomDirty(); closeModal(); renderAllRoomViews(); renderPool();
  };
}
function openFullHistoryModal() {
  const room = App.room, cls = App.data;
  let rows = '';
  for (const name of cls.students) {
    const neigh = neighbourHistoryFor(room, cls, name).slice(0, 4).map(r => `${r.name} (${r.count}x)`).join(', ');
    const zh = zoneHistoryFor(room, cls, name);
    rows += `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(cls.genders[name] || '\u2013')}</td><td>${escapeHtml(neigh)}</td><td>${zh.framme}</td><td>${zh.bak}</td><td>${zh.vindauge}</td></tr>`;
  }
  let sessRows = '';
  for (const s of [...cls.sessions].reverse()) sessRows += `<tr><td>${new Date(s.timestamp).toLocaleString()}</td><td>${escapeHtml(s.label || '')}</td><td>${Object.keys(s.arrangement).length}</td></tr>`;
  const modal = openModal(`
    <h2>${t('fullHistory')}</h2><h3>${t('statsStudents')}</h3>
    <table class="stats"><thead><tr><th>${t('poolHeading')}</th><th>${t('gender')}</th><th>${t('seatWith')}</th>
    <th>${t('zoneFramme')}</th><th>${t('zoneBak')}</th><th>${t('zoneVindauge')}</th></tr></thead><tbody>${rows}</tbody></table>
    <h3>${t('statsSessions')} (${cls.sessions.length})</h3>
    <table class="stats"><tbody>${sessRows}</tbody></table>
    <div class="actions"><button id="fhClear" class="danger">${t('clearHistoryBtn')}</button><button id="fhClose" class="primary">${t('close')}</button></div>`);
  modal.querySelector('#fhClose').onclick = closeModal;
  modal.querySelector('#fhClear').onclick = () => { if (confirm(t('confirmClearHistory'))) { cls.sessions = []; saveCurrentClass(); closeModal(); } };
}

// -- Eksport: PNG (canvas) og tekst --
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function wrapText(ctx, text, cx, cy, maxW, lh) {
  if (ctx.measureText(text).width <= maxW) { ctx.fillText(text, cx, cy); return; }
  const words = text.split(' ');
  if (words.length < 2) { ctx.fillText(text, cx, cy); return; }
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const l1 = words.slice(0, i).join(' '), l2 = words.slice(i).join(' ');
    const w = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width);
    if (!best || w < best.w) best = { w, l1, l2 };
  }
  ctx.fillText(best.l1, cx, cy - lh / 2); ctx.fillText(best.l2, cx, cy + lh / 2);
}
function downloadDataUrl(url, filename) { const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); }

function isoWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}
function exportTitleLine() {
  const s = App.settings, now = new Date(), parts = [];
  if (s.exportClassName) { const c = Store.listClasses().find(c => c.id === App.classId); if (c) parts.push(c.name); }
  if (s.exportDate) parts.push(now.toLocaleDateString());
  if (s.exportTime) parts.push(now.toLocaleTimeString());
  if (s.exportWeek) parts.push(t('weekShort') + ' ' + isoWeekNumber(now));
  return parts.length ? `${t('appTitle')} \u2013 ${parts.join(' \u00b7 ')}` : t('appTitle');
}

// Teiknar eit reint bilete av plasseringa (berre tavle, plassar og namn -
// ingen soner, lås eller åtvaringar) til eit gjeve canvas. `flipped` er
// uavhengig av romet sitt gjeldande view_flipped, slik at førehandsvising
// kan snuast utan å påverke sjølve romet.
async function drawSeatingChart(canvas, flipped) {
  const room = App.room, cls = App.data, { w: seatW, h: seatH } = computeSeatSize(cls.students);
  const layoutRoom = { groups: room.groups, view_flipped: flipped };
  const { positions, boardRect, totalW, totalH } = computeLayout(layoutRoom, seatW, seatH);
  const titleH = 40;
  canvas.width = totalW; canvas.height = totalH + titleH;
  const ctx = canvas.getContext('2d');

  const cs = getComputedStyle(document.documentElement);
  const pageBg = cs.getPropertyValue('--page-bg').trim() || '#eef2f7';
  const ink = cs.getPropertyValue('--ink').trim() || '#111827';
  const muted = cs.getPropertyValue('--muted').trim() || '#9ca3af';
  const panelBg = cs.getPropertyValue('--panel-bg').trim() || '#ffffff';
  const panelBorder = cs.getPropertyValue('--panel-border').trim() || '#d1d5db';

  ctx.fillStyle = pageBg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (App.settings.bgImage) {
    await new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.max(canvas.width / img.width, canvas.height / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
        resolve();
      };
      img.onerror = resolve;
      img.src = App.settings.bgImage;
    });
  }
  ctx.fillStyle = ink; ctx.font = 'bold 16px "Segoe UI",Arial'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(exportTitleLine(), 16, 26);

  const [bx, by0, bw] = boardRect, by = by0 + titleH;
  roundRect(ctx, bx, by, bw, BOARD_H, 4); ctx.fillStyle = '#374151'; ctx.fill();
  ctx.fillStyle = 'white'; ctx.font = 'bold 12px "Segoe UI"'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(t('boardLabel'), bx + bw / 2, by + BOARD_H / 2);

  for (const g of Object.values(room.groups)) for (const sid of g.seats) {
    if (!positions[sid]) continue;
    const [px, py0] = positions[sid], py = py0 + titleH;
    const student = cls.arrangement[sid];
    roundRect(ctx, px, py, seatW, seatH, 8); ctx.fillStyle = panelBg; ctx.fill();
    ctx.strokeStyle = panelBorder; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = student ? ink : muted; ctx.font = (student ? 'bold ' : '') + '13px "Segoe UI"';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    wrapText(ctx, student || t('empty'), px + seatW / 2, py + seatH / 2, seatW - 12, 17);
  }
}
async function exportImage() {
  const canvas = document.createElement('canvas');
  await drawSeatingChart(canvas, App.room.view_flipped);
  downloadDataUrl(canvas.toDataURL('image/png'), 'klasseromplassering.png');
}
async function openImagePreviewModal() {
  let flipped = App.room.view_flipped;
  const modal = openModal(`
    <h2>${t('previewTitle')}</h2>
    <div class="row" style="margin-bottom:.6rem">
      <button id="pvFlip">${t('previewFlip')}</button>
      <button id="pvDownload" class="primary">${t('exportImage')}</button>
      <span class="spacer"></span>
      <button id="pvClose">${t('close')}</button>
    </div>
    <div id="pvCanvasWrap" style="max-height:75vh; overflow:auto; border:1px solid var(--panel-border); border-radius:8px; text-align:center;">
      <canvas id="pvCanvas" style="max-width:100%; height:auto; display:inline-block;"></canvas>
    </div>`);
  modal.style.maxWidth = '92vw';
  const canvas = modal.querySelector('#pvCanvas');
  const redraw = async () => { await drawSeatingChart(canvas, flipped); };
  await redraw();
  modal.querySelector('#pvFlip').onclick = async () => { flipped = !flipped; await redraw(); };
  modal.querySelector('#pvDownload').onclick = () => downloadDataUrl(canvas.toDataURL('image/png'), 'klasseromplassering.png');
  modal.querySelector('#pvClose').onclick = closeModal;
}
function exportText() {
  const room = App.room, cls = App.data;
  const lines = [exportTitleLine(), ''];
  const groups = Object.values(room.groups).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const g of groups) lines.push(`(${g.seats.length}): ${g.seats.map(sid => cls.arrangement[sid] || '\u2014').join(', ')}`);
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  downloadDataUrl(URL.createObjectURL(blob), 'plassering.txt');
}

// -- Elevpool og historikk-/infopanel --
function renderPool() {
  const wrap = document.getElementById('poolList');
  wrap.innerHTML = '';
  const filt = document.getElementById('poolSearch').value.trim().toLowerCase();
  const unseated = unseatedStudents(App.data);
  const shown = unseated.filter(n => !filt || n.toLowerCase().includes(filt));
  for (const name of shown) {
    const el = document.createElement('div');
    el.className = 'pool-item' + (App.armedStudent === name ? ' armed' : '') + (App.selectedStudent === name ? ' selected' : '');
    el.textContent = name;
    attachPoolEvents(el, name);
    wrap.appendChild(el);
  }
  if (!unseated.length) wrap.innerHTML = `<p class="hint">${t('allSeated')}</p>`;
  else if (!shown.length) wrap.innerHTML = `<p class="hint">${t('noMatch')}</p>`;
}
function renderStudentHistory(panel, name, showHeader) {
  const room = App.room, cls = App.data;
  if (showHeader) panel.innerHTML += `<h3>${escapeHtml(name)}</h3>`;
  const gender = cls.genders[name];
  if (gender) panel.innerHTML += `<p>${t('gender')}: ${escapeHtml(gender)}</p>`;
  const bl = blacklistPairsFor(cls, name);
  if (bl.length) panel.innerHTML += `<div class="blacklist-box"><b>${t('blacklistWith')}:</b> ${bl.map(escapeHtml).join(', ')}</div>`;
  const neigh = neighbourHistoryFor(room, cls, name);
  panel.innerHTML += `<p><b>${t('seatWith')}</b></p>`;
  if (!neigh.length) panel.innerHTML += `<p class="hint">${t('noHistory')}</p>`;
  else {
    const curSid = studentSeat(cls, name);
    const curNb = curSid ? new Set(neighbours(room, curSid).map(nb => cls.arrangement[nb]).filter(Boolean)) : new Set();
    for (const rec of neigh.slice(0, 5)) {
      const now = curNb.has(rec.name);
      panel.innerHTML += `<div class="neighbour-row${now ? ' now' : ''}">\u2022 ${escapeHtml(rec.name)} \u2014 ${rec.count}x${now ? ' (' + t('sitsNow') + ')' : ''}</div>`;
    }
  }
  const zh = zoneHistoryFor(room, cls, name);
  panel.innerHTML += `<p><b>${t('zonesHistory')}</b></p>`;
  for (const z of ZONES) panel.innerHTML += `<span class="zone-chip" style="background:${ZONE_COLORS[z]}">${t('zone' + z[0].toUpperCase() + z.slice(1))}: ${zh[z] || 0}</span>`;
  panel.innerHTML += `<label class="row" style="margin-top:.6rem">
    <input type="checkbox" id="heatmapToggle" ${App.heatmapStudent === name ? 'checked' : ''}> ${t('showHeatmap')}</label>
    <p class="hint">${t('heatmapHint')}</p>`;
  panel.querySelector('#heatmapToggle').onchange = e => {
    App.heatmapStudent = e.target.checked ? name : null;
    renderAllRoomViews();
  };
}
function renderInfoPanel() {
  const panel = document.getElementById('infoPanel');
  panel.innerHTML = '';
  const room = App.room, cls = App.data;
  if (App.selectedSeat) {
    const sid = App.selectedSeat, student = cls.arrangement[sid], zones = zonesFor(room, sid), locked = !!cls.locked[sid];
    const gid = groupOf(room, sid), n = gid ? room.groups[gid].seats.length : 1;
    panel.innerHTML += `<h3>${t('seatInGroup', { n })}</h3>`;
    panel.innerHTML += `<p>${zones.map(z => t('zone' + z[0].toUpperCase() + z.slice(1))).join(', ') || '\u2013'}</p>`;
    panel.innerHTML += `<p>${t('lockSeat')}: ${locked ? '\u2713' : '\u2013'}</p>`;
    if (student) renderStudentHistory(panel, student, false);
  } else if (App.selectedStudent) {
    renderStudentHistory(panel, App.selectedStudent, true);
  } else {
    panel.innerHTML = `<p class="hint">${t('historyEmptyHint')}</p>`;
  }
}

// -- Klasse-fane: klassar, elevar+kjønn (samla), svarteliste --
function renderClassTab() {
  const list = document.getElementById('classList');
  const classes = Store.listClasses(), defId = Store.getDefaultId();
  list.innerHTML = classes.length ? '' : `<p class="hint">${t('noClasses')}</p>`;
  for (const c of classes) {
    const row = document.createElement('div'); row.className = 'item' + (c.id === App.classId ? ' active' : '');
    row.innerHTML = `<span class="name">${escapeHtml(c.name)}</span>` + (c.id === defId ? `<span class="hint">(${t('defaultClass')})</span>` : '');
    row.onclick = () => switchClass(c.id);
    list.appendChild(row);
  }
  const sel = document.getElementById('classSelect');
  sel.innerHTML = '';
  for (const c of classes) sel.appendChild(new Option(c.name, c.id));
  sel.value = App.classId;

  document.getElementById('studentsText').value = App.data.students.join('\n');
  renderGenderList();
  renderBlacklistUI();
}
function renderGenderList() {
  const wrap = document.getElementById('genderList'); wrap.innerHTML = '';
  for (const name of App.data.students) {
    const row = document.createElement('div'); row.className = 'gender-row';
    const label = document.createElement('span'); label.className = 'name'; label.textContent = name;
    const sel = document.createElement('select');
    sel.appendChild(new Option(t('genderNone'), ''));
    sel.appendChild(new Option(t('genderGirl'), 'Jente'));
    sel.appendChild(new Option(t('genderBoy'), 'Gut'));
    sel.value = App.data.genders[name] || '';
    sel.onchange = () => { if (sel.value) App.data.genders[name] = sel.value; else delete App.data.genders[name]; saveCurrentClass(); };
    row.appendChild(label); row.appendChild(sel); wrap.appendChild(row);
  }
  if (!App.data.students.length) wrap.innerHTML = `<p class="hint">${t('noStudents')}</p>`;
}
function renderBlacklistUI() {
  const cls = App.data, sel = document.getElementById('blPickA');
  const prevVal = sel.value;
  sel.innerHTML = '';
  for (const name of cls.students) sel.appendChild(new Option(name, name));
  if (prevVal && cls.students.includes(prevVal)) sel.value = prevVal;
  renderBlacklistChecklist();
}
function renderBlacklistChecklist() {
  const cls = App.data, main = document.getElementById('blPickA').value;
  const wrap = document.getElementById('blacklistChecklist');
  wrap.innerHTML = '';
  if (!main) { wrap.innerHTML = `<p class="hint">${t('pickTwo')}</p>`; return; }
  const others = cls.students.filter(n => n !== main);
  if (!others.length) { wrap.innerHTML = `<p class="hint">${t('noStudents')}</p>`; return; }
  const already = new Set(blacklistPairsFor(cls, main));
  for (const name of others) {
    const row = document.createElement('label'); row.className = 'pair-row';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = already.has(name);
    cb.onchange = () => {
      if (cb.checked) addBlacklistPair(cls, main, name); else removeBlacklistPair(cls, main, name);
      saveCurrentClass(); renderAllRoomViews();
    };
    row.appendChild(cb); row.appendChild(document.createTextNode(' ' + name));
    wrap.appendChild(row);
  }
}

// -- Klasserom-fane: rom-veljar --
function renderRoomTab() {
  const rooms = Store.listRooms(), sel = document.getElementById('roomSelect');
  sel.innerHTML = '';
  for (const r of rooms) sel.appendChild(new Option(r.name, r.id));
  sel.value = App.roomId;
}

// -- Klasse-/rom-bytte og sjølvlækjande rom-tilknyting --
function syncFlipButton() {
  const btn = document.getElementById('btnFlipRoom');
  btn.classList.toggle('active', App.room.view_flipped);
  btn.textContent = App.room.view_flipped ? t('roomToolbarFlipToTop') : t('roomToolbarFlipToBottom');
}
function loadRoomForCurrentClass() {
  let roomId = App.data.room_id;
  let room = roomId ? Store.loadRoom(roomId) : null;
  if (!room) {
    roomId = Store.createRoom(t('newRoom'), { autoPopulateFor: App.data.students.length });
    App.data.room_id = roomId;
    // Romtilvisinga var ugyldig (sletta/manglar) - gamal plassering/lås/historikk
    // høyrer ikkje til det nye, tomme romet, så vi startar reint.
    App.data.arrangement = {}; App.data.locked = {}; App.data.sessions = [];
    saveCurrentClass();
    room = Store.loadRoom(roomId);
  }
  App.roomId = roomId; App.room = room;
}
function switchClass(id) {
  if (!confirmLeaveRoomDraft()) return false;
  App.classId = id;
  App.data = Store.loadClass(id) || newClassData();
  loadRoomForCurrentClass();
  App.selectedSeat = null; App.selectedStudent = null; App.multiSelected = new Set(); App.armedStudent = null;
  App.roomDirty = false; updateRoomDraftBar(); App.heatmapStudent = null;
  fillGenderModeSelect(); syncFlipButton();
  renderClassTab(); renderRoomTab(); renderAllRoomViews(); renderPool(); renderInfoPanel();
  return true;
}
function switchRoom(id) {
  if (!confirmLeaveRoomDraft()) return false;
  const room = Store.loadRoom(id);
  if (!room) return false;
  archiveCurrentRoomState(App.data);
  restoreRoomState(App.data, id);
  App.roomId = id; App.room = room;
  App.data.room_id = id;
  saveCurrentClass();
  App.selectedSeat = null; App.multiSelected = new Set();
  App.roomDirty = false; updateRoomDraftBar(); App.heatmapStudent = null;
  syncFlipButton(); renderRoomTab(); renderAllRoomViews(); renderPool(); renderInfoPanel();
  return true;
}
function saveCurrentClass() { if (App.classId) Store.saveClass(App.classId, App.data); }
function saveCurrentRoom() { if (App.roomId) Store.saveRoom(App.roomId, App.room); }

// -- Romutkast: endringar i romoppsettet (bordgrupper/soner/vend visning) er
// mellombelse til dei uttrykkeleg vert lagra eller forkasta. Låsing/tømming
// av plassar og elevplassering er derimot alltid umiddelbart lagra (dette er
// klasse-tilstand, ikkje romet sitt utsjånad).
function markRoomDirty() {
  App.roomDirty = true;
  updateRoomDraftBar();
}
function updateRoomDraftBar() {
  const bar = document.getElementById('roomDraftBar');
  if (bar) bar.classList.toggle('show', App.roomDirty);
}
function saveRoomDraft() {
  saveCurrentRoom();
  ensureConsistency(App.room, App.data);
  saveCurrentClass();
  App.roomDirty = false;
  updateRoomDraftBar();
  renderAllRoomViews(); renderPool(); renderInfoPanel();
  setStatus(t('roomChangesSaved'));
}
function discardRoomDraft() {
  App.room = Store.loadRoom(App.roomId) || newRoomData();
  ensureConsistency(App.room, App.data);
  saveCurrentClass();
  App.selectedSeat = null; App.multiSelected = new Set();
  App.roomDirty = false;
  syncFlipButton(); updateRoomDraftBar();
  renderAllRoomViews(); renderPool(); renderInfoPanel();
  setStatus(t('roomChangesDiscarded'));
}
function confirmLeaveRoomDraft() {
  if (!App.roomDirty) return true;
  return confirm(t('confirmDiscardRoomDraft'));
}

// -- Status og div. --
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function setStatus(text) { document.getElementById('statusBar').textContent = text; }
function updateStatusBar() {
  const cls = App.data;
  setStatus(`${cls.students.length} \u00b7 ${Object.keys(cls.arrangement).length}/${allSeatIds(App.room).length} \u00b7 ${Object.keys(App.room.groups).length}`);
}
function clampZoom(z) { return Math.max(0.5, Math.min(2, Math.round(z * 100) / 100)); }
function updateZoomLabel(which) {
  document.getElementById('zoomLabel' + which).textContent = Math.round((which === 'Room' ? App.zoomRoom : App.zoomSeat) * 100) + '%';
}
function fillGenderModeSelect() {
  const sel = document.getElementById('genderModeSelect'); sel.innerHTML = '';
  sel.appendChild(new Option(t('genderNone2'), 'ingen'));
  sel.appendChild(new Option(t('genderUnlike'), 'ulikt'));
  sel.appendChild(new Option(t('genderAlike'), 'likt'));
  sel.value = App.data.gender_weight_mode;
}

// -- Tema (fullstendige fargesett - lys/mørk/Catppuccin) --
const THEMES = {
  lys: { page: '#eef2f7', ink: '#111827', muted: '#6b7280', panel: '#ffffff', border: '#e5e7eb',
         input: '#ffffff', row: '#f9fafb', rowActive: '#dbeafe', glass: '255,255,255',
         header: 'rgba(17,24,39,.92)', accent: '#2563eb' },
  mork: { page: '#0f172a', ink: '#e5e7eb', muted: '#94a3b8', panel: '#1e293b', border: '#334155',
          input: '#1e293b', row: '#243244', rowActive: '#1e3a5f', glass: '30,41,59',
          header: 'rgba(2,6,23,.92)', accent: '#3b82f6' },
  catppuccin_mocha: { page: '#1e1e2e', ink: '#cdd6f4', muted: '#a6adc8', panel: '#181825', border: '#313244',
          input: '#313244', row: '#313244', rowActive: '#45475a', glass: '24,24,37',
          header: 'rgba(17,17,27,.92)', accent: '#89b4fa' },
  catppuccin_latte: { page: '#eff1f5', ink: '#4c4f69', muted: '#6c6f85', panel: '#ffffff', border: '#ccd0da',
          input: '#e6e9ef', row: '#e6e9ef', rowActive: '#ccd0da', glass: '255,255,255',
          header: 'rgba(76,79,105,.92)', accent: '#1e66f5' },
};
function shade(hex, pct) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) + Math.round(2.55 * pct), g = (n >> 8 & 0xff) + Math.round(2.55 * pct), b = (n & 0xff) + Math.round(2.55 * pct);
  r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
  return '#' + (0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1);
}
function applySettings(s) {
  const root = document.documentElement.style, th = THEMES[s.theme] || THEMES.lys;
  root.setProperty('--page-bg', th.page); root.setProperty('--ink', th.ink); root.setProperty('--muted', th.muted);
  root.setProperty('--panel-bg', th.panel); root.setProperty('--panel-border', th.border);
  root.setProperty('--input-bg', th.input); root.setProperty('--row-bg', th.row); root.setProperty('--row-active', th.rowActive);
  root.setProperty('--glass-rgb', th.glass); root.setProperty('--header-bg', th.header);
  root.setProperty('--accent', s.accent); root.setProperty('--accent-dark', shade(s.accent, -15));
  root.setProperty('--radius', s.radius + 'px'); root.setProperty('--blur', s.blur + 'px');
  root.setProperty('--opacity', s.opacity); root.setProperty('--ui-scale', s.uiScale); root.setProperty('--font-scale', s.fontScale);
  root.setProperty('--bg-image', s.bgImage ? `url(${s.bgImage})` : 'none');
}
function renderSettingsTab() {
  const s = App.settings;
  const cards = document.getElementById('themeCards'); cards.innerHTML = '';
  for (const key of Object.keys(THEMES)) {
    const th = THEMES[key];
    const c = document.createElement('div'); c.className = 'theme-card' + (s.theme === key ? ' active' : '');
    c.title = t('theme_' + key);
    c.innerHTML = `<div class="sw1" style="background:${th.page}"></div><div class="sw2" style="background:${th.panel}"></div>`;
    c.onclick = () => { s.theme = key; s.accent = th.accent; Store.saveSettings(s); applySettings(s); renderSettingsTab(); };
    cards.appendChild(c);
  }
  const sw = document.getElementById('accentSwatches'); sw.innerHTML = '';
  for (const c of ACCENT_PRESETS) {
    const d = document.createElement('div'); d.className = 'swatch' + (s.accent === c ? ' active' : ''); d.style.background = c;
    d.onclick = () => { s.accent = c; Store.saveSettings(s); applySettings(s); renderSettingsTab(); };
    sw.appendChild(d);
  }
  document.getElementById('accentCustom').value = s.accent;
  document.getElementById('radiusRange').value = s.radius;
  document.getElementById('blurRange').value = s.blur;
  document.getElementById('opacityRange').value = s.opacity;
  document.getElementById('uiScaleRange').value = s.uiScale;
  document.getElementById('fontScaleRange').value = s.fontScale;
  document.getElementById('seatSizeRange').value = s.seatSizeOverride || SEAT_W;
  document.getElementById('seatSizeAuto').checked = !s.seatSizeOverride;
  document.getElementById('seatSizeRange').disabled = !s.seatSizeOverride;
  document.getElementById('bgPreview').style.backgroundImage = s.bgImage ? `url(${s.bgImage})` : 'none';
  document.getElementById('exportDate').checked = !!s.exportDate;
  document.getElementById('exportTime').checked = !!s.exportTime;
  document.getElementById('exportWeek').checked = !!s.exportWeek;
  document.getElementById('exportClassName').checked = !!s.exportClassName;
}

// -- Panel: minimer/endre storleik (Plassering-fana) --
function toggleSidePanel(el, key) {
  const collapsed = el.classList.toggle('collapsed');
  App.settings[key] = collapsed; Store.saveSettings(App.settings);
  updateCollapseIcon(el);
}
function updateCollapseIcon(el) {
  const btn = el.querySelector('.collapse-btn');
  const collapsed = el.classList.contains('collapsed');
  const isLeftPanel = el.id === 'poolPanel'; // ligg til venstre - utvidar mot høgre
  btn.textContent = collapsed ? (isLeftPanel ? '\u25B6' : '\u25C0') : (isLeftPanel ? '\u25C0' : '\u25B6');
  btn.title = collapsed ? t('expandPanel') : t('collapsePanel');
}
function applyPanelCollapseState() {
  const pool = document.getElementById('poolPanel'), info = document.getElementById('infoPanelWrap');
  pool.classList.toggle('collapsed', !!App.settings.poolCollapsed);
  info.classList.toggle('collapsed', !!App.settings.infoCollapsed);
  updateCollapseIcon(pool); updateCollapseIcon(info);
}

// -- Språk --
function applyStaticTranslations() {
  document.documentElement.lang = currentLang;
  document.querySelectorAll('[data-i18n]').forEach(el => el.textContent = t(el.dataset.i18n));
  document.querySelectorAll('[data-lang]').forEach(btn => btn.classList.toggle('active', btn.dataset.lang === currentLang));
}
function refreshDynamicTexts() {
  fillGenderModeSelect(); renderClassTab(); renderRoomTab(); renderAllRoomViews(); renderPool(); renderInfoPanel(); renderSettingsTab();
  syncFlipButton(); applyPanelCollapseState();
}
function wireLangButtons() {
  document.querySelectorAll('[data-lang]').forEach(btn => btn.onclick = () => { setLang(btn.dataset.lang); applyStaticTranslations(); refreshDynamicTexts(); });
}

// -- Oppstart og hendingsbinding --
function wireEvents() {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.onclick = () => switchTab(btn.dataset.tab));

  // -- Klasse-fane --
  document.getElementById('btnNewClass').onclick = () => {
    if (!confirmLeaveRoomDraft()) return;
    const name = prompt(t('newClassPrompt'), t('newClass')); if (!name) return;
    App.roomDirty = false;
    switchClass(Store.createClass(name, null)); renderClassTab();
  };
  document.getElementById('btnRenameClass').onclick = () => {
    const cur = Store.listClasses().find(c => c.id === App.classId); if (!cur) return;
    const name = prompt(t('renameClassPrompt'), cur.name); if (!name) return;
    Store.renameClass(App.classId, name); renderClassTab();
  };
  document.getElementById('btnDuplicateClass').onclick = () => {
    if (!confirmLeaveRoomDraft()) return;
    App.roomDirty = false;
    const cur = Store.listClasses().find(c => c.id === App.classId);
    const id = Store.createClass((cur ? cur.name : 'Klasse') + ' (kopi)', App.data.room_id);
    const copy = JSON.parse(JSON.stringify(App.data));
    Store.saveClass(id, copy);
    switchClass(id); renderClassTab();
  };
  document.getElementById('btnDeleteClass').onclick = () => {
    const cur = Store.listClasses().find(c => c.id === App.classId); if (!cur) return;
    if (!confirmLeaveRoomDraft()) return;
    if (!confirm(t('deleteClassConfirm', { name: cur.name }))) return;
    App.roomDirty = false;
    Store.deleteClass(App.classId);
    const next = Store.getDefaultId();
    if (next) switchClass(next); else { const id = Store.createClass(t('newClass'), null); Store.setDefaultId(id); switchClass(id); }
    renderClassTab(); renderRoomTab(); renderAllRoomViews(); renderPool();
  };
  document.getElementById('btnSetDefault').onclick = () => { Store.setDefaultId(App.classId); renderClassTab(); };
  document.getElementById('btnExportClass').onclick = () => {
    const full = { ...App.data, version: CLASS_VERSION, room_id: null, room: App.room };
    const blob = new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' });
    downloadDataUrl(URL.createObjectURL(blob), 'klasse.json');
  };
  document.getElementById('btnImportClass').onclick = () => document.getElementById('importClassFile').click();
  document.getElementById('importClassFile').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      const { classData, embeddedRoom } = normalizeClassData(raw);
      const name = file.name.replace(/\.json$/i, '');
      let roomId = null;
      if (embeddedRoom) { roomId = Store.createRoom(name + ' - rom'); Store.saveRoom(roomId, embeddedRoom); }
      else if (raw.room && !classData.room_id) { roomId = Store.createRoom(name + ' - rom'); Store.saveRoom(roomId, raw.room); }
      classData.room_id = roomId || classData.room_id;
      const id = Store.createClass(name, classData.room_id);
      Store.saveClass(id, classData); switchClass(id); renderClassTab();
    } catch (err) { alert('Feil: ' + err.message); }
    e.target.value = '';
  };
  document.getElementById('classSelect').onchange = e => {
    if (switchClass(e.target.value)) renderClassTab(); else document.getElementById('classSelect').value = App.classId;
  };

  document.getElementById('btnSaveStudents').onclick = () => {
    const raw = document.getElementById('studentsText').value.split('\n');
    const seen = new Set(), list = [];
    for (const line of raw) { const n = line.trim(); if (n && !seen.has(n)) { seen.add(n); list.push(n); } }
    const removed = App.data.students.filter(s => !list.includes(s));
    for (const r of removed) for (const [sid, name] of Object.entries(App.data.arrangement)) if (name === r) delete App.data.arrangement[sid];
    App.data.students = list; ensureConsistency(App.room, App.data);
    saveCurrentClass(); renderClassTab(); renderAllRoomViews(); renderPool(); renderInfoPanel();
  };
  document.getElementById('btnImportStudents').onclick = () => document.getElementById('importStudentsFile').click();
  document.getElementById('importStudentsFile').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    const text = await file.text();
    const cur = document.getElementById('studentsText').value.trim();
    document.getElementById('studentsText').value = (cur ? cur + '\n' : '') + text.split('\n').map(l => l.trim()).filter(Boolean).join('\n');
    e.target.value = '';
  };
  document.getElementById('blPickA').onchange = renderBlacklistChecklist;

  // -- Klasserom-fane: rom-styring --
  document.getElementById('roomSelect').onchange = e => {
    if (!switchRoom(e.target.value)) document.getElementById('roomSelect').value = App.roomId;
  };
  document.getElementById('btnNewRoom').onclick = () => {
    const name = prompt(t('newRoomPrompt'), t('newRoom')); if (!name) return;
    const id = Store.createRoom(name, { autoPopulateFor: App.data.students.length });
    switchRoom(id); renderRoomTab();
  };
  document.getElementById('btnRenameRoom').onclick = () => {
    const cur = Store.listRooms().find(r => r.id === App.roomId); if (!cur) return;
    const name = prompt(t('renameRoomPrompt'), cur.name); if (!name) return;
    Store.renameRoom(App.roomId, name); renderRoomTab();
  };
  document.getElementById('btnDuplicateRoom').onclick = () => {
    const cur = Store.listRooms().find(r => r.id === App.roomId);
    const id = Store.duplicateRoom(App.roomId, (cur ? cur.name : 'Rom') + ' (kopi)');
    if (id) { switchRoom(id); renderRoomTab(); }
  };
  document.getElementById('btnDeleteRoom').onclick = () => {
    const cur = Store.listRooms().find(r => r.id === App.roomId); if (!cur) return;
    if (!confirm(t('deleteRoomConfirm', { name: cur.name }))) return;
    const deletedId = App.roomId;
    const inUse = Store.roomsInUseBy(deletedId).filter(c => c.id !== App.classId);
    Store.deleteRoom(deletedId);
    for (const c of inUse) { const cd = Store.loadClass(c.id); if (cd) { cd.room_id = null; Store.saveClass(c.id, cd); } }
    for (const c of Store.listClasses()) {
      const cd = Store.loadClass(c.id);
      if (cd && cd.room_states && cd.room_states[deletedId]) { delete cd.room_states[deletedId]; Store.saveClass(c.id, cd); }
    }
    delete App.data.room_states[deletedId];
    App.roomDirty = false;
    loadRoomForCurrentClass(); syncFlipButton(); updateRoomDraftBar(); renderRoomTab(); renderAllRoomViews(); renderPool();
  };
  document.getElementById('btnAddGroup').onclick = openAddGroupModal;
  document.getElementById('btnQuickGrid').onclick = openQuickGridModal;
  document.getElementById('btnSeatMenu').onclick = openMenuForSelection;
  document.getElementById('btnBulkZones').onclick = openBulkZonesModal;
  document.getElementById('btnClearSelection').onclick = clearSelection;
  document.getElementById('btnAutoFrontBack').onclick = () => {
    autoTagFrontBack(App.room);
    markRoomDirty();
    renderAllRoomViews();
  };
  document.getElementById('btnMergeGroups').onclick = doMergeSelectedGroups;
  document.getElementById('btnSplitGroups').onclick = doSplitSelectedSeats;
  document.getElementById('btnSaveRoomDraft').onclick = saveRoomDraft;
  document.getElementById('btnDiscardRoomDraft').onclick = discardRoomDraft;
  document.getElementById('btnFlipRoom').onclick = () => {
    App.room.view_flipped = !App.room.view_flipped;
    syncFlipButton(); markRoomDirty(); renderAllRoomViews();
  };
  document.getElementById('zoomInRoom').onclick = () => { App.zoomRoom = clampZoom(App.zoomRoom + .1); updateZoomLabel('Room'); renderRoom('roomCanvasA', 'layout', App.zoomRoom); };
  document.getElementById('zoomOutRoom').onclick = () => { App.zoomRoom = clampZoom(App.zoomRoom - .1); updateZoomLabel('Room'); renderRoom('roomCanvasA', 'layout', App.zoomRoom); };
  document.getElementById('zoomResetRoom').onclick = () => { App.zoomRoom = 1; updateZoomLabel('Room'); renderRoom('roomCanvasA', 'layout', App.zoomRoom); };
  document.getElementById('zoomInSeat').onclick = () => { App.zoomSeat = clampZoom(App.zoomSeat + .1); updateZoomLabel('Seat'); renderRoom('roomCanvasB', 'seating', App.zoomSeat); };
  document.getElementById('zoomOutSeat').onclick = () => { App.zoomSeat = clampZoom(App.zoomSeat - .1); updateZoomLabel('Seat'); renderRoom('roomCanvasB', 'seating', App.zoomSeat); };
  document.getElementById('zoomResetSeat').onclick = () => { App.zoomSeat = 1; updateZoomLabel('Seat'); renderRoom('roomCanvasB', 'seating', App.zoomSeat); };
  document.getElementById('roomScrollA').addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); App.zoomRoom = clampZoom(App.zoomRoom + (e.deltaY < 0 ? .1 : -.1)); updateZoomLabel('Room'); renderRoom('roomCanvasA', 'layout', App.zoomRoom); } }, { passive: false });
  document.getElementById('roomScrollB').addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); App.zoomSeat = clampZoom(App.zoomSeat + (e.deltaY < 0 ? .1 : -.1)); updateZoomLabel('Seat'); renderRoom('roomCanvasB', 'seating', App.zoomSeat); } }, { passive: false });

  // -- Plasserings-fane --
  document.getElementById('btnRandom').onclick = () => {
    const room = App.room, cls = App.data;
    if (!cls.students.length) { alert(t('noStudents')); return; }
    if (!Object.keys(room.groups).length) { alert(t('noGroups')); return; }
    const totalSeats = allSeatIds(room).length;
    if (cls.students.length > totalSeats && !confirm(t('tooFewSeats', { students: cls.students.length, seats: totalSeats }))) return;
    cls.arrangement = generateArrangement(room, cls, { genders: cls.genders, genderMode: cls.gender_weight_mode });
    saveCurrentClass(); App.selectedSeat = null;
    renderAllRoomViews(); renderPool(); renderInfoPanel();
    const viol = blacklistViolationSeats(room, cls, cls.arrangement);
    if (Object.keys(viol).length) {
      const pairs = new Set();
      for (const [sid, others] of Object.entries(viol)) { const name = cls.arrangement[sid]; for (const o of others) pairs.add([name, o].sort().join(' & ')); }
      alert(t('blacklistUnavoidable') + '\n' + [...pairs].join('\n'));
    }
  };
  document.getElementById('btnClearArrangement').onclick = () => {
    if (!Object.keys(App.data.arrangement).length || !confirm(t('confirmClearArrangement'))) return;
    App.data.arrangement = {}; saveCurrentClass(); renderAllRoomViews(); renderPool(); renderInfoPanel();
  };
  document.getElementById('btnSaveHistory').onclick = () => {
    if (!Object.keys(App.data.arrangement).length) return;
    recordSession(App.data, prompt(t('sessionLabelPrompt'), '') || '');
    saveCurrentClass(); renderInfoPanel();
  };
  document.getElementById('genderModeSelect').onchange = e => { App.data.gender_weight_mode = e.target.value; saveCurrentClass(); };
  document.getElementById('poolSearch').oninput = renderPool;
  document.getElementById('btnFullHistory').onclick = openFullHistoryModal;
  document.getElementById('btnPreviewImage').onclick = openImagePreviewModal;
  document.getElementById('btnExportImage').onclick = exportImage;
  document.getElementById('btnExportText').onclick = exportText;
  document.getElementById('poolCollapseBtn').onclick = () => toggleSidePanel(document.getElementById('poolPanel'), 'poolCollapsed');
  document.getElementById('infoCollapseBtn').onclick = () => toggleSidePanel(document.getElementById('infoPanelWrap'), 'infoCollapsed');

  // -- Innstillingar --
  document.getElementById('accentCustom').oninput = e => { App.settings.accent = e.target.value; Store.saveSettings(App.settings); applySettings(App.settings); };
  document.getElementById('radiusRange').oninput = e => { App.settings.radius = +e.target.value; Store.saveSettings(App.settings); applySettings(App.settings); };
  document.getElementById('blurRange').oninput = e => { App.settings.blur = +e.target.value; Store.saveSettings(App.settings); applySettings(App.settings); };
  document.getElementById('opacityRange').oninput = e => { App.settings.opacity = +e.target.value; Store.saveSettings(App.settings); applySettings(App.settings); };
  document.getElementById('uiScaleRange').oninput = e => { App.settings.uiScale = +e.target.value; Store.saveSettings(App.settings); applySettings(App.settings); };
  document.getElementById('fontScaleRange').oninput = e => { App.settings.fontScale = +e.target.value; Store.saveSettings(App.settings); applySettings(App.settings); };
  document.getElementById('seatSizeAuto').onchange = e => {
    App.settings.seatSizeOverride = e.target.checked ? null : parseInt(document.getElementById('seatSizeRange').value);
    Store.saveSettings(App.settings); document.getElementById('seatSizeRange').disabled = e.target.checked;
    renderAllRoomViews();
  };
  document.getElementById('seatSizeRange').oninput = e => {
    App.settings.seatSizeOverride = +e.target.value; Store.saveSettings(App.settings); renderAllRoomViews();
  };
  for (const [id, key] of [['exportDate', 'exportDate'], ['exportTime', 'exportTime'], ['exportWeek', 'exportWeek'], ['exportClassName', 'exportClassName']]) {
    document.getElementById(id).onchange = e => { App.settings[key] = e.target.checked; Store.saveSettings(App.settings); };
  }
  document.getElementById('btnUploadBg').onclick = () => document.getElementById('bgFile').click();
  document.getElementById('bgFile').onchange = e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1600 / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = img.width * scale; canvas.height = img.height * scale;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        App.settings.bgImage = canvas.toDataURL('image/jpeg', .82);
        Store.saveSettings(App.settings); applySettings(App.settings); renderSettingsTab();
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file); e.target.value = '';
  };
  document.getElementById('btnRemoveBg').onclick = () => { App.settings.bgImage = null; Store.saveSettings(App.settings); applySettings(App.settings); renderSettingsTab(); };
  document.getElementById('btnResetSettings').onclick = () => { App.settings = defaultSettings(); Store.saveSettings(App.settings); applySettings(App.settings); renderSettingsTab(); applyPanelCollapseState(); };
  document.getElementById('btnFeedback').onclick = () => {
    const subject = encodeURIComponent(t('appTitle') + ' - tilbakemelding');
    window.location.href = `mailto:klasserom.strongly541@simplelogin.com?subject=${subject}`;
  };
  document.getElementById('btnResetAll').onclick = openResetAllModal;
  document.getElementById('btnBackupDownload').onclick = downloadBackup;
  document.getElementById('btnBackupImport').onclick = () => document.getElementById('backupFile').click();
  document.getElementById('backupFile').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try { await openBackupImportModal(JSON.parse(await file.text())); }
    catch (err) { alert(t('backupInvalid')); }
    e.target.value = '';
  };

  wireLangButtons();
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      App.armedStudent = null; App.selectedSeat = null; App.selectedStudent = null; App.multiSelected = new Set();
      renderAllRoomViews(); renderPool(); renderInfoPanel(); closeModal();
    }
  });
}
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tabview').forEach(v => v.classList.toggle('active', v.id === 'tab-' + name));
}

// -- Nullstill alt (krev at brukaren skriv eit stadfestingsord - vernar mot uhell) --
function openResetAllModal() {
  const word = t('resetConfirmWord');
  const modal = openModal(`
    <h2 style="color:#ef4444">${t('resetConfirmTitle')}</h2>
    <p>${t('resetConfirmText')}</p>
    <p>${t('resetConfirmTypeHint')}</p>
    <input type="text" id="resetConfirmInput" style="width:100%" autocomplete="off">
    <div class="actions"><button id="resetCancel">${t('cancel')}</button><button id="resetOk" class="danger" disabled>${t('resetConfirmButton')}</button></div>`);
  const input = modal.querySelector('#resetConfirmInput'), okBtn = modal.querySelector('#resetOk');
  input.oninput = () => { okBtn.disabled = input.value.trim().toUpperCase() !== word; };
  modal.querySelector('#resetCancel').onclick = closeModal;
  okBtn.onclick = () => { localStorage.clear(); location.reload(); };
  input.focus();
}

// -- Sikkerheitskopi: last ned alt, og importer valde delar frå ei fil --
function gatherBackup() {
  const idx = loadIndex(), roomIdx = loadRoomIndex();
  const classes = {}, rooms = {};
  for (const id of idx.order) { const c = Store.loadClass(id); if (c) classes[id] = { name: idx.names[id], data: c }; }
  for (const id of roomIdx.order) { const r = Store.loadRoom(id); if (r) rooms[id] = { name: roomIdx.names[id], data: r }; }
  return { type: 'krp-backup', version: 1, defaultClassId: idx.defaultId, classes, rooms, settings: App.settings };
}
function downloadBackup() {
  const blob = new Blob([JSON.stringify(gatherBackup(), null, 2)], { type: 'application/json' });
  downloadDataUrl(URL.createObjectURL(blob), 'klasseromplassering-backup.json');
}
async function openBackupImportModal(backup) {
  if (!backup || backup.type !== 'krp-backup' || !backup.classes || !backup.rooms) { alert(t('backupInvalid')); return; }
  const classEntries = Object.entries(backup.classes), roomEntries = Object.entries(backup.rooms);
  const classRoomMap = {}; // klasse-id -> rom-id (i sikkerheitskopien) - for auto-avkryssing
  for (const [id, c] of classEntries) classRoomMap[id] = c.data.room_id;

  const classRows = classEntries.map(([id, c]) =>
    `<label style="display:block"><input type="checkbox" class="bkClass" data-id="${id}" checked> ${escapeHtml(c.name)}</label>`).join('');
  const roomRows = roomEntries.map(([id, r]) =>
    `<label style="display:block"><input type="checkbox" class="bkRoom" data-id="${id}" checked> ${escapeHtml(r.name)}</label>`).join('');

  const modal = openModal(`
    <h2>${t('backupImportTitle')}</h2>
    <p class="hint">${t('backupImportHelp')}</p>
    <div class="row"><button id="bkAll">${t('backupSelectAll')}</button><button id="bkNone">${t('backupSelectNone')}</button></div>
    <h3>${t('backupClasses')} (${classEntries.length})</h3>
    <div style="max-height:180px; overflow:auto">${classRows || '<p class="hint">-</p>'}</div>
    <h3>${t('backupRooms')} (${roomEntries.length})</h3>
    <div style="max-height:180px; overflow:auto">${roomRows || '<p class="hint">-</p>'}</div>
    <div class="actions"><button id="bkCancel">${t('cancel')}</button><button id="bkOk" class="primary">${t('backupImportConfirm')}</button></div>`);

  modal.querySelectorAll('.bkClass').forEach(cb => cb.onchange = () => {
    if (!cb.checked) return;
    const roomId = classRoomMap[cb.dataset.id];
    const roomCb = modal.querySelector(`.bkRoom[data-id="${roomId}"]`);
    if (roomCb) roomCb.checked = true;
  });
  modal.querySelector('#bkAll').onclick = () => modal.querySelectorAll('.bkClass,.bkRoom').forEach(cb => cb.checked = true);
  modal.querySelector('#bkNone').onclick = () => modal.querySelectorAll('.bkClass,.bkRoom').forEach(cb => cb.checked = false);
  modal.querySelector('#bkCancel').onclick = closeModal;
  modal.querySelector('#bkOk').onclick = () => {
    const chosenClasses = [...modal.querySelectorAll('.bkClass:checked')].map(cb => cb.dataset.id);
    const chosenRooms = [...modal.querySelectorAll('.bkRoom:checked')].map(cb => cb.dataset.id);
    if (!chosenClasses.length && !chosenRooms.length) { alert(t('backupNoneSelected')); return; }

    // rom først (klassar kan vise til dei), behald id om ledig, elles nytt
    const roomIdMap = {};
    for (const oldId of chosenRooms) {
      const entry = backup.rooms[oldId];
      const newRoomIdVal = Store.loadRoom(oldId) ? newId('r') : oldId;
      Store.saveRoom(newRoomIdVal, entry.data);
      const idx = loadRoomIndex(); idx.order.push(newRoomIdVal); idx.names[newRoomIdVal] = entry.name; saveRoomIndex(idx);
      roomIdMap[oldId] = newRoomIdVal;
    }
    let lastImportedClassId = null;
    for (const oldId of chosenClasses) {
      const entry = backup.classes[oldId];
      const cls = JSON.parse(JSON.stringify(entry.data));
      if (cls.room_id && roomIdMap[cls.room_id]) cls.room_id = roomIdMap[cls.room_id];
      else if (cls.room_id && !Store.loadRoom(cls.room_id)) cls.room_id = null; // romet vart ikkje valt/finst ikkje
      const newClassIdVal = Store.loadClass(oldId) ? newId('c') : oldId;
      Store.saveClass(newClassIdVal, cls);
      const idx = loadIndex(); idx.order.push(newClassIdVal); idx.names[newClassIdVal] = entry.name; saveIndex(idx);
      lastImportedClassId = newClassIdVal;
    }
    closeModal();
    setStatus(t('backupDone'));
    if (lastImportedClassId) switchClass(lastImportedClassId);
    renderClassTab();
  };
}


function init() {
  App.settings = Store.getSettings();
  applySettings(App.settings);
  applyStaticTranslations();
  wireEvents();
  renderSettingsTab();
  applyPanelCollapseState();
  updateZoomLabel('Room'); updateZoomLabel('Seat');

  let defId = Store.getDefaultId();
  if (!defId) defId = Store.createClass(t('newClass'), null);
  switchClass(defId);

  window.addEventListener('beforeunload', e => {
    if (App.roomDirty) { e.preventDefault(); e.returnValue = ''; }
  });
}
window.addEventListener('DOMContentLoaded', init);
