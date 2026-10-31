'use strict';
// Scan360 UI: captura guiada por sensores + procesamiento final (alineación, mezcla, relleno).
const { D2R, orientationMatrix, forward, angleBetween, toCam, buildTargets, Pano, makeGray, alignShots, stitchOrder, tick } = Core;

let FW = 4096, FH = 2048;     // panorama final (según la resolución elegida)
const PW = 1024, PH = 512;    // vista previa en vivo
const ALIGN_DEG = 5;          // tolerancia de alineación para capturar
const MAX_SPEED = 12;         // deg/s máximo para considerar "quieto"
const DWELL_MS = 450;         // tiempo alineado antes de capturar
let MAXSIDE = 1280;            // lado máximo de cada foto guardada
const SMALL = 320;

const $ = id => document.getElementById(id);
const S = {
  vfov: 62, alpha0: null, hasOri: false, sim: false,
  ori: { alpha: 0, beta: 90, gamma: 0 },
  targets: [], shots: [], stream: null, running: false, finishing: false,
  dwell: 0, lastT: 0, lastFwd: null, speed: 0, busy: false,
  preview: null, blob: null, url: null, viewer: null,
};
const previewCanvas = document.createElement('canvas'); previewCanvas.width = PW; previewCanvas.height = PH;

function currentR() { const o = S.ori; return orientationMatrix(o.alpha - (S.alpha0 || 0), o.beta, o.gamma); }

// ---------- sensores ----------
function onOrientation(e) {
  if (e.alpha == null || e.beta == null) return;
  S.hasOri = true;
  if (S.alpha0 === null) S.alpha0 = e.alpha;
  S.ori = { alpha: e.alpha, beta: e.beta, gamma: e.gamma || 0 };
}
let simBound = false;
function enableSimDrag() {
  S.sim = true; S.hasOri = true; S.alpha0 = 0; S.ori = { alpha: 0, beta: 90, gamma: 0 };
  if (simBound) return; simBound = true;
  const c = $('overlay'); let last = null;
  c.addEventListener('pointerdown', e => { last = [e.clientX, e.clientY]; c.setPointerCapture(e.pointerId); });
  c.addEventListener('pointerup', () => last = null);
  c.addEventListener('pointermove', e => {
    if (!last || !S.sim) return;
    S.ori.alpha -= (e.clientX - last[0]) * 0.2;
    S.ori.beta = Math.max(0, Math.min(180, S.ori.beta - (e.clientY - last[1]) * 0.2));
    last = [e.clientX, e.clientY];
  });
}

// ---------- captura ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
function sharpness(canvas) { // varianza del laplaciano en una versión reducida
  const w = 192, h = Math.max(32, Math.round(192 * canvas.height / canvas.width));
  const t = document.createElement('canvas'); t.width = w; t.height = h;
  const x = t.getContext('2d', { willReadFrequently: true }); x.drawImage(canvas, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = d[i*4] * 0.299 + d[i*4+1] * 0.587 + d[i*4+2] * 0.114;
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let xx = 1; xx < w - 1; xx++) {
    const k = y * w + xx, l = 4 * g[k] - g[k-1] - g[k+1] - g[k-w] - g[k+w]; s += l; s2 += l * l; n++;
  }
  return s2 / n - (s / n) ** 2;
}
async function capture() {
  const v = $('video'), vw = v.videoWidth, vh = v.videoHeight;
  if (!vw) return false;
  const k = Math.min(1, MAXSIDE / Math.max(vw, vh));
  let best = null; // la más nítida de 3 fotos seguidas
  for (let n = 0; n < 3; n++) {
    const big = document.createElement('canvas'); big.width = Math.round(vw * k); big.height = Math.round(vh * k);
    big.getContext('2d').drawImage(v, 0, 0, big.width, big.height);
    const R = currentR(), sc = sharpness(big);
    if (!best || sc > best.sc) best = { big, R, sc };
    if (n < 2) await sleep(70);
  }
  const { big, R } = best;
  const blobP = new Promise(res => big.toBlob(res, 'image/jpeg', 0.93));
  const ks = SMALL / Math.max(big.width, big.height), gw = Math.round(big.width * ks), gh = Math.round(big.height * ks);
  const sm = document.createElement('canvas'); sm.width = gw; sm.height = gh;
  const sctx = sm.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(big, 0, 0, gw, gh);
  const rgba = sctx.getImageData(0, 0, gw, gh).data;
  S.shots.push({ R, blobP, g: makeGray(rgba, gw, gh), gw, gh });
  S.preview.add(R, rgba, gw, gh, S.vfov, false);
  previewCanvas.getContext('2d').putImageData(new ImageData(S.preview.data, PW, PH), 0, 0);
  $('mini').getContext('2d').drawImage(previewCanvas, 0, 0, 256, 128);
  if (navigator.vibrate) navigator.vibrate(25);
  return true;
}

