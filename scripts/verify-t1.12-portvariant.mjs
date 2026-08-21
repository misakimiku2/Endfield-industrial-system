// T1.12 端口变体验证 — 掩码派生单测 + 拼装像素对比 + 图集产物
// 用法: node --experimental-strip-types scripts/verify-t1.12-portvariant.mjs
//   （需先 npm run pack-assets；掩码单测直接 import src 的 PortMask/buildings）
//
// 验证内容（S3 §6 验收的离线部分）:
//   A. portMaskFromDef 掩码派生单测（含旧 PortType 过渡规则，S3 §5.2）
//   B. 精炼炉 0 差异: 新链路 [slice+port 全叠加+lport-l/r] vs
//      [原四组素材 + 原独立液口素材 liquid_export/import] 逐像素（S3 §6-1，
//      含 equipment→lport 切片迁移的等价性）
//   C. 无端口设备 0 差异: [slice+deco-l/r] vs 3x3_unit base+Decoration（用户素材）
//   D. deco 竖向连续性: 3×5 逐行平铺合并为连续饰条（无缺口、帽端完整）
//   E. 顶/底液体口造型落位（合成掩码驱动，等 A3 数据模型拆分后 def 才能置位）
//   F. 图集: port-* 6 帧 + lport-* 8 帧 288²、deco-l/r 320²、图集 ≤ 4096
//
// 依据: doc/nineslice-port-variant.md（S3）、doc/asset-drawing-standard.md §9（S1）

import sharp from 'sharp';
import * as fs from 'node:fs';
import { portMaskFromDef, portMaskKey, emptyPortMask } from '../src/game/render/PortMask.ts';
import { getBuildingDefinition } from '../src/game/data/buildings.ts';

const SCALE = 8;
const CELL = 16.9333333;
let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
};

// ───────────────────── 拼装工具（与 verify-t1.11 同逻辑） ─────────────────────

const nsSvg = fs.readFileSync('src/assets/svg/nineslice_unit.svg', 'utf8');
const nsHead = nsSvg.match(/<svg\b[^>]*>/)[0];

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

async function renderGroup(name, dstR, dstC) {
  const [hr, hc, margin] = GROUP_HOME[name];
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

function tileName(r, c, w, h) {
  const v = r === 0 ? 't' : r === h - 1 ? 'b' : 'm';
  const u = c === 0 ? 'l' : c === w - 1 ? 'r' : 'm';
  if (v === 'm' && u === 'm') return 'c';
  return v === 'm' ? u : u === 'm' ? v : v + u;
}

/** 拼装 w×h：底座切片 + extra 叠加组 [{group, r, c}]（按序叠在底座之上）。 */
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
  return { png, PAD };
}

/** 取拼装结果中央设备区域的 raw 像素（含 PAD 偏移）。 */
async function devicePixels(png, PAD, w, h) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  return (sx, sy) => {
    const i = ((sy * SCALE + PAD) | 0) * W + ((sx * SCALE + PAD) | 0);
    return [data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]];
  };
}

