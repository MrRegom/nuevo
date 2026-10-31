'use strict';
// Scan360 core: matemáticas, panorama con mezcla, alineación. Sin DOM (se prueba en node).
(function (root) {
  const D2R = Math.PI / 180;
  const WS = 16384; // escala de pesos (Uint16)
  const GX = 9, GY = 12, SMW = 128, PHALF = 6, SRCH = 8; // malla de deformación local
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

  // La lente se desplaza del eje de giro del cuerpo: offset horizontal (m) hacia donde mira.
  const lensOffset = (R, arm) => {
    const f = forward(R); if (!arm || Math.abs(f[1]) > 0.9) return [0, 0, 0];
    const h = Math.hypot(f[0], f[2]) || 1; return [f[0] / h * arm, 0, f[2] / h * arm];
  };
  // rayo desde el punto c con dirección unitaria d -> dirección (desde el centro) del punto a distancia rho
  const rayToSphere = (c, d, rho) => {
    const b = c[0]*d[0] + c[1]*d[1] + c[2]*d[2], cc = c[0]*c[0] + c[1]*c[1] + c[2]*c[2];
    const t = -b + Math.sqrt(Math.max(0, b*b - (cc - rho*rho)));
    return [c[0] + t*d[0], c[1] + t*d[1], c[2] + t*d[2]];
  };

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

  // Busca el desplazamiento (ox,oy) de un parche de ref (rg) dentro de new (ng) por correlación normalizada.
  function searchPatch(rg, ng, valid, w, h, cu, cv, half, ox0, oy0, R) {
    const PWD = 2 * half + 1, pu = [], pv = [], pa = [];
    let sa = 0, saa = 0;
    for (let dv = -half; dv <= half; dv++) for (let du = -half; du <= half; du++) {
      const u = cu + du, v = cv + dv; if (u < 0 || v < 0 || u >= w || v >= h) continue;
      const k = v * w + u; if (!valid[k]) continue;
      pu.push(u); pv.push(v); pa.push(rg[k]); sa += rg[k]; saa += rg[k] * rg[k];
    }
    const n = pu.length; if (n < 0.6 * PWD * PWD) return null;
    if (saa - sa * sa / n < 20 * n) return null; // sin textura
    const S2 = 2 * R + 1, grid = new Float32Array(S2 * S2).fill(-2);
    let best = -2, bx = 0, by = 0;
    for (let oy = oy0 - R; oy <= oy0 + R; oy++) for (let ox = ox0 - R; ox <= ox0 + R; ox++) {
      let m = 0, sb = 0, sbb = 0, sab = 0, a0 = 0, aa = 0;
      for (let q = 0; q < n; q++) {
        const u = pu[q] + ox, v = pv[q] + oy; if (u < 0 || v < 0 || u >= w || v >= h) continue;
        const b = ng[v * w + u], a = pa[q]; m++; a0 += a; aa += a * a; sb += b; sbb += b * b; sab += a * b;
      }
      if (m < 0.75 * n) continue;
      const va = aa - a0 * a0 / m, vb = sbb - sb * sb / m; if (va < 1 || vb < 1) continue;
      const ncc = (sab - a0 * sb / m) / Math.sqrt(va * vb);
      grid[(oy - oy0 + R) * S2 + ox - ox0 + R] = ncc;
      if (ncc > best) { best = ncc; bx = ox; by = oy; }
    }
    if (best < -1) return null;
    let fx = bx, fy = by;
    if (Math.abs(bx - ox0) < R && Math.abs(by - oy0) < R) {
      const g = (x, y) => grid[(y - oy0 + R) * S2 + x - ox0 + R];
      const l = g(bx - 1, by), r = g(bx + 1, by), u2 = g(bx, by - 1), d2 = g(bx, by + 1);
      if (l > -2 && r > -2) { const den = l - 2 * best + r; if (den < -1e-6) fx += Math.max(-.5, Math.min(.5, .5 * (l - r) / den)); }
      if (u2 > -2 && d2 > -2) { const den = u2 - 2 * best + d2; if (den < -1e-6) fy += Math.max(-.5, Math.min(.5, .5 * (u2 - d2) / den)); }
    }
    return { ncc: best, fx, fy };
  }

  // ---------- panorama equirectangular con mezcla ponderada ----------
  class Pano {
    constructor(W, H) {
      this.W = W; this.H = H;
      this.data = new Uint8ClampedArray(W * H * 4);
      for (let i = 3; i < this.data.length; i += 4) this.data[i] = 255;
      this.weight = new Uint16Array(W * H); // peso acumulado * WS
      this.par = null; this.useFlow = false; this.localGain = false; this.pw = 6;
      this.sinLon = new Float32Array(W); this.cosLon = new Float32Array(W);
      for (let i = 0; i < W; i++) { const lo = ((i + .5) / W) * 2 * Math.PI - Math.PI; this.sinLon[i] = Math.sin(lo); this.cosLon[i] = Math.cos(lo); }
      this.sinLat = new Float32Array(H); this.cosLat = new Float32Array(H);
      for (let j = 0; j < H; j++) { const la = Math.PI / 2 - ((j + .5) / H) * Math.PI; this.sinLat[j] = Math.sin(la); this.cosLat[j] = Math.cos(la); }
    }
    // recorre los píxeles del panorama que cubre una foto; fn(idx, sx, sy, w)
    _scan(R, sw, sh, vfov, fn) {
      const { W, H, sinLon, cosLon, sinLat, cosLat } = this;
      const ty = Math.tan(vfov * D2R / 2), tx = ty * sw / sh;
      const r = Math.atan(Math.hypot(tx, ty)) + (this.par && this.par.arm ? 0.12 : 0);
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
      const par = this.par, lo = par ? lensOffset(R, par.arm) : [0, 0, 0], rho = par ? par.rho : 0;
      for (let j = j0; j <= j1; j++) {
        const cl = cosLat[j], sl = sinLat[j];
        for (let k = i0; k <= i1; k++) {
          const i = ((k % W) + W) % W;
          const dx = cl * sinLon[i] * (par ? rho : 1) - lo[0], dy = sl * (par ? rho : 1) - lo[1], dz = -cl * cosLon[i] * (par ? rho : 1) - lo[2];
          const cz = R2*dx + R5*dy + R8*dz;
          if (cz > -1e-6) continue;
          const ax = ((R0*dx + R3*dy + R6*dz) / -cz) / tx;
          const ay = ((R1*dx + R4*dy + R7*dz) / -cz) / ty;
          if (ax < -1 || ax > 1 || ay < -1 || ay > 1) continue;
          fn(j * W + i, (ax + 1) / 2 * (sw - 1), (1 - ay) / 2 * (sh - 1), 1.0001 - Math.max(Math.abs(ax), Math.abs(ay)));
        }
      }
    }

    // Compara la foto con lo ya armado: ganancia de color local y desplazamiento local (corrige paralaje).
    _prepare(R, sd, sw, sh, vfov) {
      const { W, H, data, weight } = this;
      const smw = SMW, smh = Math.max(32, Math.round(SMW * sh / sw)), N = smw * smh;
      const ty = Math.tan(vfov * D2R / 2), tx = ty * sw / sh;
      const ref = [new Float32Array(N), new Float32Array(N), new Float32Array(N)], nw = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
      const rg = new Float32Array(N), ng = new Float32Array(N), valid = new Uint8Array(N);
      const R0=R[0],R1=R[1],R2=R[2],R3=R[3],R4=R[4],R5=R[5],R6=R[6],R7=R[7],R8=R[8];
      const par = this.par, lo = par ? lensOffset(R, par.arm) : [0, 0, 0];
      const thr = 0.01 * WS; let nValid = 0;
      for (let v = 0; v < smh; v++) for (let u = 0; u < smw; u++) {
        const k = v * smw + u; let cnt = 0, a = 0, b = 0, c2 = 0;
        for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
          const ax = ((u + (sx + .5) / 3) / smw) * 2 - 1, ay = 1 - ((v + (sy + .5) / 3) / smh) * 2;
          const cx = ax * tx, cy = ay * ty;
          let dx = R0*cx + R1*cy - R2, dy = R3*cx + R4*cy - R5, dz = R6*cx + R7*cy - R8;
          let n = Math.sqrt(dx*dx + dy*dy + dz*dz);
          if (par && par.arm) { const P = rayToSphere(lo, [dx / n, dy / n, dz / n], par.rho); dx = P[0]; dy = P[1]; dz = P[2]; n = Math.sqrt(dx*dx + dy*dy + dz*dz); }
          const lon = Math.atan2(dx, -dz), lat = Math.asin(dy / n);
          let i = Math.floor((lon / (2 * Math.PI) + .5) * W); if (i >= W) i = W - 1; if (i < 0) i = 0;
          let j = Math.floor((.5 - lat / Math.PI) * H); if (j >= H) j = H - 1; if (j < 0) j = 0;
          const idx = j * W + i;
          if (weight[idx] >= thr) { const o = idx * 4; a += data[o]; b += data[o+1]; c2 += data[o+2]; cnt++; }
        }
        if (cnt >= 5) { valid[k] = 1; ref[0][k] = a / cnt; ref[1][k] = b / cnt; ref[2][k] = c2 / cnt; nValid++; }
        // foto reducida por promedio de bloque
        const x0 = Math.floor(u * sw / smw), x1 = Math.max(x0 + 1, Math.floor((u + 1) * sw / smw));
        const y0 = Math.floor(v * sh / smh), y1 = Math.max(y0 + 1, Math.floor((v + 1) * sh / smh));
        let n2 = 0; a = b = c2 = 0;
        for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const o = (y * sw + x) * 4; a += sd[o]; b += sd[o+1]; c2 += sd[o+2]; n2++; }
        nw[0][k] = a / n2; nw[1][k] = b / n2; nw[2][k] = c2 / n2;
        rg[k] = ref[0][k] * 0.299 + ref[1][k] * 0.587 + ref[2][k] * 0.114;
        ng[k] = nw[0][k] * 0.299 + nw[1][k] * 0.587 + nw[2][k] * 0.114;
      }
      if (nValid < 0.04 * N) return null;
      // ganancia global
      const gl = [1, 1, 1];
      for (let c3 = 0; c3 < 3; c3++) { let s1 = 0, s2 = 0; for (let k = 0; k < N; k++) if (valid[k]) { s1 += ref[c3][k]; s2 += nw[c3][k]; } gl[c3] = Math.max(0.6, Math.min(1.6, (s1 + 1) / (s2 + 1))); if (Math.abs(gl[c3] - 1) < 0.04) gl[c3] = 1; }
      const NN = GX * GY, dxN = new Float32Array(NN), dyN = new Float32Array(NN), okF = new Uint8Array(NN);
      const gN = [new Float32Array(NN).fill(gl[0]), new Float32Array(NN).fill(gl[1]), new Float32Array(NN).fill(gl[2])], okG = new Uint8Array(NN);
      const PW = 2 * PHALF + 1, pu = new Int32Array(PW * PW), pv = new Int32Array(PW * PW), pa = new Float32Array(PW * PW);
      const sc = sw / smw, hw = smw >> 1, hh = smh >> 1;
      const rg2 = new Float32Array(hw * hh), ng2 = new Float32Array(hw * hh), valid2 = new Uint8Array(hw * hh);
      for (let v = 0; v < hh; v++) for (let u = 0; u < hw; u++) {
        const ks = [(2*v)*smw + 2*u, (2*v)*smw + 2*u + 1, (2*v+1)*smw + 2*u, (2*v+1)*smw + 2*u + 1]; let cv2 = 0, sr = 0, sn = 0;
        for (const k of ks) { sn += ng[k]; if (valid[k]) { cv2++; sr += rg[k]; } }
        const k2 = v * hw + u; ng2[k2] = sn / 4; if (cv2 >= 3) { valid2[k2] = 1; rg2[k2] = sr / cv2; }
      }
      for (let jn = 0; jn < GY; jn++) for (let inn = 0; inn < GX; inn++) {
        const node = jn * GX + inn;
        const cu = Math.round(inn / (GX - 1) * (smw - 1)), cv = Math.round(jn / (GY - 1) * (smh - 1));
        let n = 0, sa = 0, saa = 0, gr = [0, 0, 0], gn = [0, 0, 0];
        for (let dv = -PHALF; dv <= PHALF; dv++) for (let du = -PHALF; du <= PHALF; du++) {
          const u = cu + du, v = cv + dv; if (u < 0 || v < 0 || u >= smw || v >= smh) continue;
          const k = v * smw + u; if (!valid[k]) continue;
          pu[n] = u; pv[n] = v; pa[n] = rg[k]; sa += rg[k]; saa += rg[k] * rg[k]; n++;
          for (let c3 = 0; c3 < 3; c3++) { gr[c3] += ref[c3][k]; gn[c3] += nw[c3][k]; }
        }
        if (n < 0.6 * PW * PW) continue;
        { // ganancia local con ventana grande (estable) y limitada alrededor de la global
          const GH = 24; let m = 0; const r3 = [0, 0, 0], n3 = [0, 0, 0];
          for (let dv = -GH; dv <= GH; dv += 3) for (let du = -GH; du <= GH; du += 3) {
            const u = cu + du, v = cv + dv; if (u < 0 || v < 0 || u >= smw || v >= smh) continue;
            const k = v * smw + u; if (!valid[k]) continue;
            m++; for (let c3 = 0; c3 < 3; c3++) { r3[c3] += ref[c3][k]; n3[c3] += nw[c3][k]; }
          }
          if (m >= 60) { for (let c3 = 0; c3 < 3; c3++) gN[c3][node] = Math.max(gl[c3] * 0.9, Math.min(gl[c3] * 1.1, (r3[c3] + 1) / (n3[c3] + 1))); okG[node] = 1; }
        }
        if (!this.useFlow) continue;
        const c1 = searchPatch(rg2, ng2, valid2, hw, hh, cu >> 1, cv >> 1, 4, 0, 0, 8); // grueso (+-6 grados)
        if (!c1 || c1.ncc < 0.45) continue;
        const c2 = searchPatch(rg, ng, valid, smw, smh, cu, cv, PHALF, Math.round(c1.fx * 2), Math.round(c1.fy * 2), 2); // fino
        if (!c2 || c2.ncc < 0.6) continue;
        dxN[node] = c2.fx * sc; dyN[node] = c2.fy * sc; okF[node] = 1;
      }
      // rechaza valores atípicos respecto a la mediana de sus vecinos
      const nbrs = node => { const x = node % GX, y = (node / GX) | 0, l = []; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < GX && Y < GY) l.push(Y * GX + X); } return l; };
      const med = a => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
      const keep = okF.slice();
      for (let k = 0; k < NN; k++) if (okF[k]) {
        const nb = nbrs(k).filter(q => okF[q]);
        if (nb.length >= 3) { const mx = med(nb.map(q => dxN[q])), my = med(nb.map(q => dyN[q])); if (Math.abs(dxN[k] - mx) > 4 * sc || Math.abs(dyN[k] - my) > 4 * sc) keep[k] = 0; }
      }
      okF.set(keep);
      const relax = (arrs, ok, init) => {
        const has = ok.slice(); let any = has.some(x => x);
        if (!any) { arrs.forEach((a, i) => a.fill(init[i])); return; }
        for (let it = 0; it < 80; it++) {
          const add = [];
          for (let k = 0; k < NN; k++) if (!has[k]) { const nb = nbrs(k).filter(q => has[q]); if (nb.length) add.push([k, arrs.map(a => nb.reduce((s, q) => s + a[q], 0) / nb.length)]); }
          if (!add.length) break;
          for (const [k, vals] of add) { has[k] = 1; arrs.forEach((a, i) => a[k] = vals[i]); }
        }
        // suavizado ligero
        for (let p = 0; p < 2; p++) arrs.forEach(a => { const c0 = a.slice(); for (let k = 0; k < NN; k++) { const nb = nbrs(k); a[k] = 0.5 * c0[k] + 0.5 * nb.reduce((s, q) => s + c0[q], 0) / nb.length; } });
      };
      relax([dxN, dyN], okF, [0, 0]);
      relax(gN, okG, gl);
      return { dxN, dyN, gN, gl };
    }

    // sd: RGBA de la foto (sw x sh). mode=true: alinea localmente y compensa color; false: pegado directo (vista previa)
    add(R, sd, sw, sh, vfov, mode) {
      const { data, weight } = this;
      const prep = mode ? this._prepare(R, sd, sw, sh, vfov) : null;
      if (prep && !this.useFlow) { prep.dxN.fill(0); prep.dyN.fill(0); }
      if (prep && !this.localGain) prep.gN.forEach((a, i) => a.fill(prep.gl[i]));
      if (prep && this.noGain) prep.gN.forEach(a => a.fill(1));
      const P = this.pw || 6;
      this._scan(R, sw, sh, vfov, (idx, sx, sy, w) => {
        let g0 = 1, g1 = 1, g2 = 1;
        if (prep) {
          const gxf = sx / (sw - 1) * (GX - 1), gyf = sy / (sh - 1) * (GY - 1);
          const i0 = Math.min(GX - 2, gxf | 0), j0 = Math.min(GY - 2, gyf | 0), fx = gxf - i0, fy = gyf - j0;
          const n00 = j0 * GX + i0, n10 = n00 + 1, n01 = n00 + GX, n11 = n01 + 1;
          const a = (1-fx)*(1-fy), b = fx*(1-fy), c = (1-fx)*fy, d = fx*fy;
          sx += prep.dxN[n00]*a + prep.dxN[n10]*b + prep.dxN[n01]*c + prep.dxN[n11]*d;
          sy += prep.dyN[n00]*a + prep.dyN[n10]*b + prep.dyN[n01]*c + prep.dyN[n11]*d;
          g0 = prep.gN[0][n00]*a + prep.gN[0][n10]*b + prep.gN[0][n01]*c + prep.gN[0][n11]*d;
          g1 = prep.gN[1][n00]*a + prep.gN[1][n10]*b + prep.gN[1][n01]*c + prep.gN[1][n11]*d;
          g2 = prep.gN[2][n00]*a + prep.gN[2][n10]*b + prep.gN[2][n01]*c + prep.gN[2][n11]*d;
          if (sx < 0) sx = 0; else if (sx > sw - 1) sx = sw - 1;
          if (sy < 0) sy = 0; else if (sy > sh - 1) sy = sh - 1;
        }
        const x0 = sx | 0, y0 = sy | 0, x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
        const fx = sx - x0, fy = sy - y0;
        const a = ((1-fx)*(1-fy)), b = fx*(1-fy), c = (1-fx)*fy, d = fx*fy;
        const p00 = (y0*sw + x0)*4, p10 = (y0*sw + x1)*4, p01 = (y1*sw + x0)*4, p11 = (y1*sw + x1)*4;
        const r = (sd[p00]*a + sd[p10]*b + sd[p01]*c + sd[p11]*d) * g0;
        const g = (sd[p00+1]*a + sd[p10+1]*b + sd[p01+1]*c + sd[p11+1]*d) * g1;
        const bl = (sd[p00+2]*a + sd[p10+2]*b + sd[p01+2]*c + sd[p11+2]*d) * g2;
        const wp = Math.pow(w, P);
        const wn = (wp > 1e-3 ? wp : 1e-3), wo = weight[idx] / WS, wt = wo + wn, k = wn / wt, o = idx * 4;
        if (this.stats && wo > 0) { const q = k * (1 - k); this.stats.dis += q * Math.abs((r + g + bl) / 3 - (data[o] + data[o+1] + data[o+2]) / 3); this.stats.w += q; }
        data[o] = data[o] * (1 - k) + r * k;
        data[o+1] = data[o+1] * (1 - k) + g * k;
        data[o+2] = data[o+2] * (1 - k) + bl * k;
        weight[idx] = Math.min(65535, wt * WS);
      });
    }

    // afinado suave (unsharp 3x3) al final
    sharpen(amount) {
      const { W, H, data } = this, rb = W * 4;
      let prev = data.slice(0, rb), cur = data.slice(0, rb);
      for (let j = 0; j < H; j++) {
        const next = j + 1 < H ? data.slice((j + 1) * rb, (j + 2) * rb) : cur;
        for (let i = 0; i < W; i++) {
          const l = ((i + W - 1) % W) * 4, r = ((i + 1) % W) * 4, m = i * 4;
          for (let c = 0; c < 3; c++) {
            const bl = (prev[l+c] + 2*prev[m+c] + prev[r+c] + 2*(cur[l+c] + 2*cur[m+c] + cur[r+c]) + next[l+c] + 2*next[m+c] + next[r+c]) / 16;
            data[j * rb + m + c] = cur[m+c] + amount * (cur[m+c] - bl);
          }
        }
        prev = cur; // fila original j
        // cur pasa a ser la fila original j+1 (next)
        cur = next;
      }
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

  function pairStats(si, sj, Ri, Rj, ty, par) {
    const ci = par ? lensOffset(Ri, par.arm) : null, cj = par ? lensOffset(Rj, par.arm) : null;
    const txi = ty * si.gw / si.gh, txj = ty * sj.gw / sj.gh;
    const gwj = sj.gw, ghj = sj.gh, gj = sj.g, samp = si.samp;
    let n = 0, sd = 0, sd2 = 0;
    for (let k = 0; k < NX * NY; k++) {
      const cx = AX[k] * txi, cy = AY[k] * ty;
      let dx = Ri[0]*cx + Ri[1]*cy - Ri[2], dy = Ri[3]*cx + Ri[4]*cy - Ri[5], dz = Ri[6]*cx + Ri[7]*cy - Ri[8];
      if (par && par.arm) {
        const nn = Math.sqrt(dx*dx + dy*dy + dz*dz), P = rayToSphere(ci, [dx / nn, dy / nn, dz / nn], par.rho);
        dx = P[0] - cj[0]; dy = P[1] - cj[1]; dz = P[2] - cj[2];
      }
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
    let par = null;
    const pc = (i, j, Ri, Rj, ty) => {
      const st = pairStats(shots[i], shots[j], Ri, Rj, ty, par);
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
    // paralaje (largo del brazo y profundidad del recinto) ANTES de refinar rotaciones, que si no lo absorben
    say('Corrigiendo paralaje…', 0.3);
    let ty1 = Math.tan(v * D2R / 2), bestC = total(ty1), bestPar = null;
    for (const arm of [0.12, 0.25, 0.4]) for (const rho of [1.5, 2.5, 4, 8]) {
      par = { arm, rho }; const cst = total(ty1); if (cst < bestC * 0.985) { bestC = cst; bestPar = par; }
    }
    par = bestPar; await tick();
    say('Alineando fotos…', 0.4);
    await optimize(ty1, [2, 1, 0.5], 2);
    v = scan(Math.max(45, v - 4), Math.min(90, v + 4), 1);
    say('Afinando alineación…', 0.6);
    const tyv = Math.tan(v * D2R / 2);
    await optimize(tyv, [1, 0.5, 0.25], 2);
    return { vfov: v, Rs: shots.map(s => s.Rc), par, cost0, cost1: total(tyv) };
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

  const Core = { lensOffset, D2R, tick, mul, Rx, Ry, Rz, orientationMatrix, applyDelta, forward, dot, angleBetween, toCam, buildTargets, PRESETS, Pano, makeGray, alignShots, stitchOrder };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core; else root.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
