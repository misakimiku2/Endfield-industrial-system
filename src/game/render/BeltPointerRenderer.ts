// 传送带 pointer 流动渲染器 — T2.0
// 移植自旧 Flutter 项目 transport_belt_renderer.dart 的 drawItemAt（直段线性 + 转角圆弧）。
//
// 职责:
//   - 每帧查询所有 Position+BeltSegmentComp 实体，为每段维护一个 pointer Sprite + 单元蒙版。
//   - 传送带单元（正方形）作为 pointer 的蒙版，**但仅在链端点格（链首/链尾）启用**：
//     端点格的 pointer 越过传送带物理边界时被裁掉（不溢出到传送带外）；
//     中间格**不蒙版**，pointer 可自然跨越格边界，使整链箭头像传送带一样连贯流动、无断层。
//   - 每段共享同一个 globalPhase（2 秒一格）：N 格出口边 = N+1 格入口边，
//     相位复位时下一格的 pointer 接管同一世界位置 → 视觉无缝衔接（自动扶梯效果）。
//   - 直段：沿方向轴线性移动；链首/链尾格移动范围扩展半个箭头（滑入/滑出），越界部分由蒙版裁掉。
//   - 转角段：沿四分之一圆弧移动。
//   - 阶段1 无物品，pointer 始终显示（T2.1 物品出现后会隐藏）。
//
// pointer 纹理：devices 图集的 pointer.png（来自 pointer.svg，9.4×21.3，纵向，默认箭头朝上）。
// 挂 layer3Item（物品层），盖在传送带带身（layer2Building）之上。

import { Sprite, Texture, Graphics, Container } from 'pixi.js';
import type { World, EntityHandle } from '../ECS';
import type { Position } from '../components/Position';
import type { BeltSegmentComp } from '../components/BeltSegmentComp';
import type { Direction } from '../components/BuildingComp';
import type { TextureLookup } from '../systems/RenderSystem';
import type { BeltSelection } from '../systems/belt/BeltSelection';
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
  /** 包裹 sprite 的容器（作为蒙版裁剪单元，位置=格左上角世界坐标）。 */
  cellWrap: Container;
  /** 单元蒙版（Graphics，走 StencilMask 路径，无纹理、resize 安全）。
   *  形状随端点类型变化（见 lastMaskKind），仅在 kind 变化时重画，避免每帧 redraw 开销。 */
  cellMask: Graphics;
  /** 当前已画进 cellMask 的形状种类（避免每帧重画相同形状）。 */
  lastMaskKind: MaskKind;
  handle: EntityHandle;
}

/**
 * 蒙版形状种类。决定 cellMask 画什么形状：
 *  - 'none'：中间格，不裁（renderable=false、mask=null）。
 *  - 'head'：链首格，只裁"背向"方向那一侧（传送带真正的起点），其余三面向链内敞开。
 *  - 'tail'：链尾格，只裁"朝向"方向那一侧（传送带真正的终点）。
 * 端点格只裁"真正是传送带尽头"的那一面，另一面朝向链内保持敞开，
 * 这样 pointer 从端点格滑向相邻格时前端不会被本格蒙版裁断（避免"前端闪断再完整出现"）。
 */
