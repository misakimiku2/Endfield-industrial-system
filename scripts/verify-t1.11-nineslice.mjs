// T1.11 九宫格验证 — 切片拼装像素级还原 + 多尺寸结构 + 图集产物
// 用法: node scripts/verify-t1.11-nineslice.mjs   （需先 npm run pack-assets）
//
// 验证内容（S2 §8 验收的离线部分）:
//   A. 3×3 拼装 vs 3x3_unit.svg layer-base 逐像素对比（像素级还原，差异必须 = 0）
//   B. 6×3 / 6×6 / 2×2 拼装结构探针: 边框环完整、每条内部竖格线端部有柱、边框带无缝
//   C. devices 图集: nineslice/* 8 切片帧存在且 288²；图集 ≤ 4096
//
// 依据: doc/nine-slice-device-base.md（S2）、doc/asset-drawing-standard.md §9（S1 v1.1）

import sharp from 'sharp';
import * as fs from 'node:fs';

const SCALE = 8;
const CELL = 16.9333333;
const MARGIN = 1.0583333;
const WIN = 19.05;
let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
};

const nsSvg = fs.readFileSync('src/assets/svg/nineslice_unit.svg', 'utf8');
const nsHead = nsSvg.match(/<svg\b[^>]*>/)[0];
const SLICES = [['tl',0,0],['t',0,1],['tr',0,2],['l',1,0],['c',1,1],['r',1,2],['bl',2,0],['b',2,1],['br',2,2]];
const HOME = Object.fromEntries(SLICES.map(([n, r, c]) => [n, [r, c]]));

/** 渲染单个切片（窗口 = 切片自身所在格 ± 边距，CSS 隐藏其它 slice 组）。 */
async function renderSlice(name, dstR, dstC) {
  const [hr, hc] = HOME[name];
  const x0 = hc * CELL - MARGIN, y0 = hr * CELL - MARGIN;
  const winSvg = nsSvg
    .replace(nsHead, `${nsHead}\n<style>g[id^="slice-"] { display: none !important; } g#slice-${name} { display: inline !important; }</style>`)
    .replace(/viewBox="[^"]*"/, `viewBox="${x0} ${y0} ${WIN} ${WIN}"`)
    .replace(/width="192"/, `width="152"`).replace(/height="192"/, `height="152"`);
  const px = Math.round((WIN / 50.8) * 192 * SCALE);
  const png = await sharp(Buffer.from(winSvg)).resize(px, px, { fit: 'fill' }).png().toBuffer();
  return { input: png, left: (dstC * 64 - 4) * SCALE + 32, top: (dstR * 64 - 4) * SCALE + 32 };
}

function tileName(r, c, w, h) {
  const v = r === 0 ? 't' : r === h - 1 ? 'b' : 'm';
  const u = c === 0 ? 'l' : c === w - 1 ? 'r' : 'm';
  if (v === 'm' && u === 'm') return 'c';
  return v === 'm' ? u : u === 'm' ? v : v + u;
}

/** 拼装 w×h 设备底座（含 4px 边距画布，用于探针）。 */
async function assemble(w, h) {
  const ops = [];
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    ops.push(await renderSlice(tileName(r, c, w, h), r, c));
  }
  const PAD = 32;
  const W = w * 64 * SCALE + PAD * 2, H = h * 64 * SCALE + PAD * 2;
  const png = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(ops).png().toBuffer();
  return { png, W, H, PAD };
}

// ── A. 3×3 像素级还原 ──
console.log('\n[A] 3×3 拼装 vs 3x3_unit.svg layer-base 逐像素（像素级还原）');
{
  const { png } = await assemble(3, 3);
  const A = (await sharp(png).extract({ left: 32, top: 32, width: 192 * SCALE, height: 192 * SCALE }).raw().toBuffer({ resolveWithObject: true })).data;

  const origSvg = fs.readFileSync('src/assets/svg/3x3_unit.svg', 'utf8');
  const origHead = origSvg.match(/<svg\b[^>]*>/)[0];
  // ports_top 组无 layer- 前缀（3x3_unit 特有），base 提取时需一并隐藏
  const origLayer = origSvg.replace(origHead, `${origHead}\n<style>
  g[id^="layer-"] { display: none !important; }
  g#ports_top { display: none !important; }
  g#layer-base { display: inline !important; }
</style>`);
  const origPng = await sharp(Buffer.from(origLayer)).resize(192 * SCALE, 192 * SCALE, { fit: 'fill' }).png().toBuffer();
  const B = (await sharp(origPng).raw().toBuffer({ resolveWithObject: true })).data;

  let diff = 0;
  for (let i = 0; i < A.length; i += 4) {
    for (let ch = 0; ch < 4; ch++) {
      if (Math.abs(A[i + ch] - B[i + ch]) > 8) { diff++; break; }
    }
  }
  ok(diff === 0, `差异像素(>8) = ${diff} / ${(192 * SCALE) ** 2}（必须为 0）`);
}