// ── A. 掩码派生单测 ──
console.log('\n[A] portMaskFromDef 掩码派生（旧 PortType 过渡规则，S3 §5.2）');
{
  const refining = portMaskFromDef(getBuildingDefinition('refining_unit'));
  ok(refining.top.solid === 0b111 && refining.bottom.solid === 0b111
    && refining.left.liquid === 0b010 && refining.right.liquid === 0b010
    && refining.top.liquid === 0 && refining.bottom.liquid === 0
    && refining.left.solid === 0 && refining.right.solid === 0,
    '精炼炉: top/bottom.solid=0b111, left/right.liquid=0b010（与现状一致）');

  const partial = portMaskFromDef(getBuildingDefinition('test_nineslice_4x3'));
  ok(partial.top.solid === 0b100 && partial.bottom.solid === 0b010,
    '部分端口 4×3: top.solid=0b100（dx=2）, bottom.solid=0b010（dx=1）');

  const noport = portMaskFromDef(getBuildingDefinition('test_nineslice_noport'));
  const zero = emptyPortMask();
  ok(JSON.stringify(noport) === JSON.stringify(zero), '无端口设备: 全零掩码');

  const liquid55 = portMaskFromDef(getBuildingDefinition('test_nineslice_liquid_5x5'));
  ok(liquid55.left.liquid === 0b01010 && liquid55.right.liquid === 0b00100
    && liquid55.top.solid === 0b100 && liquid55.bottom.solid === 0b100,
    '侧液多行 5×5: left.liquid=0b01010（dy=1,3）, right.liquid=0b00100（dy=2）');

  const seed = portMaskFromDef(getBuildingDefinition('seed_picking_unit'));
  ok(seed.top.solid === 0b01110 && seed.bottom.solid === 0b01110,
    '采种机式 5×5: top/bottom.solid=0b01110（dx=1..3 两角无口）');

  // 角格液体口归侧边（dx 规则优先）；顶/底液体口不进掩码（等 A3 拆分）
  const corner = portMaskFromDef({
    ...getBuildingDefinition('test_nineslice_noport'),
    ports: [
      { type: 'liquid', position: { dx: 0, dy: 0 } },
      { type: 'liquid', position: { dx: 1, dy: 0 } },
      { type: 'liquid', position: { dx: 1, dy: 2 } },
    ],
  });
  ok(corner.left.liquid === 0b001 && corner.top.liquid === 0 && corner.bottom.liquid === 0,
    '角格液体口 dx=0 优先归 left（bit0）；顶/底液体口不进掩码（A3 拆分前）');

  const m1 = portMaskFromDef(getBuildingDefinition('refining_unit'));
  ok(portMaskKey(m1) === portMaskKey(portMaskFromDef(getBuildingDefinition('refining_unit')))
    && portMaskKey(m1) !== portMaskKey(zero),
    'portMaskKey 稳定（同掩码同键 / 不同掩码不同键）');
}

// ── B. 精炼炉 0 差异（slice+port+emblazon+lport 新链路 vs 原素材） ──
console.log('\n[B] 精炼炉逐像素 0 差异（S3 §6-1，含 equipment→lport 迁移等价）');
{
  const { png, PAD } = await assemble(3, 3, [
    { group: 'port-tl', r: 0, c: 0 }, { group: 'port-t', r: 0, c: 1 }, { group: 'port-tr', r: 0, c: 2 },
    { group: 'port-bl', r: 2, c: 0 }, { group: 'port-b', r: 2, c: 1 }, { group: 'port-br', r: 2, c: 2 },
    { group: 'emblazon-ta', r: 0, c: 1 }, { group: 'emblazon-tb', r: 0, c: 2 },
    { group: 'emblazon-ba', r: 2, c: 1 }, { group: 'emblazon-bb', r: 2, c: 2 },
    { group: 'lport-l', r: 1, c: 0 }, { group: 'lport-r', r: 1, c: 2 },
  ]);
  const A = (await sharp(png).extract({ left: PAD, top: PAD, width: 192 * SCALE, height: 192 * SCALE }).raw().toBuffer({ resolveWithObject: true })).data;

  // 基线 = 3x3_unit 四组素材（隐藏 Decoration/indicators） + 原独立液口素材
  // （liquid_export.svg 平边贴左竖轨 x=1.8521 → 画布偏移 7px；liquid_import.svg
  //  内部已镜像，平边贴右竖轨 x=48.948 → 偏移 153px；均 32×64px @ y=64）
  const origSvg = fs.readFileSync('src/assets/svg/3x3_unit.svg', 'utf8');
  const origHead = origSvg.match(/<svg\b[^>]*>/)[0];
  const baseLayer = origSvg.replace(origHead, `${origHead}\n<style>
  g[id^="layer-"] { display: none !important; }
  g#layer-base { display: inline !important; }
  g#Decoration { display: none !important; }
</style>`);
  const basePng = await sharp(Buffer.from(baseLayer)).resize(192 * SCALE, 192 * SCALE, { fit: 'fill' }).png().toBuffer();
  const exportPng = await sharp('src/assets/svg/liquid_export.svg').resize(32 * SCALE, 64 * SCALE, { fit: 'fill' }).png().toBuffer();
  const importPng = await sharp('src/assets/svg/liquid_import.svg').resize(32 * SCALE, 64 * SCALE, { fit: 'fill' }).png().toBuffer();
  const origFull = await sharp(basePng).composite([
    { input: exportPng, left: 7 * SCALE, top: 64 * SCALE },
    { input: importPng, left: 153 * SCALE, top: 64 * SCALE },
  ]).png().toBuffer();
  const B = (await sharp(origFull).raw().toBuffer({ resolveWithObject: true })).data;

  let diff = 0;
  for (let i = 0; i < A.length; i += 4) {
    for (let ch = 0; ch < 4; ch++) {
      if (Math.abs(A[i + ch] - B[i + ch]) > 8) { diff++; break; }
    }
  }
  ok(diff === 0, `差异像素(>8) = ${diff} / ${(192 * SCALE) ** 2}（必须为 0）`);
}

