// 传送带物品渲染器 — T2.1
// 依据: A9 logistics-spec.md §2.1/§5.3.2/§5.4.2、implementation-phase-2.md T2.1
//
// 职责:
//   - 每帧查询所有 BeltSegmentComp 实体，为段上每个物品维护一个 Sprite（diff 管理）。
//   - 位置: 直段沿方向轴线性插值 (A9 §5.3.2 getItemWorldPos)；
//            转角沿四分之一圆弧插值 (A9 §5.4.2，数学与 BeltPointerRenderer 同源)。
//   - 物品 Sprite 居中于传送带表面中心线，不随流向旋转（俯视图小图标，始终屏幕朝上）。
//   - 单层渲染（T2.8 用户反馈修订，层级从下到上: 带身→物品→设备→端口高亮→箭头）:
//     所有传送带物品统一挂 belowLayer（layer2Building 内 zIndex=0.5，带身之上、设备之下）——
//     物品在带身上传输，进入设备 footprint 即被设备纹理遮挡（"钻到设备下方"），
//     而非飘在设备 base 层上。
//
// 渲染读快照 (A5 §1.1): 物品 progress 由 BeltSystem 在 Simulation Tick(20TPS) 推进，
//   本渲染器每帧(60FPS)读取最新 progress 画位置，不做帧间插值。0.5 格/秒慢速下
//   每 Tick 仅跳 1.6px，视觉近似连续；如需更平滑可后续把 GameLoop.accumulator 传入插值。
//
// 与 BeltPointerRenderer 的几何关系: 转角圆弧数学等价（pivot = 进入/出口边缘向量之和，
//   半径半格），但本类只需位置不需箭头旋转，故独立实现以避免改动已稳定的 pointer 渲染器。

import { Sprite, Texture, type Container } from 'pixi.js';
import type { World, EntityHandle } from '../ECS';
import type { Position } from '../components/Position';
import type { BeltItem, BeltSegmentComp } from '../components/BeltSegmentComp';
import type { Direction } from '../components/BuildingComp';
import type { TextureLookup } from '../systems/RenderSystem';
import { turnInfoFromDirections, directionVector } from '../systems/belt/BeltPathGeometry';
import { CELL_SIZE } from './constants';

/** 物品视觉边长（世界像素），约占半格。各物品纹理按长边缩放到此尺寸（保持长宽比）。 */
const ITEM_VISUAL_SIZE = CELL_SIZE * 0.5;

/** 方向 → 序号（up=0,right=1,down=2,left=3），直段物品旋转角用（与 pointer computeStraightTransform 一致）。 */
function directionToIndex(dir: Direction): number {
  switch (dir) {
    case 270: return 0;
    case 0:   return 1;
    case 90:  return 2;
    case 180: return 3;
  }
}

/** 单段的物品 Sprite 运行时态。sprites[i] 对应 seg.items[i]。 */
interface SegmentEntry {
  sprites: Sprite[];
}

/**
 * 传送带物品渲染器。
 *
 * 用法：主循环每帧调用 update()。构造时传入 layer3Item 与 getTexture（与 RenderSystem 一致）。
 */
