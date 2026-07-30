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
 *
 * @param scale 光栅化倍率（默认 1）。SVG 是矢量，在更大目标尺寸下重新栅格化得到
 *              真实高分辨率像素——devices 图集用 4× 匹配 CAMERA_ZOOM_MAX，避免 zoom 放大锯齿。
 *              （对 PNG 源无意义，故 readPng 不接此参数。）
 */
async function rasterizeSvg(
  svgPath: string,
  scale = 1,
): Promise<{ png: Buffer; width: number; height: number }> {
  const svgBuf = fs.readFileSync(svgPath);
  // 先获取 sharp 解析出的基础尺寸(它内部用 librsvg 渲染)
  const meta = await sharp(svgBuf).metadata();
  let baseWidth = meta.width ?? meta.pages;
  let baseHeight = meta.height;

  // 如果 sharp 无法从 SVG 直接读出尺寸(某些无 width/height 的 SVG)，
  // 回退到解析 viewBox
  if (!baseWidth || !baseHeight) {
    const content = svgBuf.toString('utf8');
    const vbMatch = content.match(/viewBox=["']([\d.\s,-]+)["']/);
    if (vbMatch) {
      const vb = vbMatch[1].trim().split(/[\s,]+/).map(Number);
      if (vb.length === 4) {
        baseWidth = Math.round(vb[2]);
        baseHeight = Math.round(vb[3]);
      }
    }
  }
  if (!baseWidth || !baseHeight) {
    throw new Error(`无法确定 SVG 尺寸: ${svgPath}`);
  }

  // 按倍率光栅化: SVG 矢量在 targetWidth×targetHeight 下重新渲染得真实高分辨率像素。
  const targetWidth = Math.round(baseWidth * scale);
  const targetHeight = Math.round(baseHeight * scale);
  const png = await sharp(svgBuf).resize(targetWidth, targetHeight, { fit: 'fill' }).png().toBuffer();
  // 返回光栅化后的实际尺寸（= 基础尺寸 × scale），供打包/JSON 使用
  return { png, width: targetWidth, height: targetHeight };
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

// ───────────────────────── 箭头 mask SVG 构建 ─────────────────────────

/**
 * 正则匹配端口箭头 path: 同时满足 `fill:none` + `stroke:#828080` 的 `<path/>`。
 *
 * 设计依据: 设备 SVG(3x3_unit.svg) 中 6 个端口箭头 path 唯一地用
 *   `fill:none;...stroke:#828080;stroke-width:0.79375` 描述（箭头是描边线条，无填充）。
 *   双 lookahead 保证只匹配箭头，不误伤:
 *     - 连接器柱用 `fill:#828080;stroke:none`（stroke 是 none，不满足第二条）
 *     - rect86 占位用 `fill:none;stroke:none`（stroke 非 #828080，不满足第二条）
 *   lookahead 不消耗字符，两个条件都在同一 `<path .../>` 标签内时才命中。
 */
const ARROW_PATH_REGEX = /<path\b(?=[^>]*fill:\s*none)(?=[^>]*stroke:\s*#828080)[^>]*\/>/g;

/**
 * 从设备 SVG 生成"白色箭头 + 透明背景"的 mask SVG。
 *
 * 用途: 运行时预览染色 filter 需精确识别端口箭头变白。但端口区域全是消色差灰色，
 *   箭头 stroke #828080 与面板灰的抗锯齿交界中点颜色极近（灰度插值必然复现 #828080），
 *   按颜色识别会误染缝隙（详见 PreviewTintFilter 注释）。故构建期在矢量层精确分离
 *   箭头，生成 mask 纹理供运行时双纹理采样，彻底摆脱颜色识别。
 *
 * 实现策略（CSS 隐藏法，保留完整变换层级）:
 *   早期版本把箭头 path 单独提取出来，但丢失了父级 <g transform="..."> 的位移/旋转，
 *   导致 mask 中所有箭头挤回默认坐标（全部叠在设备顶部）。现改为保留原 SVG 完整结构，
 *   仅通过 CSS 把非箭头元素变透明、箭头 stroke 变白。这样所有 transform 层级都保留，
 *   mask 箭头位置与原图完全一致。
 *
 *   1. 保留原 SVG 全部内容（含 width/height/viewBox 及所有 group transform）。
 *   2. 在 <svg> 头部后注入全局 CSS:
 *        svg * { fill-opacity:0 !important; stroke-opacity:0 !important; }
 *        path[style*="fill:none"][style*="stroke:#828080"] { stroke:#fff !important; stroke-opacity:1 !important; }
 *      非箭头元素全部透明；仅端口箭头显示为白色。
 *
 * @param svgContent 设备 SVG 源文本
 * @returns 精简后的 mask SVG 文本；若不含箭头返回 null
 */
function buildArrowMaskSvg(svgContent: string): string | null {
  const arrows = svgContent.match(ARROW_PATH_REGEX);
  if (!arrows || arrows.length === 0) return null;
  // 提取 <svg ...> 头部（到第一个 >），保留 width/height/viewBox
  const headMatch = svgContent.match(/<svg\b[^>]*>/);
  if (!headMatch) return null;

  const styleBlock = `<style>
  /* 隐藏所有元素，只保留端口箭头；箭头变白 */
  svg * { fill-opacity: 0 !important; stroke-opacity: 0 !important; }
  path[style*="fill:none"][style*="stroke:#828080"] { stroke: #ffffff !important; stroke-opacity: 1 !important; }
</style>`;

  // 在 <svg ...> 开标签后插入 CSS，原 SVG 的 transform 层级与箭头位置全部保留
  return svgContent.replace(headMatch[0], `${headMatch[0]}\n${styleBlock}`);
}

/**
 * 光栅化 mask SVG → PNG（与 rasterizeSvg 同逻辑，但输入是已构建的 SVG 文本而非文件路径）。
 * 返回尺寸与设备帧一致（同 baseWidth × scale）。
 */
async function rasterizeMaskSvg(
  maskSvg: string,
  baseWidth: number,
  baseHeight: number,
  scale: number,
): Promise<{ png: Buffer; width: number; height: number }> {
  const buf = Buffer.from(maskSvg);
  const targetWidth = Math.round(baseWidth * scale);
  const targetHeight = Math.round(baseHeight * scale);
  const png = await sharp(buf).resize(targetWidth, targetHeight, { fit: 'fill' }).png().toBuffer();
  return { png, width: targetWidth, height: targetHeight };
}

// ───────────────────────── SVG 分层拆分 ─────────────────────────

/**
 * 列出设备 SVG 中所有符合 `layer-<name>` 约定的工作层名称。
 *
 * 只识别顶层 id 以 `layer-` 开头的 <g> 分组。这些组被约定为功能层
 * （base/ports/arrows/indicators 等），后续构建脚本会分别为每一层
 * 输出一张独立图集帧，供运行时按状态组合渲染。
 */
function listSvgLayers(svgContent: string): string[] {
  const regex = /<g\b[^>]*?\bid=["']layer-([^"']+)["'][^>]*>/g;
  const layers: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = regex.exec(svgContent)) !== null) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      layers.push(name);
    }
  }
  return layers;
}

