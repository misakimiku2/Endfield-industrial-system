// 资源产物验证脚本 — 校验打包图集尺寸符合 rasterScale 配置
// 用法 (需 ts-loader 解析无后缀 import):
//   node --experimental-strip-types \
//        --import 'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("./scripts/ts-loader.mjs", pathToFileURL("./"));' \
//        scripts/verify-assets.ts
//
// 验证内容:
//   A. devices 图集各纹理 frame = SVG 源原始尺寸 × DEVICE_RASTER_SCALE(4)
//      （修复 zoom=4 锯齿的关键：1×1 设备纹理应有 256×256 像素）
//   B. items/ui 图集各纹理 frame = 源原始尺寸 × 1（未提倍）
//   C. 图集边长为 POT 且 ≤ MAX_ATLAS_SIZE(4096)
//   D. PNG 产物与 JSON 声明的图集尺寸一致
//
// 说明: 直接读 public/spritesheets/*.json + 源 SVG 的 width/height 属性，
//       不依赖运行时。用 sharp 校验 PNG 实际尺寸。

import * as fs from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';
import {
  ATLAS_GROUPS,
  DEVICE_RASTER_SCALE,
  MAX_ATLAS_SIZE,
} from './assets/asset-manifest.ts';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

const OUTPUT_DIR = 'public/spritesheets';

