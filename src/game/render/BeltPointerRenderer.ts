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
//   - 2026-08-27: v7~v10 五轮重写（邻接隐藏/门口恒隐/全格裁剪/恒显遮挡/带面纹理化）
//     均被用户实测否决，本文件已回退到 v6 定稿状态；旧项目参考结论见
//     implementation-phase-2.md 第 12 条。
//
// PixiJS v8 注意：Graphics 作为 StencilMask，clear()+redraw 后模板缓冲不更新（github #10290）。
//   drawEndpointMask 重画后必须 cellWrap.mask=null 再绑回，否则蒙版形同虚设——曾导致起点
//   pointer 从传送带外面飘入。详见 update 中 isHead 分支的 workaround 注释。
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
  /** 选中格叠加的白色 pointer（tint 白，alpha 随相位渐入渐出）；非选中段 visible=false。 */
  whiteSprite: Sprite;
  /** 包裹 sprite 的容器（作为蒙版裁剪单元，位置=格左上角世界坐标）。 */
  cellWrap: Container;
  /** 单元蒙版（Graphics，走 StencilMask 路径，无纹理、resize 安全）。
   *  形状随端点类型变化（见 lastMaskKey），仅在 kind/direction 变化时重画，避免每帧 redraw 开销。 */
  cellMask: Graphics;
  /** 当前已画进 cellMask 的形状 key（kind+direction，避免每帧重画相同形状）。 */
  lastMaskKey: string;
  handle: EntityHandle;
  /** 堵塞渐变进度 0~1（箭头黄 → 橙 #E6956F）。每帧向目标趋近。 */
  blockedBlend: number;
}

/**
 * 蒙版形状种类。决定 cellMask 画什么形状：
 *  - 'none'：中间格，不裁（renderable=false、mask=null）。
 *  - 'head'：链首格，只裁"背向"方向那一侧（传送带真正的起点），其余三面向链内敞开。
 *  - 'tail'：链尾格，只裁"朝向"方向那一侧（传送带真正的终点），其余三面向链内敞开。
 *  - 'single'：单格链（head+tail 同格），两端都是尽头，完整格蒙版（两端都裁）。
 * 选中格不再单独用蒙版——改用 whiteSprite 叠层 + alpha 渐变实现"白色 pointer"，避免硬切断层。
 */
