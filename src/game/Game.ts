// 游戏主控制器 — Phase 1 实现
// 依据: implementation-phase-1.md T1.6 / T1.7、A1 ecs-spec.md (World)、A11 WV-003 §4.4 (MapInstance)
//
// Game 是 Phase 1 的最小编排器: 持有 ECS World、世界数据（含 MapInstance）、
// 相机与各 System。main.ts 实例化 Game 后，在主循环里调用 update() 驱动各 System。
//
// 世界尺寸: 通过 worldData.map（MapInstance）传给 Camera 作为边界来源 (A11 WV-003 §4.4)，
// 不再读全局常量。OccupancyMap 也从同一 MapInstance 取边界（T1.7）。

import { World } from './ECS';
import { WorldData } from './world/World';
import { OccupancyMap } from './world/OccupancyMap';
import { Camera, type ViewportSize } from './render/Camera';
import type { SceneRenderer } from './render/SceneRenderer';
import { RenderSystem } from './systems/RenderSystem';
import { PlacementSystem } from './systems/PlacementSystem';
import { BeltCreationSystem } from './systems/BeltCreationSystem';
import { getTexture } from './render/AssetsLoader';

export class Game {
  readonly world: World;
  readonly worldData: WorldData;
  readonly camera: Camera;
  readonly renderSystem: RenderSystem;
  /** 占用表（设备放置/删除用，A2 §7）。边界读 worldData.map（A11 WV-003 §4.4）。 */
  readonly occupancy: OccupancyMap;
  /** 放置系统（T1.7）。输入由 main.ts 转发，update 由主循环调用。 */
  readonly placement: PlacementSystem;
  /** 传送带创建系统（T2.0 阶段 1）。 */
  readonly beltCreation: BeltCreationSystem;

  constructor(scene: SceneRenderer, viewport: ViewportSize) {
    this.world = new World();
    this.worldData = new WorldData();
    // 世界边界取自 MapInstance（A11 WV-003 §4.4）
    this.camera = new Camera(viewport, {
      widthPx: this.worldData.map.widthPx,
      heightPx: this.worldData.map.heightPx,
    });
    this.renderSystem = new RenderSystem(this.world, scene.layers, this.camera, getTexture);
    // 占用表 + 放置系统（T1.7）。占用表边界读 worldData.map，不读全局常量。
    this.occupancy = new OccupancyMap(this.worldData.map);
    this.placement = new PlacementSystem(
      this.world, this.occupancy, this.camera, scene.layers, getTexture,
    );
    this.beltCreation = new BeltCreationSystem(
      this.world, this.occupancy, this.camera, scene.layers, getTexture,
    );
  }

  /**
   * 每帧驱动各 System。
   * 注意: PlacementSystem.update 需要 deltaMS，由 main 主循环单独调用并传入；
   *       RenderSystem 在此处更新（实体↔Sprite 同步 + 视口剔除 + 传送带 pointer 流动）。
   * @param deltaMS 自上一帧的毫秒数（来自 Pixi ticker），传入 RenderSystem 累积 pointer 相位。
   */
  update(deltaMS = 0): void {
    this.renderSystem.update(deltaMS);
  }
}
