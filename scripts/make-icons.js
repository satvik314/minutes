// Generates the wax-seal extension icons (no design tools required):
//   node scripts/make-icons.js
// Draws a softly-lit red wax seal with a gently scalloped edge at 4x and
// downsamples for anti-aliasing.

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling factor

function drawSeal(size) {
  const S = size * SS;
  const png = new PNG({ width: S, height: S });
  const cx = S / 2;
  const cy = S / 2;
  const baseR = S * 0.46;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      const theta = Math.atan2(dy, dx);
      // Scalloped wax edge
      const r = baseR * (1 + 0.035 * Math.sin(theta * 9 + 0.7) + 0.02 * Math.sin(theta * 17));
      const idx = (S * y + x) << 2;
      if (dist > r) {
        png.data[idx + 3] = 0;
        continue;
      }

      // Base wax color with a highlight toward the upper left
      const lx = (dx / r + 0.35) * 0.9;
      const ly = (dy / r + 0.4) * 0.9;
      const light = Math.max(0, 1 - Math.hypot(lx, ly)); // 0..1
      let R = 124 + light * 105; // 7c → soft cd
      let G = 29 + light * 52;
      let B = 21 + light * 43;

      // Darkened rim
      const edge = dist / r;
      if (edge > 0.86) {
        const k = (edge - 0.86) / 0.14;
        R *= 1 - 0.35 * k;
        G *= 1 - 0.35 * k;
        B *= 1 - 0.35 * k;
      }
      // Embossed inner ring
      const ring = Math.abs(edge - 0.62);
      if (ring < 0.05) {
        const k = 1 - ring / 0.05;
        const lit = dy < dx * 0.3 ? 1 : -1; // lit on top, shadow below
        R += lit * 22 * k;
        G += lit * 14 * k;
        B += lit * 12 * k;
      }
      // Central stamped dot
      if (edge < 0.16) {
        R *= 0.82;
        G *= 0.82;
        B *= 0.82;
      }

      png.data[idx] = Math.max(0, Math.min(255, R));
      png.data[idx + 1] = Math.max(0, Math.min(255, G));
      png.data[idx + 2] = Math.max(0, Math.min(255, B));
      png.data[idx + 3] = 255;
    }
  }
  return png;
}

function downsample(src, size) {
  const out = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = (src.width * (y * SS + sy) + (x * SS + sx)) << 2;
          const alpha = src.data[i + 3] / 255;
          r += src.data[i] * alpha;
          g += src.data[i + 1] * alpha;
          b += src.data[i + 2] * alpha;
          a += alpha;
        }
      }
      const n = SS * SS;
      const o = (size * y + x) << 2;
      out.data[o + 3] = Math.round((a / n) * 255);
      out.data[o] = a ? Math.round(r / a) : 0;
      out.data[o + 1] = a ? Math.round(g / a) : 0;
      out.data[o + 2] = a ? Math.round(b / a) : 0;
    }
  }
  return out;
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const size of SIZES) {
  const png = downsample(drawSeal(size), size);
  fs.writeFileSync(path.join(dir, `icon${size}.png`), PNG.sync.write(png));
  console.log(`icons/icon${size}.png`);
}
