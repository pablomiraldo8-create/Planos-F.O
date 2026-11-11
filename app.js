/* Mapa de Trazas – FO Tigo  ·  app.js */
'use strict';

// ============ util ============
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const DEG = Math.PI / 180;
function meters(a, b) { // [lng,lat]
  const k = Math.cos(((a[1] + b[1]) / 2) * DEG);
  return Math.hypot((a[0] - b[0]) * 111320 * k, (a[1] - b[1]) * 110540);
}
function loading(on, txt) { $('#loading').classList.toggle('hidden', !on); if (txt) $('#loadingText').textContent = txt; }
function hint(txt) { const h = $('#toolHint'); h.textContent = txt || ''; h.classList.toggle('hidden', !txt); }
function fmtDate(d = new Date()) { return d.toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
function timeout(p, ms) { return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]); }

// ============ settings ============
const DEFAULTS = {
  names: true, riskColors: true, red: 5, orange: 20,
  title: 'Red de Fibra Óptica – Ubicación de traza',
  company: 'Tigo Uruguay',
  author: 'Pablo Miraldo – Mantenimiento de Fibra Óptica',
  contact: 'Tel. 094 940 082 · Pmiraldo@hansa.uy',
  note: 'Ubicación aproximada. Las líneas punteadas son tramos estimados entre cámaras. Ante cualquier duda solicitar presencia en obra antes de excavar.'
};
let S = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('settings') || '{}'));
const saveS = () => localStorage.setItem('settings', JSON.stringify(S));

