// Sprite 组件 — 实体的渲染描述（纯数据）
// 依据: A1 ecs-spec.md §3 (Component 纯数据)、A2 world-model.md §4 (层级模型)
//
// RenderSystem 读取 Position + SpriteComp，把实体绑定到 PixiJS Sprite。
// 纹理通过 AssetsLoader.getTexture(group, textureKey) 取（DD-013 图集分组）。

import type { AtlasGroup } from '../render/AssetsLoader';

export interface SpriteComp {
  /** 纹理所在图集分组 (devices/items/ui)，决定从哪个 spritesheet 取纹理。 */
  group: AtlasGroup;
  /** 图集内的 texture key（不含 .png 后缀，如 'transport_belt', 'refining_unit'）。 */
  textureKey: string;
  /** 可选： billboard 徽标层 key，叠加在主体上方并保持屏幕朝上（同属 group）。 */
  logoTextureKey?: string;
  /**
   * Sprite 内容世界像素宽（= 0° 朝向 footprint cells × CELL_SIZE）。
   * T2.17: 恒存**未旋转**尺寸——90°/270° 旋转由渲染侧按 direction 转动内容、
   * 以有效占地（effectiveFootprint）中心为锚，本字段不随朝向交换宽高。
   */
  width: number;
  /** Sprite 内容世界像素高（未旋转尺寸，语义同 width）。 */
  height: number;
  /** 渲染层级 (0~5)，对应 SceneLayers 的 layer0~layer5 Container (A2 §4)。 */
  layer: number;
}
