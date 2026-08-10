// 场景渲染器 — 搭建 PixiJS 场景图层结构
// 依据: A2 world-model.md §4 (7 层层级模型)、§5 (视觉风格)
//
// 层级结构 (A2 §4 + §5.4 渲染顺序，从底到顶):
//   stage
//   ├─ backgroundLayer   [屏幕空间] 网格背景底色 + 网格线 (T1.4 GridRenderer)
//   ├─ worldContainer    [世界空间] 受相机变换
//   │   ├─ layer0Terrain   (地形瓦片/矿脉，T1.4 之后为空，背景已移到屏幕层)
//   │   ├─ layer1Grid      (留空; 网格线在 backgroundLayer 屏幕空间渲染)
//   │   ├─ layer4Enemy     (敌人实体)
//   │   ├─ layer5Effect    (子弹/粒子/伤害数字)
//   │   ├─ layer2Building  (已放置的建筑/传送带 —— 渲染在最高层，盖住网格线等下层内容)
//   │   └─ layer3Item      (传送带上的物品/掉落物/pointer —— 在建筑之上，pointer 盖在带身上)
//   └─ overlayLayer      [屏幕空间] UIOverlay (选中框) + 暗角 (T1.4 GridRenderer)
//
// 说明: 网格背景与网格线在屏幕空间渲染(每帧按相机可见范围重绘)，而非世界空间，
//       这样网格线密度恒定、只画可见范围、像素对齐无模糊。建筑/物品/敌人在世界空间
//       (worldContainer 内)随相机平移缩放。

import { Application, Container } from 'pixi.js';

/** A2 §4 定义的渲染层（从底到顶），供 RenderSystem/交互系统引用。 */
export interface SceneLayers {
  /** [屏幕空间] 网格背景 + 网格线，在 worldContainer 之下。 */
  backgroundLayer: Container;
  /** [世界空间] 受相机变换支配的容器。 */
  worldContainer: Container;
  layer0Terrain: Container;
  layer1Grid: Container;
  layer2Building: Container;
  layer3Item: Container;
  layer4Enemy: Container;
  layer5Effect: Container;
  /** [屏幕空间] UIOverlay (选中框) + 暗角。 */
  overlayLayer: Container;
}

export class SceneRenderer {
  readonly layers: SceneLayers;

  constructor(private app: Application) {
    // ── 屏幕空间背景层 (在 worldContainer 之下) ──
    const backgroundLayer = new Container({ label: 'backgroundLayer' });

    // ── 受相机变换的世界容器 ──
    const worldContainer = new Container({ label: 'worldContainer' });

    // A2 §4 的 0~5 层。sortableChildren 开启以便后续用 zIndex。
    const layer0Terrain = new Container({ label: 'terrain', sortableChildren: true });
    const layer1Grid = new Container({ label: 'grid', sortableChildren: true });
    const layer2Building = new Container({ label: 'building', sortableChildren: true });
    const layer3Item = new Container({ label: 'item', sortableChildren: true });
    const layer4Enemy = new Container({ label: 'enemy', sortableChildren: true });
    const layer5Effect = new Container({ label: 'effect', sortableChildren: true });

    worldContainer.addChild(
      layer0Terrain,
      layer1Grid,
      layer4Enemy,
      layer5Effect,
      layer2Building,
      layer3Item,
    );

    // ── 屏幕空间 UIOverlay + 暗角 ──
    const overlayLayer = new Container({ label: 'overlay', sortableChildren: true });

    // 顺序: 背景 → 世界 → overlay (后加的在上面)
    this.app.stage.addChild(backgroundLayer, worldContainer, overlayLayer);

    this.layers = {
      backgroundLayer,
      worldContainer,
      layer0Terrain,
      layer1Grid,
      layer2Building,
      layer3Item,
      layer4Enemy,
      layer5Effect,
      overlayLayer,
    };
  }
}
