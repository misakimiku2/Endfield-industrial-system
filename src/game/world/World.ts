// 世界数据 — Phase 1 实现
// 依据: A2 world-model.md §1~§2、§8、A11 world-vision.md WV-003 §4.4
//
// WorldData 持有当前地图的静态数据（地图实例 / 后续的资源分布等）。
// 世界尺寸（widthPx/heightPx）以 MapInstance 属性的形式提供，不再是全局常量
// （A11 WV-003 §4.4）——相机边界 clamp、占用表都从 worldData.map 读尺寸。

import { MapInstance, createDefaultMap } from './MapInstance';

export class WorldData {
  /** 地图实例（世界尺寸的唯一真相源）。 */
  readonly map: MapInstance;
  // TODO: 地图网格、资源分布（后续 Phase）

  constructor(map?: MapInstance) {
    this.map = map ?? createDefaultMap();
  }
}