// ── B. 多尺寸结构探针 ──
console.log('\n[B] 多尺寸结构（边框环 / 内部竖线柱 / 无缝）');
for (const [w, h] of [[4, 3], [6, 3], [6, 6], [2, 2], [5, 5]]) {
  const { png, PAD } = await assemble(w, h);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const px = (sx, sy) => {
    const i = ((sy * SCALE + PAD) | 0) * W + ((sx * SCALE + PAD) | 0);
    return [data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]];
  };
  const isDark = p => p[3] > 200 && p[0] < 70;
  const isGray = p => p[3] > 200 && p[0] > 100 && p[0] < 170;
  const wp = w * 64, hp = h * 64;
  const botY = (h - 1) * 64 + 29; // 底行柱带 y≈[155.3,170.4]px，取带内
  let fail = 0;
  for (let sx = 8; sx <= wp - 8; sx++) {
    if (!isDark(px(sx, 8)) || !isDark(px(sx, hp - 9))) { fail++; break; }
  }
  for (let sy = 8; sy <= hp - 8; sy++) {
    if (!isDark(px(6, sy)) || !isDark(px(wp - 7, sy))) { fail++; break; }
  }
  const missing = [];
  for (let i = 1; i < w; i++) {
    const L = i * 64;
    const g = (y) => [-3, -2, -1, 0, 1, 2, 3].some(dx => isGray(px(L + dx, y)));
    if (!g(26)) missing.push(`top@${L}`);
    if (!g(botY)) missing.push(`bot@${L}`);
  }
  ok(fail === 0 && missing.length === 0, `${w}×${h}: 边框环完整${missing.length ? '，柱缺失 ' + missing.join(',') : ''}，内部竖线 ${w - 1} 条全有柱`);
}

// ── C. 图集产物 ──
console.log('\n[C] devices 图集产物（需先 npm run pack-assets）');
{
  const sheet = JSON.parse(fs.readFileSync('public/spritesheets/devices.json', 'utf8'));
  const nsWin = (64 + 2 * 4) * 4;
  const names = ['tl', 't', 'tr', 'l', 'r', 'bl', 'b', 'br'];
  ok(names.every(n => {
    const f = sheet.frames[`nineslice/${n}.png`];
    return f && f.frame.w === nsWin && f.frame.h === nsWin;
  }), `nineslice/* 8 切片帧存在且 = ${nsWin}²（c 空心不打包）`);
  ok(!sheet.frames['nineslice/c.png'], 'nineslice/c 空心切片未打包');
  ok(sheet.meta.size.w <= 4096 && sheet.meta.size.h <= 4096, `图集回落 4096²（实际 ${sheet.meta.size.w}×${sheet.meta.size.h}）`);
  // 层帧白名单: 不应再有 base/ports/arrows/indicators/equipment 整层帧
  const banned = Object.keys(sheet.frames).filter(k =>
    /\/(base|ports|arrows|indicators|equipment)\.png$/.test(k));
  ok(banned.length === 0, `无人消费的整层帧已砍（残留 ${banned.length ? banned.join(',') : 0}）`);
  // trim 帧: 端口帧应被 trim（768² → 内容大小）
  const p = sheet.frames['refining_unit/port-in-0.png'];
  ok(p && p.trimmed && p.frame.w < 768 && p.frame.h < 768, `逐端口帧已 trim（${p ? p.frame.w + '×' + p.frame.h : '缺失'}）`);
  const m = sheet.frames['refining_unit_arrow_mask.png'];
  ok(m && !m.trimmed, 'arrow_mask 帧**未** trim（PreviewTintFilter UV 映射契约）');
}

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
if (failed > 0) process.exit(1);
