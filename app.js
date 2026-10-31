'use strict';
// Scan360: captura guiada por giroscopio -> panorama equirectangular 4096x2048.
const W = 4096, H = 2048;
const D2R = Math.PI / 180;
const ALIGN_DEG = 5;      // tolerancia de alineación para capturar
const MAX_SPEED = 30;     // deg/s máximo para considerar "quieto"
const DWELL_MS = 350;     // tiempo alineado antes de capturar

const $ = id => document.getElementById(id);
const S = {
  vfov: 62, alpha0: null, hasOri: false, sim: false,
  ori: { alpha: 0, beta: 90, gamma: 0 },
  targets: [], stream: null, running: false,
  dwell: 0, lastT: 0, lastFwd: null, speed: 0, busy: false,
};

// ---------- matemáticas ----------
const mul = (a, b) => { const r = new Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i*3+j] = a[i*3]*b[j] + a[i*3+1]*b[3+j] + a[i*3+2]*b[6+j]; return r; };
const Rx = t => { const c = Math.cos(t), s = Math.sin(t); return [1,0,0, 0,c,-s, 0,s,c]; };
const Ry = t => { const c = Math.cos(t), s = Math.sin(t); return [c,0,s, 0,1,0, -s,0,c]; };
const Rz = t => { const c = Math.cos(t), s = Math.sin(t); return [c,-s,0, s,c,0, 0,0,1]; };
// camara (x der, y arriba, -z adelante) -> mundo (y arriba). Misma convención que three.js.
const orientationMatrix = (a, b, g) => mul(mul(mul(Ry(a*D2R), Rx(b*D2R)), Rz(-g*D2R)), Rx(-Math.PI/2));
const forward = R => [-R[2], -R[5], -R[8]];
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const angleBetween = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) / D2R;
const toCam = (R, d) => [R[0]*d[0]+R[3]*d[1]+R[6]*d[2], R[1]*d[0]+R[4]*d[1]+R[7]*d[2], R[2]*d[0]+R[5]*d[1]+R[8]*d[2]];

function buildTargets() {
  // [latitud, cantidad de fotos en el anillo]
  const rings = [[0,12],[45,8],[-45,8],[90,1],[-90,1]];
  const t = [];
  for (const [lat, n] of rings) for (let k = 0; k < n; k++) {
    const lon = (k / n) * 360 - 180 + (lat === 0 ? 0 : 0);
    const la = lat * D2R, lo = lon * D2R;
    t.push({ lat, lon, dir: [Math.cos(la)*Math.sin(lo), Math.sin(la), -Math.cos(la)*Math.cos(lo)], done: false });
  }
  return t;
}

function currentR() {
  const o = S.ori;
  return orientationMatrix(o.alpha - (S.alpha0 || 0), o.beta, o.gamma);
}

// ---------- panorama ----------
const eqCanvas = document.createElement('canvas'); eqCanvas.width = W; eqCanvas.height = H;
const eqCtx = eqCanvas.getContext('2d');
let eqImg, weight, sinLon, cosLon, sinLat, cosLat;
function initPano() {
  eqImg = eqCtx.createImageData(W, H);
  for (let i = 3; i < eqImg.data.length; i += 4) eqImg.data[i] = 255; // negro opaco
  weight = new Float32Array(W * H);
  sinLon = new Float32Array(W); cosLon = new Float32Array(W);
  for (let i = 0; i < W; i++) { const lo = ((i + .5) / W) * 2 * Math.PI - Math.PI; sinLon[i] = Math.sin(lo); cosLon[i] = Math.cos(lo); }
  sinLat = new Float32Array(H); cosLat = new Float32Array(H);
  for (let j = 0; j < H; j++) { const la = Math.PI / 2 - ((j + .5) / H) * Math.PI; sinLat[j] = Math.sin(la); cosLat[j] = Math.cos(la); }
  eqCtx.putImageData(eqImg, 0, 0);
}

const scratch = document.createElement('canvas');
const sctx = scratch.getContext('2d', { willReadFrequently: true });

