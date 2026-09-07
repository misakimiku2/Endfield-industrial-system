// 传送带 pointer 流动渲染器 — T2.0 → T2.29 指针队列物理（0/1 统一模型完整版）
// 移植自旧 Flutter 项目 transport_belt_renderer.dart 的 drawItemAt（直段线性 + 转角圆弧）。
//
// 职责:
//   - 每帧查询所有 Position+BeltSegmentComp 实体，按链分组；每链持有一个
//     ChainPointerQueue（指针队列的真值状态，纯逻辑、node 可驱动），逐帧按仿真
//     Tick 折算步长推进，把每支指针经链几何（直段线性/转角圆弧）映射到世界坐标。
//   - **队列物理（T2.29，§十三 用户拍板）**: 指针 0 与物品 1 运行逻辑相同——以带速
//     流动、被物品/其他 0 挡住就停在格心排队（不穿过 1）、被停稳的 1 压住即消失、
//     滑出链尾后从链首再进来；链激活（首件注入）时全链一次性重相位到物品格网
//     （最短模距离 ≤半格）——0 与 1 从此永同格网（图1"物品与指针网格错开"根治）。
//     阻挡/击杀/循环/补充的规则全在 BeltPointerQueue（纯逻辑），本类只做精灵 I/O。
//   - **带身遮罩（用户参考图设计，T2.28 保留）**: 带身格矩形并集 = 箭头的遮罩——
//     箭头滑出带端/等待入链时被像素级裁掉，配合端部渐变呈现"半透明滑出/滑入"。
//   - 保留: 堵塞 tint（黄→橙 #E6956F 渐变）、选中段白色 pointer 叠层、延长预览
//     隐藏格。
//
// 层级: 指针层在 layer2Building zIndex 0.4（带身 0 之上、物品 belowItems 0.5 之下、
// 设备 1 之下）——流动的物品从指针上方碾过（指针在其下方继续存在，§十三②"盖住"）。
//
// pointer 纹理：devices 图集的 pointer.png（来自 pointer.svg，9.4×21.3，纵向，默认箭头朝上）。

import { Sprite, Texture, Container, Graphics } from 'pixi.js';
import type { World, EntityHandle } from '../ECS';
import type { Position } from '../components/Position';
import type { BeltSegmentComp } from '../components/BeltSegmentComp';
import type { TextureLookup } from '../systems/RenderSystem';
import type { BeltSelection } from '../systems/belt/BeltSelection';
import type { Direction } from '../components/BuildingComp';
import { CELL_SIZE } from './constants';
import { turnInfoFromDirections } from '../systems/belt/BeltPathGeometry';
import { BeltSystem, ITEM_PROGRESS_PER_TICK } from '../systems/BeltSystem';
import { ChainPointerQueue, chainCreationClass, ARROW_WINDOW_MARGIN, type QueueItemRef } from './BeltPointerQueue';
import { lerpColor, BLOCKED_BLEND_MS } from './BeltVectorGeometry';

/** pointer 在格内的视觉尺寸（相对 CELL_SIZE）。与旧项目 cellSize*0.25 一致（按 pointer 高度）。 */
const POINTER_SIZE_RATIO = 0.25;
/** 常态箭头 tint（黄 #DFB615）。 */
const POINTER_TINT_NORMAL = 0xdfb615;
/** 堵塞时箭头 tint（用户指定 #E6956F）。 */
const POINTER_TINT_BLOCKED = 0xe6956f;

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

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 单支箭头的运行时状态（按指针 id 键控——id 稳定，位置帧间连续）。 */
interface ArrowEntry {
  sprite: Sprite;
  /** 选中段叠加的白色 pointer；非选中段 visible=false。 */
  whiteSprite: Sprite;
  /** 几何行走游标（缓存所在段下标省去每帧线性查找；循环瞬移可双向行走）。 */
  segCursor: number;
  /** 上一 Tick 边界的链坐标（渲染内插起点，与物品 prevTick 同律）。 */
  prevD: number;
  /** 当前 Tick 的链坐标（队列真值，Tick 边界推进时更新）。 */
  lastD: number;
}

