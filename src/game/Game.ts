// 游戏主控制器 — Phase 1 实现
// 依据: implementation-phase-1.md T1.6、A1 ecs-spec.md (World)、A11 WV-003 §4.4 (MapInstance)
//
// Game 是 Phase 1 的最小编排器: 持有 ECS World、世界数据（含 MapInstance）、
// 相机与各 System。main.ts 实例化 Game 后，在主循环里调用 update() 驱动各 System。
//
// 世界尺寸: 通过 worldData.map（MapInstance）传给 Camera 作为边界来源 (A11 WV-003 §4.4)，
// 不再读全局常量。

import { World } from './ECS';
import { WorldData } from './world/World';
import { Camera, type ViewportSize } from './render/Camera';
import type { SceneRenderer } from './render/SceneRenderer';
import { RenderSystem } from './systems/RenderSystem';
import { getTexture } from './render/AssetsLoader';

export class Game {
  readonly world: World;
  readonly worldData: WorldData;
  readonly camera: Camera;
  readonly renderSystem: RenderSystem;

  constructor(scene: SceneRenderer, viewport: ViewportSize) {
    this.world = new World();
    this.worldData = new WorldData();
    // 世界边界取自 MapInstance（A11 WV-003 §4.4）
    this.camera = new Camera(viewport, {
      widthPx: this.worldData.map.widthPx,
      heightPx: this.worldData.map.heightPx,
    });
    this.renderSystem = new RenderSystem(this.world, scene.layers, this.camera, getTexture);
  }

  /** 每帧驱动各 System（不含相机变换，那由 main 的主循环直接调 camera.update/updateTransform）。 */
  update(): void {
    this.renderSystem.update();
  }
}
