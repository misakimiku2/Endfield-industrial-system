// 资源管线主脚本 — SVG/PNG → 纹理图集
// 用法: node --experimental-strip-types scripts/pack-assets.ts
//   或   npm run pack-assets
//
// 流程:
//   阶段 A 扫描+光栅化: 遍历各图集分组的输入目录，SVG 用 sharp 光栅化为 PNG buffer，
//                        PNG 直接读取。所有图块得到 {key, width, height, png}
//   阶段 B 打包: 对每个分组调用 shelfPack，得到放置坐标 + 图集尺寸
//   阶段 C 合成+输出: 用 sharp 把图块 composite 到透明底图集，写出 {group}.png + {group}.json
//
// 输出: public/spritesheets/{devices,items,ui}.{png,json}
// 产物不入库(.gitignore)，dev 时 Vite 自动 serve public/。
//
// 依据: DD-008(revised) 双格式、DD-013 分组、T1.3 验收(运行时 Assets.get 可取)

import sharp from 'sharp';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ATLAS_GROUPS,
  isDeviceFile,
  isExcluded,
  OUTPUT_DIR,
  type AtlasGroup,
} from './assets/asset-manifest.ts';
import { shelfPack, type PackInput } from './assets/packer.ts';

// ───────────────────────── texture key 规范化 ─────────────────────────

/**
 * 文件名 → texture key。
 * 规则: 去扩展名 → 小写 → 连续的非字母数字替换为单个 _ → 去首尾 _。
 * 例: "Transport_Belt_Move.svg" → "transport_belt_move"
 *     "Cuprium_Ore.png" → "cuprium_ore"
 *     "Buck_Capsule_(A).png" → "buck_capsule_a"
 */
function toTextureKey(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '');
  const lower = base.toLowerCase();
  const cleaned = lower.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned;
}

/** 获取某文件应使用的 texture key(查覆盖表，否则自动规则)。 */
function resolveKey(group: AtlasGroup, filename: string): string {
  return group.keyOverrides?.[filename] ?? toTextureKey(filename);
}

// ───────────────────────── SVG 光栅化 ─────────────────────────

/**
 * 用 sharp 光栅化 SVG → PNG buffer。
 * sharp 会读取 SVG 的 width/height(像素)作为基础尺寸光栅化；
 * 若 SVG 只有 viewBox 无 width/height，sharp 默认按 72 DPI 渲染 viewBox。
 * 我们再 resize 到目标尺寸(此处用 SVG 自带尺寸，保持原始像素精度)。
 */
