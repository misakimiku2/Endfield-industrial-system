// 地图实例 — 世界尺寸作为地图实例属性（不再是全局常量）
// 依据: A11 world-vision.md WV-003 §4.4、A2 world-model.md §8
//
// 背景与动机（A11 WV-003 §4.4）:
//   原 `WORLD_WIDTH/HEIGHT_CELLS` 是全局常量，占用表、相机边界 clamp 都读它。
//   Phase 3a 起世界将 Chunk 化（无限世界），世界尺寸不再是"全局固定值"。
//   若硬编码成全局常量，届时要扫全代码改硬编码。此处提前把尺寸收口为
//   **地图实例属性**，占用表 / 边界 clamp 都读 MapInstance，让 Phase 3a 切换无感。
//
// 范围（A11 WV-003 §4.4 明确）:
//   Phase 1 仅做"常量→实例属性"改造，**不引入 Chunk 本身**。
//   默认地图仍是 64×64 cells（A2 §8 临时方案），与改造前数值一致，零行为变化。

import { CELL_SIZE, WORLD_DEFAULT_CELLS } from '../render/constants';

/** 地图配置（构造 MapInstance 用）。 */
export interface MapConfig {
  /** 地图宽度（单位: Cell）。Phase 1-2 默认 64。 */
  widthCells: number;
  /** 地图高度（单位: Cell）。Phase 1-2 默认 64。 */
  heightCells: number;
}

/**
 * 地图实例 — 世界尺寸的"唯一真相源"。
 *
 * 一个地图实例描述一块固定世界区域（Phase 1-2），所有需要世界尺寸的子系统
 * （相机边界、占用表范围、坐标 clamp）都应从这里读，而不是读全局常量。
 *
 * Phase 3a 起语义变更: 这两个字段表示"初始已生成区域"，世界本身无固定边界
 * （无限世界，Chunk 动态生成）。届时 MapInstance 仍是尺寸的访问入口，调用方无需改动。
 */
export class MapInstance {
  readonly widthCells: number;
  readonly heightCells: number;
  /** 世界宽度（世界像素）= widthCells * CELL_SIZE。 */
  readonly widthPx: number;
  /** 世界高度（世界像素）= heightCells * CELL_SIZE。 */
  readonly heightPx: number;

  constructor(config: MapConfig) {
    if (config.widthCells <= 0 || config.heightCells <= 0) {
      throw new Error(
        `MapInstance: 尺寸必须为正数 (got ${config.widthCells}×${config.heightCells})`,
      );
    }
    this.widthCells = config.widthCells;
    this.heightCells = config.heightCells;
    this.widthPx = config.widthCells * CELL_SIZE;
    this.heightPx = config.heightCells * CELL_SIZE;
  }
}

/**
 * 创建默认地图实例（64×64 cells）。
 * Phase 1-2 的世界尺寸默认值集中在此处，避免魔数散落。
 */
export function createDefaultMap(): MapInstance {
  return new MapInstance({
    widthCells: WORLD_DEFAULT_CELLS,
    heightCells: WORLD_DEFAULT_CELLS,
  });
}