// ============ IndexedDB ============
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('mapaTrazas', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('layers', { keyPath: 'id' });
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(mode) { return this.db.transaction('layers', mode).objectStore('layers'); },
  all() { return new Promise((res, rej) => { const q = this.tx('readonly').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  put(v) { return new Promise((res, rej) => { const q = this.tx('readwrite').put(v); q.onsuccess = res; q.onerror = () => rej(q.error); }); },
  del(id) { return new Promise((res, rej) => { const q = this.tx('readwrite').delete(id); q.onsuccess = res; q.onerror = () => rej(q.error); }); }
};

// ============ map ============
const map = L.map('map', { zoomControl: false, preferCanvas: true, maxZoom: 20, worldCopyJump: false }).setView([-34.86, -56.17], 13);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);
[['basePane', 410], ['obraPane', 420], ['riskPane', 430], ['annPane', 440], ['lblPane', 450]].forEach(([n, z]) => { map.createPane(n).style.zIndex = z; });
map.getPane('lblPane').style.pointerEvents = 'none';
const R_BASE = L.canvas({ pane: 'basePane', tolerance: 6 });
const R_OBRA = L.canvas({ pane: 'obraPane', tolerance: 6 });
const R_RISK = L.canvas({ pane: 'riskPane', tolerance: 4 });

const BASES = {
  calles: [{ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', max: 19, attr: '© OpenStreetMap' }],
  claro: [{ url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', max: 20, attr: '© OpenStreetMap © CARTO' }],
  sat: [{ url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', max: 19, attr: '© Esri, Maxar' },
        { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png', max: 20, attr: '© CARTO' }]
};
let baseKey = localStorage.getItem('baseKey') || 'calles', baseLayers = [];
function setBase(k) {
  baseKey = k; localStorage.setItem('baseKey', k);
  baseLayers.forEach(l => map.removeLayer(l));
  baseLayers = BASES[k].map(b => L.tileLayer(b.url, { maxZoom: 20, maxNativeZoom: b.max, attribution: b.attr, crossOrigin: 'anonymous', subdomains: 'abcd' }).addTo(map));
  $$('#baseSwitch button').forEach(b => b.classList.toggle('on', b.dataset.base === k));
}
setBase(baseKey);
$('#baseSwitch').onclick = e => { if (e.target.dataset.base) setBase(e.target.dataset.base); };

// ============ KML parsing ============
function kmlColor(c) { // aabbggrr -> {color, opacity}
  c = (c || '').trim(); if (!/^[0-9a-f]{8}$/i.test(c)) return null;
  return { color: '#' + c.slice(6, 8) + c.slice(4, 6) + c.slice(2, 4), opacity: parseInt(c.slice(0, 2), 16) / 255 };
}
function kids(el, tag) { return [...el.children].filter(c => c.localName === tag); }
function kid(el, tag) { return [...el.children].find(c => c.localName === tag); }
function ktext(el, tag) { const k = el && kid(el, tag); return k ? k.textContent.trim() : ''; }
function parseCoords(t) { return t.trim().split(/\s+/).map(s => s.split(',').map(Number)).filter(a => a.length >= 2 && !isNaN(a[0]) && !isNaN(a[1])).map(a => [+a[0].toFixed(7), +a[1].toFixed(7)]); }

function parseKML(text, fileName) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length && !doc.getElementsByTagName('Placemark').length) throw new Error('El archivo KML no se pudo leer');
  const styles = {}, maps = {};
  const readStyle = st => {
    const o = {};
    const ls = st.getElementsByTagName('LineStyle')[0];
    if (ls) { const c = kmlColor(ktext(ls, 'color')); if (c) { o.color = c.color; o.opacity = c.opacity; } const w = parseFloat(ktext(ls, 'width')); if (w) o.weight = w; }
    const ps = st.getElementsByTagName('PolyStyle')[0];
    if (ps) { const c = kmlColor(ktext(ps, 'color')); if (c) { o.fill = c.color; o.fillOpacity = c.opacity; } if (ktext(ps, 'fill') === '0') o.fillOpacity = 0; }
    const is = st.getElementsByTagName('IconStyle')[0];
    if (is) {
      const c = kmlColor(ktext(is, 'color')); if (c) o.pcolor = c.color;
      const sc = parseFloat(ktext(is, 'scale')); if (sc) o.pscale = sc;
      const href = (is.getElementsByTagName('href')[0] || {}).textContent || '';
      o.shape = /triangle/.test(href) ? 'tri' : /square/.test(href) ? 'sq' : /caution/.test(href) ? 'warn' : 'dot';
    }
    return o;
  };
  for (const st of doc.getElementsByTagName('Style')) if (st.getAttribute('id')) styles[st.getAttribute('id')] = readStyle(st);
  for (const sm of doc.getElementsByTagName('StyleMap')) {
    for (const p of sm.getElementsByTagName('Pair')) if (ktext(p, 'key') === 'normal') maps[sm.getAttribute('id')] = ktext(p, 'styleUrl').replace(/^.*#/, '');
  }
  const styleOf = pm => {
    let s = {};
    const url = ktext(pm, 'styleUrl').replace(/^.*#/, '');
    if (url) s = Object.assign({ sid: url }, styles[maps[url] || url] || {});
    const inl = kid(pm, 'Style'); if (inl) Object.assign(s, readStyle(inl));
    return s;
  };
  const geoms = (g, out) => {
    switch (g.localName) {
      case 'Point': { const c = parseCoords(ktext(g, 'coordinates')); if (c.length) out.push({ t: 'P', c: c[0] }); break; }
      case 'LineString': { const c = parseCoords(ktext(g, 'coordinates')); if (c.length > 1) out.push({ t: 'L', c }); break; }
      case 'LinearRing': { const c = parseCoords(ktext(g, 'coordinates')); if (c.length > 2) out.push({ t: 'L', c }); break; }
      case 'Polygon': {
        const ob = g.getElementsByTagName('outerBoundaryIs')[0];
        const ring = ob && ob.getElementsByTagName('coordinates')[0];
        if (ring) { const c = parseCoords(ring.textContent); if (c.length > 2) out.push({ t: 'A', c }); }
        break;
      }
      case 'MultiGeometry': case 'MultiTrack': for (const k of g.children) geoms(k, out); break;
      case 'Track': {
        const cs = [...g.getElementsByTagNameNS('*', 'coord')].map(e => e.textContent.trim().split(/\s+/).map(Number)).map(a => [a[0], a[1]]);
        if (cs.length > 1) out.push({ t: 'L', c: cs }); break;
      }
    }
  };
  let n = 0;
  const walk = (el, node, path) => {
    for (const c of el.children) {
      if (c.localName === 'Folder' || c.localName === 'Document') {
        const name = ktext(c, 'name') || 'Carpeta';
        const child = { id: node.id + '/' + (n++), name, vis: ktext(c, 'visibility') !== '0', open: false, children: [], features: [] };
        walk(c, child, path + '/' + name.toLowerCase());
        if (child.children.length || child.features.length) node.children.push(child);
      } else if (c.localName === 'Placemark') {
        const out = []; for (const g of c.children) geoms(g, out);
        if (!out.length) continue;
        const st = styleOf(c);
        const dashed = /estimad/i.test(st.sid || '') || /estimad/.test(path);
        const name = ktext(c, 'name');
        const desc = ktext(c, 'description');
        const vis = ktext(c, 'visibility') !== '0';
        for (const g of out) node.features.push(Object.assign(g, { n: name, d: desc, s: Object.assign({ dashed }, st), v: vis }));
      }
    }
  };
  const kml = doc.documentElement;
  const rootEl = kid(kml, 'Document') || kid(kml, 'Folder') || kml;
  const root = { id: 'r', name: ktext(rootEl, 'name') || fileName, vis: true, open: true, children: [], features: [] };
  walk(rootEl, root, '');
  // collapse single wrapper folders
  while (!root.features.length && root.children.length === 1 && root.children[0].children.length) {
    const only = root.children[0]; root.children = only.children; root.features = only.features;
  }
  return root;
}

async function readFile(file) {
  const buf = await file.arrayBuffer();
  if (/\.kmz$/i.test(file.name) || new Uint8Array(buf.slice(0, 2)).join() === '80,75') {
    const zip = await JSZip.loadAsync(buf, { checkCRC32: false });
    const kmls = Object.values(zip.files).filter(f => /\.kml$/i.test(f.name) && !f.dir);
    if (!kmls.length) throw new Error('El KMZ no tiene ningún KML adentro');
    kmls.sort((a, b) => (b.name === 'doc.kml') - (a.name === 'doc.kml'));
    return parseKML(await kmls[0].async('string'), file.name);
  }
  return parseKML(new TextDecoder().decode(buf), file.name);
}

// ============ sanitizer for descriptions ============
function sanitize(html) {
  if (!html) return '';
  const d = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
  d.querySelectorAll('script,iframe,object,embed,style,link,meta,form,input,button').forEach(e => e.remove());
  d.querySelectorAll('*').forEach(e => {
    [...e.attributes].forEach(a => {
      const n = a.name.toLowerCase(), v = a.value.trim().toLowerCase();
      if (n.startsWith('on') || ((n === 'href' || n === 'src') && v.startsWith('javascript:'))) e.removeAttribute(a.name);
    });
    if (e.tagName === 'A') { e.setAttribute('target', '_blank'); e.setAttribute('rel', 'noopener'); }
  });
  return d.body.firstChild.innerHTML;
}

// ============ layers ============
const PALETTE = ['#7b2ff7', '#0a8f3c', '#0d5bd7', '#d6007a', '#8a5a00', '#007c91', '#5b6b00'];
let layers = []; // {id,name,isBase,pinned,color,tree}
const VIS_KEY = id => 'vis_' + id;

function eachNode(node, fn, parentVis = true) {
  const eff = parentVis && node.vis;
  fn(node, eff);
  node.children.forEach(c => eachNode(c, fn, eff));
}

const TriMarker = L.CircleMarker.extend({
  _updatePath() {
    const r = this._renderer; if (!r._drawing || this._empty()) return;
    const p = this._point, ctx = r._ctx, s = this._radius, sh = this.options.shape;
    ctx.beginPath();
    if (sh === 'tri') { ctx.moveTo(p.x, p.y - s); ctx.lineTo(p.x + s * 0.95, p.y + s * 0.75); ctx.lineTo(p.x - s * 0.95, p.y + s * 0.75); ctx.closePath(); }
    else if (sh === 'sq') { ctx.rect(p.x - s * .8, p.y - s * .8, s * 1.6, s * 1.6); }
    else { ctx.moveTo(p.x, p.y - s); ctx.lineTo(p.x + s, p.y + s * .8); ctx.lineTo(p.x - s, p.y + s * .8); ctx.closePath(); }
    r._fillStroke(ctx, this);
  }
});

function featStyle(f, layer) {
  const s = f.s || {};
  const own = !layer.isBase;
  const col = own ? layer.color : null;
  if (f.t === 'P') {
    const shape = s.shape || 'dot';
    const rad = shape === 'tri' ? 7 : shape === 'dot' ? Math.max(3.5, Math.min(7, 7 * (s.pscale || .6))) : 6;
    return { shape, radius: own ? 6 : rad, fill: col || s.pcolor || '#ffd400' };
  }
  if (f.t === 'A') return { color: col || s.color || '#7b2ff7', weight: Math.max(2, s.weight || 2), fill: col || s.fill || s.color || '#7b2ff7', fillOpacity: own ? .18 : (s.fillOpacity ?? .2), dashed: false };
  return { color: col || s.color || '#7b2ff7', weight: own ? Math.max(3, s.weight || 3) : (s.weight || 3), opacity: own ? 1 : (s.opacity ?? 1), dashed: !!s.dashed };
}

function buildNodeLayer(node, layer) {
  const R = layer.isBase ? R_BASE : R_OBRA;
  const g = L.layerGroup();
  for (const f of node.features) {
    const st = featStyle(f, layer); let m;
    if (f.t === 'P') {
      const ll = [f.c[1], f.c[0]];
      const o = { renderer: R, radius: st.radius, color: '#1d2530', weight: 1, fillColor: st.fill, fillOpacity: 1 };
      m = st.shape === 'dot' ? L.circleMarker(ll, o) : new TriMarker(ll, Object.assign(o, { shape: st.shape }));
    } else if (f.t === 'L') {
      m = L.polyline(f.c.map(c => [c[1], c[0]]), { renderer: R, color: st.color, weight: st.weight, opacity: st.opacity, dashArray: st.dashed ? '7 6' : null });
    } else {
      m = L.polygon(f.c.map(c => [c[1], c[0]]), { renderer: R, color: st.color, weight: st.weight, fillColor: st.fill, fillOpacity: st.fillOpacity });
    }
    m.on('click', e => { if (drawMode) return; L.DomEvent.stop(e); showInfo(f, e.latlng, layer); });
    g.addLayer(m);
  }
  return g;
}

function refreshVisibility() {
  for (const layer of layers) {
    eachNode(layer.tree, (node, eff) => {
      if (!node.features.length) return;
      if (eff) { if (!node.lg) node.lg = buildNodeLayer(node, layer); if (!map.hasLayer(node.lg)) node.lg.addTo(map); }
      else if (node.lg && map.hasLayer(node.lg)) map.removeLayer(node.lg);
    });
  }
  updateLabels();
}
function saveVis(layer) {
  const v = {}; eachNode(layer.tree, n => { v[n.id] = n.vis; });
  localStorage.setItem(VIS_KEY(layer.id), JSON.stringify(v));
}
function loadVis(layer) {
  const v = JSON.parse(localStorage.getItem(VIS_KEY(layer.id)) || 'null'); if (!v) return;
  eachNode(layer.tree, n => { if (n.id in v) n.vis = v[n.id]; });
}
function countFeat(node) { let c = node.features.length; node.children.forEach(k => c += countFeat(k)); return c; }
function boundsOf(node) {
  const b = L.latLngBounds([]);
  eachNode(node, n => n.features.forEach(f => (f.t === 'P' ? [f.c] : f.c).forEach(c => b.extend([c[1], c[0]]))));
  return b;
}

async function addLayer(tree, opts) {
  const layer = Object.assign({ id: uid(), name: tree.name, isBase: false, pinned: false, color: PALETTE[layers.filter(l => !l.isBase).length % PALETTE.length], tree }, opts);
  layer.tree.vis = true;
  if (layer.isBase) { layers = layers.filter(l => { if (l.isBase) removeLayerObj(l, true); return !l.isBase; }); }
  layers.push(layer);
  loadVis(layer);
  if (layer.pinned) await DB.put(serial(layer));
  refreshVisibility(); renderTree();
  if (layer.isBase) buildRiskIndex();
  analyzeRisks();
  return layer;
}
function serial(l) { return { id: l.id, name: l.name, isBase: l.isBase, pinned: l.pinned, color: l.color, tree: stripLg(l.tree) }; }
function stripLg(n) { return { id: n.id, name: n.name, vis: n.vis, open: n.open, features: n.features, children: n.children.map(stripLg) }; }
function removeLayerObj(l, silent) {
  eachNode(l.tree, n => { if (n.lg) map.removeLayer(n.lg); });
  if (l.pinned) DB.del(l.id);
  localStorage.removeItem(VIS_KEY(l.id));
  if (!silent) { layers = layers.filter(x => x !== l); refreshVisibility(); renderTree(); analyzeRisks(); }
}
function restyleLayer(l) {
  eachNode(l.tree, n => { if (n.lg) { map.removeLayer(n.lg); n.lg = null; } });
  refreshVisibility(); analyzeRisks();
}

// ---- tree UI ----
function renderTree() {
  const el = $('#layerTree'); el.innerHTML = '';
  const ordered = [...layers.filter(l => !l.isBase).reverse(), ...layers.filter(l => l.isBase)];
  $('#baseHint').classList.toggle('hidden', layers.some(l => l.isBase));
  if (!layers.length) { el.innerHTML = '<div class="empty">Cargá un KMZ para empezar</div>'; return; }
  for (const l of ordered) {
    const card = document.createElement('div'); card.className = 'layer-card' + (l.isBase ? ' base' : '');
    const top = document.createElement('div'); top.className = 'layer-top';
    top.innerHTML = `<button class="eye ${l.tree.vis ? '' : 'off'}" title="Ver / ocultar">👁</button>
      ${l.isBase ? '<span title="Base fija">📌</span>' : `<input type="color" class="sw" value="${l.color}" title="Color de la capa">`}
      <span class="nm" title="${esc(l.name)}">${esc(l.isBase ? 'Red Tigo (base fija)' : l.name)}</span>
      <button class="mini zoom" title="Ir a la capa">⌖</button>
      ${l.isBase ? '' : `<button class="mini pin ${l.pinned ? 'on' : ''}" title="Fijar (queda guardada al abrir la app)">📌</button><button class="mini del" title="Eliminar capa">✕</button>`}`;
    top.querySelector('.eye').onclick = () => { l.tree.vis = !l.tree.vis; saveVis(l); refreshVisibility(); renderTree(); analyzeRisks(); };
    top.querySelector('.zoom').onclick = () => { const b = boundsOf(l.tree); if (b.isValid()) map.fitBounds(b, { padding: [30, 30], maxZoom: 18 }); closePanelMobile(); };
    const sw = top.querySelector('.sw'); if (sw) sw.oninput = () => { l.color = sw.value; restyleLayer(l); if (l.pinned) DB.put(serial(l)); };
    const pin = top.querySelector('.pin'); if (pin) pin.onclick = async () => { l.pinned = !l.pinned; if (l.pinned) await DB.put(serial(l)); else await DB.del(l.id); renderTree(); };
    const del = top.querySelector('.del'); if (del) del.onclick = () => { if (confirm('¿Eliminar la capa "' + l.name + '"?')) removeLayerObj(l); };
    card.appendChild(top);
    const body = document.createElement('div'); body.style.padding = '2px 0 4px';
    l.tree.features.length && body.appendChild(nodeRow({ id: l.tree.id + '#f', name: 'Elementos', vis: true, children: [], features: l.tree.features, _self: true }, l));
    l.tree.children.forEach(c => body.appendChild(nodeEl(c, l)));
    card.appendChild(body);
    el.appendChild(card);
  }
}
function nodeRow(n, l) {
  const row = document.createElement('div'); row.className = 'node';
  const has = n.children.length > 0;
  row.innerHTML = `<button class="caret">${has ? (n.open ? '▼' : '▶') : ''}</button>
    <button class="eye ${n.vis ? '' : 'off'}">👁</button>
    <span class="nm" title="${esc(n.name)}">${esc(n.name)}</span><span class="cnt">${countFeat(n)}</span>`;
  row.querySelector('.eye').onclick = () => { if (n._self) return; n.vis = !n.vis; saveVis(l); refreshVisibility(); renderTree(); if (!l.isBase) analyzeRisks(); };
  const tog = () => { if (has) { n.open = !n.open; renderTree(); } };
  row.querySelector('.caret').onclick = tog;
  row.querySelector('.nm').onclick = () => { if (has) tog(); else { const b = boundsOf(n); if (b.isValid()) { map.fitBounds(b, { padding: [30, 30], maxZoom: 18 }); closePanelMobile(); } } };
  return row;
}
function nodeEl(n, l) {
  const wrap = document.createElement('div'); wrap.className = 'tl';
  wrap.appendChild(nodeRow(n, l));
  if (n.children.length && n.open) {
    const k = document.createElement('div'); k.className = 'kids';
    n.children.forEach(c => k.appendChild(nodeEl(c, l)));
    if (n.features.length) k.prepend(nodeRow({ id: n.id + '#f', name: 'Elementos sueltos', vis: true, children: [], features: n.features, _self: true }, l));
    wrap.appendChild(k);
  }
  return wrap;
}

// ---- info popup ----
function showInfo(f, latlng, layer) {
  const desc = sanitize(f.d);
  const ll = f.t === 'P' ? L.latLng(f.c[1], f.c[0]) : latlng;
  let extra = '';
  if (f.t === 'L') { let len = 0; for (let i = 1; i < f.c.length; i++) len += meters(f.c[i - 1], f.c[i]); extra = `Largo aprox.: ${Math.round(len).toLocaleString('es-UY')} m`; }
  const html = `<div class="pop"><h3>${esc(f.n || '(sin nombre)')}</h3>
    ${desc ? `<div class="desc">${desc}</div>` : ''}
    <div class="meta">${esc(layer.isBase ? 'Red Tigo' : layer.name)}${extra ? ' · ' + extra : ''}<br>${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}</div>
    <div class="acts"><button data-a="addr">📍 Dirección</button><button data-a="copy">⧉ Copiar coordenadas</button><button data-a="gmaps">Google Maps</button></div>
    <div class="addr meta"></div></div>`;
  const p = L.popup({ maxWidth: 320 }).setLatLng(ll).setContent(html).openOn(map);
  wirePopup(p, ll);
}
function wirePopup(p, ll) {
  const el = p.getElement(); if (!el) return;
  el.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
    const a = b.dataset.a;
    if (a === 'copy') { navigator.clipboard?.writeText(`${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`); b.textContent = '✔ Copiado'; }
    if (a === 'gmaps') window.open(`https://www.google.com/maps?q=${ll.lat},${ll.lng}`, '_blank');
    if (a === 'addr') { const o = el.querySelector('.addr'); o.textContent = 'Buscando dirección…'; o.textContent = (await reverseGeocode(ll)) || 'No se encontró dirección'; }
  });
}
// long-press / right click → address
map.on('contextmenu', e => {
  if (drawMode) return;
  const ll = e.latlng;
  const p = L.popup().setLatLng(ll).setContent(`<div class="pop"><b>Punto del mapa</b><div class="meta">${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}</div><div class="addr meta">Buscando dirección…</div><div class="acts"><button data-a="copy">⧉ Copiar coordenadas</button><button data-a="gmaps">Google Maps</button></div></div>`).openOn(map);
  wirePopup(p, ll);
  reverseGeocode(ll).then(a => { const o = p.getElement()?.querySelector('.addr'); if (o) o.textContent = a || 'No se encontró dirección'; });
});

// ============ labels ============
const lblLayer = L.layerGroup().addTo(map);
function updateLabels() {
  lblLayer.clearLayers();
  if (!S.names || map.getZoom() < 16) return;
  const b = map.getBounds().pad(0.1); let n = 0;
  for (const l of layers) eachNode(l.tree, (node, eff) => {
    if (!eff || n > 500) return;
    for (const f of node.features) {
      if (f.t !== 'P' || !f.n) continue;
      const ll = L.latLng(f.c[1], f.c[0]); if (!b.contains(ll)) continue;
      lblLayer.addLayer(L.marker(ll, { pane: 'lblPane', interactive: false, icon: L.divIcon({ className: 'lbl', html: `<span>${esc(f.n)}</span>`, iconSize: [0, 0] }) }));
      if (++n > 500) break;
    }
  });
}
map.on('moveend', updateLabels);

// ============ geocoding ============
async function reverseGeocode(ll) {
  try {
    const r = await timeout(fetch(`https://direcciones.ide.uy/api/v1/geocode/reverse?latitud=${ll.lat}&longitud=${ll.lng}&limit=1`), 5000);
    if (r.ok) {
      const j = await r.json(); const o = Array.isArray(j) ? j[0] : j;
      if (o) {
        const a = o.address || [o.nomVia, o.portalNumber].filter(Boolean).join(' ');
        if (a) return [a, o.localidad, o.departamento].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(', ');
      }
    }
  } catch (e) { /* fallback */ }
  try {
    const r = await timeout(fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${ll.lat}&lon=${ll.lng}&zoom=18&accept-language=es`), 6000);
    const j = await r.json(); const a = j.address || {};
    const street = [a.road, a.house_number].filter(Boolean).join(' ');
    return [street, a.suburb || a.neighbourhood, a.city || a.town || a.village, a.state].filter(Boolean).join(', ') || j.display_name;
  } catch (e) { return ''; }
}
function pickLL(o) {
  const lat = o.lat ?? o.latitud ?? o.puntoY ?? o.y ?? o.punto?.y ?? o.geom?.coordinates?.[1];
  const lng = o.lng ?? o.lon ?? o.longitud ?? o.puntoX ?? o.x ?? o.punto?.x ?? o.geom?.coordinates?.[0];
  return (lat != null && lng != null && Math.abs(lat) <= 90) ? [+lat, +lng] : null;
}
async function searchIDE(q) {
  const out = [];
  try {
    const r = await timeout(fetch(`https://direcciones.ide.uy/api/v1/geocode/candidates?q=${encodeURIComponent(q)}&limit=8&soloLocalidad=false`), 5000);
    if (r.ok) {
      const j = await r.json();
      for (const o of (Array.isArray(j) ? j : j.results || [])) {
        let ll = pickLL(o);
        if (!ll && o.id && o.type) { // candidates sin coordenadas → resolver
          try { const f = await timeout(fetch(`https://direcciones.ide.uy/api/v1/geocode/find?type=${encodeURIComponent(o.type)}&id=${encodeURIComponent(o.id)}${o.idCalle ? '&idcalle=' + o.idCalle : ''}${o.portalNumber ? '&portal=' + o.portalNumber : ''}`), 4000); const fj = await f.json(); ll = pickLL(Array.isArray(fj) ? fj[0] : fj); } catch (e) { }
        }
        if (ll) out.push({ label: o.address || o.direccion || o.nombre || q, sub: [o.localidad, o.departamento].filter(Boolean).join(', ') + ' · IDE Uruguay', ll });
      }
    }
  } catch (e) { }
  return out;
}
async function searchNominatim(q) {
  try {
    const r = await timeout(fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=uy&limit=8&accept-language=es&q=${encodeURIComponent(q)}`), 7000);
    const j = await r.json();
    return j.map(o => ({ label: o.display_name.split(',').slice(0, 2).join(','), sub: o.display_name.split(',').slice(2, 5).join(',') + ' · OpenStreetMap', ll: [+o.lat, +o.lon] }));
  } catch (e) { return []; }
}
let searchMarker = null;
$('#searchForm').onsubmit = async e => {
  e.preventDefault();
  const q = $('#searchInput').value.trim(); if (!q) return;
  const box = $('#searchResults'); box.classList.remove('hidden'); box.innerHTML = '<div>Buscando…</div>';
  const m = q.match(/^\s*(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)\s*$/);
  let res = [];
  if (m) res = [{ label: 'Coordenadas', sub: q, ll: [+m[1], +m[2]] }];
  else {
    // localizar también cámaras / sitios por nombre
    const up = q.toUpperCase();
    for (const l of layers) eachNode(l.tree, node => node.features.forEach(f => { if (res.length < 5 && f.t === 'P' && f.n && f.n.toUpperCase() === up) res.push({ label: f.n, sub: 'Elemento de ' + (l.isBase ? 'Red Tigo' : l.name), ll: [f.c[1], f.c[0]] }); }));
    const qq = q.replace(/\s+y\s+/i, ' esquina ');
    res = res.concat(await searchIDE(q));
    if (res.length < 3) res = res.concat(await searchNominatim(/ esquina /.test(qq) ? q.replace(/\s+y\s+/i, ' & ') : q));
  }
  if (!res.length) { box.innerHTML = '<div>No encontré esa dirección. Probá con “calle número, ciudad”.</div>'; return; }
  box.innerHTML = '';
  res.forEach(r => {
    const d = document.createElement('div'); d.innerHTML = `${esc(r.label)}<small>${esc(r.sub)}</small>`;
    d.onclick = () => {
      box.classList.add('hidden');
      map.setView(r.ll, 18);
      if (searchMarker) map.removeLayer(searchMarker);
      searchMarker = L.marker(r.ll).addTo(map).bindPopup(esc(r.label)).openPopup();
    };
    box.appendChild(d);
  });
};
document.addEventListener('click', e => { if (!e.target.closest('#searchForm')) $('#searchResults').classList.add('hidden'); });

// ============ GPS ============
let gpsLayer = L.layerGroup().addTo(map);
$('#btnGps').onclick = () => map.locate({ setView: true, maxZoom: 18, enableHighAccuracy: true });
map.on('locationfound', e => {
  gpsLayer.clearLayers();
  L.circle(e.latlng, { radius: e.accuracy, color: '#0d5bd7', weight: 1, fillOpacity: .1 }).addTo(gpsLayer);
  L.circleMarker(e.latlng, { radius: 8, color: '#fff', weight: 3, fillColor: '#0d5bd7', fillOpacity: 1 }).addTo(gpsLayer);
});
map.on('locationerror', () => alert('No se pudo obtener la ubicación. Revisá que el GPS y el permiso de ubicación estén activados.'));

// ============ RISK ANALYSIS ============
let riskIndex = null; // grid of base segments
const CELL = 0.0005;
function buildRiskIndex() {
  const base = layers.find(l => l.isBase); riskIndex = null; if (!base) return;
  const grid = new Map(); let n = 0;
  eachNode(base.tree, node => node.features.forEach(f => {
    if (f.t !== 'L') return;
    for (let i = 1; i < f.c.length; i++) {
      const a = f.c[i - 1], b = f.c[i];
      const seg = { a, b, f };
      const x0 = Math.floor(Math.min(a[0], b[0]) / CELL), x1 = Math.floor(Math.max(a[0], b[0]) / CELL);
      const y0 = Math.floor(Math.min(a[1], b[1]) / CELL), y1 = Math.floor(Math.max(a[1], b[1]) / CELL);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 2500) continue;
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = x + ':' + y; let arr = grid.get(k); if (!arr) grid.set(k, arr = []); arr.push(seg);
      }
      n++;
    }
  }));
  riskIndex = grid;
}
function toLocal(p, o) { const k = Math.cos(o[1] * DEG); return [(p[0] - o[0]) * 111320 * k, (p[1] - o[1]) * 110540]; }
function distPointSeg(p, a, b) {
  const A = toLocal(a, p), B = toLocal(b, p);
  const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, -(A[0] * dx + A[1] * dy) / L2)) : 0;
  return Math.hypot(A[0] + t * dx, A[1] + t * dy);
}
function segIntersect(p1, p2, p3, p4) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (!d) return null;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return (t >= 0 && t <= 1 && u >= 0 && u <= 1) ? [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])] : null;
}
function candidates(p, rad) {
  const r = Math.max(1, Math.ceil(rad / 45));
  const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL); const set = new Set();
  for (let x = -r; x <= r; x++) for (let y = -r; y <= r; y++) { const a = riskIndex.get((cx + x) + ':' + (cy + y)); if (a) a.forEach(s => set.add(s)); }
  return set;
}
function nearestBase(p, rad) {
  let best = null, bd = Infinity;
  for (const s of candidates(p, rad)) { const d = distPointSeg(p, s.a, s.b); if (d < bd) { bd = d; best = s; } }
  return { d: bd, seg: best };
}
function pointInPoly(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

let risks = [], riskLayer = L.layerGroup().addTo(map);
function analyzeRisks() {
  risks = []; riskLayer.clearLayers();
  if (!riskIndex) { renderRisks(); return; }
  const RED = +S.red, OR = Math.max(+S.orange, RED);
  const pieces = [];
  for (const l of layers) {
    if (l.isBase) continue;
    eachNode(l.tree, (node, eff) => {
      if (!eff) return;
      for (const f of node.features) {
        const zonesF = [];
        const push = (cls, d, at, seg, cross) => zonesF.push({ cls, d, at, seg, cross, obra: f.n, layer: l });
        if (f.t === 'P') {
          const nb = nearestBase(f.c, OR);
          if (nb.d <= OR) push(nb.d <= RED ? 2 : 1, nb.d, f.c, nb.seg, false);
        } else {
          const ring = f.t === 'A' ? [...f.c, f.c[0]] : f.c;
          let run = null;
          const flush = () => { if (run && run.cls) { pieces.push(run); } run = null; };
          for (let i = 1; i < ring.length; i++) {
            const a = ring[i - 1], b = ring[i]; const len = meters(a, b);
            // crossings
            for (const s of candidates(a, Math.max(OR, len)).values()) {
              const x = segIntersect(a, b, s.a, s.b); if (x) push(2, 0, x, s, true);
            }
            const n = Math.max(1, Math.ceil(len / 2));
            for (let k = (i === 1 ? 0 : 1); k <= n; k++) {
              const p = [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n];
              const nb = nearestBase(p, OR);
              const cls = nb.d <= RED ? 2 : nb.d <= OR ? 1 : 0;
              if (!run || run.cls !== cls) { const prev = run && run.pts[run.pts.length - 1]; flush(); run = { cls, pts: prev ? [prev, p] : [p] }; }
              else run.pts.push(p);
              if (cls) push(cls, nb.d, p, nb.seg, false);
            }
          }
          flush();
          if (f.t === 'A') { // base inside polygon
            const xs = f.c.map(c => c[0]), ys = f.c.map(c => c[1]);
            const bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
            const cx = Math.floor(bb[0] / CELL), cx2 = Math.floor(bb[2] / CELL), cy = Math.floor(bb[1] / CELL), cy2 = Math.floor(bb[3] / CELL);
            if ((cx2 - cx + 1) * (cy2 - cy + 1) < 20000) {
              outer: for (let x = cx; x <= cx2; x++) for (let y = cy; y <= cy2; y++) {
                for (const s of riskIndex.get(x + ':' + y) || []) if (pointInPoly(s.a, f.c)) { push(2, 0, s.a, s, false); zonesF[zonesF.length - 1].inside = true; break outer; }
              }
            }
          }
        }
        // merge samples into zones (within 30 m)
        zonesF.sort((x, y) => y.cls - x.cls || x.d - y.d);
        const merged = [];
        for (const z of zonesF) {
          const m = merged.find(m => meters(m.at, z.at) < 30);
          if (m) { m.cross = m.cross || z.cross; m.inside = m.inside || z.inside; continue; }
          merged.push(z);
        }
        risks.push(...merged);
      }
    });
  }
  // global merge (cross-feature) & order
  risks.sort((x, y) => y.cls - x.cls || x.d - y.d);
  const fin = [];
  for (const z of risks) { if (fin.some(m => m.layer === z.layer && meters(m.at, z.at) < 30)) continue; fin.push(z); }
  risks = fin.slice(0, 300);
  risks.forEach((z, i) => z.num = i + 1);
  riskPieces = pieces;
  drawRiskOverlay();
  renderRisks();
}
let riskPieces = [];
function drawRiskOverlay() {
  riskLayer.clearLayers();
  if (!S.riskColors) return;
  for (const p of riskPieces) L.polyline(p.pts.map(c => [c[1], c[0]]), { renderer: R_RISK, color: p.cls === 2 ? '#e01e1e' : '#ff8c00', weight: 10, opacity: .55, interactive: false, lineCap: 'round' }).addTo(riskLayer);
  for (const z of risks) {
    const col = z.cls === 2 ? '#e01e1e' : '#ff8c00';
    L.marker([z.at[1], z.at[0]], { pane: 'riskPane', icon: L.divIcon({ className: 'riskpin', html: `<div style="background:${col}">${z.num}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }) })
      .on('click', () => { openRiskPanel(); }).addTo(riskLayer);
  }
}
function riskText(z) {
  const what = z.inside ? 'La traza pasa dentro del área de la obra' : z.cross ? 'La obra CRUZA la traza' : `Obra a ${z.d < 1 ? 'menos de 1' : Math.round(z.d)} m de la traza`;
  const tigo = z.seg?.f?.n || 'Traza Tigo';
  return { what, tigo };
}
function renderRisks() {
  $('#riskCount').textContent = risks.length;
  $$('.rRed').forEach(e => e.textContent = S.red); $$('.rOr').forEach(e => e.textContent = S.orange);
  const el = $('#riskList'); el.innerHTML = '';
  if (!layers.some(l => !l.isBase)) { el.innerHTML = '<div class="empty">Cargá el KMZ de la obra para ver los cruces y puntos de riesgo.</div>'; return; }
  if (!riskIndex) { el.innerHTML = '<div class="empty">Falta cargar la base Tigo.</div>'; return; }
  if (!risks.length) { el.innerHTML = `<div class="empty">✔ Ninguna obra visible pasa a menos de ${S.orange} m de la traza.</div>`; return; }
  for (const z of risks) {
    const t = riskText(z); const col = z.cls === 2 ? '#e01e1e' : '#ff8c00';
    const d = document.createElement('div'); d.className = 'risk';
    d.innerHTML = `<div class="num" style="background:${col}">${z.num}</div>
      <div class="info"><b>${esc(t.what)}</b><br><small>Tigo: ${esc(t.tigo)} · Obra: ${esc(z.layer.name)}${z.obra ? ' / ' + esc(z.obra) : ''}</small></div>
      <div class="acts"><button class="btn small">Ver</button><button class="btn small primary">Imagen</button></div>`;
    const [bv, bi] = d.querySelectorAll('button');
    bv.onclick = () => { map.setView([z.at[1], z.at[0]], 19); if (innerWidth < 760) $('#riskPanel').classList.add('hidden'); };
    bi.onclick = () => { map.setView([z.at[1], z.at[0]], 19); $('#riskPanel').classList.add('hidden'); openExport(z); };
    el.appendChild(d);
  }
}
function openRiskPanel() { closeSheets(); $('#riskPanel').classList.remove('hidden'); }
$('#btnRisks').onclick = () => { const h = $('#riskPanel').classList.contains('hidden'); closeSheets(); if (h) openRiskPanel(); };

// ============ DRAWING / ANNOTATIONS ============
let anns = JSON.parse(localStorage.getItem('anns') || '[]');
let drawMode = null, temp = [], tempLayer = L.layerGroup().addTo(map);
const annLayer = L.layerGroup().addTo(map);
const saveAnns = () => localStorage.setItem('anns', JSON.stringify(anns));
function arrowHead(a, b, px = 16) { // latlngs -> polygon latlngs (screen-space size)
  const A = map.latLngToLayerPoint(a), B = map.latLngToLayerPoint(b);
  const ang = Math.atan2(B.y - A.y, B.x - A.x);
  const p1 = L.point(B.x - px * Math.cos(ang - 0.45), B.y - px * Math.sin(ang - 0.45));
  const p2 = L.point(B.x - px * Math.cos(ang + 0.45), B.y - px * Math.sin(ang + 0.45));
  return [b, map.layerPointToLatLng(p1), map.layerPointToLatLng(p2)];
}
function renderAnns() {
  annLayer.clearLayers();
  for (const a of anns) {
    const o = { pane: 'annPane', color: a.color, weight: 4 };
    let lyr;
    if (a.type === 'point') lyr = L.marker(a.ll, { pane: 'annPane', icon: L.divIcon({ className: 'ann-text', html: `<span style="color:${a.color}">📍${a.text ? ' ' + esc(a.text) : ''}</span>`, iconSize: [0, 0] }) });
    else if (a.type === 'text') lyr = L.marker(a.ll, { pane: 'annPane', icon: L.divIcon({ className: 'ann-text', html: `<span style="color:${a.color}">${esc(a.text)}</span>`, iconSize: [0, 0] }) });
    else if (a.type === 'circle') lyr = L.circle(a.ll, Object.assign({ radius: a.r, fillOpacity: .08, fillColor: a.color }, o));
    else if (a.type === 'rect') lyr = L.rectangle(a.lls, Object.assign({ fillOpacity: .08, fillColor: a.color }, o));
    else if (a.type === 'line' || a.type === 'free') lyr = L.polyline(a.lls, o);
    else if (a.type === 'arrow') lyr = L.featureGroup([L.polyline(a.lls, o), L.polygon(arrowHead(a.lls[0], a.lls[1]), Object.assign({ fillColor: a.color, fillOpacity: 1 }, o))]);
    if (!lyr) continue;
    lyr.on('click', e => {
      if (drawMode && drawMode !== 'erase') return;
      L.DomEvent.stop(e);
      if (drawMode === 'erase') { anns = anns.filter(x => x !== a); saveAnns(); renderAnns(); }
      else if (a.note) L.popup().setLatLng(e.latlng).setContent(`<div class="pop"><b>${esc(a.text || '')}</b><div class="desc">${esc(a.note)}</div></div>`).openOn(map);
    });
    annLayer.addLayer(lyr);
  }
}
map.on('zoomend', renderAnns);
renderAnns();

const TOOL_HINTS = {
  point: 'Tocá el mapa donde va el punto', text: 'Tocá el mapa donde va el texto', line: 'Tocá para agregar puntos, después “Terminar”',
  arrow: 'Tocá el inicio y después la punta de la flecha', circle: 'Tocá el centro y después el borde del círculo',
  rect: 'Tocá una esquina y después la esquina opuesta', free: 'Dibujá arrastrando el dedo / mouse', erase: 'Tocá el dibujo que querés borrar'
};
function setTool(t) {
  drawMode = drawMode === t ? null : t; temp = []; tempLayer.clearLayers();
  $$('#drawBar [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === drawMode));
  $('#btnFinish').classList.toggle('hidden', drawMode !== 'line');
  hint(drawMode ? TOOL_HINTS[drawMode] : '');
  if (drawMode === 'free') map.dragging.disable(); else map.dragging.enable();
  if (drawMode === 'line') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
  map.getContainer().style.cursor = drawMode ? 'crosshair' : '';
}
$('#drawBar').addEventListener('click', e => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); });
$('#btnDraw').onclick = () => { const bar = $('#drawBar'); bar.classList.toggle('hidden'); if (bar.classList.contains('hidden') && drawMode) setTool(drawMode); };
$('#btnDrawClose').onclick = () => { if (drawMode) setTool(drawMode); $('#drawBar').classList.add('hidden'); };
$('#btnClearAll').onclick = () => { if (anns.length && confirm('¿Borrar todos los dibujos?')) { anns = []; saveAnns(); renderAnns(); } };
const color = () => $('#drawColor').value;
function addAnn(a) { anns.push(a); saveAnns(); renderAnns(); }
$('#btnFinish').onclick = () => { if (temp.length > 1) addAnn({ type: 'line', color: color(), lls: temp.map(ll => [ll.lat, ll.lng]) }); temp = []; tempLayer.clearLayers(); };

map.on('click', e => {
  if (!drawMode || drawMode === 'erase' || drawMode === 'free') return;
  const ll = e.latlng, c = color();
  if (drawMode === 'point') {
    const text = prompt('Nombre del punto (ej: Cruce con fibra Tigo):', ''); if (text === null) return;
    const note = prompt('Nota (opcional):', '') || '';
    addAnn({ type: 'point', color: c, ll: [ll.lat, ll.lng], text, note });
  } else if (drawMode === 'text') {
    const text = prompt('Texto:', ''); if (text) addAnn({ type: 'text', color: c, ll: [ll.lat, ll.lng], text });
  } else if (drawMode === 'line') {
    temp.push(ll); tempLayer.clearLayers(); L.polyline(temp, { color: c, weight: 4, dashArray: '4 4', pane: 'annPane' }).addTo(tempLayer);
    temp.forEach(p => L.circleMarker(p, { radius: 4, color: c, pane: 'annPane' }).addTo(tempLayer));
  } else {
    temp.push(ll);
    if (temp.length === 1) { L.circleMarker(ll, { radius: 5, color: c, pane: 'annPane' }).addTo(tempLayer); return; }
    const [a, b] = temp; temp = []; tempLayer.clearLayers();
    if (drawMode === 'arrow') addAnn({ type: 'arrow', color: c, lls: [[a.lat, a.lng], [b.lat, b.lng]] });
    if (drawMode === 'circle') addAnn({ type: 'circle', color: c, ll: [a.lat, a.lng], r: map.distance(a, b) });
    if (drawMode === 'rect') addAnn({ type: 'rect', color: c, lls: [[a.lat, a.lng], [b.lat, b.lng]] });
  }
});
map.on('dblclick', e => { if (drawMode === 'line') { L.DomEvent.stop(e); $('#btnFinish').click(); } });
// freehand
(() => {
  const ct = map.getContainer(); let pts = null, line = null;
  ct.addEventListener('pointerdown', e => { if (drawMode !== 'free') return; pts = [map.mouseEventToLatLng(e)]; line = L.polyline(pts, { color: color(), weight: 4, pane: 'annPane' }).addTo(tempLayer); ct.setPointerCapture(e.pointerId); });
  ct.addEventListener('pointermove', e => { if (!pts) return; pts.push(map.mouseEventToLatLng(e)); line.setLatLngs(pts); });
  const end = () => { if (!pts) return; if (pts.length > 2) addAnn({ type: 'free', color: color(), lls: pts.filter((_, i) => i % 2 === 0 || i === pts.length - 1).map(p => [p.lat, p.lng]) }); pts = null; tempLayer.clearLayers(); };
  ct.addEventListener('pointerup', end); ct.addEventListener('pointercancel', end);
  ct.style.touchAction = 'none';
})();

// ============ EXPORT IMAGE ============
let exportZone = null;
function openExport(zone) {
  closeSheets(); exportZone = zone || null;
  $('#exportPanel').classList.remove('hidden');
  $('#expGo').textContent = zone ? `Generar imagen del punto ${zone.num}` : 'Generar imagen de lo que se ve en pantalla';
  if (!$('#expObra').value) { const ob = layers.filter(l => !l.isBase && l.tree.vis).map(l => l.name.replace(/\.(kmz|kml)$/i, '')); $('#expObra').value = ob.join(' / '); }
  ['#expPreview', '#expActions', '#expStatus'].forEach(s => $(s).classList.add('hidden'));
}
$('#btnExport').onclick = () => openExport(null);
let lastBlob = null, lastName = '';
$('#expGo').onclick = async () => {
  const st = $('#expStatus'); st.classList.remove('hidden'); st.textContent = 'Armando la imagen…';
  $('#expGo').disabled = true;
  try {
    const blob = await renderSheet();
    lastBlob = blob; lastName = `Traza_Tigo_${(($('#expObra').value || 'obra').replace(/[^\w\-]+/g, '_')).slice(0, 40)}_${new Date().toISOString().slice(0, 10)}${exportZone ? '_punto' + exportZone.num : ''}.png`;
    const url = URL.createObjectURL(blob);
    $('#expPreview').src = url; $('#expPreview').classList.remove('hidden');
    $('#expDownload').href = url; $('#expDownload').download = lastName;
    $('#expActions').classList.remove('hidden');
    $('#expShare').classList.toggle('hidden', !(navigator.canShare && navigator.canShare({ files: [new File([blob], lastName, { type: 'image/png' })] })));
    st.textContent = 'Lista. Descargala o compartila para adjuntar al mail.';
  } catch (e) { console.error(e); st.textContent = 'Error al generar la imagen: ' + e.message; }
  $('#expGo').disabled = false;
};
$('#expShare').onclick = async () => { try { await navigator.share({ files: [new File([lastBlob], lastName, { type: 'image/png' })], title: lastName }); } catch (e) { } };

function loadImg(src) { return new Promise(res => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = () => res(null); i.src = src; }); }
function tileUrl(t, z, x, y) { return t.url.replace('{s}', 'abcd'[(x + y) % 4]).replace('{z}', z).replace('{x}', x).replace('{y}', y); }

async function renderSheet() {
  const view = map.getSize();
  let W = Math.max(900, Math.min(view.x, 1600)), H = Math.max(600, Math.min(view.y, 1100));
  if (exportZone) { W = 1200; H = 800; }
  const center = map.getCenter(); const z0 = map.getZoom();
  const maxNative = Math.min(...BASES[baseKey].map(b => b.max));
  const zr = Math.min(z0 + 1, 20); const k = Math.pow(2, zr - z0); // render at higher zoom for sharpness
  const MW = W * k, MH = H * k;
  const crs = map.options.crs;
  const cpx = crs.latLngToPoint(center, zr);
  const tl = L.point(cpx.x - MW / 2, cpx.y - MH / 2);
  const proj = (lng, lat) => { const p = crs.latLngToPoint(L.latLng(lat, lng), zr); return [p.x - tl.x, p.y - tl.y]; };
  // ---- map canvas ----
  const mc = document.createElement('canvas'); mc.width = MW; mc.height = MH; const g = mc.getContext('2d');
  g.fillStyle = '#e9edf1'; g.fillRect(0, 0, MW, MH);
  for (const t of BASES[baseKey]) {
    const tz = Math.min(zr, t.max), sc = Math.pow(2, zr - tz), ts = 256 * sc;
    const x0 = Math.floor(tl.x / ts), x1 = Math.floor((tl.x + MW) / ts), y0 = Math.floor(tl.y / ts), y1 = Math.floor((tl.y + MH) / ts);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) throw new Error('Área demasiado grande: acercá más el zoom');
    const jobs = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push(loadImg(tileUrl(t, tz, x, y)).then(img => { if (img) g.drawImage(img, x * ts - tl.x, y * ts - tl.y, ts, ts); }));
    await Promise.all(jobs);
  }
  try { g.getImageData(0, 0, 1, 1); } catch (e) { throw new Error('El servidor de mapas no permitió exportar. Probá con otro fondo (Calles / Claro).'); }
  const b = L.latLngBounds(crs.pointToLatLng(tl, zr), crs.pointToLatLng(tl.add([MW, MH]), zr)).pad(0.05);
  const inView = c => b.contains([c[1], c[0]]);
  const bbOk = f => { if (!f._bb) { let a = 180, c = -180, d = 90, e = -90; for (const p of f.c) { a = Math.min(a, p[0]); c = Math.max(c, p[0]); d = Math.min(d, p[1]); e = Math.max(e, p[1]); } f._bb = [a, d, c, e]; } return b.intersects([[f._bb[1], f._bb[0]], [f._bb[3], f._bb[2]]]); };
  const s = k * (exportZone ? 1.15 : 1);
  // risk overlay (under)
  if (S.riskColors) for (const p of riskPieces) {
    g.strokeStyle = p.cls === 2 ? 'rgba(224,30,30,.55)' : 'rgba(255,140,0,.55)'; g.lineWidth = 10 * s; g.lineCap = 'round'; g.lineJoin = 'round'; g.setLineDash([]);
    g.beginPath(); p.pts.forEach((c, i) => { const q = proj(c[0], c[1]); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); }); g.stroke();
  }
  const ordered = [...layers.filter(l => l.isBase), ...layers.filter(l => !l.isBase)];
  const legend = new Map();
  const labels = [];
  for (const l of ordered) {
    const pts = [];
    eachNode(l.tree, (node, eff) => {
      if (!eff) return;
      for (const f of node.features) {
        const st = featStyle(f, l);
        if (f.t === 'P') { if (inView(f.c)) pts.push([f, st]); continue; }
        if (!bbOk(f)) continue;
        g.setLineDash(st.dashed ? [8 * s, 6 * s] : []); g.lineCap = 'round'; g.lineJoin = 'round';
        g.strokeStyle = st.color; g.globalAlpha = st.opacity ?? 1; g.lineWidth = (st.weight || 3) * s;
        g.beginPath(); f.c.forEach((c, i) => { const q = proj(c[0], c[1]); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); });
        if (f.t === 'A') { g.closePath(); g.fillStyle = st.fill; g.globalAlpha = st.fillOpacity; g.fill(); g.globalAlpha = 1; }
        g.stroke(); g.globalAlpha = 1;
        const key = l.isBase ? (st.dashed ? 'Tramo estimado de fibra Tigo' : 'Traza de fibra Tigo') : 'Obra: ' + l.name.replace(/\.(kmz|kml)$/i, '');
        if (!legend.has(key)) legend.set(key, { kind: f.t === 'A' ? 'area' : 'line', color: st.color, dashed: st.dashed });
      }
    });
    g.setLineDash([]);
    for (const [f, st] of pts) {
      const [x, y] = proj(f.c[0], f.c[1]); const r = st.radius * s;
      g.fillStyle = st.fill; g.strokeStyle = '#1d2530'; g.lineWidth = 1 * s;
      g.beginPath();
      if (st.shape === 'tri') { g.moveTo(x, y - r); g.lineTo(x + r * .95, y + r * .75); g.lineTo(x - r * .95, y + r * .75); g.closePath(); }
      else if (st.shape === 'sq') g.rect(x - r * .8, y - r * .8, r * 1.6, r * 1.6);
      else g.arc(x, y, r, 0, Math.PI * 2);
      g.fill(); g.stroke();
      const key = l.isBase ? (st.shape === 'tri' ? 'Sitio / radiobase' : st.shape === 'dot' ? 'Cámara de registro' : 'Punto') : 'Obra: ' + l.name.replace(/\.(kmz|kml)$/i, '');
      if (!legend.has(key)) legend.set(key, { kind: st.shape === 'tri' ? 'tri' : 'dot', color: st.fill });
      if (S.names && z0 >= 16 && f.n) labels.push([x + r + 4 * s, y, f.n]);
    }
  }
  // labels
  g.font = `bold ${11 * s}px Arial`; g.textBaseline = 'middle'; g.lineJoin = 'round';
  for (const [x, y, t] of labels.slice(0, 600)) { g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 3.5 * s; g.strokeText(t, x, y); g.fillStyle = '#1d2530'; g.fillText(t, x, y); }
  // annotations
  for (const a of anns) {
    g.strokeStyle = a.color; g.fillStyle = a.color; g.lineWidth = 4 * s; g.setLineDash([]); g.lineCap = 'round'; g.lineJoin = 'round';
    const P = ll => proj(ll[1], ll[0]);
    if (a.type === 'line' || a.type === 'free' || a.type === 'arrow') {
      g.beginPath(); a.lls.forEach((ll, i) => { const q = P(ll); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); }); g.stroke();
      if (a.type === 'arrow') { const A = P(a.lls[0]), B = P(a.lls[1]); const ang = Math.atan2(B[1] - A[1], B[0] - A[0]), hl = 18 * s; g.beginPath(); g.moveTo(B[0], B[1]); g.lineTo(B[0] - hl * Math.cos(ang - .45), B[1] - hl * Math.sin(ang - .45)); g.lineTo(B[0] - hl * Math.cos(ang + .45), B[1] - hl * Math.sin(ang + .45)); g.closePath(); g.fill(); }
    } else if (a.type === 'circle') {
      const c = P(a.ll); const mpp = 40075016.686 * Math.cos(a.ll[0] * DEG) / Math.pow(2, zr + 8);
      g.beginPath(); g.arc(c[0], c[1], a.r / mpp, 0, Math.PI * 2); g.globalAlpha = .08; g.fill(); g.globalAlpha = 1; g.stroke();
    } else if (a.type === 'rect') {
      const p1 = P(a.lls[0]), p2 = P(a.lls[1]); g.globalAlpha = .08; g.fillRect(p1[0], p1[1], p2[0] - p1[0], p2[1] - p1[1]); g.globalAlpha = 1; g.strokeRect(p1[0], p1[1], p2[0] - p1[0], p2[1] - p1[1]);
    } else if (a.type === 'text' || a.type === 'point') {
      const [x, y] = P(a.ll); const t = (a.type === 'point' ? '📍 ' : '') + (a.text || '');
      g.font = `800 ${15 * s}px Arial`; g.textAlign = a.type === 'text' ? 'center' : 'left'; g.textBaseline = 'middle';
      g.strokeStyle = '#fff'; g.lineWidth = 5 * s; g.strokeText(t, x - (a.type === 'point' ? 9 * s : 0), y); g.fillStyle = a.color; g.fillText(t, x - (a.type === 'point' ? 9 * s : 0), y); g.textAlign = 'left';
    }
  }
  // risk pins
  if (S.riskColors) for (const z of risks) {
    const [x, y] = proj(z.at[0], z.at[1]); if (x < 0 || y < 0 || x > MW || y > MH) continue;
    const big = exportZone && z === exportZone; const r = (big ? 16 : 12) * s;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = z.cls === 2 ? '#e01e1e' : '#ff8c00'; g.fill(); g.lineWidth = 2.5 * s; g.strokeStyle = '#fff'; g.stroke();
    g.fillStyle = '#fff'; g.font = `bold ${(big ? 14 : 11) * s}px Arial`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(z.num, x, y + .5); g.textAlign = 'left';
  }
  if (S.riskColors && risks.length) { legend.set(`Riesgo: cruce o a menos de ${S.red} m`, { kind: 'risk', color: '#e01e1e' }); legend.set(`A revisar: hasta ${S.orange} m`, { kind: 'risk', color: '#ff8c00' }); }
  // north arrow + scale
  const na = (x, y) => { g.save(); g.translate(x, y); g.fillStyle = 'rgba(255,255,255,.9)'; g.beginPath(); g.arc(0, 0, 24 * k, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#333'; g.lineWidth = 1 * k; g.stroke();
    g.fillStyle = '#1d2530'; g.beginPath(); g.moveTo(0, -17 * k); g.lineTo(8 * k, 9 * k); g.lineTo(0, 4 * k); g.closePath(); g.fill(); g.fillStyle = '#999'; g.beginPath(); g.moveTo(0, -17 * k); g.lineTo(-8 * k, 9 * k); g.lineTo(0, 4 * k); g.closePath(); g.fill();
    g.fillStyle = '#1d2530'; g.font = `bold ${10 * k}px Arial`; g.textAlign = 'center'; g.fillText('N', 0, 19 * k); g.restore(); };
  na(MW - 36 * k, 36 * k);
  const mpp = 40075016.686 * Math.cos(center.lat * DEG) / Math.pow(2, zr + 8);
  const target = 140 * k * mpp; const pw = Math.pow(10, Math.floor(Math.log10(target))); const nice = [1, 2, 5, 10].map(x => x * pw).filter(x => x <= target).pop();
  const sw = nice / mpp; const sx = 16 * k, sy = MH - 22 * k;
  g.fillStyle = 'rgba(255,255,255,.88)'; g.fillRect(sx - 8 * k, sy - 22 * k, sw + 16 * k, 34 * k);
  g.fillStyle = '#1d2530'; g.fillRect(sx, sy, sw / 2, 5 * k); g.strokeStyle = '#1d2530'; g.lineWidth = 1 * k; g.strokeRect(sx, sy, sw, 5 * k);
  g.font = `${11 * k}px Arial`; g.textBaseline = 'alphabetic'; g.textAlign = 'center'; g.fillText('0', sx, sy - 5 * k); g.fillText(nice >= 1000 ? (nice / 1000) + ' km' : nice + ' m', sx + sw, sy - 5 * k); g.textAlign = 'left';
  // ---- sheet ----
  let addr = '';
  if ($('#expAddr').checked) addr = await timeout(reverseGeocode(exportZone ? L.latLng(exportZone.at[1], exportZone.at[0]) : center), 6000).catch(() => '');
  const HEAD = 96 * k, LEG = 30 * k + Math.ceil(legend.size / 3) * 24 * k + 40 * k, PAD = 16 * k;
  const C = document.createElement('canvas'); C.width = MW + PAD * 2; C.height = HEAD + MH + LEG + PAD; const c = C.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, C.width, C.height);
  c.fillStyle = '#0b2a4a'; c.fillRect(0, 0, C.width, HEAD);
  c.fillStyle = '#e01e1e'; c.fillRect(0, HEAD - 5 * k, C.width, 5 * k);
  c.fillStyle = '#fff'; c.textBaseline = 'alphabetic';
  c.font = `bold ${24 * k}px Arial`; c.fillText(S.title, PAD, 36 * k);
  c.font = `${15 * k}px Arial`; c.fillStyle = '#cfe0f5';
  const obra = $('#expObra').value.trim(), to = $('#expTo').value.trim();
  c.fillText([S.company, obra && 'Obra: ' + obra, to && 'Para: ' + to].filter(Boolean).join('   ·   '), PAD, 62 * k);
  c.fillText([addr && 'Zona: ' + addr, exportZone && `Punto ${exportZone.num}: ${riskText(exportZone).what}`].filter(Boolean).join('   ·   '), PAD, 84 * k);
  c.textAlign = 'right'; c.fillStyle = '#fff'; c.font = `bold ${16 * k}px Arial`; c.fillText(fmtDate(), C.width - PAD, 36 * k); c.textAlign = 'left';
  c.drawImage(mc, PAD, HEAD);
  c.strokeStyle = '#9aa5b1'; c.lineWidth = 1 * k; c.strokeRect(PAD, HEAD, MW, MH);
  // legend
  let y = HEAD + MH + 26 * k; c.fillStyle = '#0b2a4a'; c.font = `bold ${13 * k}px Arial`; c.fillText('Referencias', PAD, y);
  const colW = MW / 3; let i = 0;
  for (const [name, it] of legend) {
    const x = PAD + (i % 3) * colW, yy = y + 22 * k + Math.floor(i / 3) * 24 * k; i++;
    c.save();
    if (it.kind === 'line') { c.strokeStyle = it.color; c.lineWidth = 4 * k; c.setLineDash(it.dashed ? [7 * k, 5 * k] : []); c.beginPath(); c.moveTo(x, yy - 4 * k); c.lineTo(x + 30 * k, yy - 4 * k); c.stroke(); }
    else if (it.kind === 'area') { c.fillStyle = it.color; c.globalAlpha = .3; c.fillRect(x, yy - 12 * k, 30 * k, 14 * k); c.globalAlpha = 1; c.strokeStyle = it.color; c.lineWidth = 2 * k; c.strokeRect(x, yy - 12 * k, 30 * k, 14 * k); }
    else if (it.kind === 'tri') { c.fillStyle = it.color; c.strokeStyle = '#1d2530'; c.lineWidth = k; c.beginPath(); c.moveTo(x + 15 * k, yy - 13 * k); c.lineTo(x + 23 * k, yy + 1 * k); c.lineTo(x + 7 * k, yy + 1 * k); c.closePath(); c.fill(); c.stroke(); }
    else if (it.kind === 'risk') { c.fillStyle = it.color; c.globalAlpha = .55; c.fillRect(x, yy - 9 * k, 30 * k, 9 * k); c.globalAlpha = 1; }
    else { c.fillStyle = it.color; c.strokeStyle = '#1d2530'; c.lineWidth = k; c.beginPath(); c.arc(x + 15 * k, yy - 5 * k, 6 * k, 0, Math.PI * 2); c.fill(); c.stroke(); }
    c.restore();
    c.fillStyle = '#1d2530'; c.font = `${12.5 * k}px Arial`; c.fillText(name.length > 46 ? name.slice(0, 45) + '…' : name, x + 38 * k, yy);
  }
  // footer
  const fy = C.height - 14 * k;
  c.fillStyle = '#6b7480'; c.font = `italic ${11 * k}px Arial`; c.fillText(S.note, PAD, fy - 16 * k);
  c.font = `${11 * k}px Arial`; c.fillText(`Elaborado por: ${S.author}${S.contact ? '  ·  ' + S.contact : ''}`, PAD, fy);
  c.textAlign = 'right'; c.fillText(BASES[baseKey].map(b => b.attr).join(' '), C.width - PAD, fy); c.textAlign = 'left';
  return await new Promise(res => C.toBlob(res, 'image/png'));
}

