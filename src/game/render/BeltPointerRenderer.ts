// 传送带 pointer 流动渲染器 — T2.0
// 移植自旧 Flutter 项目 transport_belt_renderer.dart 的 drawItemAt（直段线性 + 转角圆弧）。
//
// 职责:
//   - 每帧查询所有 Position+BeltSegmentComp 实体，为每段维护一个 pointer Sprite + 单元蒙版。
//   - 传送带单元（正方形）作为 pointer 的蒙版，**仅在链端点格启用**：
//     链首格(head)裁起点侧、链尾格(tail)裁终点侧、单格链(single)两端都裁——
//     pointer 从传送带边界出现/消失，不溢出到传送带之外（起点不外飘，终点不走出）；
//     中间格不蒙版，pointer 可自然跨越格边界，使整链箭头像传送带一样连贯流动、无断层。
//   - 每链共享一个相位（2 秒一格）：N 格出口边 = N+1 格入口边，相位复位时下一格的
//     pointer 接管同一世界位置 → 视觉无缝衔接（链内自动扶梯效果）。相位 = 全局时钟
//     + **按 chainId 确定性派生的偏移**（2026-08-25 用户实测修订: 不同时间创建的传送带
//     指针动画不应全局锁步，并行带互相独立；同链保持扶梯连续）。物品已与指针解耦
//     （T2.7 起注入段首独立推进），指针相位只影响箭头动画本身。
//   - 直段：沿方向轴线性移动；链首/链尾格移动范围在端点侧各扩展半个箭头（滑入/滑出），
//     越界部分由端点蒙版裁掉（pointer 从边界渐入/渐出，而非硬切或外飘）。
//   - 转角段：沿四分之一圆弧移动。
//   - T2.1 起：段上有物品时指针隐藏（A9 §5.2.2 一格一物品: 该格显示指针或物品二选一，
//     物品替换箭头为硬切）。2026-08-25 相位解耦后曾迭代的变体（相位差渐隐、世界距离
//     渐隐、占据半径、显隐缓动）均被用户实测否决——队列前方箭头出现各种形式的
//     alpha 渐变闪动。定稿: **无任何特殊效果**，段上 items 非空即隐藏、空段常显流动，
//     与其他指针行为完全一致。
//   - 2026-08-27 v8 终稿（用户第九轮澄清"我要的其实就是队列前的箭头，不要闪动"）:
//     v7/v7b 的邻接接近隐藏（物品压线/指针尖触邻物品即隐）会让**队列前方的箭头提前
//     0.6~0.9s 消失**——每次队列推进箭头先没、物品后才到，读作"闪动"；v7c 门口恒隐
//     更是把用户要的箭头删了。全部撤销。像素互斥改由**几何保证**:
//     **每一格的箭头都蒙版裁剪在自己格内**（贴图像素永不过线），物品过线时两者正好
//     在格界两侧交接——空格箭头常驻稳定（直到物品真正进格才硬切为物品）、零像素共存、
//     零闪动。相邻格箭头由链相位自动接力（N 格出口边 = N+1 格入口边，wrap 瞬间下一格
//     接管同一世界位置），扶梯观感保留。判定回归唯一规则: 本段 items 非空 → 隐藏。
//
// PixiJS v8 注意：Graphics 作为 StencilMask，clear()+redraw 后模板缓冲不更新（github #10290）。
//   本类 v8 起蒙版形状恒为整格、创建后从不清空重画，不触发该 regression。
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
import { BeltSystem } from '../systems/BeltSystem';
import { lerpColor, BLOCKED_BLEND_MS } from './BeltVectorGeometry';

/** pointer 在格内的视觉尺寸（相对 CELL_SIZE）。与旧项目 cellSize*0.25 一致（按 pointer 高度）。 */
const POINTER_SIZE_RATIO = 0.25;
/** 常态箭头 tint（黄 #DFB615）。 */
const POINTER_TINT_NORMAL = 0xdfb615;
/** 堵塞时箭头 tint（用户指定 #E6956F）。 */
const POINTER_TINT_BLOCKED = 0xe6956f;
/** 指针显隐变化日志环形容量。 */
const POINTER_LOG_MAX = 300;
/** 临时调试开关: 指针显隐跳变直接 console.log 到浏览器控制台。
 *  ⚠️ 仅为定位"指针×物品同格"临时存在——问题解决后把本开关改 false 或整段删除
 *  （搜索 POINTER_DEBUG_CONSOLE）。 */
const POINTER_DEBUG_CONSOLE = true;
/** 显隐原因的控制台中文表述（v8 只剩 self/restore——邻接接近隐藏已撤销）。 */
const EXCL_REASON_CN: Record<string, string> = {
  self: '本格有物品',
  restore: '物品离开, 恢复显示',
};