function show(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id)); }

async function start() {
  $('introErr').textContent = '';
  try {
    // iOS exige pedir permiso dentro del gesto del usuario
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const p = await DeviceOrientationEvent.requestPermission();
      if (p !== 'granted') throw new Error('Permiso de movimiento denegado');
    }
    S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
  } catch (err) {
    $('introErr').textContent = 'No se pudo iniciar: ' + err.message + ' (se necesita HTTPS y permisos de cámara/movimiento)';
    return;
  }
  const v = $('video'); v.srcObject = S.stream; await v.play().catch(() => {});
  try { navigator.wakeLock && navigator.wakeLock.request('screen').catch(() => {}); } catch (e) {}
  [FW, FH, MAXSIDE] = pickResolution($('res').value);
  S.vfov = +$('fov').value; S.alpha0 = null; S.hasOri = false; S.sim = false;
  S.targets = buildTargets($('preset').value); S.shots = [];
  S.dwell = 0; S.lastFwd = null; S.busy = false; S.finishing = false;
  S.preview = new Pano(PW, PH);
  $('mini').getContext('2d').clearRect(0, 0, 256, 128);
  window.addEventListener('deviceorientation', onOrientation);
  show('scan'); resize();
  setTimeout(() => { if (!S.hasOri) enableSimDrag(); }, 1500);
  S.running = true; S.lastT = performance.now(); requestAnimationFrame(loop);
}

function stop() {
  S.running = false;
  window.removeEventListener('deviceorientation', onOrientation);
  if (S.stream) S.stream.getTracks().forEach(t => t.stop());
  S.stream = null;
}

function resize() {
  const c = $('overlay'), d = window.devicePixelRatio || 1;
  c.width = innerWidth * d; c.height = innerHeight * d;
}
addEventListener('resize', resize);