function stitch(R, src, sw, sh) {
  const ty = Math.tan(S.vfov * D2R / 2), tx = ty * sw / sh;
  const r = Math.atan(Math.hypot(tx, ty));
  const f = forward(R), lat0 = Math.asin(f[1]), lon0 = Math.atan2(f[0], -f[2]);
  const j0 = Math.max(0, Math.floor((Math.PI/2 - (lat0 + r)) / Math.PI * H));
  const j1 = Math.min(H - 1, Math.ceil((Math.PI/2 - (lat0 - r)) / Math.PI * H));
  let i0 = 0, i1 = W - 1;
  const s = Math.sin(r) / Math.max(1e-6, Math.cos(lat0));
  if (lat0 + r < Math.PI/2 && lat0 - r > -Math.PI/2 && s < 1) {
    const dl = Math.asin(s) * 1.05;
    i0 = Math.floor((lon0 - dl + Math.PI) / (2*Math.PI) * W); i1 = Math.ceil((lon0 + dl + Math.PI) / (2*Math.PI) * W);
  }
  const R0=R[0],R1=R[1],R2=R[2],R3=R[3],R4=R[4],R5=R[5],R6=R[6],R7=R[7],R8=R[8];
  const out = eqImg.data, sd = src.data;
  for (let j = j0; j <= j1; j++) {
    const cl = cosLat[j], sl = sinLat[j];
    for (let k = i0; k <= i1; k++) {
      const i = ((k % W) + W) % W;
      const dx = cl * sinLon[i], dy = sl, dz = -cl * cosLon[i];
      const cz = R2*dx + R5*dy + R8*dz;
      if (cz > -1e-6) continue;
      const ax = ((R0*dx + R3*dy + R6*dz) / -cz) / tx;
      const ay = ((R1*dx + R4*dy + R7*dz) / -cz) / ty;
      if (ax < -1 || ax > 1 || ay < -1 || ay > 1) continue;
      const w = 1.0001 - Math.max(Math.abs(ax), Math.abs(ay));
      const idx = j * W + i;
      if (w <= weight[idx]) continue;
      weight[idx] = w;
      const sx = ((ax + 1) / 2 * (sw - 1)) | 0, sy = ((1 - ay) / 2 * (sh - 1)) | 0;
      const so = (sy * sw + sx) * 4, o = idx * 4;
      out[o] = sd[so]; out[o+1] = sd[so+1]; out[o+2] = sd[so+2];
    }
  }
}

function capture(R) {
  const v = $('video'), vw = v.videoWidth, vh = v.videoHeight;
  if (!vw) return;
  const k = Math.min(1, 1280 / Math.max(vw, vh));
  const sw = Math.round(vw * k), sh = Math.round(vh * k);
  scratch.width = sw; scratch.height = sh;
  sctx.drawImage(v, 0, 0, sw, sh);
  stitch(R, sctx.getImageData(0, 0, sw, sh), sw, sh);
  eqCtx.putImageData(eqImg, 0, 0);
  const m = $('mini').getContext('2d'); m.drawImage(eqCanvas, 0, 0, 256, 128);
}

// ---------- sensores ----------
function onOrientation(e) {
  if (e.alpha == null || e.beta == null) return;
  S.hasOri = true;
  if (S.alpha0 === null) S.alpha0 = e.alpha;
  S.ori = { alpha: e.alpha, beta: e.beta, gamma: e.gamma || 0 };
}
function enableSimDrag() {
  S.sim = true; S.hasOri = true; S.alpha0 = 0;
  S.ori = { alpha: 0, beta: 90, gamma: 0 };
  const c = $('overlay'); let last = null;
  c.addEventListener('pointerdown', e => { last = [e.clientX, e.clientY]; c.setPointerCapture(e.pointerId); });
  c.addEventListener('pointerup', () => last = null);
  c.addEventListener('pointermove', e => {
    if (!last) return;
    S.ori.alpha -= (e.clientX - last[0]) * 0.2;
    S.ori.beta = Math.max(0, Math.min(180, S.ori.beta - (e.clientY - last[1]) * 0.2));
    last = [e.clientX, e.clientY];
  });
}

