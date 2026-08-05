// 传送带 pointer 流动渲染器 — T2.0 阶段1（回退版：每段独立 sprite + 端点 alpha 渐变滑入/滑出）
// 移植自旧 Flutter 项目 transport_belt_renderer.dart 的 drawItemAt（直段线性 + 转角圆弧）。
//
// 职责:
//   - 每帧查询所有 Position+BeltSegmentComp 实体，为每段维护一个 pointer Sprite。
//   - 每段独立循环相位（globalPhase 同步，2 秒一格）。
//   - 直段：沿方向轴线性移动；链首/链尾格移动范围扩展半个箭头（滑入/滑出），
//     越界部分 alpha 渐变淡出，形成"箭头从传送带外移动进入/移动出去"的平滑效果。
//   - 转角段：沿四分之一圆弧移动，端点格做 alpha 渐变。
//   - 阶段1 无物品，pointer 始终显示（T2.1 物品出现后会隐藏）。
//
// pointer 纹理：devices 图集的 pointer.png（来自 pointer.svg，9.4×21.3，纵向，默认箭头朝上）。
// 挂 layer3Item（物品层），盖在传送带带身（layer2Building）之上。

import { Sprite, Texture, type Container } from 'pixi.js';
import type { World, EntityHandle } from '../ECS';
import type { Position } from '../components/Position';
import type { BeltSegmentComp } from '../components/BeltSegmentComp';
import type { Direction } from '../components/BuildingComp';
import type { TextureLookup } from '../systems/RenderSystem';
import { CELL_SIZE } from './constants';
import { turnInfoFromDirections } from '../systems/belt/BeltPathGeometry';

/** pointer 一个完整循环的时间（毫秒）= 走过一格。与 T2.1 的 40-tick/2s 模型一致。 */
const POINTER_CYCLE_MS = 2000;
/** pointer 在格内的视觉尺寸（相对 CELL_SIZE）。与旧项目 cellSize*0.25 一致（按 pointer 高度）。 */
const POINTER_SIZE_RATIO = 0.25;

/** 方向 → 序号：up=0, right=1, down=2, left=3（与旧项目 _directionToIndex 一致）。 */
function directionToIndex(dir: Direction): number {
  switch (dir) {
    case 270: return 0; // up
    case 0:   return 1; // right
    case 90:  return 2; // down
    case 180: return 3; // left
  }
}

/** 方向对应的角度（弧度），right=0, down=π/2, left=π, up=3π/2。 */
function directionAngle(dir: Direction): number {
  switch (dir) {
    case 0:   return 0;
    case 90:  return Math.PI / 2;
    case 180: return Math.PI;
    case 270: return (3 * Math.PI) / 2;
  }
}

/** 单个 pointer Sprite 的运行时状态。 */
interface PointerEntry {
  sprite: Sprite;
  handle: EntityHandle;
}

/**
 * 传送带 pointer 渲染器。
 *
 * 用法：在主循环每帧调用 update(elapsedMS, cameraVisibleBounds?)。
 * elapsedMS 由调用方累积（从游戏开始的总毫秒数）。
 */
export class BeltPointerRenderer {
  private world: World;
  private layer: Container;
  private getTexture: TextureLookup;
  /** 指针纹理（devices 图集的 pointer）。懒解析：assets 在 Game 构造之后才加载完，
   *  故不能在构造时取（那时还是 EMPTY）；首次 update 时解析并缓存。 */
  private pointerTex: Texture | null = null;
  /** 指针按高度的基准缩放（使 pointer 高度 = CELL_SIZE * POINTER_SIZE_RATIO）。 */
  private pointerScale = 1;

  /** handle → entry 映射，用于 diff。 */
  private entries = new Map<EntityHandle, PointerEntry>();

  constructor(world: World, layer: Container, getTexture: TextureLookup) {
    this.world = world;
    this.layer = layer;
    this.getTexture = getTexture;
  }

  /**
   * 懒解析 pointer 纹理。assets 在 Game 构造之后才 loadAllAssets 完成，
   * 构造时取会拿到 undefined → EMPTY。首次有传送带段时解析并缓存。
   * @returns 纹理已就绪返回 true。
   */
  private resolveTexture(): boolean {
    if (this.pointerTex) return true;
    const tex = this.getTexture('devices', 'pointer');
    if (!tex || tex.width <= 1) return false; // 仍未加载
    this.pointerTex = tex;
    if (tex.height > 0) {
      this.pointerScale = (CELL_SIZE * POINTER_SIZE_RATIO) / tex.height;
    }
    return true;
  }

