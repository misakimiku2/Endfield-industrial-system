// 占用表 — 跟踪每个 Cell 是否已被设备占用
// 依据: A2 world-model.md §7 (占用表)、§7.2 (多 Cell 建筑)、A11 world-vision.md WV-003 §4.4
//
// 用途: 放置设备前检查目标 Cell 是否空闲 (canPlace)，放置后标记占用 (occupyFootprint)，
//       删除设备时释放 (releaseFootprint，T1.9 用，本会话建好接口备用)。
//
// 数据结构 (A2 §7.1 / §3.3): Phase 1 用全局 Map<"gx,gy", definitionId>。
//   key 格式 "gx,gy"（字符串拼接，比对象 key 省内存且 Map 查找 O(1)）。
//   Phase 3a Chunk 化后，占用表改为按 Chunk 存储 (A2 §3.2 已预留职责)，
//   但本类的对外接口 (occupy/isOccupied/canPlace/release) 不变——调用方无感。
//
// 边界来源 (A11 WV-003 §4.4，T1.6 接口预留): canPlace 的世界范围检查读 MapInstance 的
//   widthCells/heightCells，**不读全局常量**。这样 Phase 3a 把世界换成 Chunk 化、或
//   加载不同尺寸地图时，只需替换传入的 MapInstance，占用表自动适配新边界。

import type { MapInstance } from './MapInstance';
import type { BuildingDefinition } from '../data/buildings';
import { effectiveFootprint } from '../data/buildings';
import type { Direction } from '../components/BuildingComp';

/**
 * 占用表。不进 ECS（它是 WorldData 持有的世界结构，不是 Component）。
 *
 * 一个 OccupancyMap 实例对应一张地图（一个 MapInstance）。占用记录的是
 * "哪个 Cell 被哪个 building 的哪个朝向占用"——存 definitionId 便于调试/查询。
 * 朝向影响占用区域: T2.17 起非正方形占地 90°/270° 旋转宽高互换（effectiveFootprint，
 * 3×1 仓库口 ↔ 1×3），occupy/releaseFootprint 按 direction 取有效占地。
 */
export class OccupancyMap {
  /** key "gx,gy" → building definitionId。null 不进表（未占用）。 */
  private readonly grid = new Map<string, string>();
  /** 地图实例，提供世界边界（widthCells/heightCells）供 canPlace 边界检查。 */
  private readonly map: MapInstance;

  constructor(map: MapInstance) {
    this.map = map;
  }

  /** Cell 是否在地图边界内 [0,widthCells)×[0,heightCells)。Phase 3a 无限世界后此语义变更。 */
  private inBounds(gx: number, gy: number): boolean {
    return gx >= 0 && gy >= 0 && gx < this.map.widthCells && gy < this.map.heightCells;
  }

  /** map key 拼接。 */
  private key(gx: number, gy: number): string {
    return `${gx},${gy}`;
  }

  /** 该 Cell 是否已被占用。 */
  isOccupied(gx: number, gy: number): boolean {
    return this.grid.has(this.key(gx, gy));
  }

  /** 该 Cell 的占用者 (building definitionId)，未占用返回 null。 */
  getOccupant(gx: number, gy: number): string | null {
    return this.grid.get(this.key(gx, gy)) ?? null;
  }

  /** 标记单个 Cell 被指定 building 占用。若已被占用则覆盖（调用方应先 canPlace 检查）。 */
  occupy(gx: number, gy: number, defId: string): void {
    this.grid.set(this.key(gx, gy), defId);
  }

  /** 释放单个 Cell 的占用。未占用则无操作（幂等）。 */
  release(gx: number, gy: number): void {
    this.grid.delete(this.key(gx, gy));
  }

  /**
   * 检查从 (gx,gy) 起、尺寸 w×h 的 footprint 区域是否**全部可放置**:
   *   (1) 区域内每个 Cell 都在地图边界内；
   *   (2) 区域内每个 Cell 当前都未被占用。
   * 任一不满足返回 false。A2 §7.2 多 Cell 建筑的 footprint 占用检查。
   *
   * @param gx footprint 左上角 Cell 的 gridX
   * @param gy footprint 左上角 Cell 的 gridY
   * @param w  footprint 宽 (Cell)
   * @param h  footprint 高 (Cell)
   */
  canPlace(gx: number, gy: number, w: number, h: number): boolean {
    // 先做边界整体判断（footprint 右下角 Cell 是否在界内），避免逐格 inBounds 短路顺序问题
    if (!this.inBounds(gx, gy)) return false;
    if (!this.inBounds(gx + w - 1, gy + h - 1)) return false;
    // 逐格检查占用
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        if (this.grid.has(this.key(gx + dx, gy + dy))) return false;
      }
    }
    return true;
  }

  /**
   * 占用一个 building 的整个 footprint 区域（便利方法）。
   * 调用前应由调用方先 canPlace 确认可放；本方法不做检查直接占用（信任调用方）。
   *
   * @param gx        footprint 左上角 Cell 的 gridX
   * @param gy        footprint 左上角 Cell 的 gridY
   * @param def       建筑定义（取 footprint.w/h 和 id）
   * @param direction 朝向（T2.17: 90°/270° 时非正方形占地宽高互换，见 effectiveFootprint）
   */
  occupyFootprint(
    gx: number,
    gy: number,
    def: BuildingDefinition,
    direction: Direction,
  ): void {
    const { w, h } = effectiveFootprint(def.footprint, direction);
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        this.occupy(gx + dx, gy + dy, def.id);
      }
    }
  }

  /**
   * 释放一个 building 的整个 footprint 区域（便利方法）。
   * T1.9 删除设备时用，本会话建好接口备用。幂等：未占用的 Cell 释放无操作。
   * 与 occupyFootprint 同一套有效占地计算，方向必须与放置时一致。
   */
  releaseFootprint(
    gx: number,
    gy: number,
    def: BuildingDefinition,
    direction: Direction,
  ): void {
    const { w, h } = effectiveFootprint(def.footprint, direction);
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        this.release(gx + dx, gy + dy);
      }
    }
  }

  /** 清空所有占用记录（重置/切图用）。 */
  clear(): void {
    this.grid.clear();
  }

  /** 当前已占用的 Cell 总数（调试/验收用）。 */
  get occupiedCount(): number {
    return this.grid.size;
  }

  /**
   * 返回所有已占用记录的快照（调试/验收用）。
   * @returns 数组，每项 { gx, gy, defId }
   */
  snapshot(): Array<{ gx: number; gy: number; defId: string }> {
    const result: Array<{ gx: number; gy: number; defId: string }> = [];
    for (const [k, defId] of this.grid) {
      const comma = k.indexOf(',');
      result.push({ gx: Number(k.slice(0, comma)), gy: Number(k.slice(comma + 1)), defId });
    }
    return result;
  }
}