/** 单链的箭头池 + 队列真值 + 几何缓存 + 遮罩。 */
interface ChainRuntime {
  /** 指针队列真值（位置/阻挡/击杀/循环/补充/重相位; 逐 Tick 编排在 queue.tick）。 */
  queue: ChainPointerQueue;
  /** 创建相位（chainId 时间戳派生）——空带图案各链各异的锚。 */
  creationClass: number;
  /** 指针 id → 箭头精灵（击杀/链销毁时回收）。 */
  arrows: Map<number, ArrowEntry>;
  /** 本链可见段（按 segmentIndex 升序）。 */
  segs: Array<{ handle: EntityHandle; seg: BeltSegmentComp; pos: Position }>;
  /** 链长（格）= 最大 segmentIndex + 1。 */
  chainLen: number;
  /** 堵塞渐变进度 0~1（箭头黄 → 橙）。每帧向目标趋近。 */
  blockedBlend: number;
  /** 带身遮罩（格矩形并集）——裁掉滑出带端/带外等待的箭头。 */
  mask: Graphics | null;
  /** 遮罩对应格集指纹（变化才重建）。 */
  maskKey: string;
}

/**
 * 传送带 pointer 流动渲染器（指针队列物理）。
 *
 * 用法：在主循环每帧调用 update(alpha, deltaMS)。
 */
export class BeltPointerRenderer {
  private world: World;
  private layer: Container;
  private getTexture: TextureLookup;
  /** 指针纹理（devices 图集的 pointer）。懒解析：assets 在 Game 构造之后才加载完。 */
  private pointerTex: Texture | null = null;
  /** 指针按高度的基准缩放（使 pointer 高度 = CELL_SIZE * POINTER_SIZE_RATIO）。 */
  private pointerScale = 1;

  /** chainId → 链运行时（队列真值 + 箭头池 + 几何 + 遮罩）。链消失即销毁。 */
  private chains = new Map<string, ChainRuntime>();
  /** 上一帧的 beltPhase——差值折算本帧跨过的仿真 Tick 数（暂停时 0）。 */
  private lastBeltPhase: number | null = null;

  /** 选中态（SelectionSystem 写）；选中段上的箭头叠加白色 pointer。 */
  private beltSelection: BeltSelection | null = null;
  /** 延长预览中被隐藏的原尾格（该格带身+箭头由创建系统预览接管渲染）。 */
  private getHiddenCell?: () => { x: number; y: number } | null;

  constructor(
    world: World,
    layer: Container,
    getTexture: TextureLookup,
    getHiddenCell?: () => { x: number; y: number } | null,
  ) {
    this.world = world;
    this.layer = layer;
    this.getTexture = getTexture;
    this.getHiddenCell = getHiddenCell;
  }

  /** 注入选中态（由 RenderSystem.setBeltSelection 转发）。 */
  setBeltSelection(bs: BeltSelection): void {
    this.beltSelection = bs;
  }