  /**
   * 每帧更新所有 pointer 的位置与朝向。
   * @param elapsedMS 从游戏开始累积的总毫秒数。
   */
  update(elapsedMS: number): void {
    const visible = this.world.query('Position', 'BeltSegmentComp');
    const seen = new Set<EntityHandle>(visible);

    // 1. 销毁消失实体对应的 pointer
    for (const [handle, entry] of this.entries) {
      if (!seen.has(handle)) {
        entry.sprite.removeFromParent();
        entry.sprite.destroy();
        this.entries.delete(handle);
      }
    }

    // 无传送带段时直接返回（也避免无谓的纹理解析）
    if (visible.length === 0) return;

    // 懒解析纹理：assets 在 Game 构造之后才加载完，首次有传送带段时取真实纹理。
    if (!this.resolveTexture()) return;

    // 2. 全局相位（0~1，2 秒一循环）
    const globalPhase = (elapsedMS % POINTER_CYCLE_MS) / POINTER_CYCLE_MS;

    // 3. 新增 + 同步
    for (const handle of visible) {
      let entry = this.entries.get(handle);
      if (!entry) {
        const sprite = new Sprite(this.pointerTex!);
        sprite.anchor.set(0.5);
        sprite.scale.set(this.pointerScale);
        this.layer.addChild(sprite);
        entry = { sprite, handle };
        this.entries.set(handle, entry);
      }

      const seg = this.world.getComponent<BeltSegmentComp>(handle, 'BeltSegmentComp')!;
      const pos = this.world.getComponent<Position>(handle, 'Position')!;
      // 格中心世界坐标
      const cx = pos.x + CELL_SIZE / 2;
      const cy = pos.y + CELL_SIZE / 2;

      // 全段统一相位：与旧项目一致，同一时刻所有段用相同的 arrowProgress，
      // 使 pointer 像自动扶梯一样均匀分布、连续流动（无重叠/跳变）。
      const { x, y, rotation, alpha } = this.computePointerTransform(seg, globalPhase);
      entry.sprite.position.set(cx + x, cy + y);
      entry.sprite.rotation = rotation;
      entry.sprite.alpha = alpha;
      // T2.0 阶段1 无物品，pointer 始终可见（端点滑入/滑出时 alpha 渐变淡入淡出）
      entry.sprite.visible = true;
    }
  }

  /**
   * 计算指针在格内的偏移、朝向与透明度。
   * 端点格（链首/链尾）的指针允许越过传送带物理边界滑动（滑入/滑出），
   * 越界部分用 alpha 渐变淡出，实现"箭头从传送带外移动进入/移动出去"的平滑效果。
   * @returns 相对格中心的 (x, y) 偏移（世界像素）+ 旋转角（弧度）+ alpha。
   */
  private computePointerTransform(
    seg: BeltSegmentComp,
    phase: number,
  ): { x: number; y: number; rotation: number; alpha: number } {
    if (seg.isCorner && seg.entryDir !== undefined) {
      // 转角格：指针沿圆弧走，端点就在格子边缘上，无需额外扩展；
      // 但链首/链尾的端点做 alpha 渐变（滑入/滑出时淡入淡出）。
      const t = this.computeCornerTransform(seg.entryDir, seg.direction, phase);
      return { ...t, alpha: this.computeEndpointAlpha(seg, phase) };
    }
    return this.computeStraightTransform(seg, phase);
  }