// ── C. 无端口设备 0 差异（slice+deco vs 用户 base+Decoration 素材） ──
console.log('\n[C] 无端口设备逐像素 0 差异（deco-l/r = 用户 2026-08-21 素材）');
{
  const { png, PAD } = await assemble(3, 3, [
    { group: 'deco-l', r: 1, c: 0 }, { group: 'deco-r', r: 1, c: 2 },
  ]);
  const A = (await sharp(png).extract({ left: PAD, top: PAD, width: 192 * SCALE, height: 192 * SCALE }).raw().toBuffer({ resolveWithObject: true })).data;

  const origSvg = fs.readFileSync('src/assets/svg/3x3_unit.svg', 'utf8');
  const origHead = origSvg.match(/<svg\b[^>]*>/)[0];
  // 基线 = 3x3_unit 边框环（layer-base）+ Decoration（无端口设备没有 ports_base/
  // ports/emblazon——底板跟端口走、emblazon 只在相邻口之间，2026-08-21 语义）
  const baseLayer = origSvg.replace(origHead, `${origHead}\n<style>
  g[id^="layer-"] { display: none !important; }
  g#layer-base { display: inline !important; }
  path[id^="emblazon"] { display: none !important; }
  g#ports_base, g#ports, g#ports_top, g#arrows { display: none !important; }
</style>`);
  const origPng = await sharp(Buffer.from(baseLayer)).resize(192 * SCALE, 192 * SCALE, { fit: 'fill' }).png().toBuffer();
  const B = (await sharp(origPng).raw().toBuffer({ resolveWithObject: true })).data;

  let diff = 0;
  for (let i = 0; i < A.length; i += 4) {
    for (let ch = 0; ch < 4; ch++) {
      if (Math.abs(A[i + ch] - B[i + ch]) > 8) { diff++; break; }
    }
  }
  ok(diff === 0, `差异像素(>8) = ${diff} / ${(192 * SCALE) ** 2}（必须为 0）`);
}

// ── D. deco 竖向连续性（3×5 逐行平铺合并为连续饰条） ──
console.log('\n[D] deco 3×5 连续饰条（帽端越界合并，无行缝缺口）');
{
  const extra = [];
  for (let r = 1; r <= 3; r++) {
    extra.push({ group: 'deco-l', r, c: 0 }, { group: 'deco-r', r, c: 2 });
  }
  const { png, PAD } = await assemble(3, 5, extra);
  const px = await devicePixels(png, PAD, 3, 5);
  const isRib = p => p[3] > 200 && Math.abs(p[0] - p[1]) < 12 && p[0] > 175 && p[0] < 230; // #cbc9c9 一带
  // 左饰条中轴 x=16px（3.175~5.066u 中段），y 从首行帽端(≈15.7u)到末行帽端(≈68.9u) 应全程不透明
  let gaps = 0;
  for (let y = 60; y <= 260; y++) {
    if (!isRib(px(16, y))) gaps++;
  }
  ok(gaps === 0, `左饰条 x=16px, y∈[60,260] 缺口像素 = ${gaps}（必须为 0）`);
  let gapsR = 0;
  for (let y = 60; y <= 260; y++) {
    if (!isRib(px(176, y))) gapsR++;
  }
  ok(gapsR === 0, `右饰条 x=176px, y∈[60,260] 缺口像素 = ${gapsR}（必须为 0）`);
  ok(isRib(px(13, 58)) && px(16, 55)[3] < 50, '帽端越界保留（(13,58) 有色 / (16,55) 透明）');
}