  /**
   * 懒解析 pointer 纹理。assets 在 Game 构造之后才 loadAllAssets 完成，
   * 构造时取会拿到 undefined → EMPTY。首次 update 时解析并缓存。
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
   * 每帧更新所有链的指针队列。
   * @param alpha 仿真周期插值系数（accumulator/SIM_STEP，0~1）。与物品同源时钟
   *   （BeltSystem.beltPhase），帧间差 = 本帧应推进的 Tick 数（暂停时为 0）。
   */
  update(alpha: number, deltaMS = 0): void {
    const visible = this.world.query('Position', 'BeltSegmentComp');
    const seen = new Set<string>();

    // 无传送带段时直接返回（也避免无谓的纹理解析）
    if (visible.length === 0) {
      this.destroyAll();
      this.lastBeltPhase = null;
      return;
    }
    if (!this.resolveTexture()) return;

    // 1. 分组: chainId → 段列表（segmentIndex 升序）。链运行时必须经 this.chains
    //    持久化复用（队列真值 + 箭头池跨帧存活）——每帧新建会按帧泄漏精灵且丢失
    //    队列状态。段列表须在逐实体循环外整帧清空一次（T2.27-b 教训: 循环内清
    //    会只剩最后一段，弯折处箭头穿出成直线）。
    for (const rt of this.chains.values()) rt.segs.length = 0;
    const grouped = new Map<string, ChainRuntime>();
    for (const handle of visible) {
      const seg = this.world.getComponent<BeltSegmentComp>(handle, 'BeltSegmentComp');
      const pos = this.world.getComponent<Position>(handle, 'Position');
      if (!seg || !pos) continue;
      let rt = this.chains.get(seg.chainId);
      if (!rt) {
        rt = {
          queue: new ChainPointerQueue(),
          creationClass: chainCreationClass(seg.chainId, ((BeltSystem.beltPhase % 1) + 1) % 1),
          arrows: new Map(), segs: [], chainLen: 1, blockedBlend: 0, mask: null, maskKey: '',
        };
        this.chains.set(seg.chainId, rt);
      }
      rt.segs.push({ handle, seg, pos });
      grouped.set(seg.chainId, rt);
      seen.add(seg.chainId);
    }

    // 2. 销毁消失链的队列与箭头池、遮罩
    for (const [chainId, rt] of this.chains) {
      if (!seen.has(chainId)) {
        for (const a of rt.arrows.values()) this.destroyArrow(a);
        this.destroyMask(rt);
        this.chains.delete(chainId);
      }
    }

    // 3. 本帧跨过的仿真 Tick 数（beltPhase 差值折算；暂停 = 0，指针与物品同步
    //    冻结）。队列按**整数 Tick** 推进——指针真值恒在 1/40 格网上（与物品同一
    //    纪律），渲染内插用与物品完全相同的 prev + α×Δ 公式（渲染滞后一 Tick 的
    //    既有语义），两者逐帧严格同余——这是 0-1 网格对齐的时钟根基。
    let ticks = 0;
    if (this.lastBeltPhase !== null) {
      const d = ((BeltSystem.beltPhase - this.lastBeltPhase) % 1 + 1.5) % 1 - 0.5;
      ticks = Math.max(0, Math.round(d / ITEM_PROGRESS_PER_TICK));
    }
    this.lastBeltPhase = BeltSystem.beltPhase;
    const advance = ticks > 0;
    // 堵塞渐变步长（线性插值，固定时长；deltaMS=0 时瞬间到位，兼容旧调用）
    const blendStep = deltaMS > 0 ? deltaMS / BLOCKED_BLEND_MS : 1;
    // 延长预览中被隐藏的原尾格（每帧取一次，段循环内比对格坐标）
    const hiddenCell = this.getHiddenCell?.() ?? null;

    // 4. 每链: 队列推进（Tick 边界）→ 精灵池同步 → 几何映射（α 内插）
    for (const rt of grouped.values()) {
      // 段按 segmentIndex 升序 + 链长
      rt.segs.sort((a, b) => (a.seg.segmentIndex ?? 0) - (b.seg.segmentIndex ?? 0));
      rt.chainLen = Math.max(...rt.segs.map(({ seg }) => (seg.segmentIndex ?? 0) + 1));

      // 物品快照（非 entering；stopped = 本 Tick 停走）——击杀/钳制的判定源
      const items: QueueItemRef[] = [];
      for (const { seg } of rt.segs) {
        const idx = seg.segmentIndex ?? 0;
        for (const it of seg.items ?? []) {
          if (it.entering === true) continue; // 走进设备的过客: 不挡 0、不被 0 阻挡
          items.push({ total: idx + it.progress, stopped: (it.delta ?? 0) === 0 });
        }
      }

      if (advance) {
        // Tick 边界: 内插起点前移 + 队列 Tick 编排（播种/击杀/前进/循环/注入格
        // 击杀/注入重相位/空带回归创建相位——单一事实来源 ChainPointerQueue.tick，
        // 诊断脚本直跑同入口）+ 精灵插值锚更新。
        for (const entry of rt.arrows.values()) entry.prevD = entry.lastD;
        for (let i = 0; i < ticks; i++) rt.queue.tick(rt.chainLen, items, rt.creationClass);
        for (const a of rt.queue.arrows) {
          const entry = rt.arrows.get(a.id) ?? this.createEntry(rt, a);
          // 循环瞬移不得内插——prev→last 横跨整条带（尾→首），α 扫过中段会让
          // 幽灵箭头逐帧从带顶扫到带底（用户实测"连续两帧各多出一个指针"）。
          // 位移 > 0.55（正常 0.025 / 重相位 ≤0.525）判定为瞬移: 本 Tick 直接
          // 渲染在新位置（两端都在遮罩外/渐变区，跳变不可见）。
          if (Math.abs(a.pos - entry.prevD) > 0.55) entry.prevD = a.pos;
          entry.lastD = a.pos; // prevD 保持推进前快照（新建 entry 两值同为 pos = 首 Tick 静止）
        }
        // 击杀回收
        for (const [id, entry] of rt.arrows) {
          if (!rt.queue.arrows.some((a) => a.id === id)) {
            this.destroyArrow(entry);
            rt.arrows.delete(id);
          }
        }
      }

      // 带身遮罩（格矩形并集；格集变化才重建）
      this.ensureMask(rt);

      // 堵塞渐变: 链上任一段 blocked → 箭头黄 → 橙 #E6956F
      const blockedTarget = rt.segs.some(({ seg }) => seg.blocked === true) ? 1 : 0;
      rt.blockedBlend = rt.blockedBlend < blockedTarget
        ? Math.min(blockedTarget, rt.blockedBlend + blendStep)
        : rt.blockedBlend > blockedTarget
          ? Math.max(blockedTarget, rt.blockedBlend - blendStep)
          : rt.blockedBlend;
      const tint = lerpColor(POINTER_TINT_NORMAL, POINTER_TINT_BLOCKED, rt.blockedBlend);

      // 几何映射: 链坐标 d（prev + α×Δ 内插，与物品同公式）→ 世界坐标
      for (const arrow of rt.queue.arrows) {
        const entry = rt.arrows.get(arrow.id);
        if (!entry) continue; // advance 帧才建新 entry; 非推进帧不应出现新 id
        const d = entry.prevD + alpha * (entry.lastD - entry.prevD);
        const { seg, pos, handle } = this.segmentAt(rt, entry, d);
        const progress = d - (seg.segmentIndex ?? 0);
        const { x, y, rotation } = this.computePointerTransform(seg, progress);

        // 可见性: 端部渐变（带外等待/滑出由遮罩裁剪，渐变给"半透明滑出"观感）
        let vis = 1;
        vis = Math.min(vis, clamp01(
          ((rt.chainLen + ARROW_WINDOW_MARGIN) - d) / (2 * ARROW_WINDOW_MARGIN),
        ));
        vis = Math.min(vis, clamp01((d + ARROW_WINDOW_MARGIN) / (2 * ARROW_WINDOW_MARGIN)));

        entry.sprite.position.set(
          pos.x + CELL_SIZE / 2 + x,
          pos.y + CELL_SIZE / 2 + y,
        );
        entry.sprite.rotation = rotation;
        entry.sprite.tint = tint;
        entry.sprite.alpha = vis;
        entry.sprite.visible = vis > 0.02 && !this.isHiddenCell(pos, hiddenCell);
        if (rt.mask && entry.sprite.mask !== rt.mask) entry.sprite.mask = rt.mask;

        // 选中段白色 pointer 叠层（按段内进度渐入渐出）
        const selected = this.beltSelection?.has(handle) ?? false;
        if (selected) {
          entry.whiteSprite.position.copyFrom(entry.sprite.position);
          entry.whiteSprite.rotation = rotation;
          const FADE = 0.18;
          const p = ((progress % 1) + 1) % 1;
          const selAlpha = p < FADE
            ? p / FADE
            : p > 1 - FADE
              ? (1 - p) / FADE
              : 1;
          entry.whiteSprite.alpha = selAlpha * vis;
          entry.whiteSprite.visible = vis > 0.02;
          if (rt.mask && entry.whiteSprite.mask !== rt.mask) entry.whiteSprite.mask = rt.mask;
        } else {
          entry.whiteSprite.visible = false;
        }
      }
    }

  }

