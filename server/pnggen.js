// Генератор PNG без зависимостей (zlib + ручная сборка чанков).
// Используется для превью изображений и постеров видео в демо-данных.
import zlib from 'node:zlib';
import { crc32 } from './zipstore.js';

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * Рисует «постер»: градиент, крупные геометрические фигуры, опционально треугольник play.
 * opts: { width, height, color: [r,g,b] 0..1, play?: boolean, seed?: number }
 */
export function generatePng(opts = {}) {
  const W = opts.width || 1280;
  const H = opts.height || 720;
  const [cr, cg, cb] = opts.color || [0.36, 0.36, 0.84];
  let seed = opts.seed ?? 42;
  const rnd = () => { seed = (seed * 16807 + 12345) % 2147483647; return (seed & 0xffff) / 0xffff; };

  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const off = y * (1 + W * 3);
    raw[off] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const t = y / H;
      let r = Math.round((cr * 0.35 + 0.05 + t * 0.1) * 255);
      let g = Math.round((cg * 0.35 + 0.05 + t * 0.12) * 255);
      let b = Math.round((cb * 0.4 + 0.12 + t * 0.14) * 255);
      raw[off + 1 + x * 3] = clamp(r);
      raw[off + 2 + x * 3] = clamp(g);
      raw[off + 3 + x * 3] = clamp(b);
    }
  }

  const setPx = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const off = y * (1 + W * 3) + 1 + x * 3;
    raw[off] = clamp(r); raw[off + 1] = clamp(g); raw[off + 2] = clamp(b);
  };
  const fillCircle = (cx, cy, rad, r, g, b, alpha) => {
    for (let y = Math.max(0, Math.floor(cy - rad)); y <= Math.min(H - 1, Math.ceil(cy + rad)); y++) {
      for (let x = Math.max(0, Math.floor(cx - rad)); x <= Math.min(W - 1, Math.ceil(cx + rad)); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= rad) {
          const off = y * (1 + W * 3) + 1 + x * 3;
          raw[off] = clamp(raw[off] * (1 - alpha) + r * alpha);
          raw[off + 1] = clamp(raw[off + 1] * (1 - alpha) + g * alpha);
          raw[off + 2] = clamp(raw[off + 2] * (1 - alpha) + b * alpha);
        }
      }
    }
  };
  // декоративные круги
  for (let i = 0; i < 7; i++) {
    fillCircle(rnd() * W, rnd() * H, 40 + rnd() * 160,
      Math.round((cr + rnd() * 0.4) * 255), Math.round((cg + rnd() * 0.4) * 255), Math.round((cb + rnd() * 0.5) * 255), 0.12 + rnd() * 0.15);
  }
  if (opts.play) {
    // треугольник play по центру + круглая подложка
    fillCircle(W / 2, H / 2, Math.min(W, H) * 0.16, 255, 255, 255, 0.92);
    const s = Math.min(W, H) * 0.1;
    for (let y = 0; y < H; y++) {
      for (let x = Math.floor(W / 2 - s * 0.4); x <= Math.ceil(W / 2 + s); x++) {
        const t = (x - (W / 2 - s * 0.4)) / (s * 1.4);
        if (t < 0 || t > 1) continue;
        const half = s * (1 - t) * 0.9;
        if (Math.abs(y - H / 2) <= half) setPx(x, y, Math.round(cr * 255), Math.round(cg * 255), Math.round(cb * 255));
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }
