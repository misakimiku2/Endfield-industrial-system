// T1.11 九宫格验证 — 切片拼装像素级还原 + 多尺寸结构 + 图集产物
// 用法: node scripts/verify-t1.11-nineslice.mjs   （需先 npm run pack-assets）
//
// 验证内容（S2 §8 验收的离线部分; T1.12 后端口拆层，对比基准 =
// slice-*+port-* 全叠加 vs 原四组素材，S3 §6-6）:
//   A. 3×3 拼装 vs 3x3_unit.svg base+ports+ports_top+arrows 逐像素对比（差异必须 = 0）
//   B. 6×3 / 6×6 / 2×2 拼装结构探针: 边框环完整、每条内部竖格线端部有柱、边框带无缝
//   C. devices 图集: nineslice/* 8 切片帧存在且 288²；图集 ≤ 4096
//
// 依据: doc/nine-slice-device-base.md（S2）、doc/asset-drawing-standard.md §9（S1 v1.1）、
//       doc/nineslice-port-variant.md（S3，T1.12 端口拆层）

import sharp from 'sharp';
import * as fs from 'node:fs';

const SCALE = 8;
const CELL = 16.9333333;
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

/** 渲染单个组（窗口 = 组所在格 ± 边距，CSS 隐藏 #nineslice 下其余兄弟组）。 */
async function renderGroup(name, dstR, dstC) {
  const home = GROUP_HOME[name];
  if (!home) throw new Error(`未知组: ${name}`);
  const [hr, hc, margin] = home;
  const mUnit = margin / 3.7795275;
  const x0 = hc * CELL - mUnit, y0 = hr * CELL - mUnit;
  const winUnit = CELL + mUnit * 2;
  const winPxSrc = 64 + margin * 2;
  const winSvg = nsSvg
    .replace(nsHead, `${nsHead}\n<style>#nineslice > g { display: none !important; } #nineslice > g#${name} { display: inline !important; }</style>`)
    .replace(/viewBox="[^"]*"/, `viewBox="${x0} ${y0} ${winUnit} ${winUnit}"`)
    .replace(/width="192"/, `width="${winPxSrc}"`).replace(/height="192"/, `height="${winPxSrc}"`);
  const px = Math.round((winUnit / 50.8) * 192 * SCALE);
  const png = await sharp(Buffer.from(winSvg)).resize(px, px, { fit: 'fill' }).png().toBuffer();
  return { input: png, left: (dstC * 64 - margin) * SCALE + 32, top: (dstR * 64 - margin) * SCALE + 32 };
}

/** 组 id → [所在行, 所在列, 窗口边距 src px]（与 pack-assets NINESLICE_GROUPS 一致）。 */
const GROUP_HOME = {
  'slice-tl': [0, 0, 4], 'slice-t': [0, 1, 4], 'slice-tr': [0, 2, 4],
  'slice-l': [1, 0, 4], 'slice-c': [1, 1, 4], 'slice-r': [1, 2, 4],
  'slice-bl': [2, 0, 4], 'slice-b': [2, 1, 4], 'slice-br': [2, 2, 4],
  'port-tl': [0, 0, 4], 'port-t': [0, 1, 4], 'port-tr': [0, 2, 4],
  'port-bl': [2, 0, 4], 'port-b': [2, 1, 4], 'port-br': [2, 2, 4],
  'emblazon-ta': [0, 1, 4], 'emblazon-tb': [0, 2, 4],
  'emblazon-ba': [2, 1, 4], 'emblazon-bb': [2, 2, 4],
  'lport-tl': [0, 0, 4], 'lport-t': [0, 1, 4], 'lport-tr': [0, 2, 4],
  'lport-bl': [2, 0, 4], 'lport-b': [2, 1, 4], 'lport-br': [2, 2, 4],
  'lport-l': [1, 0, 4], 'lport-r': [1, 2, 4],
  'deco-l': [1, 0, 8], 'deco-r': [1, 2, 8],
};

/**
 * 全固体口掩码的叠加组清单（顶/底行每列一口 + 相邻口边界 emblazon A/B 交替，
 * 与 buildNineSlicePorts 对全 1 位图的行为一致）。
 */