function loop(now) {
  if (!S.running) return;
  const dt = Math.max(1, now - S.lastT); S.lastT = now;
  const c = $('overlay'), g = c.getContext('2d');
  const d = window.devicePixelRatio || 1, cw = c.width / d, ch = c.height / d;
  g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, cw, ch);

  if (!S.hasOri) { $('hint').textContent = 'Esperando sensores…'; requestAnimationFrame(loop); return; }
  const R = currentR(), f = forward(R);
  if (S.lastFwd) S.speed = angleBetween(f, S.lastFwd) / (dt / 1000);
  S.lastFwd = f;

  const focal = (ch / 2) / Math.tan(S.vfov * D2R / 2);
  const cx = cw / 2, cy = ch / 2;
  let nearest = null, nd = 1e9;
  for (const t of S.targets) {
    const ang = angleBetween(f, t.dir);
    if (!t.done && ang < nd) { nd = ang; nearest = t; }
    const c3 = toCam(R, t.dir);
    if (c3[2] < -0.05) {
      const x = cx + (c3[0] / -c3[2]) * focal, y = cy - (c3[1] / -c3[2]) * focal;
      g.beginPath(); g.arc(x, y, t.done ? 7 : 15, 0, 7);
      if (t.done) { g.fillStyle = 'rgba(80,255,120,.85)'; g.fill(); }
      else { g.lineWidth = 3; g.strokeStyle = t === nearest ? '#fff' : 'rgba(255,255,255,.55)'; g.stroke(); }
    }
  }
  if (nearest) {
    const c3 = toCam(R, nearest.dir);
    const onScreen = c3[2] < -0.05 && Math.abs(c3[0] / -c3[2]) * focal < cw / 2 && Math.abs(c3[1] / -c3[2]) * focal < ch / 2;
    if (!onScreen) {
      const a = Math.atan2(-c3[1], c3[0]);
      const rr = Math.min(cw, ch) * 0.32;
      g.save(); g.translate(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); g.rotate(a);
      g.fillStyle = '#fff'; g.beginPath(); g.moveTo(18, 0); g.lineTo(-10, -14); g.lineTo(-10, 14); g.closePath(); g.fill(); g.restore();
    }
  }
  g.beginPath(); g.arc(cx, cy, 16, 0, 7); g.fillStyle = '#fff'; g.fill();
  const aligned = nearest && nd < ALIGN_DEG && S.speed < MAX_SPEED && !S.busy;
  S.dwell = aligned ? S.dwell + dt : 0;
  if (aligned) { g.beginPath(); g.arc(cx, cy, 26, -Math.PI / 2, -Math.PI / 2 + Math.min(1, S.dwell / DWELL_MS) * 2 * Math.PI); g.lineWidth = 5; g.strokeStyle = '#5f8'; g.stroke(); }
  if (aligned && S.dwell >= DWELL_MS) {
    S.busy = true; S.dwell = 0;
    const tgt = nearest;
    capture().then(ok => { if (ok) tgt.done = true; }).catch(e => console.error(e)).finally(() => setTimeout(() => S.busy = false, 250));
  }
  const done = S.targets.filter(t => t.done).length;
  $('count').textContent = done + ' / ' + S.targets.length + (S.sim ? '  (modo ratón: arrastra)' : '');
  $('hint').textContent = !nearest ? '¡Listo!' : S.speed > MAX_SPEED ? 'Más despacio…' : 'Lleva el punto blanco al círculo';
  if (!nearest && !S.finishing) { S.finishing = true; setTimeout(finish, 600); }
  requestAnimationFrame(loop);
}

// ---------- procesamiento final ----------
async function loadImage(blob) {
  if (window.createImageBitmap) return createImageBitmap(blob);
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(blob); });
}

function addXmp(buf, W, H) {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0xFF || u8[1] !== 0xD8) return buf;
  const xml = '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" GPano:UsePanoramaViewer="True" GPano:ProjectionType="equirectangular" GPano:FullPanoWidthPixels="' + W + '" GPano:FullPanoHeightPixels="' + H + '" GPano:CroppedAreaImageWidthPixels="' + W + '" GPano:CroppedAreaImageHeightPixels="' + H + '" GPano:CroppedAreaLeftPixels="0" GPano:CroppedAreaTopPixels="0"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const enc = new TextEncoder(), hdr = enc.encode('http://ns.adobe.com/xap/1.0/\0'), body = enc.encode(xml);
  const len = 2 + hdr.length + body.length;
  const seg = new Uint8Array(2 + len); seg[0] = 0xFF; seg[1] = 0xE1; seg[2] = len >> 8; seg[3] = len & 255; seg.set(hdr, 4); seg.set(body, 4 + hdr.length);
  let pos = 2; if (u8[2] === 0xFF && u8[3] === 0xE0) pos = 4 + ((u8[4] << 8) | u8[5]);
  const out = new Uint8Array(u8.length + seg.length);
  out.set(u8.subarray(0, pos), 0); out.set(seg, pos); out.set(u8.subarray(pos), pos + seg.length);
  return out.buffer;
}