export class BeltItemRenderer {
  private world: World;
  /** 物品统一容器（T2.8: 带身之上、设备之下，所有传送带物品挂此层）。 */
  private belowLayer: Container;
  private getTexture: TextureLookup;
  /** handle → 该段物品 Sprite 列表，用于 diff。 */
  private entries = new Map<EntityHandle, SegmentEntry>();
  /** itemId → Texture 缓存，避免每帧每物品重复 Assets 查找。 */
  private texCache = new Map<string, Texture>();
  /**
   * 物品 → 帧间**内插**状态（2026-09-02 三轮修订: ①修外推过冲回弹 ②修每帧覆盖导致
   * 的 20Hz 跳变 ③修静止物品高频抖动——prevTick 改在 **Tick 边界**（alpha 回卷）推进，
   * 而非"progress 变化"时推进: 旧版物品停住（断头/门口/排队钳制）后 progress 恒定，
   * prevTick 永远停在停止前一 Tick 的位置，renderProgress 随 alpha 0→1 周期性扫动，
   * 表现为停止物品 20Hz 前后微抖（用户实测"整条线高频抖动"）。边界推进后停止物品
   * prevTick==progress，插值区间塌缩为 0，恒静止）。prevTick = 上一 Tick 的逻辑
   * progress（渲染在 prevTick → 本 Tick progress 之间内插，永不超过逻辑位置——
   * 零倒退零过冲）。WeakMap: 物品移除/跨段重建（新对象）自动回收；新物品以
   * progress−delta 起步（跨段前格 1.0 == 新格 0，世界坐标连续）。
   */
  private renderState = new WeakMap<BeltItem, { prevTick: number; lastSeen: number }>();
  /** 上一帧的 alpha。alpha 每 Simulation Tick 回卷变小（accumulator −= SIM_STEP）→ 回卷 = 新 Tick 第一帧。 */
  private lastAlpha = -1;

  constructor(world: World, _layer: Container, belowLayer: Container, getTexture: TextureLookup) {
    this.world = world;
    this.belowLayer = belowLayer;
    this.getTexture = getTexture;
  }