async function rasterizeSvg(svgPath: string): Promise<{ png: Buffer; width: number; height: number }> {
  const svgBuf = fs.readFileSync(svgPath);
  // 先获取 sharp 解析出的尺寸(它内部用 librsvg 渲染)
  const meta = await sharp(svgBuf).metadata();
  let width = meta.width ?? meta.pages;
  let height = meta.height;

  // 如果 sharp 无法从 SVG 直接读出尺寸(某些无 width/height 的 SVG)，
  // 回退到解析 viewBox
  if (!width || !height) {
    const content = svgBuf.toString('utf8');
    const vbMatch = content.match(/viewBox=["']([\d.\s,-]+)["']/);
    if (vbMatch) {
      const vb = vbMatch[1].trim().split(/[\s,]+/).map(Number);
      if (vb.length === 4) {
        width = Math.round(vb[2]);
        height = Math.round(vb[3]);
      }
    }
  }
  if (!width || !height) {
    throw new Error(`无法确定 SVG 尺寸: ${svgPath}`);
  }

  // 光栅化到原始像素尺寸(放大倍数=1)。sharp 对 SVG 默认以 72DPI 渲染，
  // width/height 属性为像素时直接采用。
  const png = await sharp(svgBuf).resize(width, height, { fit: 'fill' }).png().toBuffer();
  return { png, width, height };
}

/** 读取 PNG 文件 → {png, width, height}。 */
async function readPng(pngPath: string): Promise<{ png: Buffer; width: number; height: number }> {
  const png = fs.readFileSync(pngPath);
  const meta = await sharp(png).metadata();
  if (!meta.width || !meta.height) {
    throw new Error(`无法读取 PNG 尺寸: ${pngPath}`);
  }
  return { png, width: meta.width, height: meta.height };
}

// ───────────────────────── 图集分组扫描 ─────────────────────────

/**
 * 扫描某图集分组的输入目录，收集该分组应包含的所有图块。
 * devices/ui 共用 src/assets/svg/，按 DEVICE_FILES 白名单分流:
 *   - devices 只收 DEVICE_FILES 列出的
 *   - ui 收 svg 目录下非 device、非排除的
 * items 收 src/assets/png/ 下所有(跨 AIC Products + Natural Resources)
 */
async function collectGroup(group: AtlasGroup): Promise<PackInput[]> {
  const blocks: PackInput[] = [];
  const keySeen = new Set<string>();

  // 扫描 inputDir
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...walk(full));
      } else if (/\.(svg|png)$/i.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  const allFiles = walk(group.inputDir);

  for (const file of allFiles) {
    const basename = path.basename(file);
    const ext = path.extname(file).toLowerCase();

    // 排除
    if (isExcluded(basename)) continue;

    // devices/ui 分流(svg 目录)
    if (group.name === 'devices') {
      if (!isDeviceFile(basename)) continue;
    } else if (group.name === 'ui') {
      // ui 收 svg 目录下非 device 的；但 inputDir 对 ui 也是 src/assets/svg
      // svg 目录里的 device 文件跳过
      if (isDeviceFile(basename)) continue;
      // png/window/ 不在 svg 目录下，ui 的 inputDir 是 svg，故 Close_button 需单独纳入
    } else if (group.name === 'items') {
      // items 只收 png 文件(png 目录下)
      if (ext !== '.png') continue;
    }

    // 光栅化/读取
    let raster: { png: Buffer; width: number; height: number };
    try {
      raster = ext === '.svg' ? await rasterizeSvg(file) : await readPng(file);
    } catch (e) {
      console.warn(`  ⚠ 跳过 ${file}: ${(e as Error).message}`);
      continue;
    }

    const key = resolveKey(group, basename);
    if (keySeen.has(key)) {
      console.warn(`  ⚠ texture key 冲突: "${key}" (来自 ${basename})，已存在，跳过`);
      continue;
    }
    keySeen.add(key);
    blocks.push({ key, width: raster.width, height: raster.height, png: raster.png });
  }

  // ui 组额外纳入 png/window/Close_button.svg(它在 png 目录但属 UI)
  if (group.name === 'ui') {
    const closeBtn = path.join('src/assets/png/window/Close_button.svg');
    if (fs.existsSync(closeBtn)) {
      const raster = await rasterizeSvg(closeBtn);
      const key = 'close_button';
      if (!keySeen.has(key)) {
        keySeen.add(key);
        blocks.push({ key, width: raster.width, height: raster.height, png: raster.png });
      }
    }
  }

  return blocks;
}

// ───────────────────────── 图集合成 + JSON ─────────────────────────

/** PixiJS spritesheet JSON 帧。 */
interface SpriteFrame {
  frame: { x: number; y: number; w: number; h: number };
  rotated: boolean;
  trimmed: boolean;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
}

/** 把一组图块合成图集 PNG + 生成 spritesheet JSON，写到 OUTPUT_DIR。 */
async function buildAtlas(groupName: string, blocks: PackInput[]): Promise<void> {
  if (blocks.length === 0) {
    console.log(`  [${groupName}] 无图块，跳过`);
    return;
  }

  // 1. 打包
  const pack = shelfPack(blocks);
  console.log(
    `  [${groupName}] ${blocks.length} 块 → ${pack.atlasWidth}×${pack.atlasHeight} 图集`,
  );

  // 2. 合成: 透明底 + 逐块 composite
  let compositor = sharp({
    create: {
      width: pack.atlasWidth,
      height: pack.atlasHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).png();

  const operations: Array<{ input: Buffer; left: number; top: number }> = [];
  for (const rect of pack.rects) {
    const block = blocks.find(b => b.key === rect.key)!;
    operations.push({
      input: block.png,
      left: rect.x,
      top: rect.y,
    });
  }
  compositor = compositor.composite(operations);
  const pngPath = path.join(OUTPUT_DIR, `${groupName}.png`);
  await compositor.toFile(pngPath);

  // 3. 生成 spritesheet JSON (PixiJS v8 格式)
  const frames: Record<string, SpriteFrame> = {};
  for (const rect of pack.rects) {
    const block = blocks.find(b => b.key === rect.key)!;
    // PixiJS frame key 惯例带 .png 后缀
    frames[`${rect.key}.png`] = {
      frame: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: rect.width, h: rect.height },
      sourceSize: { w: block.width, h: block.height },
    };
  }
  const json = {
    frames,
    meta: {
      app: 'pack-assets.ts',
      version: '1.0',
      image: `${groupName}.png`,
      format: 'RGBA8888',
      size: { w: pack.atlasWidth, h: pack.atlasHeight },
      scale: 1,
    },
  };
  const jsonPath = path.join(OUTPUT_DIR, `${groupName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));
  console.log(`  [${groupName}] 写出 ${groupName}.png + ${groupName}.json`);
}

// ───────────────────────── 主入口 ─────────────────────────

async function main(): Promise<void> {
  console.log('=== pack-assets: 构建纹理图集 ===\n');

  // 准备输出目录
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const group of ATLAS_GROUPS) {
    console.log(`\n[${group.name}] 扫描 ${group.inputDir}...`);
    const blocks = await collectGroup(group);
    console.log(`  收集到 ${blocks.length} 个图块`);
    await buildAtlas(group.name, blocks);
  }

  console.log('\n=== 完成 ===');
  console.log(`产物: ${OUTPUT_DIR}/{devices,items,ui}.{png,json}`);
}

main().catch((err) => {
  console.error('\n❌ 打包失败:', err);
  process.exit(1);
});