async function process() {
  const say = (m, p) => { $('procMsg').textContent = m; $('procBar').style.width = Math.round(p * 100) + '%'; };
  show('processing'); say('Preparando…', 0.02); await tick();
  const blobs = await Promise.all(S.shots.map(s => s.blobP));
  let res;
  try { res = await alignShots(S.shots, S.vfov, (m, p) => say(m, p * 0.5)); }
  catch (e) { console.error(e); res = { vfov: S.vfov, Rs: S.shots.map(s => s.R) }; }
  let pano;
  for (;;) { // si el equipo no tiene memoria, baja de resolución
    try { pano = new Pano(FW, FH); break; } catch (e) { if (FW <= 4096) throw e; FW = FW > 5760 ? 5760 : 4096; FH = FW / 2; }
  }
  pano.par = res.par || null; pano.pw = 8;
  const order = stitchOrder(res.Rs);
  const work = document.createElement('canvas'), wctx = work.getContext('2d', { willReadFrequently: true });
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    say('Mezclando fotos… ' + (k + 1) + '/' + order.length, 0.5 + 0.4 * (k / order.length));
    const bmp = await loadImage(blobs[i]);
    const w = bmp.width, h = bmp.height; work.width = w; work.height = h;
    wctx.drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
    pano.add(res.Rs[i], wctx.getImageData(0, 0, w, h).data, w, h, res.vfov, true);
    await tick();
  }
  say('Rellenando huecos…', 0.93); await tick();
  pano.fillHoles();
  say('Afinando nitidez…', 0.95); await tick();
  pano.sharpen(0.5);
  say('Guardando…', 0.97); await tick();
  const out = document.createElement('canvas'); out.width = FW; out.height = FH;
  out.getContext('2d').putImageData(new ImageData(pano.data, FW, FH), 0, 0);
  const raw = await new Promise(r => out.toBlob(r, 'image/jpeg', 0.94));
  const blob = new Blob([addXmp(await raw.arrayBuffer(), FW, FH)], { type: 'image/jpeg' });
  const rec = await saveCapture(blob, out);
  showResult(blob, rec);
}

function finish() {
  S.finishing = false;
  if (!S.running) return;
  stop();
  if (S.shots.length < 4) { $('introErr').textContent = 'Toma al menos unas cuantas fotos antes de terminar.'; show('intro'); return; }
  process().catch(e => { console.error(e); $('introErr').textContent = 'Error al procesar: ' + e.message; show('intro'); });
}

// ---------- resolución ----------
const RES = { max: [8192, 4096, 1920], high: [5760, 2880, 1600], std: [4096, 2048, 1280] };
function canvasOk(w, h) { // Safari iOS limita el canvas a ~16.7 Mpx
  try {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); if (!x) return false;
    x.fillStyle = '#fff'; x.fillRect(w - 1, h - 1, 1, 1);
    const ok = x.getImageData(w - 1, h - 1, 1, 1).data[3] === 255;
    c.width = c.height = 0; return ok;
  } catch (e) { return false; }
}
function pickResolution(key) {
  const order = ['max', 'high', 'std'];
  for (const k of order.slice(order.indexOf(key))) if (canvasOk(RES[k][0], RES[k][1])) return RES[k];
  return RES.std;
}

// ---------- galería (IndexedDB) ----------
const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open('scan360', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('caps', { keyPath: 'id' });
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function dbDo(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => { const t = db.transaction('caps', mode), req = fn(t.objectStore('caps')); t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error); });
}
const dbAll = () => dbDo('readonly', s => s.getAll());
const dbPut = rec => dbDo('readwrite', s => s.put(rec));
const dbDel = id => dbDo('readwrite', s => s.delete(id));
const dbGet = id => dbDo('readonly', s => s.get(id));
const fmtDate = t => new Date(t).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });

async function saveCapture(blob, canvas) {
  const th = document.createElement('canvas'); th.width = 320; th.height = 160;
  th.getContext('2d').drawImage(canvas, 0, 0, 320, 160);
  const rec = { id: Date.now(), name: 'Captura ' + fmtDate(Date.now()), createdAt: Date.now(), w: FW, h: FH, size: blob.size, thumb: th.toDataURL('image/jpeg', 0.7), blob };
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); await dbPut(rec); } catch (e) { console.warn('No se pudo guardar en la galería', e); }
  refreshCount();
  return rec;
}
async function refreshCount() { try { $('galCount').textContent = (await dbAll()).length; } catch (e) {} }

