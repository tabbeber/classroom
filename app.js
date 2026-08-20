// ===================================================================
// app.js - appstyring: tilstand, teikning av rom, drag, dialogar
// ===================================================================

const MARGIN = 20, BOARD_H = 30, GROUP_GAP = 40, DRAG_T = 6;
const ACCENT_PRESETS = ['#2563eb', '#16a34a', '#7c3aed', '#ea580c', '#db2777', '#475569'];

const App = {
  classId: null, data: null, settings: null,
  zoomRoom: 1, zoomSeat: 1,
  selectedSeat: null, selectedStudent: null,
  multiSelected: new Set(), armedStudent: null,
  drag: null, ctxMenu: null,
};

// -- Tekstmåling og layout-utrekning (speglar Python-versjonen) --
let _measureCtx = null;
function measureCtx() {
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
  return _measureCtx;
}
function computeSeatSize(students) {
  const ctx = measureCtx();
  ctx.font = "bold 10pt 'Segoe UI'";
  let w = SEAT_W;
  if (students.length) {
    const longest = Math.max(...students.map(s => ctx.measureText(s).width));
    w = Math.max(100, Math.min(220, longest + 34));
  }
  return { w, h: Math.round(w / (SEAT_W / SEAT_H)) };
}
function computeLayout(d, seatW, seatH) {
  const raw = {}; let maxX = 0, maxY = 0;
  for (const g of Object.values(d.groups)) {
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
  if (!d.view_flipped) {
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

// -- Teikning av klasserom (delt av Klasserom- og Plasserings-fana) --
function buildSeatEl(sid, mode, w, h, repeatWarn, blWarn) {
  const d = App.data, student = d.arrangement[sid], locked = !!d.locked[sid], zones = zonesFor(d, sid);
  const el = document.createElement('div');
  el.className = 'seat' + (student ? '' : ' empty');
  if (locked) el.classList.add('locked');
  if (mode === 'layout') el.classList.add('layout-mode');
  if (App.multiSelected.has(sid)) el.classList.add('multi');
  else if (App.selectedSeat === sid) el.classList.add('selected');
  el.style.width = w + 'px'; el.style.height = h + 'px';
  el.dataset.sid = sid;

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

function renderRoom(containerId, mode, zoom) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  _seatElCache[containerId] = {};
  const d = App.data, { w: seatW, h: seatH } = computeSeatSize(d.students);
  const { positions, boardRect, totalW, totalH } = computeLayout(d, seatW, seatH);
  container.style.width = (totalW * zoom) + 'px'; container.style.height = (totalH * zoom) + 'px';

  const [bx, by, bw] = boardRect;
  const board = document.createElement('div'); board.className = 'board'; board.textContent = t('boardLabel');
  board.style.left = (bx * zoom) + 'px'; board.style.top = (by * zoom) + 'px';
  board.style.width = (bw * zoom) + 'px'; board.style.height = Math.max(18, BOARD_H * zoom) + 'px';
  container.appendChild(board);
  _boardElCache[containerId] = board;

  if (!Object.keys(d.groups).length) {
    const hint = document.createElement('p'); hint.className = 'hint';
    hint.style.position = 'absolute'; hint.style.left = (bx * zoom) + 'px'; hint.style.top = (by * zoom + BOARD_H * zoom + 16) + 'px';
    hint.style.width = Math.max(bw, 260) + 'px'; hint.textContent = t('roomEmptyHint');
    container.appendChild(hint);
    return;
  }
  const repeatWarn = mode === 'seating' ? repeatNeighbourSeats(d, d.arrangement) : {};
  const blWarn = mode === 'seating' ? blacklistViolationSeats(d, d.arrangement) : {};
  for (const g of Object.values(d.groups)) {
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
  const d = App.data, { w: seatW, h: seatH } = computeSeatSize(d.students);
  const { positions, boardRect, totalW, totalH } = computeLayout(d, seatW, seatH);
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
}
function renderAllRoomViews() {
  renderRoom('roomCanvasA', 'layout', App.zoomRoom);
  renderRoom('roomCanvasB', 'seating', App.zoomSeat);
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

function attachSeatEvents(el, sid, mode) {
  el.addEventListener('pointerdown', e => onSeatPointerDown(e, sid, mode));
  el.addEventListener('contextmenu', e => { e.preventDefault(); openSeatContextMenu(e, sid); });
}
function onSeatPointerDown(e, sid, mode) {
  if (e.button !== 0) return;
  if (e.ctrlKey || e.metaKey) { toggleMultiSelect(sid); return; }
  e.preventDefault();
  const el = e.currentTarget, d = App.data;
  if (mode === 'layout') {
    const gid = groupOf(d, sid); if (!gid) return;
    const g = d.groups[gid];
    App.drag = { kind: 'group', gid, sid, startX: e.clientX, startY: e.clientY, origX: g.x, origY: g.y, dragging: false, zoom: App.zoomRoom };
  } else {
    App.drag = { kind: 'seat', sid, startX: e.clientX, startY: e.clientY, dragging: false, locked: !!d.locked[sid] };
  }
  el.setPointerCapture(e.pointerId);
  el.addEventListener('pointermove', onSeatPointerMove);
  el.addEventListener('pointerup', onSeatPointerUp);
}
function onSeatPointerMove(e) {
  const drag = App.drag; if (!drag) return;
  const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
  if (drag.kind === 'group') {
    if (!drag.dragging) { if (Math.abs(dx) < DRAG_T && Math.abs(dy) < DRAG_T) return; drag.dragging = true; }
    const sign = App.data.view_flipped ? -1 : 1;
    moveGroup(App.data, drag.gid, Math.max(0, drag.origX + dx / drag.zoom), Math.max(0, drag.origY + sign * (dy / drag.zoom)));
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

  if (drag.kind === 'group') {
    if (drag.dragging) { saveCurrentClass(); renderAllRoomViews(); }
    else { App.selectedSeat = drag.sid; renderAllRoomViews(); }
    return;
  }
  destroyGhost();
  if (drag.locked) { App.selectedSeat = drag.sid; renderInfoPanel(); renderAllRoomViews(); return; }
  if (drag.dragging) {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const seatEl = target && target.closest('.seat');
    const poolEl = target && target.closest('.pool-list');
    handleSeatDrop(drag.sid, seatEl ? seatEl.dataset.sid : null, !!poolEl);
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
  const d = App.data, gid = groupOf(d, targetSeat); if (!gid) return [];
  const blSet = blacklistSet(d); if (!blSet.size) return [];
  const hits = [];
  for (const sib of d.groups[gid].seats) {
    if (sib === targetSeat || sib === excludeSid) continue;
    const other = d.arrangement[sib];
    if (other && blSet.has([student, other].sort().join('||'))) hits.push(other);
  }
  return hits;
}
function placeStudent(student, targetSeat) {
  const d = App.data;
  if (d.locked[targetSeat]) { setStatus(t('lockSeat')); return; }
  const hits = wouldViolateBlacklist(student, targetSeat);
  if (hits.length && !confirm(`${student} ${t('blacklistWith')} ${hits.join(', ')}. ${t('confirm')}?`)) return;
  const old = studentSeat(d, student); if (old) delete d.arrangement[old];
  d.arrangement[targetSeat] = student;
  saveCurrentClass(); renderAllRoomViews(); renderPool(); renderInfoPanel();
}
function moveOrSwap(sourceSid, targetSeat) {
  const d = App.data;
  if (d.locked[targetSeat]) { setStatus(t('lockSeat')); return; }
  const moving = d.arrangement[sourceSid];
  const hits = wouldViolateBlacklist(moving, targetSeat, sourceSid);
  if (hits.length && !confirm(`${moving} ${t('blacklistWith')} ${hits.join(', ')}. ${t('confirm')}?`)) return;
  const other = d.arrangement[targetSeat];
  if (other) d.arrangement[sourceSid] = other; else delete d.arrangement[sourceSid];
  d.arrangement[targetSeat] = moving;
  saveCurrentClass(); renderAllRoomViews(); renderPool(); renderInfoPanel();
}
function handleSeatDrop(sourceSid, targetSid, inPool) {
  const d = App.data, student = d.arrangement[sourceSid]; if (!student) return;
  if (targetSid && targetSid !== sourceSid) moveOrSwap(sourceSid, targetSid);
  else if (inPool) { delete d.arrangement[sourceSid]; saveCurrentClass(); renderAllRoomViews(); renderPool(); renderInfoPanel(); }
}

// -- Høgreklikk-meny --
function closeContextMenu() { if (App.ctxMenu) { App.ctxMenu.remove(); App.ctxMenu = null; } }
function openSeatContextMenu(e, sid) {
  closeContextMenu();
  const d = App.data, menu = document.createElement('div');
  menu.className = 'panel';
  Object.assign(menu.style, { position: 'fixed', left: e.clientX + 'px', top: e.clientY + 'px', zIndex: 200, minWidth: '230px', padding: '.3rem' });
  const items = [];
  if (App.multiSelected.size > 1 && App.multiSelected.has(sid)) items.push([t('editZonesBulk', { n: App.multiSelected.size }), openBulkZonesModal]);
  const locked = !!d.locked[sid];
  items.push([locked ? t('unlockSeat') : t('lockSeat'), () => { d.locked[sid] = !locked; saveCurrentClass(); renderAllRoomViews(); }]);
  items.push([t('editZones'), () => openEditZonesModal(sid)]);
  if (d.arrangement[sid]) items.push([t('clearSeat'), () => { delete d.arrangement[sid]; saveCurrentClass(); renderAllRoomViews(); renderPool(); }]);
  const gid = groupOf(d, sid);
  if (gid) {
    items.push([t('selectGroup'), () => { App.multiSelected = new Set(d.groups[gid].seats); renderAllRoomViews(); }]);
    items.push([t('editGroup'), () => openEditGroupModal(gid)]);
    items.push([t('removeGroupBtn'), () => { if (confirm(t('confirmRemoveGroup'))) { removeGroup(d, gid); saveCurrentClass(); renderAllRoomViews(); renderPool(); } }]);
  }
  for (const [label, fn] of items) {
    const b = document.createElement('button'); b.textContent = label;
    Object.assign(b.style, { display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', borderRadius: '6px' });
    b.onmouseenter = () => b.style.background = '#f3f4f6'; b.onmouseleave = () => b.style.background = 'transparent';
    b.onclick = () => { closeContextMenu(); fn(); };
    menu.appendChild(b);
  }
  document.body.appendChild(menu); App.ctxMenu = menu;
  setTimeout(() => document.addEventListener('mousedown', closeContextMenu, { once: true }), 0);
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
  const d = App.data, current = new Set(zonesFor(d, sid));
  const modal = openModal(`
    <h2>${t('editZones')}</h2>${zoneCheckboxesHtml(current)}
    <label style="display:block;margin-top:.5rem"><input type="checkbox" id="ezLock" ${d.locked[sid] ? 'checked' : ''}> ${t('lockSeat')}</label>
    <div class="actions"><button id="ezCancel">${t('cancel')}</button><button id="ezOk" class="primary">${t('save')}</button></div>`);
  modal.querySelector('#ezCancel').onclick = closeModal;
  modal.querySelector('#ezOk').onclick = () => {
    const zones = [...modal.querySelectorAll('input[data-z]')].filter(c => c.checked).map(c => c.dataset.z);
    if (zones.length) d.seat_zones[sid] = zones; else delete d.seat_zones[sid];
    d.locked[sid] = modal.querySelector('#ezLock').checked;
    saveCurrentClass(); closeModal(); renderAllRoomViews();
  };
}
function openBulkZonesModal() {
  const sids = [...App.multiSelected].filter(s => groupOf(App.data, s));
  if (!sids.length) { alert(t('roomHint')); return; }
  const modal = openModal(`
    <h2>${t('editZonesBulk', { n: sids.length })}</h2><p>${t('zonesForSeats')}</p>${zoneCheckboxesHtml(new Set())}
    <div class="actions"><button id="bzCancel">${t('cancel')}</button><button id="bzOk" class="primary">${t('confirm')}</button></div>`);
  modal.querySelector('#bzCancel').onclick = closeModal;
  modal.querySelector('#bzOk').onclick = () => {
    const zones = [...modal.querySelectorAll('input[data-z]')].filter(c => c.checked).map(c => c.dataset.z);
    for (const sid of sids) { if (zones.length) App.data.seat_zones[sid] = [...zones]; else delete App.data.seat_zones[sid]; }
    saveCurrentClass(); closeModal(); App.multiSelected = new Set(); renderAllRoomViews();
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
    const count = Object.keys(App.data.groups).length;
    const x = 20 + (count * 24) % 400, y = 20 + Math.floor((count * 24) / 400) * 140;
    addGroup(App.data, x, y, n, cols);
    saveCurrentClass(); closeModal(); renderAllRoomViews();
  };
}
function openEditGroupModal(gid) {
  const g = App.data.groups[gid];
  const modal = openModal(`
    <h2>${t('editGroupTitle')}</h2>
    <div class="row"><label>${t('seatsInGroup')}</label><input type="number" id="egSeats" value="${g.seats.length}" min="1" max="10"></div>
    <div class="row"><label>${t('seatsPerRow')}</label><input type="number" id="egCols" value="${g.cols}" min="1" max="6"></div>
    <div class="actions"><button id="egRemove" class="danger">${t('removeGroupBtn')}</button><button id="egCancel">${t('cancel')}</button><button id="egOk" class="primary">${t('save')}</button></div>`);
  modal.querySelector('#egCancel').onclick = closeModal;
  modal.querySelector('#egRemove').onclick = () => { if (confirm(t('confirmRemoveGroup'))) { removeGroup(App.data, gid); saveCurrentClass(); closeModal(); renderAllRoomViews(); renderPool(); } };
  modal.querySelector('#egOk').onclick = () => {
    resizeGroup(App.data, gid, parseInt(modal.querySelector('#egSeats').value) || 1, parseInt(modal.querySelector('#egCols').value) || 1);
    saveCurrentClass(); closeModal(); renderAllRoomViews();
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
    <p><b>${t('gridWindow')}</b></p>
    <label style="display:block"><input type="radio" name="qgWin" value="ingen" checked> ${t('winNone')}</label>
    <label style="display:block"><input type="radio" name="qgWin" value="venstre"> ${t('winLeft')}</label>
    <label style="display:block"><input type="radio" name="qgWin" value="hoyre"> ${t('winRight')}</label>
    <label style="display:block"><input type="radio" name="qgWin" value="begge"> ${t('winBoth')}</label>
    <div class="actions"><button id="qgCancel">${t('cancel')}</button><button id="qgOk" class="primary">${t('confirm')}</button></div>`);
  modal.querySelector('#qgCancel').onclick = closeModal;
  modal.querySelector('#qgOk').onclick = () => {
    const d = App.data;
    if (Object.keys(d.groups).length && !confirm(t('confirmOverwriteGrid'))) return;
    const rows = parseInt(modal.querySelector('#qgRows').value) || 1, cols = parseInt(modal.querySelector('#qgCols').value) || 1;
    const style = modal.querySelector('input[name=qgStyle]:checked').value, win = modal.querySelector('input[name=qgWin]:checked').value;
    const [nSeats, colsInGroup] = { enkelt: [1, 1], par: [2, 2], firar: [4, 2] }[style];
    const { w: seatW, h: seatH } = computeSeatSize(d.students);
    const tableRows = Math.ceil(nSeats / colsInGroup);
    const tableW = colsInGroup * (seatW + SEAT_GAP) - SEAT_GAP, tableH = tableRows * (seatH + SEAT_GAP) - SEAT_GAP;
    d.groups = {};
    for (let tr = 0; tr < rows; tr++) for (let tc = 0; tc < cols; tc++) {
      const gid = addGroup(d, 20 + tc * (tableW + GROUP_GAP), 20 + tr * (tableH + GROUP_GAP), nSeats, colsInGroup);
      const zones = [];
      if (tr === 0) zones.push('framme');
      if (tr === rows - 1 && rows > 1) zones.push('bak');
      if ((win === 'venstre' || win === 'begge') && tc === 0) zones.push('vindauge');
      if ((win === 'hoyre' || win === 'begge') && tc === cols - 1 && !zones.includes('vindauge')) zones.push('vindauge');
      if (zones.length) for (const sid of d.groups[gid].seats) d.seat_zones[sid] = zones;
    }
    ensureConsistency(d); saveCurrentClass(); closeModal(); renderAllRoomViews(); renderPool();
  };
}
function openFullHistoryModal() {
  const d = App.data;
  let rows = '';
  for (const name of d.students) {
    const neigh = neighbourHistoryFor(d, name).slice(0, 4).map(r => `${r.name} (${r.count}x)`).join(', ');
    const zh = zoneHistoryFor(d, name);
    rows += `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(d.genders[name] || '\u2013')}</td><td>${escapeHtml(neigh)}</td><td>${zh.framme}</td><td>${zh.bak}</td><td>${zh.vindauge}</td></tr>`;
  }
  let sessRows = '';
  for (const s of [...d.sessions].reverse()) sessRows += `<tr><td>${new Date(s.timestamp).toLocaleString()}</td><td>${escapeHtml(s.label || '')}</td><td>${Object.keys(s.arrangement).length}</td></tr>`;
  const modal = openModal(`
    <h2>${t('fullHistory')}</h2><h3>${t('statsStudents')}</h3>
    <table class="stats"><thead><tr><th>${t('poolHeading')}</th><th>${t('gender')}</th><th>${t('seatWith')}</th>
    <th>${t('zoneFramme')}</th><th>${t('zoneBak')}</th><th>${t('zoneVindauge')}</th></tr></thead><tbody>${rows}</tbody></table>
    <h3>${t('statsSessions')} (${d.sessions.length})</h3>
    <table class="stats"><tbody>${sessRows}</tbody></table>
    <div class="actions"><button id="fhClear" class="danger">${t('clearHistoryBtn')}</button><button id="fhClose" class="primary">${t('close')}</button></div>`);
  modal.querySelector('#fhClose').onclick = closeModal;
  modal.querySelector('#fhClear').onclick = () => { if (confirm(t('confirmClearHistory'))) { d.sessions = []; saveCurrentClass(); closeModal(); } };
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

function exportImage() {
  const d = App.data, { w: seatW, h: seatH } = computeSeatSize(d.students);
  const { positions, boardRect, totalW, totalH } = computeLayout(d, seatW, seatH);
  const titleH = 40;
  const canvas = document.createElement('canvas');
  canvas.width = totalW; canvas.height = totalH + titleH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#eef2f7'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111827'; ctx.font = 'bold 16px "Segoe UI",Arial'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${t('appTitle')} \u2013 ${new Date().toLocaleString()}`, 16, 26);

  const [bx, by0, bw] = boardRect, by = by0 + titleH;
  roundRect(ctx, bx, by, bw, BOARD_H, 4); ctx.fillStyle = '#374151'; ctx.fill();
  ctx.fillStyle = 'white'; ctx.font = 'bold 12px "Segoe UI"'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(t('boardLabel'), bx + bw / 2, by + BOARD_H / 2);

  const repeatWarn = repeatNeighbourSeats(d, d.arrangement), blWarn = blacklistViolationSeats(d, d.arrangement);
  for (const g of Object.values(d.groups)) for (const sid of g.seats) {
    if (!positions[sid]) continue;
    const [px, py0] = positions[sid], py = py0 + titleH;
    const student = d.arrangement[sid], locked = !!d.locked[sid], zones = zonesFor(d, sid);
    roundRect(ctx, px, py, seatW, seatH, 8); ctx.fillStyle = 'white'; ctx.fill();
    ctx.strokeStyle = locked ? '#9ca3af' : '#d1d5db'; ctx.lineWidth = 2; ctx.stroke();
    let zx = px + 6;
    for (const z of zones) {
      roundRect(ctx, zx, py + 6, 16, 14, 2); ctx.fillStyle = ZONE_COLORS[z]; ctx.fill();
      ctx.fillStyle = 'white'; ctx.font = 'bold 8px "Segoe UI"'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(z[0].toUpperCase(), zx + 8, py + 13); zx += 20;
    }
    if (locked) { ctx.fillStyle = '#4b5563'; ctx.font = 'bold 8px "Segoe UI"'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(t('locked'), px + seatW - 6, py + 13); }
    ctx.fillStyle = student ? '#111827' : '#9ca3af'; ctx.font = (student ? 'bold ' : '') + '13px "Segoe UI"';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    wrapText(ctx, student || t('empty'), px + seatW / 2, py + seatH / 2, seatW - 12, 17);
    const hits = blWarn[sid];
    if (hits) {
      ctx.fillStyle = '#fecaca'; ctx.fillRect(px, py + seatH - 16, seatW, 16);
      ctx.fillStyle = '#7f1d1d'; ctx.font = 'bold 7px "Segoe UI"';
      ctx.fillText(t('blacklistWarn', { names: hits.join(', ') }), px + seatW / 2, py + seatH - 8);
    } else if (repeatWarn[sid]) {
      ctx.fillStyle = '#fee2e2'; ctx.fillRect(px, py + seatH - 16, seatW, 16);
      ctx.fillStyle = '#b91c1c'; ctx.font = 'bold 7px "Segoe UI"';
      ctx.fillText(t('obsWarn'), px + seatW / 2, py + seatH - 8);
    }
  }
  downloadDataUrl(canvas.toDataURL('image/png'), 'klasseromplassering.png');
}
function exportText() {
  const d = App.data;
  const lines = [`${t('appTitle')} \u2013 ${new Date().toLocaleString()}`, ''];
  const groups = Object.values(d.groups).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const g of groups) lines.push(`(${g.seats.length}): ${g.seats.map(sid => d.arrangement[sid] || '\u2014').join(', ')}`);
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
  const d = App.data;
  if (showHeader) panel.innerHTML += `<h3>${escapeHtml(name)}</h3>`;
  const gender = d.genders[name];
  if (gender) panel.innerHTML += `<p>${t('gender')}: ${escapeHtml(gender)}</p>`;
  const bl = blacklistPairsFor(d, name);
  if (bl.length) panel.innerHTML += `<div class="blacklist-box"><b>${t('blacklistWith')}:</b> ${bl.map(escapeHtml).join(', ')}</div>`;
  const neigh = neighbourHistoryFor(d, name);
  panel.innerHTML += `<p><b>${t('seatWith')}</b></p>`;
  if (!neigh.length) panel.innerHTML += `<p class="hint">${t('noHistory')}</p>`;
  else {
    const curSid = studentSeat(d, name);
    const curNb = curSid ? new Set(neighbours(d, curSid).map(nb => d.arrangement[nb]).filter(Boolean)) : new Set();
    for (const rec of neigh.slice(0, 5)) {
      const now = curNb.has(rec.name);
      panel.innerHTML += `<div class="neighbour-row${now ? ' now' : ''}">\u2022 ${escapeHtml(rec.name)} \u2014 ${rec.count}x${now ? ' (' + t('sitsNow') + ')' : ''}</div>`;
    }
  }
  const zh = zoneHistoryFor(d, name);
  panel.innerHTML += `<p><b>${t('zonesHistory')}</b></p>`;
  for (const z of ZONES) panel.innerHTML += `<span class="zone-chip" style="background:${ZONE_COLORS[z]}">${t('zone' + z[0].toUpperCase() + z.slice(1))}: ${zh[z] || 0}</span>`;
}
function renderInfoPanel() {
  const panel = document.getElementById('infoPanel');
  panel.innerHTML = '';
  const d = App.data;
  if (App.selectedSeat) {
    const sid = App.selectedSeat, student = d.arrangement[sid], zones = zonesFor(d, sid), locked = !!d.locked[sid];
    const gid = groupOf(d, sid), n = gid ? d.groups[gid].seats.length : 1;
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

// -- Klasse-fane: klassar, elevar, kjønn, svarteliste --
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
}
function renderBlacklistUI() {
  const a = document.getElementById('blPickA'), b = document.getElementById('blPickB');
  a.innerHTML = ''; b.innerHTML = '';
  for (const name of App.data.students) { a.appendChild(new Option(name, name)); b.appendChild(new Option(name, name)); }
  const list = document.getElementById('blacklistList'); list.innerHTML = '';
  for (const [x, y] of App.data.blacklist) {
    const row = document.createElement('div'); row.className = 'pair-row';
    const span = document.createElement('span'); span.textContent = `${x} \u2716 ${y}`;
    const btn = document.createElement('button'); btn.className = 'danger'; btn.textContent = t('removePair');
    btn.onclick = () => { removeBlacklistPair(App.data, x, y); saveCurrentClass(); renderBlacklistUI(); renderAllRoomViews(); };
    row.appendChild(span); row.appendChild(btn); list.appendChild(row);
  }
}

// -- Klassehandtering (skiftar/lagar/slettar) --
function switchClass(id) {
  App.classId = id;
  App.data = Store.loadClass(id) || newClassData();
  App.selectedSeat = null; App.selectedStudent = null; App.multiSelected = new Set(); App.armedStudent = null;
  fillGenderModeSelect();
  renderClassTab(); renderAllRoomViews(); renderPool(); renderInfoPanel();
}
function saveCurrentClass() { if (App.classId) Store.saveClass(App.classId, App.data); }

// -- Status og div. --
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function setStatus(text) { document.getElementById('statusBar').textContent = text; }
function updateStatusBar() {
  const d = App.data;
  setStatus(`${d.students.length} \u00b7 ${Object.keys(d.arrangement).length}/${allSeatIds(d).length} \u00b7 ${Object.keys(d.groups).length}`);
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

// -- Innstillingar / tema --
function shade(hex, pct) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) + Math.round(2.55 * pct), g = (n >> 8 & 0xff) + Math.round(2.55 * pct), b = (n & 0xff) + Math.round(2.55 * pct);
  r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
  return '#' + (0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1);
}
function applySettings(s) {
  const root = document.documentElement.style;
  root.setProperty('--accent', s.accent); root.setProperty('--accent-dark', shade(s.accent, -15));
  root.setProperty('--radius', s.radius + 'px'); root.setProperty('--blur', s.blur + 'px');
  root.setProperty('--opacity', s.opacity); root.setProperty('--ui-scale', s.uiScale); root.setProperty('--font-scale', s.fontScale);
  root.setProperty('--bg-image', s.bgImage ? `url(${s.bgImage})` : 'none');
}
function renderSettingsTab() {
  const s = App.settings;
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
  document.getElementById('bgPreview').style.backgroundImage = s.bgImage ? `url(${s.bgImage})` : 'none';
}

// -- Språk --
function applyStaticTranslations() {
  document.documentElement.lang = currentLang;
  document.querySelectorAll('[data-i18n]').forEach(el => el.textContent = t(el.dataset.i18n));
  document.querySelectorAll('[data-lang]').forEach(btn => btn.classList.toggle('active', btn.dataset.lang === currentLang));
}
function refreshDynamicTexts() {
  fillGenderModeSelect(); renderClassTab(); renderAllRoomViews(); renderPool(); renderInfoPanel(); renderSettingsTab();
}
function wireLangButtons() {
  document.querySelectorAll('[data-lang]').forEach(btn => btn.onclick = () => { setLang(btn.dataset.lang); applyStaticTranslations(); refreshDynamicTexts(); });
}

// -- Oppstart og hendingsbinding --
function wireEvents() {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.onclick = () => switchTab(btn.dataset.tab));

  document.getElementById('btnNewClass').onclick = () => {
    const name = prompt(t('newClassPrompt'), t('newClass')); if (!name) return;
    switchClass(Store.createClass(name)); renderClassTab();
  };
  document.getElementById('btnRenameClass').onclick = () => {
    const cur = Store.listClasses().find(c => c.id === App.classId); if (!cur) return;
    const name = prompt(t('renameClassPrompt'), cur.name); if (!name) return;
    Store.renameClass(App.classId, name); renderClassTab();
  };
  document.getElementById('btnDuplicateClass').onclick = () => {
    const cur = Store.listClasses().find(c => c.id === App.classId);
    const id = Store.createClass((cur ? cur.name : 'Klasse') + ' (kopi)');
    Store.saveClass(id, JSON.parse(JSON.stringify(App.data)));
    switchClass(id); renderClassTab();
  };
  document.getElementById('btnDeleteClass').onclick = () => {
    const cur = Store.listClasses().find(c => c.id === App.classId); if (!cur) return;
    if (!confirm(t('deleteClassConfirm', { name: cur.name }))) return;
    Store.deleteClass(App.classId);
    const next = Store.getDefaultId();
    if (next) switchClass(next); else { App.classId = Store.createClass(t('newClass')); App.data = Store.loadClass(App.classId); Store.setDefaultId(App.classId); }
    renderClassTab(); renderAllRoomViews(); renderPool();
  };
  document.getElementById('btnSetDefault').onclick = () => { Store.setDefaultId(App.classId); renderClassTab(); };
  document.getElementById('btnExportClass').onclick = () => {
    const blob = new Blob([JSON.stringify(App.data, null, 2)], { type: 'application/json' });
    downloadDataUrl(URL.createObjectURL(blob), 'klasse.json');
  };
  document.getElementById('btnImportClass').onclick = () => document.getElementById('importClassFile').click();
  document.getElementById('importClassFile').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const data = normalizeClassData(JSON.parse(await file.text()));
      const id = Store.createClass(file.name.replace(/\.json$/i, ''));
      Store.saveClass(id, data); switchClass(id); renderClassTab();
    } catch (err) { alert('Feil: ' + err.message); }
    e.target.value = '';
  };
  document.getElementById('classSelect').onchange = e => { switchClass(e.target.value); renderClassTab(); };

  document.getElementById('btnSaveStudents').onclick = () => {
    const raw = document.getElementById('studentsText').value.split('\n');
    const seen = new Set(), list = [];
    for (const line of raw) { const n = line.trim(); if (n && !seen.has(n)) { seen.add(n); list.push(n); } }
    const removed = App.data.students.filter(s => !list.includes(s));
    for (const r of removed) for (const [sid, name] of Object.entries(App.data.arrangement)) if (name === r) delete App.data.arrangement[sid];
    App.data.students = list; ensureConsistency(App.data);
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
  document.getElementById('btnAddPair').onclick = () => {
    const a = document.getElementById('blPickA').value, b = document.getElementById('blPickB').value;
    if (!a || !b || a === b) { alert(t('pickTwo')); return; }
    if (!addBlacklistPair(App.data, a, b)) { alert(t('pairExists')); return; }
    saveCurrentClass(); renderBlacklistUI(); renderAllRoomViews();
  };

  document.getElementById('btnAddGroup').onclick = openAddGroupModal;
  document.getElementById('btnQuickGrid').onclick = openQuickGridModal;
  document.getElementById('btnBulkZones').onclick = openBulkZonesModal;
  document.getElementById('btnFlipRoom').onclick = () => {
    App.data.view_flipped = !App.data.view_flipped;
    document.getElementById('btnFlipRoom').classList.toggle('active', App.data.view_flipped);
    saveCurrentClass(); renderAllRoomViews();
  };
  document.getElementById('zoomInRoom').onclick = () => { App.zoomRoom = clampZoom(App.zoomRoom + .1); updateZoomLabel('Room'); renderRoom('roomCanvasA', 'layout', App.zoomRoom); };
  document.getElementById('zoomOutRoom').onclick = () => { App.zoomRoom = clampZoom(App.zoomRoom - .1); updateZoomLabel('Room'); renderRoom('roomCanvasA', 'layout', App.zoomRoom); };
  document.getElementById('zoomResetRoom').onclick = () => { App.zoomRoom = 1; updateZoomLabel('Room'); renderRoom('roomCanvasA', 'layout', App.zoomRoom); };
  document.getElementById('zoomInSeat').onclick = () => { App.zoomSeat = clampZoom(App.zoomSeat + .1); updateZoomLabel('Seat'); renderRoom('roomCanvasB', 'seating', App.zoomSeat); };
  document.getElementById('zoomOutSeat').onclick = () => { App.zoomSeat = clampZoom(App.zoomSeat - .1); updateZoomLabel('Seat'); renderRoom('roomCanvasB', 'seating', App.zoomSeat); };
  document.getElementById('zoomResetSeat').onclick = () => { App.zoomSeat = 1; updateZoomLabel('Seat'); renderRoom('roomCanvasB', 'seating', App.zoomSeat); };
  document.getElementById('roomScrollA').addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); App.zoomRoom = clampZoom(App.zoomRoom + (e.deltaY < 0 ? .1 : -.1)); updateZoomLabel('Room'); renderRoom('roomCanvasA', 'layout', App.zoomRoom); } }, { passive: false });
  document.getElementById('roomScrollB').addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); App.zoomSeat = clampZoom(App.zoomSeat + (e.deltaY < 0 ? .1 : -.1)); updateZoomLabel('Seat'); renderRoom('roomCanvasB', 'seating', App.zoomSeat); } }, { passive: false });

  document.getElementById('btnRandom').onclick = () => {
    const d = App.data;
    if (!d.students.length) { alert(t('noStudents')); return; }
    if (!Object.keys(d.groups).length) { alert(t('noGroups')); return; }
    const totalSeats = allSeatIds(d).length;
    if (d.students.length > totalSeats && !confirm(t('tooFewSeats', { students: d.students.length, seats: totalSeats }))) return;
    d.arrangement = generateArrangement(d, { genders: d.genders, genderMode: d.gender_weight_mode });
    saveCurrentClass(); App.selectedSeat = null;
    renderAllRoomViews(); renderPool(); renderInfoPanel();
    const viol = blacklistViolationSeats(d, d.arrangement);
    if (Object.keys(viol).length) {
      const pairs = new Set();
      for (const [sid, others] of Object.entries(viol)) { const name = d.arrangement[sid]; for (const o of others) pairs.add([name, o].sort().join(' & ')); }
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
  document.getElementById('btnExportImage').onclick = exportImage;
  document.getElementById('btnExportText').onclick = exportText;

  document.getElementById('accentCustom').oninput = e => { App.settings.accent = e.target.value; Store.saveSettings(App.settings); applySettings(App.settings); };
  document.getElementById('radiusRange').oninput = e => { App.settings.radius = +e.target.value; Store.saveSettings(App.settings); applySettings(App.settings); };
  document.getElementById('blurRange').oninput = e => { App.settings.blur = +e.target.value; Store.saveSettings(App.settings); applySettings(App.settings); };
  document.getElementById('opacityRange').oninput = e => { App.settings.opacity = +e.target.value; Store.saveSettings(App.settings); applySettings(App.settings); };
  document.getElementById('uiScaleRange').oninput = e => { App.settings.uiScale = +e.target.value; Store.saveSettings(App.settings); applySettings(App.settings); };
  document.getElementById('fontScaleRange').oninput = e => { App.settings.fontScale = +e.target.value; Store.saveSettings(App.settings); applySettings(App.settings); };
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
  document.getElementById('btnResetSettings').onclick = () => { App.settings = defaultSettings(); Store.saveSettings(App.settings); applySettings(App.settings); renderSettingsTab(); };

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

function init() {
  App.settings = Store.getSettings();
  applySettings(App.settings);
  applyStaticTranslations();
  wireEvents();
  renderSettingsTab();
  updateZoomLabel('Room'); updateZoomLabel('Seat');

  let defId = Store.getDefaultId();
  if (!defId) defId = Store.createClass(t('newClass'));
  switchClass(defId);
}
window.addEventListener('DOMContentLoaded', init);