// ---------- UI / bucle ----------
function show(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id)); }

async function start() {
  $('introErr').textContent = '';
  try {
    // iOS exige pedir permiso dentro del gesto del usuario
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const p = await DeviceOrientationEvent.requestPermission();
      if (p !== 'granted') throw new Error('Permiso de movimiento denegado');
    }
    S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
  } catch (err) {
    $('introErr').textContent = 'No se pudo iniciar: ' + err.message + ' (se necesita HTTPS y permisos de cámara/movimiento)';
    return;
  }
  const v = $('video'); v.srcObject = S.stream; await v.play().catch(() => {});
  try { navigator.wakeLock && navigator.wakeLock.request('screen').catch(() => {}); } catch (e) {}
  S.vfov = +$('fov').value; S.alpha0 = null; S.hasOri = false; S.sim = false;
  S.targets = buildTargets(); S.dwell = 0; S.lastFwd = null; S.busy = false;
  initPano(); $('mini').getContext('2d').clearRect(0, 0, 256, 128);
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
  // flecha hacia el siguiente objetivo si está fuera de pantalla
  if (nearest) {
    const c3 = toCam(R, nearest.dir);
    const onScreen = c3[2] < -0.05 && Math.abs(c3[0] / -c3[2]) * focal < cw / 2 && Math.abs(c3[1] / -c3[2]) * focal < ch / 2;
    if (!onScreen) {
      const a = Math.atan2(-c3[1], c3[0]); // pantalla: y hacia abajo
      const rr = Math.min(cw, ch) * 0.32;
      g.save(); g.translate(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); g.rotate(a);
      g.fillStyle = '#fff'; g.beginPath(); g.moveTo(18, 0); g.lineTo(-10, -14); g.lineTo(-10, 14); g.closePath(); g.fill(); g.restore();
    }
  }
  // retícula central + progreso de captura
  g.beginPath(); g.arc(cx, cy, 16, 0, 7); g.fillStyle = '#fff'; g.fill();
  const aligned = nearest && nd < ALIGN_DEG && S.speed < MAX_SPEED && !S.busy;
  S.dwell = aligned ? S.dwell + dt : 0;
  if (aligned) { g.beginPath(); g.arc(cx, cy, 26, -Math.PI / 2, -Math.PI / 2 + Math.min(1, S.dwell / DWELL_MS) * 2 * Math.PI); g.lineWidth = 5; g.strokeStyle = '#5f8'; g.stroke(); }
  if (aligned && S.dwell >= DWELL_MS) {
    S.busy = true; nearest.done = true; S.dwell = 0;
    capture(R);
    setTimeout(() => S.busy = false, 120);
  }
  const done = S.targets.filter(t => t.done).length;
  $('count').textContent = done + ' / ' + S.targets.length + (S.sim ? '  (modo ratón: arrastra)' : '');
  $('hint').textContent = !nearest ? '¡Listo! Pulsa Terminar' : S.speed > MAX_SPEED ? 'Más despacio…' : 'Lleva el punto blanco al círculo';
  if (!nearest && !S.finishing) { S.finishing = true; setTimeout(finish, 600); }
  requestAnimationFrame(loop);
}

let url = null, viewer = null;
function finish() {
  S.finishing = false;
  if (!S.running) return;
  stop(); show('result');
  eqCanvas.toBlob(b => {
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(b);
    if (viewer) { try { viewer.destroy(); } catch (e) {} }
    viewer = pannellum.viewer('pano', { type: 'equirectangular', panorama: url, autoLoad: true, showFullscreenCtrl: false });
  }, 'image/jpeg', 0.92);
}

$('fov').oninput = e => $('fovVal').textContent = e.target.value;
$('start').onclick = start;
$('finish').onclick = finish;
$('cancel').onclick = () => { stop(); show('intro'); };
$('again').onclick = () => show('intro');
$('download').onclick = () => { if (!url) return; const a = document.createElement('a'); a.href = url; a.download = 'panorama.jpg'; a.click(); };
// hooks para pruebas
window.__scan = S;