async function openGallery() {
  show('gallery');
  const list = $('galList'); list.innerHTML = '';
  let caps = []; try { caps = await dbAll(); } catch (e) {}
  caps.sort((x, y) => y.createdAt - x.createdAt);
  if (!caps.length) { list.innerHTML = '<p class="empty">Aún no tienes capturas.</p>'; return; }
  for (const c of caps) {
    const card = document.createElement('div'); card.className = 'card';
    card.innerHTML = '<img alt=""><div class="meta"><b></b><small></small></div><div class="acts"></div>';
    card.querySelector('img').src = c.thumb;
    card.querySelector('b').textContent = c.name;
    card.querySelector('small').textContent = fmtDate(c.createdAt) + ' · ' + c.w + '×' + c.h + ' · ' + (c.size / 1048576).toFixed(1) + ' MB';
    const acts = card.querySelector('.acts');
    const add = (label, fn, cls) => { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; acts.appendChild(b); };
    add('Ver', () => showResult(c.blob, c));
    add('JPG', () => exportJpg(c.blob, c.name));
    add('PNG', () => exportPng(c.blob, c.name));
    add('Renombrar', async () => { const n = prompt('Nombre:', c.name); if (n && n.trim()) { const r = await dbGet(c.id); r.name = n.trim(); await dbPut(r); openGallery(); } });
    add('Eliminar', async () => { if (confirm('¿Eliminar "' + c.name + '"?')) { await dbDel(c.id); refreshCount(); openGallery(); } }, 'del');
    list.appendChild(card);
  }
}

function showResult(blob, rec) {
  S.blob = blob; S.name = (rec && rec.name) || 'panorama';
  if (S.url) URL.revokeObjectURL(S.url);
  S.url = URL.createObjectURL(blob);
  $('resInfo').textContent = rec && rec.w ? rec.w + '×' + rec.h + ' · ' + (blob.size / 1048576).toFixed(1) + ' MB' : '';
  show('result');
  if (S.viewer) { try { S.viewer.destroy(); } catch (e) {} }
  if (window.pannellum) S.viewer = pannellum.viewer('pano', { type: 'equirectangular', panorama: S.url, autoLoad: true, showFullscreenCtrl: false });
}

// ---------- exportar ----------
const safeName = n => (n || 'panorama').replace(/[^\w\-áéíóúñ ]+/gi, '').trim().replace(/\s+/g, '_') || 'panorama';
async function shareOrDownload(file) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
const exportJpg = (blob, name) => shareOrDownload(new File([blob], safeName(name) + '.jpg', { type: 'image/jpeg' }));
async function exportPng(blob, name) {
  const bmp = await loadImage(blob), c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
  const png = await new Promise(r => c.toBlob(r, 'image/png'));
  if (png) shareOrDownload(new File([png], safeName(name) + '.png', { type: 'image/png' }));
}
function downloadHtml() {
  if (!S.blob) return;
  const fr = new FileReader();
  fr.onload = () => {
    const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/pannellum/2.5.6/pannellum.css"><title>360</title>' +
      '<style>html,body,#p{margin:0;width:100%;height:100%;background:#000}</style></head><body><div id="p"></div>' +
      '<script src="https://cdnjs.cloudflare.com/ajax/libs/pannellum/2.5.6/pannellum.js"></' + 'script>' +
      '<script>pannellum.viewer("p",{type:"equirectangular",panorama:"' + fr.result + '",autoLoad:true,autoRotate:-2});</' + 'script></body></html>';
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' })); a.download = safeName(S.name) + '.html'; a.click();
  };
  fr.readAsDataURL(S.blob);
}

$('fov').oninput = e => $('fovVal').textContent = e.target.value;
$('start').onclick = start;
$('finish').onclick = finish;
$('cancel').onclick = () => { stop(); show('intro'); };
$('again').onclick = () => { show('intro'); refreshCount(); };
$('toGallery').onclick = openGallery;
$('openGallery').onclick = openGallery;
$('galBack').onclick = () => { show('intro'); refreshCount(); };
$('dlJpg').onclick = () => exportJpg(S.blob, S.name);
$('dlPng').onclick = () => exportPng(S.blob, S.name);
$('html').onclick = downloadHtml;
refreshCount();
window.__scan = S; // hook para pruebas