// ============ panels / settings ============
function closeSheets() { $$('.sheet').forEach(s => s.classList.add('hidden')); }
$$('[data-close]').forEach(b => b.onclick = () => $('#' + b.dataset.close).classList.add('hidden'));
function closePanelMobile() { if (innerWidth < 760) { $('#panel').classList.add('closed'); document.body.classList.add('panel-closed'); } }
$('#btnPanel').onclick = () => { const p = $('#panel'); p.classList.toggle('closed'); document.body.classList.toggle('panel-closed', p.classList.contains('closed')); setTimeout(() => map.invalidateSize(), 250); };
if (innerWidth < 760) closePanelMobile();
$('#btnSettings').onclick = () => {
  const h = $('#settingsPanel').classList.contains('hidden'); closeSheets(); if (!h) return;
  $('#setNames').checked = S.names; $('#setRiskColors').checked = S.riskColors; $('#setRed').value = S.red; $('#setOrange').value = S.orange;
  $('#setTitle').value = S.title; $('#setCompany').value = S.company; $('#setAuthor').value = S.author; $('#setContact').value = S.contact; $('#setNote').value = S.note;
  $('#settingsPanel').classList.remove('hidden');
};
$('#settingsPanel').addEventListener('change', () => {
  const before = [S.red, S.orange].join();
  S.names = $('#setNames').checked; S.riskColors = $('#setRiskColors').checked;
  S.red = Math.max(1, +$('#setRed').value || 5); S.orange = Math.max(S.red, +$('#setOrange').value || 20);
  S.title = $('#setTitle').value; S.company = $('#setCompany').value; S.author = $('#setAuthor').value; S.contact = $('#setContact').value; S.note = $('#setNote').value;
  saveS(); updateLabels();
  if (before !== [S.red, S.orange].join()) analyzeRisks(); else { drawRiskOverlay(); renderRisks(); }
});

