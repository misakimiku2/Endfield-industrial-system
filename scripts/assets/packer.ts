// Shelf-pack 矩形打包算法
// 把一组已知尺寸的矩形(图块)排列进一个尽可能小的图集，返回每个图块的放置坐标。
//
// 算法: 按"高度"降序排序 → 从图集左上角逐行摆放 → 当前行(shelf)高度由该行最高块决定 →
//       当前行放不下时换行。这是经典 shelf heuristic，对尺寸相近的图块(如 93 个物品图标)
//       空间利用率很高，对尺寸差异大的(ui 部件)也足够。
//
// 依据 DD-014 渲染预算 + DD-013 分组: 图集尺寸取 2 的幂(POT)以利 GPU，
// 超过 MAX_ATLAS_SIZE 则抛错(提示需拆分)。

import { MAX_ATLAS_SIZE, ATLAS_PADDING } from './asset-manifest.ts';

/** 一个待打包的图块(已光栅化的 PNG)。 */
export interface PackInput {
  /** texture key (规范化后的)。 */
  key: string;
  /** 图块像素宽。 */
  width: number;
  /** 图块像素高。 */
  height: number;
  /** 已光栅化的 PNG Buffer (或文件路径)，打包时合成到图集。 */
  png: Buffer;
  /**
   * trim 元数据（T1.11b）。width/height 是裁剪后内容尺寸；本字段记录
   * 内容在**原始全画布帧**中的偏移与原始尺寸，spritesheet JSON 以
   * trimmed/spriteSourceSize/sourceSize 输出（PixiJS 原生支持，anchor 0.5
   * 按 orig 尺寸对齐，运行时无需偏移补偿）。
   */
  trim?: {
    /** 内容左上角在原始帧中的偏移。 */
    offsetX: number;
    offsetY: number;
    /** 原始帧全尺寸。 */
    origWidth: number;
    origHeight: number;
  };
}

/** 一个图块在图集中的放置结果。 */
export interface PackRect {
  key: string;
  /** 在图集中的左上角坐标。 */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 打包结果。 */
export interface PackResult {
  /** 各图块放置坐标。 */
  rects: PackRect[];
  /** 图集最终宽度(POT)。 */
  atlasWidth: number;
  /** 图集最终高度(POT)。 */
  atlasHeight: number;
}

/**
 * 对一组图块执行 shelf-pack，返回放置坐标 + 图集 POT 尺寸。
 * 若装不进 MAX_ATLAS_SIZE×MAX_ATLAS_SIZE 则抛错。
 */
export function shelfPack(inputs: PackInput[]): PackResult {
  if (inputs.length === 0) {
    return { rects: [], atlasWidth: 1, atlasHeight: 1 };
  }

  const pad = ATLAS_PADDING;

  // 按高度降序排(经典 shelf heuristic: 先放大块)
  const sorted = [...inputs].sort((a, b) => b.height - a.height);

  // 先估算一个初始图集宽度，取最大图块宽 × sqrt(n) 量级，然后向上取 POT
  const maxBlockW = Math.max(...sorted.map(i => i.width));
  const estimatedW = Math.max(
    maxBlockW + pad * 2,
    Math.ceil(Math.sqrt(sorted.length) * (sorted[0].width + pad)),
  );
  let atlasW = nextPow2(estimatedW);
  atlasW = Math.min(Math.max(atlasW, 64), MAX_ATLAS_SIZE);

  const rects: PackRect[] = [];
  // shelf 状态
  let shelfX = pad; // 当前行已用到 x
  let shelfY = pad; // 当前行顶部 y
  let shelfH = 0; // 当前行高度

  for (const blk of sorted) {
    const bw = blk.width;
    const bh = blk.height;

    // 当前行放得下?
    if (shelfX + bw + pad > atlasW) {
      // 换行
      shelfY += shelfH + pad;
      shelfX = pad;
      shelfH = 0;
    }

    rects.push({ key: blk.key, x: shelfX, y: shelfY, width: bw, height: bh });
    shelfX += bw + pad;
    shelfH = Math.max(shelfH, bh);
  }

  // 总高度 = 最后一行底 + padding
  const usedH = shelfY + shelfH + pad;
  let atlasH = nextPow2(usedH);

  // 检查是否超限。若超限，尝试扩大宽度重排一次。
  if (atlasW > MAX_ATLAS_SIZE || atlasH > MAX_ATLAS_SIZE) {
    // 尝试以 MAX_ATLAS_SIZE 宽度重排
    if (atlasW < MAX_ATLAS_SIZE) {
      return shelfPackWithWidth(sorted, MAX_ATLAS_SIZE, pad);
    }
    throw new Error(
      `图集装不下: 需要 ${atlasW}×${atlasH}，超过上限 ${MAX_ATLAS_SIZE}×${MAX_ATLAS_SIZE}。` +
        '请拆分图集或减少图块。' +
        ` (图块数=${inputs.length}, 最大块=${maxBlockW}×${sorted[0].height})`,
    );
  }

  // 尝试缩小宽度: 若内容很窄，用更小的 POT 宽度重排可能更省空间。
  // 简单策略: 取 usedW 的 POT 和 atlasW 中较小者
  const maxUsedX = Math.max(...rects.map(r => r.x + r.width)) + pad;
  const tighterW = Math.min(nextPow2(maxUsedX), atlasW);
  if (tighterW < atlasW) {
    // 用更窄宽度重排一次(可能高度变化，但更紧凑)
    const retry = shelfPackWithWidth(sorted, tighterW, pad);
    // 选面积较小的方案
    if (retry.atlasWidth * retry.atlasHeight <= atlasW * atlasH) {
      return retry;
    }
  }

  return { rects, atlasWidth: atlasW, atlasHeight: atlasH };
}

/** 用固定宽度执行 shelf-pack(内部辅助)。 */
function shelfPackWithWidth(sorted: PackInput[], atlasW: number, pad: number): PackResult {
  const rects: PackRect[] = [];
  let shelfX = pad;
  let shelfY = pad;
  let shelfH = 0;

  for (const blk of sorted) {
    const bw = blk.width;
    const bh = blk.height;
    if (bw + pad * 2 > atlasW) {
      throw new Error(
        `单个图块 ${blk.key} (${bw}×${bh}) 宽度超过图集宽度 ${atlasW}。`,
      );
    }
    if (shelfX + bw + pad > atlasW) {
      shelfY += shelfH + pad;
      shelfX = pad;
      shelfH = 0;
    }
    rects.push({ key: blk.key, x: shelfX, y: shelfY, width: bw, height: bh });
    shelfX += bw + pad;
    shelfH = Math.max(shelfH, bh);
  }
  const usedH = shelfY + shelfH + pad;
  const atlasH = nextPow2(usedH);
  if (atlasH > MAX_ATLAS_SIZE) {
    throw new Error(
      `图集高度 ${atlasH} 超过上限 ${MAX_ATLAS_SIZE}(宽度=${atlasW}, 图块数=${sorted.length})。`,
    );
  }
  return { rects, atlasWidth: atlasW, atlasHeight: atlasH };
}

/** 取 >= v 的最小 2 的幂。 */
export function nextPow2(v: number): number {
  if (v <= 1) return 1;
  let p = 1;
  while (p < v) p <<= 1;
  return p;
}
