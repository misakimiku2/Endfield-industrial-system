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
import { GameLoop } from './GameLoop';
import { BeltSystem } from './systems/BeltSystem';
import { SIM_STEP_MS } from './render/constants';
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
  /** 仿真主循环（A5 §2 双时钟，T2.1 起驱动 BeltSystem 等逻辑系统）。 */
  readonly gameLoop: GameLoop;
  /** 传送带物品移动系统（T2.1）。 */
  readonly beltSystem: BeltSystem;

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
      this.world, this.occupancy, this.camera, scene.layers,
    );
    // 仿真循环 + 系统（T2.1 起）：BeltSystem 先于未来的 MachineSystem 注册（A5 §5/DD-010）。
    this.beltSystem = new BeltSystem();
    this.gameLoop = new GameLoop(this.world);
    this.gameLoop.addSystem(this.beltSystem);
  }

  /**
   * 推进仿真（A5 §2 双时钟）。每渲染帧由主循环调用，累积时间跑整数个 20TPS Tick。
   * 必须在 update()（渲染）之前调用，保证 RenderSystem 读到最新 Tick 快照（A5 §1.1）。
   * 暂停时（gameLoop.paused）Tick 停止，渲染继续（相机可操作）。
   * @param deltaMS 自上一帧的毫秒数（来自 Pixi ticker）。
   */
  tickSimulation(deltaMS: number): void {
    this.gameLoop.update(deltaMS);
  }

  /**
   * 每帧驱动各 System。
   * 注意: PlacementSystem.update 需要 deltaMS，由 main 主循环单独调用并传入；
   *       RenderSystem 在此处更新（实体↔Sprite 同步 + 视口剔除 + 传送带 pointer 流动）。
   * @param deltaMS 自上一帧的毫秒数（来自 Pixi ticker），传入 RenderSystem 累积 pointer 相位。
   */
  update(deltaMS = 0): void {
    // alpha = 仿真周期插值系数（accumulator/SIM_STEP，0~1），供 BeltItemRenderer 帧间插值（消除物品 20TPS 卡顿）
    const alpha = this.gameLoop.accumulator / SIM_STEP_MS;
    this.renderSystem.update(deltaMS, alpha);
  }
}