// ── E. 顶/底液体口造型落位（合成掩码，def 置位待 A3 端口模型拆分） ──
console.log('\n[E] 顶/底液体口造型（lport-t*/b* 贴横边带，出口黄点朝上 / 进口白点朝下）');
{
  const { png, PAD } = await assemble(3, 3, [
    { group: 'lport-tl', r: 0, c: 0 }, { group: 'lport-t', r: 0, c: 1 }, { group: 'lport-tr', r: 0, c: 2 },
    { group: 'lport-bl', r: 2, c: 0 }, { group: 'lport-b', r: 2, c: 1 }, { group: 'lport-br', r: 2, c: 2 },
  ]);
  const px = await devicePixels(png, PAD, 3, 3);
  const isDisc = p => p[3] > 200 && Math.abs(p[0] - 210) < 25 && Math.abs(p[1] - 210) < 25; // #d2d2d2
  const isYellow = p => p[3] > 200 && p[0] > 230 && p[1] > 215 && p[2] < 80;  // #ffef00
  const isWhite = p => p[3] > 200 && p[0] > 235 && p[1] > 235 && p[2] > 235;  // #ffffff
  ok(isDisc(px(96, 16)) && isDisc(px(32, 16)) && isDisc(px(160, 16)),
    '顶边三列半圆盘落位（盘身 #d2d2d2 @ (32/96/160, 16)——探针避开指示点与箭头）');
  ok(isYellow(px(96, 10)), '顶边出口指示点 #ffef00 @ (96,10)');
  ok(isDisc(px(96, 164)) && isDisc(px(32, 164)) && isDisc(px(160, 164)),
    '底边三列半圆盘落位（盘身 @ (32/96/160, 164)——探针避开箭头与眼底座）');
  ok(isWhite(px(96, 183)), '底边进口指示点 #ffffff @ (96,183)');
}

// ── F. 图集产物 ──
console.log('\n[F] devices 图集产物（需先 npm run pack-assets）');
{
  const sheet = JSON.parse(fs.readFileSync('public/spritesheets/devices.json', 'utf8'));
  const ports = ['port-tl', 'port-t', 'port-tr', 'port-bl', 'port-b', 'port-br'];
  const lports = ['lport-tl', 'lport-t', 'lport-tr', 'lport-bl', 'lport-b', 'lport-br', 'lport-l', 'lport-r'];
  const emblazons = ['emblazon-ta', 'emblazon-tb', 'emblazon-ba', 'emblazon-bb'];
  ok(ports.every(n => {
    const f = sheet.frames[`nineslice/${n}.png`];
    return f && f.frame.w === 288 && f.frame.h === 288;
  }), 'nineslice/port-* 6 帧存在且 288²（含端口底板）');
  ok(emblazons.every(n => {
    const f = sheet.frames[`nineslice/${n}.png`];
    return f && f.frame.w === 288 && f.frame.h === 288;
  }), 'nineslice/emblazon-* 4 帧存在且 288²（端口间小方块）');
  ok(lports.every(n => {
    const f = sheet.frames[`nineslice/${n}.png`];
    return f && f.frame.w === 288 && f.frame.h === 288;
  }), 'nineslice/lport-* 8 帧存在且 288²');
  const d = ['deco-l', 'deco-r'].every(n => {
    const f = sheet.frames[`nineslice/${n}.png`];
    return f && f.frame.w === 320 && f.frame.h === 320;
  });
  ok(d, 'nineslice/deco-l/r 2 帧存在且 320²（8px 边距窗口）');
  ok(sheet.meta.size.w <= 4096 && sheet.meta.size.h <= 4096,
    `图集 ≤ 4096²（实际 ${sheet.meta.size.w}×${sheet.meta.size.h}）`);
}

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
if (failed > 0) process.exit(1);