  /** 带身遮罩（格矩形并集）。格集指纹变化才重建 Graphics 内容。 */
  private ensureMask(rt: ChainRuntime): void {
    const key = rt.segs
      .map(({ pos }) => `${Math.round(pos.x / CELL_SIZE)},${Math.round(pos.y / CELL_SIZE)}`)
      .sort()
      .join(';');
    if (rt.maskKey === key && rt.mask) return;
    rt.maskKey = key;
    if (!rt.mask) {
      rt.mask = new Graphics();
      this.layer.addChild(rt.mask);
    }
    rt.mask.clear();
    for (const { pos } of rt.segs) {
      rt.mask.rect(pos.x, pos.y, CELL_SIZE, CELL_SIZE);
    }
    rt.mask.fill(0xffffff);
  }

  private destroyMask(rt: ChainRuntime): void {
    if (!rt.mask) return;
    rt.mask.removeFromParent();
    rt.mask.destroy();
    rt.mask = null;
    rt.maskKey = '';
  }

  /** 箭头所在段（几何行走: 常规流动 d 单调前进，循环瞬移 d 大幅回退 → 双向游标）。 */
  private segmentAt(
    rt: ChainRuntime,
    entry: ArrowEntry,
    d: number,
  ): { handle: EntityHandle; seg: BeltSegmentComp; pos: Position } {
    let i = Math.min(Math.max(entry.segCursor, 0), rt.segs.length - 1);
    while (i < rt.segs.length - 1 && d > (rt.segs[i]!.seg.segmentIndex ?? 0) + 1) i++;
    while (i > 0 && d < (rt.segs[i]!.seg.segmentIndex ?? 0)) i--;
    entry.segCursor = i;
    return rt.segs[i]!;
  }

  /** 延长预览隐藏格判定。 */
  private isHiddenCell(
    pos: Position,
    hiddenCell: { x: number; y: number } | null,
  ): boolean {
    return !!(hiddenCell &&
      Math.round(pos.x / CELL_SIZE) === hiddenCell.x &&
      Math.round(pos.y / CELL_SIZE) === hiddenCell.y);
  }