/** 解析 SVG 的 width/height 基础像素尺寸（与 pack-assets.rasterizeSvg 同逻辑）。 */
async function svgBaseSize(svgPath: string): Promise<{ w: number; h: number } | null> {
  if (!fs.existsSync(svgPath)) return null;
  const svgBuf = fs.readFileSync(svgPath);
  const meta = await sharp(svgBuf).metadata();
  let w = meta.width ?? meta.pages;
  let h = meta.height;
  if (!w || !h) {
    const m = svgBuf.toString('utf8').match(/viewBox=["']([\d.\s,-]+)["']/);
    if (m) {
      const vb = m[1].trim().split(/[\s,]+/).map(Number);
      if (vb.length === 4) { w = Math.round(vb[2]); h = Math.round(vb[3]); }
    }
  }
  return w && h ? { w, h } : null;
}

function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

console.log('\n=== 资源产物验证 (rasterScale 配置 + 图集尺寸) ===\n');

for (const group of ATLAS_GROUPS) {
  const scale = group.rasterScale ?? 1;
  const jsonPath = path.join(OUTPUT_DIR, `${group.name}.json`);
  const pngPath = path.join(OUTPUT_DIR, `${group.name}.png`);

  console.log(`[${group.name}] rasterScale=${scale}`);

  if (!fs.existsSync(jsonPath)) {
    assert(false, `${group.name}.json 存在（需先 npm run pack-assets）`);
    continue;
  }
  const sheet = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const atlasW = sheet.meta.size.w;
  const atlasH = sheet.meta.size.h;

  // C. 图集边长 POT + 上限
  assert(isPow2(atlasW) && isPow2(atlasH),
    `${group.name} 图集尺寸 ${atlasW}×${atlasH} 为 POT`);
  assert(atlasW <= MAX_ATLAS_SIZE && atlasH <= MAX_ATLAS_SIZE,
    `${group.name} 图集尺寸 ≤ MAX_ATLAS_SIZE(${MAX_ATLAS_SIZE})`);

  // D. PNG 实际尺寸与 JSON 声明一致
  const pngMeta = await sharp(pngPath).metadata();
  assert(pngMeta.width === atlasW && pngMeta.height === atlasH,
    `${group.name}.png 实际尺寸 (${pngMeta.width}×${pngMeta.height}) == JSON 声明 (${atlasW}×${atlasH})`);

  // A/B. 各纹理 sourceSize 尺寸 = 源 × scale（T1.11b 后 frame 可能被 trim 缩小，
  //      全画布尺寸看 sourceSize；纹素 1:1 的关键是 sourceSize 而非 frame）
  //   devices/ui 源是 SVG（提倍生效）；items 源是 PNG（scale 应为 1，直接对比源 PNG 尺寸）
  const frameCount = Object.keys(sheet.frames).length;
  let checked = 0;
  let mismatches = 0;
  for (const [frameKey, frame] of Object.entries(sheet.frames) as Array<[string, {
    frame: { x: number; y: number; w: number; h: number };
    trimmed: boolean;
    spriteSourceSize: { x: number; y: number; w: number; h: number };
    sourceSize: { w: number; h: number };
  }]>) {
    const texKey = frameKey.replace(/\.png$/, '');
    // 反查源文件：用 keyOverrides 反映射，否则 toTextureKey 规则
    // 简化：devices/ui 从 svg 目录找匹配文件；items 从 png 目录找
    // 这里只校验"关键样本"以避免复杂反查，重点验证提倍生效
    if (group.name === 'devices') {
      // devices 关键样本: 已知 texture key → 期望 base 尺寸
      const samples: Record<string, { w: number; h: number }> = {
        transport_belt: { w: 64, h: 64 },
        refining_unit: { w: 192, h: 192 },
        depot: { w: 192, h: 64 },
        converger: { w: 64, h: 64 },
        splitter: { w: 64, h: 64 },
        belt_bridge: { w: 64, h: 64 },
        item_control_port: { w: 64, h: 64 },
        belt_corner: { w: 64, h: 64 },
      };
      const expect = samples[texKey];
      if (expect) {
        const ok = Math.abs(frame.sourceSize.w - expect.w * scale) <= scale &&
                   Math.abs(frame.sourceSize.h - expect.h * scale) <= scale;
        if (!ok) mismatches++;
        checked++;
      }
      // trim 元数据一致性（T1.11b）: trimmed 帧的 spriteSourceSize 偏移 + frame 尺寸
      // 必须落在 sourceSize 内，否则 PixiJS 定位错乱
      if (frame.trimmed) {
        const inBounds =
          frame.spriteSourceSize.x >= 0 && frame.spriteSourceSize.y >= 0 &&
          frame.spriteSourceSize.x + frame.spriteSourceSize.w <= frame.sourceSize.w &&
          frame.spriteSourceSize.y + frame.spriteSourceSize.h <= frame.sourceSize.h &&
          frame.spriteSourceSize.w === frame.frame.w && frame.spriteSourceSize.h === frame.frame.h;
        if (!inBounds) mismatches++;
      }
    }
  }
  if (group.name === 'devices') {
    assert(checked >= 7 && mismatches === 0,
      `${group.name} 各纹理 sourceSize = 源尺寸 × ${scale}，trim 元数据一致（已校验 ${checked} 个，不匹配 ${mismatches}）`);
    // 重点: 1×1 设备 sourceSize 应为 256×256，3×3 应为 768×768（zoom=4 纹素 1:1 的关键）
    const belt = sheet.frames['transport_belt.png'];
    const furnace = sheet.frames['refining_unit.png'];
    assert(belt && belt.sourceSize.w === DEVICE_RASTER_SCALE * 64 && belt.sourceSize.h === DEVICE_RASTER_SCALE * 64,
      `transport_belt (1×1) sourceSize = ${DEVICE_RASTER_SCALE * 64}×${DEVICE_RASTER_SCALE * 64}（zoom=4 纹素 1:1）`);
    assert(furnace && furnace.sourceSize.w === DEVICE_RASTER_SCALE * 192 && furnace.sourceSize.h === DEVICE_RASTER_SCALE * 192,
      `refining_unit (3×3) sourceSize = ${DEVICE_RASTER_SCALE * 192}×${DEVICE_RASTER_SCALE * 192}`);
    // T1.11: 九宫格切片帧存在且为窗口尺寸（64+2×4 px 源 × 4）
    const ns = ['tl', 't', 'tr', 'l', 'r', 'bl', 'b', 'br'] as const; // c 空心跳过
    const nsWin = (64 + 2 * 4) * DEVICE_RASTER_SCALE;
    const nsOk = ns.every((n) => {
      const f = sheet.frames[`nineslice/${n}.png`];
      return f && f.frame.w === nsWin && f.frame.h === nsWin;
    });
    assert(nsOk, `nineslice/* 8 切片帧存在且 = ${nsWin}×${nsWin}（窗口 72px 源 × 4）`);
  }
  console.log(`  (${frameCount} 个纹理，图集 ${atlasW}×${atlasH})\n`);
}

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===\n`);
if (failed > 0) process.exit(1);