/** 方向 → 序号：up=0, right=1, down=2, left=3（与旧项目 _directionToIndex 一致）。 */
function directionToIndex(dir: Direction): number {
  switch (dir) {
    case 270: return 0; // up
    case 0:   return 1; // right
    case 90:  return 2; // down
    case 180: return 3; // left
  }
}

/**
 * 链相位偏移（[0,1)）——从 chainId 确定性派生（无状态、每帧一致）。
 * 同链各段同偏移（扶梯连续）；不同链偏移不同（并行带指针互相独立）。
 * 传送带编辑（链合并/拆分重建 chainId）时相位会变，指针跳一次——低频可接受。
 */
function chainPhaseOf(chainId: string): number {
  let h = 0;
  for (let i = 0; i < chainId.length; i++) {
    h = (h * 31 + chainId.charCodeAt(i)) % 997;
  }
  return h / 997;
}

/** 单个 pointer Sprite 的运行时状态。 */
interface PointerEntry {
  sprite: Sprite;
  /** 选中格叠加的白色 pointer（tint 白，alpha 随相位渐入渐出）；非选中段 visible=false。 */
  whiteSprite: Sprite;
  /** 包裹 sprite 的容器（作为蒙版裁剪单元，位置=格左上角世界坐标）。 */
  cellWrap: Container;
  /** 单元蒙版（Graphics，走 StencilMask 路径，无纹理、resize 安全）。
   *  v8 起恒为整格形状、创建后从不清空重画（箭头像素永不出自己的格）。 */
  cellMask: Graphics;
  handle: EntityHandle;
  /** 堵塞渐变进度 0~1（箭头黄 → 橙 #E6956F）。每帧向目标趋近。 */
  blockedBlend: number;
  /** 上一帧指针可见性（-1=未记录；用于显隐变化日志去重）。 */
  lastPtrAlpha: number;
  /** 上一帧隐藏原因（'self'，恢复时日志用）。 */
  lastExclReason: string;
}

/** 指针显隐变化日志条目（__game.pointerLog() 覆盘用）。 */
export interface PointerLogEntry {
  /** 页面毫秒时间戳（performance.now）。 */
  t: number;
  /** 格网格坐标。 */
  gx: number;
  gy: number;
  /** 'hide' | 'show'。 */
  ev: 'hide' | 'show';
  /** 触发原因: self(本段有物品) / restore(物品离开恢复)。 */
  reason: string;
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
  /** 选中态（SelectionSystem 写）；选中段叠加白色 pointer（whiteSprite alpha 渐变）。 */
  private beltSelection: BeltSelection | null = null;
  /** 指针显隐变化环形日志（__game.pointerLog() 读取，最近 POINTER_LOG_MAX 条）。 */
  private pointerLogRing: PointerLogEntry[] = [];

  constructor(world: World, layer: Container, getTexture: TextureLookup) {
    this.world = world;
    this.layer = layer;
    this.getTexture = getTexture;
  }

  /** 注入选中态（由 RenderSystem.setBeltSelection 转发）。 */
  setBeltSelection(bs: BeltSelection): void {
    this.beltSelection = bs;
  }

  /** 指针显隐变化日志（最近 POINTER_LOG_MAX 条，供 __game.pointerLog() 覆盘）。 */
  getPointerLog(): PointerLogEntry[] {
    return this.pointerLogRing;
  }

