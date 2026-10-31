'use strict';
// Scan360 core: matemáticas, panorama con mezcla, alineación. Sin DOM (se prueba en node).
(function (root) {
  const D2R = Math.PI / 180;
  const WS = 4096; // escala de pesos (Uint16)
  const tick = () => new Promise(r => setTimeout(r, 0));

  // ---------- álgebra 3x3 (row-major) ----------
  const mul = (a, b) => { const r = new Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i*3+j] = a[i*3]*b[j] + a[i*3+1]*b[3+j] + a[i*3+2]*b[6+j]; return r; };
  const Rx = t => { const c = Math.cos(t), s = Math.sin(t); return [1,0,0, 0,c,-s, 0,s,c]; };
  const Ry = t => { const c = Math.cos(t), s = Math.sin(t); return [c,0,s, 0,1,0, -s,0,c]; };
  const Rz = t => { const c = Math.cos(t), s = Math.sin(t); return [c,-s,0, s,c,0, 0,0,1]; };
  // cámara (x der, y arriba, -z adelante) -> mundo (y arriba); misma convención que three.js
  const orientationMatrix = (a, b, g) => mul(mul(mul(Ry(a*D2R), Rx(b*D2R)), Rz(-g*D2R)), Rx(-Math.PI/2));
  const applyDelta = (R, d) => mul(mul(mul(R, Ry(d[0])), Rx(d[1])), Rz(d[2])); // rotación en ejes de cámara
  const forward = R => [-R[2], -R[5], -R[8]];
  const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
  const angleBetween = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) / D2R;
  const toCam = (R, d) => [R[0]*d[0]+R[3]*d[1]+R[6]*d[2], R[1]*d[0]+R[4]*d[1]+R[7]*d[2], R[2]*d[0]+R[5]*d[1]+R[8]*d[2]];

  // ---------- objetivos de captura ----------
  const PRESETS = {
    fast: [[0,12],[45,8],[-45,8],[90,1],[-90,1]],
    high: [[0,14],[35,12],[-35,12],[65,6],[-65,6],[90,1],[-90,1]],
  };
  function buildTargets(preset) {
    const rings = PRESETS[preset] || PRESETS.high, t = [];
    rings.forEach(([lat, n], ri) => {
      for (let k = 0; k < n; k++) {
        const lon = ((k + (ri % 2 ? 0.5 : 0)) / n) * 360 - 180;
        const la = lat * D2R, lo = lon * D2R;
        t.push({ lat, lon, dir: [Math.cos(la)*Math.sin(lo), Math.sin(la), -Math.cos(la)*Math.cos(lo)], done: false });
      }
    });
    return t;
  }

  // ---------- panorama equirectangular con mezcla ponderada ----------
  class Pano {
    constructor(W, H) {
      this.W = W; this.H = H;
      this.data = new Uint8ClampedArray(W * H * 4);
      for (let i = 3; i < this.data.length; i += 4) this.data[i] = 255;
      this.weight = new Uint16Array(W * H); // peso acumulado * WS
      this.sinLon = new Float32Array(W); this.cosLon = new Float32Array(W);
      for (let i = 0; i < W; i++) { const lo = ((i + .5) / W) * 2 * Math.PI - Math.PI; this.sinLon[i] = Math.sin(lo); this.cosLon[i] = Math.cos(lo); }
      this.sinLat = new Float32Array(H); this.cosLat = new Float32Array(H);
      for (let j = 0; j < H; j++) { const la = Math.PI / 2 - ((j + .5) / H) * Math.PI; this.sinLat[j] = Math.sin(la); this.cosLat[j] = Math.cos(la); }
    }
    // recorre los píxeles del panorama que cubre una foto; fn(idx, sx, sy, w)
    _scan(R, sw, sh, vfov, fn) {
      const { W, H, sinLon, cosLon, sinLat, cosLat } = this;
      const ty = Math.tan(vfov * D2R / 2), tx = ty * sw / sh;
      const r = Math.atan(Math.hypot(tx, ty));
      const f = forward(R), lat0 = Math.asin(Math.max(-1, Math.min(1, f[1]))), lon0 = Math.atan2(f[0], -f[2]);
      const j0 = Math.max(0, Math.floor((Math.PI/2 - (lat0 + r)) / Math.PI * H));
      const j1 = Math.min(H - 1, Math.ceil((Math.PI/2 - (lat0 - r)) / Math.PI * H));
      let i0 = 0, i1 = W - 1;
      const s = Math.sin(r) / Math.max(1e-6, Math.cos(lat0));
      if (lat0 + r < Math.PI/2 && lat0 - r > -Math.PI/2 && s < 1) {
        const dl = Math.asin(s) * 1.05;
        i0 = Math.floor((lon0 - dl + Math.PI) / (2*Math.PI) * W); i1 = Math.ceil((lon0 + dl + Math.PI) / (2*Math.PI) * W);
      }
      const R0=R[0],R1=R[1],R2=R[2],R3=R[3],R4=R[4],R5=R[5],R6=R[6],R7=R[7],R8=R[8];
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
          fn(j * W + i, (ax + 1) / 2 * (sw - 1), (1 - ay) / 2 * (sh - 1), 1.0001 - Math.max(Math.abs(ax), Math.abs(ay)));
        }
      }
    }

    // sd: RGBA de la foto (sw x sh). useGain: iguala exposición/blancos con lo ya pegado.
    add(R, sd, sw, sh, vfov, useGain) {
      const { data, weight } = this;
      let g0 = 1, g1 = 1, g2 = 1;
      if (useGain) {
        let n = 0, cnt = 0, o0 = 0, o1 = 0, o2 = 0, n0 = 0, n1 = 0, n2 = 0;
        this._scan(R, sw, sh, vfov, (idx, sx, sy, w) => {
          if (w < 0.1 || weight[idx] < 0.05 * WS) return;
          if ((++cnt) & 3) return;
          const o = idx * 4, so = (((sy + .5) | 0) * sw + ((sx + .5) | 0)) * 4;
          o0 += data[o]; o1 += data[o+1]; o2 += data[o+2];
          n0 += sd[so]; n1 += sd[so+1]; n2 += sd[so+2]; n++;
        });
        if (n >= 150) {
          const cl = v => Math.max(0.7, Math.min(1.43, v));
          g0 = cl((o0 + 1) / (n0 + 1)); g1 = cl((o1 + 1) / (n1 + 1)); g2 = cl((o2 + 1) / (n2 + 1));
        }
      }
      this._scan(R, sw, sh, vfov, (idx, sx, sy, w) => {
        const x0 = sx | 0, y0 = sy | 0, x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
        const fx = sx - x0, fy = sy - y0;
        const a = ((1-fx)*(1-fy)), b = fx*(1-fy), c = (1-fx)*fy, d = fx*fy;
        const p00 = (y0*sw + x0)*4, p10 = (y0*sw + x1)*4, p01 = (y1*sw + x0)*4, p11 = (y1*sw + x1)*4;
        const r = (sd[p00]*a + sd[p10]*b + sd[p01]*c + sd[p11]*d) * g0;
        const g = (sd[p00+1]*a + sd[p10+1]*b + sd[p01+1]*c + sd[p11+1]*d) * g1;
        const bl = (sd[p00+2]*a + sd[p10+2]*b + sd[p01+2]*c + sd[p11+2]*d) * g2;
        const wn = w * w + 1e-3, wo = weight[idx] / WS, wt = wo + wn, k = wn / wt, o = idx * 4;
        data[o] = data[o] * (1 - k) + r * k;
        data[o+1] = data[o+1] * (1 - k) + g * k;
        data[o+2] = data[o+2] * (1 - k) + bl * k;
        weight[idx] = Math.min(65535, wt * WS);
      });
    }

    // rellena zonas sin cobertura con colores difundidos desde lo cercano
    fillHoles() {
      const { W, H, data, weight } = this;
      const LW = 256, LH = 128, sx = W / LW, sy = H / LH, area = sx * sy;
      const sum = new Float32Array(LW * LH * 3), cnt = new Uint32Array(LW * LH);
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        if (weight[j * W + i] <= 0) continue;
        const c = ((j / sy) | 0) * LW + ((i / sx) | 0), o = (j * W + i) * 4;
        sum[c*3] += data[o]; sum[c*3+1] += data[o+1]; sum[c*3+2] += data[o+2]; cnt[c]++;
      }
      const col = new Float32Array(LW * LH * 3), has = new Uint8Array(LW * LH);
      let filled = 0;
      for (let c = 0; c < LW * LH; c++) if (cnt[c] > area * 0.3) { has[c] = 1; filled++; col[c*3] = sum[c*3]/cnt[c]; col[c*3+1] = sum[c*3+1]/cnt[c]; col[c*3+2] = sum[c*3+2]/cnt[c]; }
      if (!filled || filled === LW * LH) return;
      for (let it = 0; it < 400; it++) {
        const add = [];
        for (let y = 0; y < LH; y++) for (let x = 0; x < LW; x++) {
          const c = y * LW + x; if (has[c]) continue;
          let n = 0, r = 0, g = 0, b = 0;
          for (const [nx, ny] of [[(x+1)%LW, y], [(x+LW-1)%LW, y], [x, y+1], [x, y-1]]) {
            if (ny < 0 || ny >= LH) continue;
            const q = ny * LW + nx; if (!has[q]) continue;
            n++; r += col[q*3]; g += col[q*3+1]; b += col[q*3+2];
          }
          if (n) add.push([c, r/n, g/n, b/n]);
        }
        if (!add.length) break;
        for (const [c, r, g, b] of add) { has[c] = 1; col[c*3] = r; col[c*3+1] = g; col[c*3+2] = b; }
      }
      // suaviza la rejilla un poco para que no se noten bloques
      for (let p = 0; p < 4; p++) {
        const nc = col.slice();
        for (let y = 0; y < LH; y++) for (let x = 0; x < LW; x++) {
          const c = y * LW + x; if (cnt[c] > area * 0.3) continue;
          for (let k = 0; k < 3; k++) {
            const l = col[(y*LW + (x+LW-1)%LW)*3+k], r = col[(y*LW + (x+1)%LW)*3+k];
            const u = col[(Math.max(0, y-1)*LW + x)*3+k], d = col[(Math.min(LH-1, y+1)*LW + x)*3+k];
            nc[c*3+k] = (col[c*3+k]*2 + l + r + u + d) / 6;
          }
        }
        col.set(nc);
      }
      for (let j = 0; j < H; j++) {
        const fy = j / sy - 0.5, y0 = Math.max(0, Math.min(LH - 1, Math.floor(fy))), y1 = Math.min(LH - 1, y0 + 1), ty = Math.max(0, Math.min(1, fy - y0));
        for (let i = 0; i < W; i++) {
          if (weight[j * W + i] > 0) continue;
          const fx = i / sx - 0.5, xf = Math.floor(fx), tx = fx - xf;
          const x0 = ((xf % LW) + LW) % LW, x1 = (x0 + 1) % LW, o = (j * W + i) * 4;
          for (let k = 0; k < 3; k++) {
            const a = col[(y0*LW + x0)*3+k], b = col[(y0*LW + x1)*3+k], c = col[(y1*LW + x0)*3+k], d = col[(y1*LW + x1)*3+k];
            data[o+k] = (a*(1-tx) + b*tx) * (1-ty) + (c*(1-tx) + d*tx) * ty;
          }
        }
      }
    }
  }

  // ---------- alineación fina: calibra el FOV y corrige la orientación de cada foto ----------
  const NX = 14, NY = 18;
  const AX = new Float32Array(NX * NY), AY = new Float32Array(NX * NY);
  for (let iy = 0; iy < NY; iy++) for (let ix = 0; ix < NX; ix++) { AX[iy*NX+ix] = -0.9 + 1.8 * ix / (NX - 1); AY[iy*NX+ix] = -0.9 + 1.8 * iy / (NY - 1); }

  const bilinearGray = (g, gw, gh, u, v) => {
    const x0 = u | 0, y0 = v | 0, x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1), fx = u - x0, fy = v - y0;
    const a = g[y0*gw + x0], b = g[y0*gw + x1], c = g[y1*gw + x0], d = g[y1*gw + x1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };

  // gris normalizado (media 0, desviación 40): inmune a diferencias de exposición
  function makeGray(rgba, w, h) {
    const g = new Float32Array(w * h); let m = 0;
    for (let i = 0; i < w * h; i++) { g[i] = rgba[i*4]*0.299 + rgba[i*4+1]*0.587 + rgba[i*4+2]*0.114; m += g[i]; }
    m /= w * h; let v = 0;
    for (let i = 0; i < g.length; i++) { g[i] -= m; v += g[i] * g[i]; }
    const s = Math.sqrt(v / g.length) || 1;
    for (let i = 0; i < g.length; i++) g[i] = g[i] / s * 40;
    return g;
  }

  function pairStats(si, sj, Ri, Rj, ty) {
    const txi = ty * si.gw / si.gh, txj = ty * sj.gw / sj.gh;
    const gwj = sj.gw, ghj = sj.gh, gj = sj.g, samp = si.samp;
    let n = 0, sd = 0, sd2 = 0;
    for (let k = 0; k < NX * NY; k++) {
      const cx = AX[k] * txi, cy = AY[k] * ty;
      const dx = Ri[0]*cx + Ri[1]*cy - Ri[2], dy = Ri[3]*cx + Ri[4]*cy - Ri[5], dz = Ri[6]*cx + Ri[7]*cy - Ri[8];
      const ez = Rj[2]*dx + Rj[5]*dy + Rj[8]*dz;
      if (ez > -1e-6) continue;
      const bx = (Rj[0]*dx + Rj[3]*dy + Rj[6]*dz) / -ez / txj, by = (Rj[1]*dx + Rj[4]*dy + Rj[7]*dz) / -ez / ty;
      if (bx < -0.95 || bx > 0.95 || by < -0.95 || by > 0.95) continue;
      const diff = samp[k] - bilinearGray(gj, gwj, ghj, (bx + 1) / 2 * (gwj - 1), (1 - by) / 2 * (ghj - 1));
      n++; sd += diff; sd2 += diff * diff;
    }
    return n < 15 ? null : { n, v: (sd2 - sd * sd / n) / n };
  }

  // shots: [{R:[9], g:Float32Array normalizado, gw, gh}], devuelve {vfov, Rs, cost0, cost1}
  async function alignShots(shots, vfov0, progress) {
    const n = shots.length, say = progress || (() => {});
    if (n < 2) return { vfov: vfov0, Rs: shots.map(s => s.R), cost0: 0, cost1: 0 };
    for (const s of shots) {
      s.samp = new Float32Array(NX * NY);
      for (let k = 0; k < NX * NY; k++) s.samp[k] = bilinearGray(s.g, s.gw, s.gh, (AX[k] + 1) / 2 * (s.gw - 1), (1 - AY[k]) / 2 * (s.gh - 1));
      s.d = [0, 0, 0]; s.Rc = s.R;
    }
    // vecinos: hasta 8 más cercanos a < 55°
    const fw = shots.map(s => forward(s.R)), nbr = shots.map(() => new Set());
    for (let i = 0; i < n; i++) {
      const l = [];
      for (let j = 0; j < n; j++) if (j !== i) { const a = angleBetween(fw[i], fw[j]); if (a < 55) l.push([a, j]); }
      l.sort((p, q) => p[0] - q[0]);
      for (const [, j] of l.slice(0, 8)) { nbr[i].add(j); nbr[j].add(i); }
    }
    const nb = nbr.map(s => [...s]);
    const n0 = new Map(); // solapamiento inicial por par
    const key = (i, j) => i * 10000 + j;
    const pc = (i, j, Ri, Rj, ty) => {
      const st = pairStats(shots[i], shots[j], Ri, Rj, ty);
      const b = n0.get(key(i, j));
      if (!st || !b) return b ? 300 : 0;
      return st.v + 300 * Math.max(0, 1 - st.n / (b * 0.8));
    };
    const total = ty => { let c = 0; for (let i = 0; i < n; i++) for (const j of nb[i]) if (j > i) c += pc(i, j, shots[i].Rc, shots[j].Rc, ty); return c; };
    const shotCost = (i, ty) => {
      let c = 0; const d = shots[i].d;
      for (const j of nb[i]) c += pc(i, j, shots[i].Rc, shots[j].Rc, ty);
      return c + 3 * ((d[0]/D2R)**2 + (d[1]/D2R)**2 + (d[2]/D2R)**2);
    };
    const ty0 = Math.tan(vfov0 * D2R / 2);
    for (let i = 0; i < n; i++) for (const j of nb[i]) { const st = pairStats(shots[i], shots[j], shots[i].R, shots[j].R, ty0); n0.set(key(i, j), st ? st.n : 0); }
    const cost0 = total(ty0);

    const scan = (lo, hi, step) => {
      let best = lo, bc = Infinity;
      for (let v = lo; v <= hi + 1e-9; v += step) { const c = total(Math.tan(v * D2R / 2)); if (c < bc) { bc = c; best = v; } }
      return best;
    };
    const optimize = async (ty, steps, rounds) => {
      for (let r = 0; r < rounds; r++) for (const step of steps) {
        for (let i = 0; i < n; i++) {
          const s = shots[i];
          for (let ax = 0; ax < 3; ax++) {
            let cur = shotCost(i, ty);
            for (const dir of [1, -1]) {
              const old = s.d[ax]; s.d[ax] = Math.max(-6 * D2R, Math.min(6 * D2R, old + dir * step * D2R));
              s.Rc = applyDelta(s.R, s.d);
              const c = shotCost(i, ty);
              if (c < cur - 1e-6) { cur = c; break; }
              s.d[ax] = old; s.Rc = applyDelta(s.R, s.d);
            }
          }
        }
        await tick();
      }
    };

    say('Calibrando cámara…', 0.1);
    let v = scan(Math.max(45, vfov0 - 14), Math.min(90, vfov0 + 16), 2);
    await tick();
    say('Alineando fotos…', 0.3);
    await optimize(Math.tan(v * D2R / 2), [2, 1, 0.5], 2);
    v = scan(Math.max(45, v - 4), Math.min(90, v + 4), 1);
    say('Afinando alineación…', 0.6);
    await optimize(Math.tan(v * D2R / 2), [1, 0.5, 0.25], 2);
    return { vfov: v, Rs: shots.map(s => s.Rc), cost0, cost1: total(Math.tan(v * D2R / 2)) };
  }

  // orden de pegado: cada foto nueva se solapa con las ya puestas (mejor para igualar exposición)
  function stitchOrder(Rs) {
    const fw = Rs.map(forward), n = fw.length, placed = [0], left = new Set(); for (let i = 1; i < n; i++) left.add(i);
    while (left.size) {
      let best = -1, bd = 1e9;
      for (const i of left) { let m = 1e9; for (const p of placed) m = Math.min(m, angleBetween(fw[i], fw[p])); if (m < bd) { bd = m; best = i; } }
      placed.push(best); left.delete(best);
    }
    return placed;
  }

  const Core = { D2R, tick, mul, Rx, Ry, Rz, orientationMatrix, applyDelta, forward, dot, angleBetween, toCam, buildTargets, PRESETS, Pano, makeGray, alignShots, stitchOrder };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core; else root.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