  /** 为新指针建精灵 entry（首 Tick 静止: prevD = lastD = 当前位置）。 */
  private createEntry(rt: ChainRuntime, a: { id: number; pos: number }): ArrowEntry {
    const entry = this.createArrow();
    entry.prevD = entry.lastD = a.pos;
    rt.arrows.set(a.id, entry);
    return entry;
  }

  private createArrow(): ArrowEntry {
    const sprite = new Sprite(this.pointerTex ?? Texture.EMPTY);
    sprite.anchor.set(0.5);
    sprite.scale.set(this.pointerScale);
    sprite.tint = POINTER_TINT_NORMAL;
    const whiteSprite = new Sprite(this.pointerTex ?? Texture.EMPTY);
    whiteSprite.anchor.set(0.5);
    whiteSprite.scale.set(this.pointerScale);
    whiteSprite.tint = 0xffffff;
    whiteSprite.visible = false;
    this.layer.addChild(sprite);
    this.layer.addChild(whiteSprite);
    return { sprite, whiteSprite, segCursor: 0, prevD: 0, lastD: 0 };
  }

  private destroyArrow(a: ArrowEntry): void {
    a.sprite.removeFromParent();
    a.sprite.destroy();
    a.whiteSprite.removeFromParent();
    a.whiteSprite.destroy();
  }

  private destroyAll(): void {
    for (const rt of this.chains.values()) {
      for (const a of rt.arrows.values()) this.destroyArrow(a);
      this.destroyMask(rt);
    }
    this.chains.clear();
  }

  /**
   * 计算指针在链内进度 progress（段内 0~1，越界为端点滑入/滑出余量）下的
   * 世界偏移与朝向（相对所在格中心）。
   * 直段: 沿方向轴线性（**匀速**）；转角: 沿四分之一圆弧（移植自旧项目 drawItemAt）。
   */
  private computePointerTransform(
    seg: BeltSegmentComp,
    progress: number,
  ): { x: number; y: number; rotation: number } {
    if (seg.isCorner && seg.entryDir !== undefined) {
      const c = Math.min(Math.max(progress, 0), 1);
      return this.computeCornerTransform(seg.entryDir, seg.direction, c);
    }
    // 直段: 匀速线性。progress 允许轻微越界（带外等待/滑出余量），线性公式自然延伸。
    const moveDist = (progress - 0.5) * CELL_SIZE;
    const dirRad = directionAngle(seg.direction);
    return {
      x: Math.cos(dirRad) * moveDist,
      y: Math.sin(dirRad) * moveDist,
      rotation: directionToIndex(seg.direction) * (Math.PI / 2),
    };
  }

  /**
   * 转角段 pointer：沿四分之一圆弧移动。移植自旧项目 drawItemAt 转角分支。
   */
  private computeCornerTransform(
    incomingDir: Direction,
    outgoingDir: Direction,
    phase: number,
  ): { x: number; y: number; rotation: number } {
    const info = turnInfoFromDirections(incomingDir, outgoingDir);
    let eX = 0, eY = 0;
    if (incomingDir === 270) eY = 0.5;       // up
    else if (incomingDir === 90) eY = -0.5;  // down
    else if (incomingDir === 180) eX = 0.5;  // left
    else if (incomingDir === 0) eX = -0.5;   // right
    let xX = 0, xY = 0;
    if (outgoingDir === 270) xY = -0.5;      // up
    else if (outgoingDir === 90) xY = 0.5;   // down
    else if (outgoingDir === 180) xX = -0.5; // left
    else if (outgoingDir === 0) xX = 0.5;    // right
    const pivotX = eX + xX;
    const pivotY = eY + xY;
    const startVecX = -xX;
    const startVecY = -xY;
    const startAngle = Math.atan2(startVecY, startVecX);
    const deltaAngle = info.isCCW ? -Math.PI / 2 : Math.PI / 2;
    const currentAngle = startAngle + phase * deltaAngle;
    const px = pivotX + 0.5 * Math.cos(currentAngle);
    const py = pivotY + 0.5 * Math.sin(currentAngle);
    const tangentAngle = currentAngle + deltaAngle;
    const rotation = tangentAngle + Math.PI / 2;
    return {
      x: px * CELL_SIZE,
      y: py * CELL_SIZE,
      rotation,
    };
  }

  /** 销毁所有箭头。 */
  destroy(): void {
    this.destroyAll();
    this.lastBeltPhase = null;
  }
}