// ============ file inputs ============
async function loadFiles(files, asBase) {
  for (const file of files) {
    try {
      loading(true, `Leyendo ${file.name}…`);
      await new Promise(r => setTimeout(r, 30));
      const tree = await readFile(file);
      loading(true, 'Analizando cruces con la traza…'); await new Promise(r => setTimeout(r, 30));
      const l = await addLayer(tree, asBase ? { isBase: true, pinned: true, name: 'Red Tigo', id: 'base' } : { name: file.name.replace(/\.(kmz|kml)$/i, '') });
      if (!asBase) { const b = boundsOf(l.tree); if (b.isValid()) map.fitBounds(b, { padding: [40, 40], maxZoom: 18 }); }
    } catch (e) { console.error(e); alert('No se pudo abrir ' + file.name + ':\n' + e.message); }
  }
  loading(false);
  if (!asBase && risks.length) openRiskPanel();
}
$('#fileInput').onchange = e => { loadFiles([...e.target.files], false); e.target.value = ''; closePanelMobile(); };
$('#baseInput').onchange = e => { loadFiles([...e.target.files].slice(0, 1), true); e.target.value = ''; };
$('#baseReplace').onchange = e => { if (confirm('¿Reemplazar la base Tigo guardada por este archivo?')) loadFiles([...e.target.files].slice(0, 1), true); e.target.value = ''; };
// drag & drop on PC
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { e.preventDefault(); const f = [...e.dataTransfer.files].filter(f => /\.(kmz|kml)$/i.test(f.name)); if (f.length) loadFiles(f, !layers.some(l => l.isBase) && confirm('¿Este archivo es la base Tigo? (Aceptar = base fija, Cancelar = obra)')); });

// ============ start ============
(async () => {
  try {
    await DB.open();
    loading(true, 'Cargando capas guardadas…');
    const saved = await DB.all();
    saved.sort((a, b) => (b.isBase ? 1 : 0) - (a.isBase ? 1 : 0));
    for (const s of saved) { layers.push(Object.assign(s, { pinned: true })); loadVis(s); }
    refreshVisibility(); renderTree(); buildRiskIndex(); analyzeRisks();
  } catch (e) { console.error(e); alert('No se pudo abrir el almacenamiento del navegador. Las capas no van a quedar guardadas.'); renderTree(); }
  loading(false);
})();