  /** 当前每格指针状态快照（alpha + 卡住的原因）——专抓"隐藏后不恢复"的格。 */
  getPointerState(world: World): string {
    const lines: string[] = [];
    for (const [handle, entry] of this.entries) {
      const pos = world.getComponent<Position>(handle, 'Position');
      if (!pos) continue;
      const gx = Math.round(pos.x / CELL_SIZE);
      const gy = Math.round(pos.y / CELL_SIZE);
      lines.push(`(${gx},${gy}) alpha=${entry.sprite.alpha}${entry.lastExclReason ? ` ←${entry.lastExclReason}` : ''}`);
    }
    return lines.length > 0 ? lines.join('\n') : '（无指针）';
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
   * @param alpha 仿真周期插值系数（accumulator/SIM_STEP，0~1）。pointer 用 BeltSystem.beltPhase
   *   作时间源（与物品同源），消除漂移/闪烁。
   */
  update(alpha: number, deltaMS = 0): void {
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

    // 2. 全局相位（指针动画时间源）+ 帧间 alpha 插值。2026-08-25 起**按链加相位偏移**
    //    （见下方 chainPhaseOf）: 不同链的指针不同步——传送带创建时间不同，全局锁步
    //    不符实际玩法（用户实测反馈）。物品已与指针解耦（注入段首独立推进）。
    const globalPhase = BeltSystem.beltPhase + alpha * BeltSystem.beltPhaseDelta;
    // 堵塞渐变步长（线性插值，固定时长；deltaMS=0 时瞬间到位，兼容旧调用）
    const blendStep = deltaMS > 0 ? deltaMS / BLOCKED_BLEND_MS : 1;

    // 3. 新增 + 同步
    for (const handle of visible) {
      let entry = this.entries.get(handle);
      if (!entry) {
        // 结构: layer → cellWrap(位置=格左上角) → sprite(相对 cellWrap 偏移)
        //          ↑ cellMask(Graphics 整格正方形蒙版, 同为 cellWrap 子级, 坐标系=cellWrap 本地)
        // Graphics 非 Sprite → 走 StencilMask(模板缓冲) 路径，无纹理、resize 安全
        // （GridRenderer 注释里警示的是 Sprite 蒙版即 AlphaMaskPipe 的悬挂引用问题）。
        const cellWrap = new Container();
        const cellMask = new Graphics();
        cellMask.rect(0, 0, CELL_SIZE, CELL_SIZE).fill({ color: 0xffffff });
        // v8: 蒙版恒为整格、恒启用——箭头像素被裁剪在自己格内（像素互斥的几何保证）。
        // StencilMask 靠 collectRenderables 把它画进模板缓冲（渲染时 colorMask.setMask(0)
        // 关颜色写入，蒙版形状不出现在最终画面）。形状从不清空重画，不触发 github #10290。
        cellMask.renderable = true;
        const sprite = new Sprite(this.pointerTex!);
        sprite.anchor.set(0.5);
        sprite.scale.set(this.pointerScale);
        sprite.tint = POINTER_TINT_NORMAL; // 黄色 pointer
        // whiteSprite：选中段叠加的白色 pointer，tint 白，alpha 随相位渐入渐出（见 update）
        const whiteSprite = new Sprite(this.pointerTex!);
        whiteSprite.anchor.set(0.5);
        whiteSprite.scale.set(this.pointerScale);
        whiteSprite.tint = 0xffffff;
        whiteSprite.visible = false;
        cellWrap.addChild(cellMask);
        cellWrap.addChild(sprite);
        cellWrap.addChild(whiteSprite);
        cellWrap.mask = cellMask;
        this.layer.addChild(cellWrap);
        entry = { sprite, whiteSprite, cellWrap, cellMask, handle, blockedBlend: 0, lastPtrAlpha: -1, lastExclReason: '' };
        this.entries.set(handle, entry);
      }

      const seg = this.world.getComponent<BeltSegmentComp>(handle, 'BeltSegmentComp')!;
      const pos = this.world.getComponent<Position>(handle, 'Position')!;

      // 堵塞渐变: 箭头黄 → 橙 #E6956F（blockedBlend 向目标 0/1 线性趋近）
      const blockedTarget = seg.blocked === true ? 1 : 0;
      const bb = entry.blockedBlend;
      entry.blockedBlend = bb < blockedTarget ? Math.min(blockedTarget, bb + blendStep)
        : bb > blockedTarget ? Math.max(blockedTarget, bb - blendStep) : bb;
      entry.sprite.tint = lerpColor(POINTER_TINT_NORMAL, POINTER_TINT_BLOCKED, entry.blockedBlend);

      // 蒙版容器对齐到格左上角世界坐标（蒙版正方形覆盖整个传送带单元）
      entry.cellWrap.position.set(pos.x, pos.y);

      // 每链独立相位: 同一链（chainId 相同）的段共享相位 → 链内 pointer 像自动扶梯
      // 一样均匀分布、跨格衔接连续（无重叠/跳变）；不同链相位不同（chainId 确定性
      // 派生）→ 并行传送带的指针动画互相独立，不再全局锁步（2026-08-25 用户实测:
      // 传送带创建时间不同，全局同步不符实际玩法）。
      const phase = (globalPhase + chainPhaseOf(seg.chainId)) % 1;

      // sprite 用格中心为原点的偏移；再换算到 cellWrap 本地坐标（减去半格）。
      const { x, y, rotation } = this.computePointerTransform(seg, phase);
      const px = CELL_SIZE / 2 + x;
      const py = CELL_SIZE / 2 + y;

      // 一格一物品（A9 §5.2.2；v8 终稿 2026-08-27 用户澄清"我要的就是队列前的箭头，
      // 不要闪动"）: 判定回归唯一规则——**本段 items 非空（含 entering 行走中）→ 隐藏，
      // 空格 → 箭头常驻稳定**，物品进格瞬间硬切（"物品替换箭头"）。v7/v7b 的邻接接近
      // 隐藏（物品压线/指针尖触邻物品即隐）会让箭头提前 0.6~0.9s 消失 = 闪动根源，已撤销；
      // 像素互斥改由整格蒙版几何保证: 箭头贴图永不出自己的格，物品过线时两者在格界两侧
      // 交接，既无像素共存也无提前消失。显隐跳变写入环形日志供实测覆盘。
      const gx = Math.round(pos.x / CELL_SIZE);
      const gy = Math.round(pos.y / CELL_SIZE);
      const selfHidden = (seg.items ?? []).length > 0;
      const ptrAlpha = selfHidden ? 0 : 1;
      const reason = selfHidden ? 'self' : 'restore';
      // 显隐跳变日志。lastPtrAlpha=-1 表示首次观测: 只记基线不入日志（否则每段
      // 画出来瞬间都会灌一条初始化噪声，淹没有效事件——用户实测反馈）。
      if (entry.lastPtrAlpha === -1) {
        entry.lastPtrAlpha = ptrAlpha;
        entry.lastExclReason = reason;
      } else if (entry.lastPtrAlpha !== ptrAlpha) {
        this.pointerLogRing.push({
          t: performance.now(),
          gx, gy,
          ev: ptrAlpha === 0 ? 'hide' : 'show',
          reason,
        });
        if (this.pointerLogRing.length > POINTER_LOG_MAX) this.pointerLogRing.shift();
        entry.lastPtrAlpha = ptrAlpha;
        entry.lastExclReason = reason;
        // 实时控制台输出（临时调试，见 POINTER_DEBUG_CONSOLE 注释）
        if (POINTER_DEBUG_CONSOLE) {
          console.log(
            `[指针] +${(performance.now() / 1000).toFixed(2)}s (${gx},${gy}) ` +
            `${ptrAlpha === 0 ? '隐藏' : '显示'}←${EXCL_REASON_CN[reason] ?? reason}`,
          );
        }
      }
      // 黄色 pointer（底层，始终显示，保证自动扶梯跨格衔接不断层）
      entry.sprite.position.set(px, py);
      entry.sprite.rotation = rotation;
      entry.sprite.alpha = ptrAlpha;
      entry.sprite.visible = true;
      // whiteSprite：选中段叠加白色 pointer，position/rotation 同 sprite（流动同步）。
      // alpha 随 globalPhase 余弦渐变——pointer 在格中间(phase≈0.5)全白，在格边界(phase≈0/1)
      // 渐隐到 0 → pointer 流经选中格时白色平滑出现再消失（黄→白→黄），不立即变白、不溢出、
      // 不断层（黄色底层始终在）。非选中段 whiteSprite.visible=false，只显示黄色底层。
      const selected = this.beltSelection?.has(handle) ?? false;
      if (selected) {
        entry.whiteSprite.position.set(px, py);
        entry.whiteSprite.rotation = rotation;
        // 白色 pointer 在格内大部分全白，仅入口/出口附近窄区渐变（贴近 Transport_2.svg：
        // pointer 一进入选中格就变白、即将离开时才褪回黄）。phase∈[0,FADE] 入口渐入，
        // [FADE,1-FADE] 格内全白，[1-FADE,1] 出口渐出。黄色底层始终在 → 跨格衔接不断层。
        const FADE = 0.18;
        const gp = phase;
        const selAlpha = gp < FADE
          ? gp / FADE
          : gp > 1 - FADE
            ? (1 - gp) / FADE
            : 1;
        entry.whiteSprite.alpha = selAlpha * ptrAlpha; // 选中白色同受一格一物品隐藏影响
        entry.whiteSprite.visible = true;
      } else {
        entry.whiteSprite.visible = false;
      }
    }
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
      // 转角格：指针沿圆弧走，端点就在格子边缘上；越界部分由整格蒙版裁掉。
      return this.computeCornerTransform(seg.entryDir, seg.direction, phase);
    }
    return this.computeStraightTransform(seg, phase);
  }

  /**
   * 直段 pointer：沿方向轴线性移动，箭头指向 dir（与物品流向一致）。
   * v8: 移动范围统一 [-0.5, +0.5]（不再做链首/链尾的 HALF_PTR 滑出扩展）——
   * 越界滑出与"箭头像素不出自己格"的整格蒙版矛盾，滑入/滑出由格边裁剪自然呈现。
   */
  private computeStraightTransform(
    seg: BeltSegmentComp,
    phase: number,
  ): { x: number; y: number; rotation: number } {
    const rotation = directionToIndex(seg.direction) * (Math.PI / 2);
    // 移动范围（相对格中心，单位=格）：[-0.5, +0.5]
    const moveRatio = phase - 0.5;
    const moveDist = moveRatio * CELL_SIZE;
    switch (seg.direction) {
      case 0:   return { x: moveDist, y: 0, rotation };
      case 90:  return { x: 0, y: moveDist, rotation };
      case 180: return { x: -moveDist, y: 0, rotation };
      case 270: return { x: 0, y: -moveDist, rotation };
    }
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