type MaskKind = 'none' | 'head' | 'tail';

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
  /** 选中态（SelectionSystem 写）；选中段不显示 pointer（逻辑不变，仅隐藏）。 */
  private beltSelection: BeltSelection | null = null;

  constructor(world: World, layer: Container, getTexture: TextureLookup) {
    this.world = world;
    this.layer = layer;
    this.getTexture = getTexture;
  }

  /** 注入选中态（由 RenderSystem.setBeltSelection 转发）。 */
  setBeltSelection(bs: BeltSelection): void {
    this.beltSelection = bs;
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
        entry.cellWrap.removeFromParent();
        entry.cellWrap.destroy({ children: true });
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
        // 结构: layer → cellWrap(位置=格左上角) → sprite(相对 cellWrap 偏移)
        //          ↑ cellMask(Graphics 正方形蒙版, 同为 cellWrap 子级, 坐标系=cellWrap 本地)
        // Graphics 非 Sprite → 走 StencilMask(模板缓冲) 路径，无纹理、resize 安全
        // （GridRenderer 注释里警示的是 Sprite 蒙版即 AlphaMaskPipe 的悬挂引用问题）。
        const cellWrap = new Container();
        const cellMask = new Graphics();
        cellMask.rect(0, 0, CELL_SIZE, CELL_SIZE).fill({ color: 0xffffff });
        // cellMask.renderable 的值随端点/中间状态每帧切换（见下方 isEndpoint 分支）。
        // 端点格（启用蒙版）置 true：StencilMask 靠 collectRenderables 把它画进模板缓冲
        //   （渲染时 colorMask.setMask(0) 关颜色写入，蒙版形状不会出现在最终画面）。
        // 中间格（不蒙版）置 false：否则白色填充正方形会被当作普通子节点画出来。
        const sprite = new Sprite(this.pointerTex!);
        sprite.anchor.set(0.5);
        sprite.scale.set(this.pointerScale);
        cellWrap.addChild(cellMask);
        cellWrap.addChild(sprite);
        this.layer.addChild(cellWrap);
        entry = { sprite, cellWrap, cellMask, lastMaskKind: 'none', handle };
        this.entries.set(handle, entry);
      }

      const seg = this.world.getComponent<BeltSegmentComp>(handle, 'BeltSegmentComp')!;
      const pos = this.world.getComponent<Position>(handle, 'Position')!;

      // 蒙版容器对齐到格左上角世界坐标（蒙版正方形覆盖整个传送带单元）
      entry.cellWrap.position.set(pos.x, pos.y);

      // 仅在链端点格（链首/链尾）启用单元蒙版：
      //  - 端点格：pointer 滑入/滑出时越界部分被裁掉，不溢出到传送带之外。
      //  - 中间格：不蒙版，pointer 可自然跨越格边界 —— N 格出口边 = N+1 格入口边
      //    （globalPhase 复位时下一格 pointer 接管同一世界位置），形成连贯流动无断层。
      // 端点蒙版是"半边裁剪"：只裁真正是传送带尽头的那一面（链首=背向、链尾=朝向），
      // 朝向链内的另一面敞开，使 pointer 流入/流出相邻格时前端不会被本格蒙版切断。
      // isTail 可能在延长时由 true 翻 false（见 BeltCreationSystem.commitCells），
      // 故每帧按当前 seg 重新判定，不缓存端点状态。
      const isHead = seg.incomingDirection !== undefined;
      const isTail = seg.isTail;
      const maskKind: MaskKind = isHead ? 'head' : isTail ? 'tail' : 'none';
      if (maskKind === 'none') {
        // 中间格：不蒙版。必须把 cellMask 的 renderable 关掉，否则那个白色填充正方形会
        // 当作普通子节点直接画出来。
        entry.cellMask.renderable = false;
        entry.cellWrap.mask = null;
      } else {
        // 端点格：按 head/tail 重画蒙版形状（仅 kind 变化时重画，避免每帧开销），再启用。
        if (entry.lastMaskKind !== maskKind) {
          this.drawEndpointMask(entry.cellMask, seg, maskKind);
          entry.lastMaskKind = maskKind;
        }
        entry.cellMask.renderable = true;
        entry.cellWrap.mask = entry.cellMask;
      }

      // 全段统一相位：与旧项目一致，同一时刻所有段用相同的 arrowProgress，
      // 使 pointer 像自动扶梯一样均匀分布、连续流动（无重叠/跳变）。
      // sprite 用格中心为原点的偏移；再换算到 cellWrap 本地坐标（减去半格）。
      const { x, y, rotation } = this.computePointerTransform(seg, globalPhase);
      entry.sprite.position.set(CELL_SIZE / 2 + x, CELL_SIZE / 2 + y);
      entry.sprite.rotation = rotation;
      entry.sprite.alpha = 1;
      // 选中段不显示 pointer（逻辑不变，仅隐藏渲染）；其余段 pointer 始终可见
      // （T2.0 阶段1 无物品；端点越界部分由单元蒙版裁掉，无 alpha 渐变）
      entry.sprite.visible = !(this.beltSelection?.has(handle) ?? false);
    }
  }

  /**
   * 画端点格的"半边裁剪"蒙版形状到 cellMask（cellWrap 本地坐标，格左上角为原点）。
   *
   * 设计：端点格只在"真正是传送带尽头"的那一面裁剪，朝向链内的其余面全部敞开：
   *  - head（链首）：裁掉"背向 direction"的一面（物品流向的源头）。沿 direction 正方向
   *    把蒙版延伸出一个超出格边界的带状区域（"敞开口"），使 pointer 越过入口边滑入时
   *    不会被本格蒙版切到；越界部分（滑出传送带起点之外）才被裁掉。
   *  - tail（链尾）：裁掉"朝向 direction"的一面（物品流向的终点）。沿 -direction 敞开。
   *
   * 实现为画一个覆盖"本格 + 敞开侧外延"的矩形（加法），而不是画 U 形多边形——
   * 矩形蒙版更简单、且 StencilMask 对凸形状无歧义。
   *
   * 敞开量 OPEN = 半格：足够覆盖 pointer 从端点格滑入/滑出相邻格时的前端越界（pointer 高度 0.25 格，
   * moveRange 扩展 0.125 格，前端最多越过边界 ~0.125+0.125=0.25 格 < 0.5 格敞开口）。
   *
   * @param kind 'head' 或 'tail'。
   */
  private drawEndpointMask(cellMask: Graphics, seg: BeltSegmentComp, kind: 'head' | 'tail'): void {
    const OPEN = CELL_SIZE / 2; // 敞开侧外延量（半格）
    // 敞开方向：head 沿 direction 正向敞开（朝链内），tail 沿 direction 负向（朝链内）。
    // 对链首 head：direction 是链内方向 → 正向敞开。
    // 对链尾 tail：direction 是链出口方向 → 链内是 -direction → 负向敞开。
    const sign = kind === 'head' ? 1 : -1;
    // 在 cellWrap 本地坐标系（原点=格左上角，y 向下）里画"本格 + 敞开侧外延"矩形。
    // direction 角度：right=0, down=π/2, left=π, up=3π/2。
    // 外延方向向量 = (cos, sin) * sign。
    const ang = directionAngle(seg.direction);
    const dx = Math.cos(ang) * sign;
    const dy = Math.sin(ang) * sign;
    let minX = 0, minY = 0, maxX = CELL_SIZE, maxY = CELL_SIZE;
    if (dx > 0) maxX += OPEN;       // 朝右敞开
    else if (dx < 0) minX -= OPEN;  // 朝左敞开
    if (dy > 0) maxY += OPEN;       // 朝下敞开
    else if (dy < 0) minY -= OPEN;  // 朝上敞开
    cellMask.clear();
    cellMask.rect(minX, minY, maxX - minX, maxY - minY).fill({ color: 0xffffff });
  }

  /**
   * 计算指针在格内的偏移与朝向。
   * 端点格（链首/链尾）的指针允许越过传送带物理边界滑动（滑入/滑出），
   * 越界部分由单元蒙版裁掉（alpha 恒为 1），实现"箭头自然走出传送带"的平滑效果。
   * @returns 相对格中心的 (x, y) 偏移（世界像素）+ 旋转角（弧度）。
   */
  private computePointerTransform(
    seg: BeltSegmentComp,
    phase: number,
  ): { x: number; y: number; rotation: number } {
    if (seg.isCorner && seg.entryDir !== undefined) {
      // 转角格：指针沿圆弧走，端点就在格子边缘上，无需额外扩展。
      // 链首/链尾滑入/滑出的越界部分由单元蒙版裁掉。
      return this.computeCornerTransform(seg.entryDir, seg.direction, phase);
    }
    return this.computeStraightTransform(seg, phase);
  }

  /**
   * 直段 pointer：沿方向轴线性移动，箭头指向 dir（与物品流向一致）。
   * 链首/链尾格把移动范围扩展半个箭头（0.125 格），使箭头能滑出传送带边界；
   * 越界部分由单元蒙版裁掉（不再用 alpha 渐变淡出）。
   */
  private computeStraightTransform(
    seg: BeltSegmentComp,
    phase: number,
  ): { x: number; y: number; rotation: number } {
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
    const moveDist = moveRatio * CELL_SIZE;
    const dirRad = directionAngle(seg.direction);
    const dvx = Math.cos(dirRad);
    const dvy = Math.sin(dirRad);
    return {
      x: dvx * moveDist,
      y: dvy * moveDist,
      rotation,
    };
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
      entry.cellWrap.removeFromParent();
      entry.cellWrap.destroy({ children: true });
    }
    this.entries.clear();
  }
}