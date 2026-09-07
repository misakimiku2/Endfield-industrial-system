// 裁剪放大传送带区域供读图核验 — node scripts/_t29c-crop.mjs
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

mkdirSync('log/crops', { recursive: true });
const Z = 4; // 放大倍数

async function crop(src, out, left, top, width, height, scale = Z) {
  await sharp(src).extract({ left, top, width, height })
    .resize({ width: width * scale, kernel: 'nearest' })
    .toFile(out);
  console.log(`  ${out}  ← ${src} [${left},${top} ${width}×${height}] ×${scale}`);
}

// ── S1: 三条空带整体区域（cam(8,7) zoom0.6 → 带1 x505..545, 带2 620..660, 带3 736..776; y 300..500）
for (const s of [1, 2, 3]) {
  await crop(`log/t29c-s1-${s}.png`, `log/crops/s1-${s}-belts.png`, 495, 295, 295, 210, 4);
}
// ── S2: 取货口带（cam(5,6) → 带 x620..665, y 220..545），填充期 + 堵塞期各取数张
for (const s of ['01', '02', '03', '04', '05', '06', '07', '10', '15']) {
  await crop(`log/t29c-s2-${s}.png`, `log/crops/s2-${s}-belt.png`, 610, 215, 70, 340, 3);
}
// ── S3: 满载带（cam(5,8) → 带 x620..665, y 295..545）
for (const s of [1, 2, 3]) {
  await crop(`log/t29c-s3-${s}.png`, `log/crops/s3-${s}-belt.png`, 610, 290, 70, 260, 3);
}
console.log('完成。');