type MaskKind = 'none' | 'head' | 'tail' | 'single';

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
        sprite.tint = POINTER_TINT_NORMAL; // 黄色 pointer（常态底层，始终显示保证跨格衔接）
        // whiteSprite：选中段叠加的白色 pointer，tint 白，alpha 随相位渐入渐出（见 update）
        const whiteSprite = new Sprite(this.pointerTex!);
        whiteSprite.anchor.set(0.5);
        whiteSprite.scale.set(this.pointerScale);
        whiteSprite.tint = 0xffffff;
        whiteSprite.visible = false;
        cellWrap.addChild(cellMask);
        cellWrap.addChild(sprite);
        cellWrap.addChild(whiteSprite);
        this.layer.addChild(cellWrap);
        entry = { sprite, whiteSprite, cellWrap, cellMask, lastMaskKey: '', handle, blockedBlend: 0 };
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

      // 链端点格启用单元蒙版，pointer 从传送带边界出现/消失，不溢出到传送带之外：
      //  - head（链首）：裁起点侧（背向 direction），pointer 从起点边界出现。
      //  - tail（链尾）：裁终点侧（朝向 direction），pointer 在终点边界消失（不走出末端）。
      //  - single（单格链 head+tail 同格）：两端都是尽头，完整格蒙版（两端都裁）。
      // 中间格不蒙版，pointer 跨格衔接（N 格出口边 = N+1 格入口边，globalPhase 复位时下一格
      // 接管同一世界位置）→ 自动扶梯连贯流动。选中格不额外蒙版——白色靠 whiteSprite 叠层
      // 实现（黄色底层始终在，保证衔接不断层；蒙版对 sprite/whiteSprite 一视同仁地裁剪）。
      // isTail 可能在延长时由 true 翻 false（见 BeltCreationSystem.commitCells），
      // 故每帧按当前 seg 重新判定，不缓存端点状态。
      const isHead = seg.incomingDirection !== undefined;
      const isTail = seg.isTail;
      const maskKind: MaskKind = (isHead && isTail) ? 'single' : isHead ? 'head' : isTail ? 'tail' : 'none';
      if (maskKind === 'none') {
        // 中间格/链尾格：不蒙版。必须把 cellMask 的 renderable 关掉，否则那个白色填充正方形会
        // 当作普通子节点直接画出来。
        entry.cellMask.renderable = false;
        entry.cellWrap.mask = null;
      } else {
        // head：重画蒙版形状。缓存 key 含 direction（延长转弯时 head 方向变也要重画）。
        const maskKey = `${maskKind}:${seg.direction}`;
        if (entry.lastMaskKey !== maskKey) {
          this.drawEndpointMask(entry.cellMask, seg, maskKind);
          entry.lastMaskKey = maskKey;
          // PixiJS v8 regression（github #10290）：Graphics 作为 StencilMask，clear()+redraw
          // 后模板缓冲不更新（仍按旧 geometry 裁剪）→ 越界 pointer 不被裁，表现为起点 pointer
          // 从传送带外面飘入。workaround：重画后先把 mask 置 null 再绑回，强制重新采集新 geometry。
          entry.cellWrap.mask = null;
        }
        entry.cellMask.renderable = true;
        entry.cellWrap.mask = entry.cellMask;
      }

      // sprite 用格中心为原点的偏移；再换算到 cellWrap 本地坐标（减去半格）。
      const { x, y, rotation } = this.computePointerTransform(seg, phase);
      const px = CELL_SIZE / 2 + x;
      const py = CELL_SIZE / 2 + y;

      // 一格一物品（A9 §5.2.2，2026-08-25 用户定稿）: 该格显示**指针或物品二选一**——
      // 段上有物品（含 entering 行走中）→ 指针立即隐藏（物品替换箭头，硬切无过渡）；
      // 空段 → 指针与其他指针行为完全一致: 常显、随链相位流动，无任何渐隐/缓动/半径
      // 特殊效果。
      const ptrAlpha = (seg.items ?? []).length > 0 ? 0 : 1;
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
   * 画链端点格(head/tail/single)的蒙版形状到 cellMask（cellWrap 本地坐标，格左上角为原点）。
   *
   * 设计：端点格只在"真正是传送带尽头"的那一面裁剪，朝向链内的其余面全部敞开：
   *  - head（链首）：裁"背向 direction"面（起点）。沿 direction 正向延伸"敞开口"，
   *    使 pointer 越过入口边滑入时前端不被切，越界部分（滑出起点之外）才被裁掉。
   *  - tail（链尾）：裁"朝向 direction"面（终点）。沿 -direction 敞开。
   *  - single（单格链）：两端都是尽头，完整格蒙版（不敞开），pointer 只在格内可见。
   *
   * 实现为画一个覆盖"本格 + 敞开侧外延"的矩形（加法），而不是画 U 形多边形——
   * 矩形蒙版更简单、且 StencilMask 对凸形状无歧义。
   *
   * 敞开量 OPEN = 半格：足够覆盖 pointer 前端越界（pointer 高度 0.25 格，moveRange 端点侧
   * 扩展 0.125 格，前端最多越过边界 ~0.125+0.125=0.25 格 < 0.5 格敞开口）。
   *
   * @param kind 'head' | 'tail' | 'single'。
   */
  private drawEndpointMask(cellMask: Graphics, seg: BeltSegmentComp, kind: 'head' | 'tail' | 'single'): void {
    cellMask.clear();
    if (kind === 'single') {
      // 单格链：两端都是尽头，完整格蒙版（pointer 只在格内可见，两端渐入/渐出）
      cellMask.rect(0, 0, CELL_SIZE, CELL_SIZE).fill({ color: 0xffffff });
      return;
    }
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