function fullSolidExtras(w, h) {
  const colName = (c, top) => (c === 0 ? (top ? 'tl' : 'bl') : c === w - 1 ? (top ? 'tr' : 'br') : top ? 't' : 'b');
  const ex = [];
  for (let c = 0; c < w; c++) {
    ex.push({ group: `port-${colName(c, true)}`, r: 0, c });
    ex.push({ group: `port-${colName(c, false)}`, r: h - 1, c });
  }
  for (let g = 0; g < w - 1; g++) {
    ex.push({ group: `emblazon-t${g % 2 ? 'b' : 'a'}`, r: 0, c: g + 1 });
    ex.push({ group: `emblazon-b${g % 2 ? 'b' : 'a'}`, r: h - 1, c: g + 1 });
  }
  return ex;
}

function tileName(r, c, w, h) {
  const v = r === 0 ? 't' : r === h - 1 ? 'b' : 'm';
  const u = c === 0 ? 'l' : c === w - 1 ? 'r' : 'm';
  if (v === 'm' && u === 'm') return 'c';
  return v === 'm' ? u : u === 'm' ? v : v + u;
}

/**
 * 拼装 w×h 设备底座（含 4px 边距画布，用于探针）。
 * @param extra 追加叠加的组（T1.12 端口拆层后 A 测试用：[{group, r, c}]，按序叠在底座之上）
 */
async function assemble(w, h, extra = []) {
  const ops = [];
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    ops.push(await renderGroup(`slice-${tileName(r, c, w, h)}`, r, c));
  }
  for (const e of extra) ops.push(await renderGroup(e.group, e.r, e.c));
  const PAD = 32;
  const W = w * 64 * SCALE + PAD * 2, H = h * 64 * SCALE + PAD * 2;
  const png = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(ops).png().toBuffer();
  return { png, W, H, PAD };
}

// ── A. 3×3 像素级还原（slice 全拼 + port/emblazon 全叠加 vs 原素材） ──
console.log('\n[A] 3×3 拼装（slice+port+emblazon 全叠加） vs 3x3_unit.svg 素材 逐像素（像素级还原）');
{
  const ports = [
    { group: 'port-tl', r: 0, c: 0 }, { group: 'port-t', r: 0, c: 1 }, { group: 'port-tr', r: 0, c: 2 },
    { group: 'port-bl', r: 2, c: 0 }, { group: 'port-b', r: 2, c: 1 }, { group: 'port-br', r: 2, c: 2 },
    { group: 'emblazon-ta', r: 0, c: 1 }, { group: 'emblazon-tb', r: 0, c: 2 },
    { group: 'emblazon-ba', r: 2, c: 1 }, { group: 'emblazon-bb', r: 2, c: 2 },
  ];
  const { png } = await assemble(3, 3, ports);
  const A = (await sharp(png).extract({ left: 32, top: 32, width: 192 * SCALE, height: 192 * SCALE }).raw().toBuffer({ resolveWithObject: true })).data;

  const origSvg = fs.readFileSync('src/assets/svg/3x3_unit.svg', 'utf8');
  const origHead = origSvg.match(/<svg\b[^>]*>/)[0];
  // 对比基准 = base（边框环+emblazon）+ ports_base（端口底板，2026-08-21 用户移出
  // layer-base）+ ports + ports_top + arrows（端口三组无 layer- 前缀默认显示，
  // 只需隐藏其余 layer-* 与 Decoration 组——deco 属 deco-l/r 切片职责，不进基线）
  const origLayer = origSvg.replace(origHead, `${origHead}\n<style>
  g[id^="layer-"] { display: none !important; }
  g#layer-base { display: inline !important; }
  g#Decoration { display: none !important; }
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
console.log('\n[B] 多尺寸结构（边框环 / 相邻口边界 emblazon / 无缝；全固体口掩码叠加）');
for (const [w, h] of [[4, 3], [6, 3], [6, 6], [2, 2], [5, 5]]) {
  const { png, PAD } = await assemble(w, h, fullSolidExtras(w, h));
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
  // arrow_mask 契约帧基准 = 3x3_unit（whole 路径）。精炼炉 T1.12 液口迁出后已无
  // #828080 箭头（arrow_mask 不再生成）——它是 nineslice 设备，预览染色走逐 Sprite
  // tint，不消费 mask，缺帧无影响。
  const m = sheet.frames['3x3_unit_arrow_mask.png'];
  ok(m && !m.trimmed, 'arrow_mask 帧**未** trim（PreviewTintFilter UV 映射契约，基准 3x3_unit）');
}

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
if (failed > 0) process.exit(1);