  /**
   * 直段 pointer：沿方向轴线性移动，箭头指向 dir（与物品流向一致）。
   * 链首/链尾格把移动范围扩展半个箭头（0.125 格），使箭头能滑出传送带边界；
   * 越界部分 alpha 从 1 渐变到 0，形成"从传送带外滑入 / 滑出传送带外"的效果。
   */
  private computeStraightTransform(
    seg: BeltSegmentComp,
    phase: number,
  ): { x: number; y: number; rotation: number; alpha: number } {
    const rotation = directionToIndex(seg.direction) * (Math.PI / 2);
    // 移动范围（相对格中心，单位=格）：中间格 [-0.5, +0.5]
    // 链首格入口端多滑出 HALF_PTR，链尾格出口端多滑出 HALF_PTR
    const HALF_PTR = POINTER_SIZE_RATIO / 2; // 0.125
    const isHead = seg.incomingDirection !== undefined;
    const isTail = seg.isTail;
    let minMove = -0.5;
    let maxMove = 0.5;
    if (isHead) minMove -= HALF_PTR;
    if (isTail) maxMove += HALF_PTR;
    const moveRatio = minMove + phase * (maxMove - minMove);
    // 越界部分 alpha 渐变：|moveRatio| > 0.5 时从 1 渐降到 0
    let alpha = 1;
    if (moveRatio < -0.5) {
      alpha = Math.max(0, 1 - (-0.5 - moveRatio) / HALF_PTR);
    } else if (moveRatio > 0.5) {
      alpha = Math.max(0, 1 - (moveRatio - 0.5) / HALF_PTR);
    }
    const moveDist = moveRatio * CELL_SIZE;
    const dirRad = directionAngle(seg.direction);
    const dvx = Math.cos(dirRad);
    const dvy = Math.sin(dirRad);
    return {
      x: dvx * moveDist,
      y: dvy * moveDist,
      rotation,
      alpha,
    };
  }

  /**
   * 转角格的端点 alpha 渐变：
   *  - 链首转角：phase 0→HALF_PTR 时从 0 渐入（箭头沿圆弧滑入传送带）
   *  - 链尾转角：phase 1−HALF_PTR→1 时渐出（箭头滑出传送带）
   */
  private computeEndpointAlpha(seg: BeltSegmentComp, phase: number): number {
    const isHead = seg.incomingDirection !== undefined;
    const isTail = seg.isTail;
    const HALF_PTR = POINTER_SIZE_RATIO / 2;
    if (isHead && isTail) {
      // 单格转角链：两头都渐变
      return Math.min(
        Math.min(1, phase / HALF_PTR),
        Math.min(1, (1 - phase) / HALF_PTR),
      );
    }
    if (isHead) {
      return Math.min(1, phase / HALF_PTR);
    }
    if (isTail) {
      return Math.min(1, (1 - phase) / HALF_PTR);
    }
    return 1;
  }

  /**
   * 转角段 pointer：沿四分之一圆弧移动。
   * 移植自旧项目 drawItemAt 转角分支。
   */
  private computeCornerTransform(
    incomingDir: Direction,
    outgoingDir: Direction,
    phase: number,
  ): { x: number; y: number; rotation: number } {
    const info = turnInfoFromDirections(incomingDir, outgoingDir);
    // 进入边的边缘向量（相对格中心，单位=半格 0.5）
    // 旧项目：inDir 'up'→eY=0.5, 'down'→eY=-0.5, 'left'→eX=0.5, 'right'→eX=-0.5
    let eX = 0, eY = 0;
    if (incomingDir === 270) eY = 0.5;       // up
    else if (incomingDir === 90) eY = -0.5;  // down
    else if (incomingDir === 180) eX = 0.5;  // left
    else if (incomingDir === 0) eX = -0.5;   // right
    // 出口边的边缘向量
    let xX = 0, xY = 0;
    if (outgoingDir === 270) xY = -0.5;      // up
    else if (outgoingDir === 90) xY = 0.5;   // down
    else if (outgoingDir === 180) xX = -0.5; // left
    else if (outgoingDir === 0) xX = 0.5;    // right
    // 圆心（pivot）= 两边缘向量之和
    const pivotX = eX + xX;
    const pivotY = eY + xY;
    // 起始切向 = -出口边向量（指向格内）
    const startVecX = -xX;
    const startVecY = -xY;
    const startAngle = Math.atan2(startVecY, startVecX);
    const deltaAngle = info.isCCW ? -Math.PI / 2 : Math.PI / 2;
    const currentAngle = startAngle + phase * deltaAngle;
    // pointer 位置（单位=格，再乘 CELL_SIZE 转世界像素）
    const px = pivotX + 0.5 * Math.cos(currentAngle);
    const py = pivotY + 0.5 * Math.sin(currentAngle);
    // pointer 朝向 = 切线方向 + π/2（旧项目：tangentAngle + π/2，因 pointer 默认朝上）
    const tangentAngle = currentAngle + deltaAngle;
    const rotation = tangentAngle + Math.PI / 2;
    return {
      x: px * CELL_SIZE,
      y: py * CELL_SIZE,
      rotation,
    };
  }

  /** 销毁所有 pointer Sprite。 */
  destroy(): void {
    for (const entry of this.entries.values()) {
      entry.sprite.removeFromParent();
      entry.sprite.destroy();
    }
    this.entries.clear();
  }
}