// 删除系统 — 删除已放置的设备（T1.9）
// 依据: implementation-phase-1.md T1.9、A2 world-model.md §7 (占用表)、A1 §4.3 (destroyEntity)
//
// 删除是放置的逆操作（A3 §5 逆）:
//   1. OccupancyMap.releaseFootprint — 释放 footprint 内所有 Cell（幂等）
//   2. world.destroyEntity(handle) — 销毁实体；RenderSystem 每帧 diff query，
//      下一帧自动移除对应 Sprite（T1.6 已实现，无需手动清理 PixiJS 对象）
//   3. 选中态清空由调用方（main.ts）在删除成功后调 selection.clearSelection()
//
// 交互约定（T1.9）: 删除统一走 Delete 键，不用右键——右键语义专留给
//   T1.7 取消放置模式，两套语义不重叠。
//
// 幂等/防御: null handle、已销毁实体、缺 BuildingComp/Position、未知 definitionId
//   → 返回 false 且无任何副作用。

import type { World, EntityHandle } from '../ECS';
import type { OccupancyMap } from '../world/OccupancyMap';
import type { BuildingComp } from '../components/BuildingComp';
import type { Position } from '../components/Position';
import { getBuildingDefinition } from '../data/buildings';
import { CELL_SIZE } from '../render/constants';

/**
 * 删除系统。
 *
 * 输入由 main.ts 转发（window keydown Delete）:
 *   - deleteBuilding(handle): 销毁设备 + 释放占用
 */
export class DeleteSystem {
  private world: World;
  private occupancy: OccupancyMap;

  constructor(world: World, occupancy: OccupancyMap) {
    this.world = world;
    this.occupancy = occupancy;
  }

  /**
   * 删除指定设备（销毁实体 + 释放 footprint 占用）。
   *
   * @param handle 设备 handle；null / 已销毁 / 无 BuildingComp / 未知定义 → false（无副作用）
   * @returns true = 删除成功
   */
  deleteBuilding(handle: EntityHandle | null): boolean {
    if (handle === null) return false;
    if (!this.world.isAlive(handle)) return false;

    const building = this.world.getComponent<BuildingComp>(handle, 'BuildingComp');
    if (!building) return false; // 非设备实体（如 T1.6 测试 Sprite）不可删
    const pos = this.world.getComponent<Position>(handle, 'Position');
    if (!pos) return false;
    const def = getBuildingDefinition(building.definitionId);
    if (!def) return false; // 定义缺失时不可信释放占用，拒绝删除

    // 世界像素 → grid。Position 左上角必然落在 CELL_SIZE 整数倍（A2 §2.3 网格吸附），
    // 相除结果一定是整数；用 round 防御浮点误差。
    const gx = Math.round(pos.x / CELL_SIZE);
    const gy = Math.round(pos.y / CELL_SIZE);

    // 1. 释放 footprint 全部 Cell（幂等，未占用 Cell 无操作）
    this.occupancy.releaseFootprint(gx, gy, def, building.direction);
    // 2. 销毁实体 → RenderSystem 下一帧自动移除 Sprite（T1.6 query diff）
    this.world.destroyEntity(handle);
    return true;
  }
}
