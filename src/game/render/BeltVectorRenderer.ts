// 传送带带身矢量渲染器 — T2.0 方案A
//
// 职责：用 PixiJS Graphics 矢量绘制传送带带身（直段/转角），替代原来的位图 Sprite。
// 背景：位图 Sprite 缩小（zoom≈0.25）时 GPU 双线性采样把纹理透明边距插值成半透明渐变，
// 相邻格叠加 → 格子边界"接缝/灰线"。矢量 Graphics 任意缩放边缘精确 → 无缝。
//
// 设计：
//  - 每帧查询 Position+BeltSegmentComp 实体，diff 维护每段一个 Graphics（挂 layer2Building）。
//  - 形状只画一次（直段/转角由 beltTextureRotation / beltCornerTransform 定位朝向与镜像），
//    仅在段的方向/转角状态变化时重绘（避免每帧 clear 的开销）。
//  - 位置每帧同步到格中心；rotation/scale 每帧按当前 seg 设置（isTail 延长翻转时 seg 会变）。
//
// 与 BeltPointerRenderer 的关系：pointer 是"流动箭头"（layer3Item），本渲染器是"带身"（layer2Building），
// 两者叠加 = 完整传送带视觉。RenderSystem 不再为传送带实体创建 Sprite（见 RenderSystem.update 跳过逻辑）。

import { Graphics, type Container } from 'pixi.js';
import type { World, EntityHandle } from '../ECS';
import type { Position } from '../components/Position';
import type { BeltSegmentComp } from '../components/BeltSegmentComp';
import { beltTextureRotation, beltCornerTransform } from '../systems/belt/BeltPathGeometry';
import type { BeltSelection } from '../systems/belt/BeltSelection';
import { CELL_SIZE } from './constants';
import {
  drawStraightBelt,
  drawCornerBelt,
  drawStraightBeltSelectionUnderlay,
  drawCornerBeltSelectionBorder,
} from './BeltVectorGeometry';

/** 单个传送带段的渲染态。 */
interface VectorEntry {
  g: Graphics;
  /** 方向/转角签名；变化时重绘形状。 */
  lastKey: string;
  handle: EntityHandle;
}

/** 由 seg 生成形状签名（直段/转角/方向/镜像任一变化都要重绘）。 */
function segShapeKey(seg: BeltSegmentComp): string {
  return `${seg.isCorner}|${seg.direction}|${seg.entryDir}|${seg.mirrorH}`;
}

/**
 * 传送带带身矢量渲染器。
 *
 * 用法：主循环每帧调用 update()。构造时传入 layer2Building 作为挂载层。
 */
export class BeltVectorRenderer {
  private world: World;
  private layer: Container;
  /** 选中态（SelectionSystem 写）；选中段在 body 上叠白边。由 RenderSystem 注入。 */
  private beltSelection: BeltSelection | null = null;

  /** handle → entry，用于 diff。 */
  private entries = new Map<EntityHandle, VectorEntry>();

  constructor(world: World, layer: Container) {
    this.world = world;
    this.layer = layer;
  }

  /** 注入选中态（由 RenderSystem.setBeltSelection 转发）。 */
  setBeltSelection(bs: BeltSelection): void {
    this.beltSelection = bs;
  }

  /** 每帧同步所有传送带段的矢量带身。 */
  update(): void {
    const visible = this.world.query('Position', 'BeltSegmentComp');
    const seen = new Set<EntityHandle>(visible);

    // 1. 销毁消失实体的 Graphics
    for (const [handle, entry] of this.entries) {
      if (!seen.has(handle)) {
        entry.g.removeFromParent();
        entry.g.destroy();
        this.entries.delete(handle);
      }
    }

    if (visible.length === 0) return;

    // 2. 新增 + 同步
    for (const handle of visible) {
      const seg = this.world.getComponent<BeltSegmentComp>(handle, 'BeltSegmentComp')!;
      const pos = this.world.getComponent<Position>(handle, 'Position')!;

      let entry = this.entries.get(handle);
      if (!entry) {
        const g = new Graphics();
        this.layer.addChild(g);
        entry = { g, lastKey: '', handle };
        this.entries.set(handle, entry);
      }

      // 位置：格中心（矢量几何以格子中心为原点）
      entry.g.position.set(pos.x + CELL_SIZE / 2, pos.y + CELL_SIZE / 2);

      // 朝向：与 RenderSystem 原 Sprite 逻辑一致
      if (seg.isCorner && seg.entryDir !== undefined) {
        const t = beltCornerTransform(seg.entryDir, seg.direction);
        entry.g.rotation = t.rotation;
        entry.g.scale.set(t.mirrorH ? -1 : 1, 1);
      } else {
        entry.g.rotation = beltTextureRotation(seg.direction);
        entry.g.scale.set(1, 1);
      }

      // 形状重绘（方向/转角/选中态变化时）
      const selected = this.beltSelection?.has(handle) ?? false;
      const key = segShapeKey(seg) + (selected ? '|sel' : '');
      if (entry.lastKey !== key) {
        entry.g.clear();
        if (seg.isCorner) {
          drawCornerBelt(entry.g, CELL_SIZE);
          if (selected) drawCornerBeltSelectionBorder(entry.g, CELL_SIZE); // 白边描边（带身之后）
        } else {
          if (selected) drawStraightBeltSelectionUnderlay(entry.g, CELL_SIZE); // 白底（灰壳之前）
          drawStraightBelt(entry.g, CELL_SIZE);
        }
        entry.lastKey = key;
      }
    }
  }

  /** 销毁所有带身 Graphics。 */
  destroy(): void {
    for (const entry of this.entries.values()) {
      entry.g.removeFromParent();
      entry.g.destroy();
    }
    this.entries.clear();
  }
}