/**
 * 从完整设备 SVG 中提取指定功能层的独立 SVG。
 *
 * 实现策略（CSS 显示切换）:
 *   保留原 SVG 完整结构与 transform 层级，仅注入 CSS 把所有 `layer-*`
 *   分组隐藏，再把目标 layer 显示出来。这样单帧光栅化后只含该层内容，
 *   且坐标、尺寸与完整设备帧逐像素对齐，方便运行时按同一 sourceSize 叠加。
 *
 * @param svgContent 设备 SVG 源文本
 * @param layerName  要去掉的 `layer-` 前缀，例如 "base" / "arrows"
 * @returns 仅显示该层的 SVG 文本；若该层不存在返回 null
 */
function extractLayerSvg(svgContent: string, layerName: string): string | null {
  if (!svgContent.includes(`id="layer-${layerName}"`)) return null;
  const headMatch = svgContent.match(/<svg\b[^>]*>/);
  if (!headMatch) return null;
  const styleBlock = `<style>
  /* 仅保留目标功能层，其余 layer-* 组隐藏 */
  g[id^="layer-"] { display: none !important; }
  g#layer-${layerName} { display: inline !important; }
</style>`;
  return svgContent.replace(headMatch[0], `${headMatch[0]}\n${styleBlock}`);
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

    // 光栅化/读取（SVG 走倍率栅格化，PNG 直接读取不提倍）
    const rasterScale = group.rasterScale ?? 1;
    let raster: { png: Buffer; width: number; height: number };
    try {
      raster = ext === '.svg' ? await rasterizeSvg(file, rasterScale) : await readPng(file);
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

  // devices 组额外生成功能层子帧 + 箭头 mask 帧
  //   A. 对 SVG 中每个 `layer-<name>` 分组输出一帧，key = ${baseKey}/${layerName}。
  //      运行时可以把 base/ports/arrows/indicators 等层按状态叠加渲染。
  //   B. 继续生成 ${baseKey}_arrow_mask（T1.7 预览染色兼容），后续可迁移到 ${baseKey}/arrows。
  if (group.name === 'devices') {
    const rasterScale = group.rasterScale ?? 1;
    for (const file of allFiles) {
      const basename = path.basename(file);
      if (!isDeviceFile(basename)) continue;
      const ext = path.extname(file).toLowerCase();
      if (ext !== '.svg') continue;
      let svgContent: string;
      try {
        svgContent = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const baseKey = resolveKey(group, basename);

      // 取与设备帧相同的基础尺寸（rasterizeSvg 同源逻辑：优先 sharp 元数据，回退 viewBox）
      const svgBuf = fs.readFileSync(file);
      const meta = await sharp(svgBuf).metadata();
      let baseWidth = meta.width ?? 0;
      let baseHeight = meta.height ?? 0;
      if (!baseWidth || !baseHeight) {
        const vbMatch = svgContent.match(/viewBox=["']([\d.\s,-]+)["']/);
        if (vbMatch) {
          const vb = vbMatch[1].trim().split(/[\s,]+/).map(Number);
          if (vb.length === 4) { baseWidth = Math.round(vb[2]); baseHeight = Math.round(vb[3]); }
        }
      }
      if (!baseWidth || !baseHeight) continue;

      // A. 功能层子帧
      const layers = listSvgLayers(svgContent);
      for (const layerName of layers) {
        const layerSvg = extractLayerSvg(svgContent, layerName);
        if (!layerSvg) continue;
        const layerKey = `${baseKey}/${layerName}`;
        if (keySeen.has(layerKey)) continue;
        try {
          const { png, width, height } = await rasterizeMaskSvg(layerSvg, baseWidth, baseHeight, rasterScale);
          keySeen.add(layerKey);
          blocks.push({ key: layerKey, width, height, png });
        } catch (e) {
          console.warn(`  ⚠ 跳过 layer ${layerKey}: ${(e as Error).message}`);
        }
      }

      // B. 箭头 mask 帧（T1.7 预览染色用）
      const maskSvg = buildArrowMaskSvg(svgContent);
      if (maskSvg) {
        const maskKey = `${baseKey}_arrow_mask`;
        if (!keySeen.has(maskKey)) {
          try {
            const { png, width, height } = await rasterizeMaskSvg(maskSvg, baseWidth, baseHeight, rasterScale);
            keySeen.add(maskKey);
            blocks.push({ key: maskKey, width, height, png });
          } catch (e) {
            console.warn(`  ⚠ 跳过箭头 mask ${basename}: ${(e as Error).message}`);
          }
        }
      }
    }
  }

  // ui 组额外纳入 png/window/Close_button.svg(它在 png 目录但属 UI)
  if (group.name === 'ui') {
    const closeBtn = path.join('src/assets/png/window/Close_button.svg');
    if (fs.existsSync(closeBtn)) {
      const raster = await rasterizeSvg(closeBtn, group.rasterScale ?? 1);
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