  /**
   * 每帧同步所有传送带段的物品 Sprite（数量/纹理/位置）。
   * @param alpha 当前 Tick 周期的插值系数（accumulator/SIM_STEP，0~1）。物品位置在
   *   **上一 Tick progress → 本 Tick progress** 之间内插（renderProgress = prev +
   *   alpha*(progress−prev)）。2026-09-02 修订: 旧版外推 `progress + alpha*delta` 在
   *   物品被钳制（门口 0.5 / walking 1.5）的前一窗口会画过头（~0.02 格），钳制
   *   Tick（delta=0）瞬间回弹——用户实测"进输入端时先后退一下再前进"。内插渲染
   *   永不超过逻辑位置: 零倒退、零过冲，代价仅一 Tick(50ms) 视觉延迟（1.6px 级，
   *   不可感知）。prevTick 在 **Tick 边界（alpha 回卷）** 推进——静止物品插值区间
   *   塌缩为 0 恒静止（旧版按"progress 变化"推进，停住后 prevTick 滞后一格增量，
   *   静止物品 20Hz 前后微抖）；恢复流动从停点平滑起步。
   */
  update(alpha: number): void {
    // Tick 边界检测: alpha = accumulator/SIM_STEP，每 Simulation Tick 回卷变小。
    // 边界帧把 prevTick 推进到上一 Tick 位置——**无论 progress 是否变化**（静止物品
    // 也要塌缩插值区间，否则 20Hz 扫动微抖，见 renderState 字段注释）。
    const tickBoundary = alpha < this.lastAlpha;
    this.lastAlpha = alpha;

    const visible = this.world.query('BeltSegmentComp');
    const seen = new Set<EntityHandle>(visible);

    // 1. 销毁消失段的全部物品 Sprite
    for (const [handle, entry] of this.entries) {
      if (!seen.has(handle)) {
        for (const s of entry.sprites) {
          s.removeFromParent();
          s.destroy();
        }
        this.entries.delete(handle);
      }
    }

    if (visible.length === 0) return;

    // 2. 同步每段的物品
    for (const handle of visible) {
      const seg = this.world.getComponent<BeltSegmentComp>(handle, 'BeltSegmentComp');
      if (!seg) continue;
      const pos = this.world.getComponent<Position>(handle, 'Position');
      if (!pos) continue;
      const items = seg.items ?? [];
      let entry = this.entries.get(handle);
      if (!entry) {
        entry = { sprites: [] };
        this.entries.set(handle, entry);
      }

      // 2a. 调整 Sprite 数量到 items.length（多了销毁，少了新建）
      const sprites = entry.sprites;
      while (sprites.length > items.length) {
        const s = sprites.pop()!;
        s.removeFromParent();
        s.destroy();
      }
      while (sprites.length < items.length) {
        const s = new Sprite(Texture.EMPTY);
        s.anchor.set(0.5);
        s.rotation = 0; // 初始旋转，每帧由 itemTransform 更新（直段朝流向/转角沿切线）
        this.belowLayer.addChild(s);
        sprites.push(s);
      }

      // 2b. 逐物品同步纹理 + 位置（上一 Tick → 本 Tick 内插，消除 20TPS 逻辑阶跃卡顿）
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const sprite = sprites[i];
        this.bindTexture(sprite, item.itemId);
        let st = this.renderState.get(item);
        if (st === undefined) {
          st = { prevTick: item.progress - (item.delta || 0), lastSeen: item.progress };
          this.renderState.set(item, st);
        } else if (tickBoundary) {
          st.prevTick = st.lastSeen; // 新 Tick: 上一 Tick 位置成为插值起点（静止物品同樣推进→区间塌缩）
          st.lastSeen = item.progress;
        }
        const renderProgress = st.prevTick + alpha * (st.lastSeen - st.prevTick);
        const { x, y, rotation } = this.itemTransform(seg, renderProgress, pos);
        sprite.position.set(x, y);
        sprite.rotation = rotation; // 物品像 pointer 一样旋转（直段朝流向/转角沿切线）
        sprite.visible = true;
        // 物品统一挂 belowLayer（带身之上、设备之下），创建时已挂，无需按 progress 切换
      }
    }
  }

  /** 绑定物品纹理（itemId→Texture 缓存，纹理变化时才重设 scale）。 */
  private bindTexture(sprite: Sprite, itemId: string): void {
    let tex = this.texCache.get(itemId);
    if (!tex) {
      tex = this.getTexture('items', itemId) ?? Texture.EMPTY;
      this.texCache.set(itemId, tex);
    }
    if (sprite.texture !== tex) {
      sprite.texture = tex;
      // 按纹理长边缩放到 ITEM_VISUAL_SIZE（保持长宽比）
      const longSide = Math.max(tex.width, tex.height);
      const scale = longSide > 0 ? ITEM_VISUAL_SIZE / longSide : 1;
      sprite.scale.set(scale);
    }
  }

  /**
   * 计算物品在世界坐标的位置（A9 §5.3.2 / §5.4.2）。
   * @param progress 渲染插值后的 progress（progress + alpha*delta）
   * @returns 世界像素坐标（已居中于传送带表面中心线）。
   * ⚠️ 本方法与 beltItemGeom.ts itemWorldPosOnSegment **逐字同源**（指针 v7 格级
   * 像素互斥依赖它复刻本坐标）。改动任何一侧的约定（progress 起算边/转角延伸），
   * 必须同步另一侧并由 scripts/verify-belt-pointer-exclusivity.ts 一致性断言兜底。
   */
  private itemTransform(
    seg: BeltSegmentComp,
    progress: number,
    pos: Position,
  ): { x: number; y: number; rotation: number } {
    if (seg.isCorner && seg.entryDir !== undefined) {
      // T2.6 修订: 转角供给段的预约物品 progress 可到 1.5（端口格中心）。
      // 弧仅在 0~1 定义，超出部分 = 弧终点（出口边中心）沿出口方向直线延伸。
      const arc = this.cornerOffset(seg.entryDir, seg.direction, Math.min(progress, 1));
      const base = {
        x: pos.x + CELL_SIZE / 2 + arc.x,
        y: pos.y + CELL_SIZE / 2 + arc.y,
        rotation: arc.rotation,
      };
      if (progress <= 1) return base;
      const dv = directionVector(seg.direction);
      const extra = (progress - 1) * CELL_SIZE;
      return { x: base.x + dv.x * extra, y: base.y + dv.y * extra, rotation: base.rotation };
    }
    const s = this.straightWorldPos(pos, seg.direction, progress);
    // 直段物品朝流向旋转（与 pointer computeStraightTransform 一致）。
    // progress>1（预约物品走进端口格，T2.6 修订）由线性公式自然延伸到段外——无需特判。
    return { x: s.x, y: s.y, rotation: directionToIndex(seg.direction) * (Math.PI / 2) };
  }

  /**
   * 直段物品世界坐标 (A9 §5.3.2 getItemWorldPos)。
   * pos = 段左上角世界坐标；progress 0→1 沿 direction 从段首到段尾。
   */
  private straightWorldPos(
    pos: Position,
    direction: Direction,
    progress: number,
  ): { x: number; y: number } {
    const offset = progress * CELL_SIZE;
    switch (direction) {
      case 0:   return { x: pos.x + offset, y: pos.y + CELL_SIZE / 2 };
      case 90:  return { x: pos.x + CELL_SIZE / 2, y: pos.y + offset };
      case 180: return { x: pos.x + CELL_SIZE - offset, y: pos.y + CELL_SIZE / 2 };
      case 270: return { x: pos.x + CELL_SIZE / 2, y: pos.y + CELL_SIZE - offset };
    }
  }

  /**
   * 转角物品相对格中心的世界像素偏移（四分之一圆弧，A9 §5.4.2）。
   * 数学与 BeltPointerRenderer.computeCornerTransform 同源（pivot = 进入/出口边缘向量之和，
   * 半径半格），仅返回位置偏移、不含箭头旋转。
   * @param entryDir  进入方向（物品来源方向）
   * @param exitDir   出口方向（seg.direction）
   * @param progress  0→1 沿弧从进入边到出口边
   */
  private cornerOffset(
    entryDir: Direction,
    exitDir: Direction,
    progress: number,
  ): { x: number; y: number; rotation: number } {
    const info = turnInfoFromDirections(entryDir, exitDir);
    // 进入边边缘向量（相对格中心，单位=半格 0.5；屏幕坐标 y 向下）
    let eX = 0, eY = 0;
    if (entryDir === 270) eY = 0.5;        // up: 进入边在下边
    else if (entryDir === 90) eY = -0.5;   // down: 进入边在上边
    else if (entryDir === 180) eX = 0.5;   // left: 进入边在右边
    else if (entryDir === 0) eX = -0.5;    // right: 进入边在左边
    // 出口边边缘向量
    let xX = 0, xY = 0;
    if (exitDir === 270) xY = -0.5;        // up: 出口边在上边
    else if (exitDir === 90) xY = 0.5;     // down: 出口边在下边
    else if (exitDir === 180) xX = -0.5;   // left: 出口边在左边
    else if (exitDir === 0) xX = 0.5;      // right: 出口边在右边
    // 圆心 = 两边缘向量之和（格单位）
    const pivotX = eX + xX;
    const pivotY = eY + xY;
    // 起始切向 = -出口边向量（指向格内）
    const startAngle = Math.atan2(-xY, -xX);
    const deltaAngle = info.isCCW ? -Math.PI / 2 : Math.PI / 2;
    const currentAngle = startAngle + progress * deltaAngle;
    // 弧上位置（格单位）→ 世界像素
    const px = pivotX + 0.5 * Math.cos(currentAngle);
    const py = pivotY + 0.5 * Math.sin(currentAngle);
    // 物品旋转 = 弧切线方向 + π/2（与 pointer computeCornerTransform 一致，物品沿弧转弯）
    const tangentAngle = currentAngle + deltaAngle;
    return { x: px * CELL_SIZE, y: py * CELL_SIZE, rotation: tangentAngle + Math.PI / 2 };
  }

  /** 销毁所有物品 Sprite。 */
  destroy(): void {
    for (const entry of this.entries.values()) {
      for (const s of entry.sprites) {
        s.removeFromParent();
        s.destroy();
      }
    }
    this.entries.clear();
    this.texCache.clear();
  }
}
