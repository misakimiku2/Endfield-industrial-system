// 渲染系统 — 把 ECS 实体（Position + SpriteComp）绑定到 PixiJS Sprite
// 依据: implementation-phase-1.md T1.6、A1 ecs-spec.md §4.3/§5、A2 world-model.md §4
//
// 核心机制 (A1 §5): 每帧 diff query 结果。
//   - 本帧有、上一帧没有 → 新建 Sprite，加到对应层 Container，存入 map。
//   - 上一帧有、本帧没有（实体被 destroyEntity 销毁或移除组件）→ 销毁 Sprite，
//     从父 Container 移除，删 map 项。这覆盖 ecs-spec §4.3 "销毁实体后由 RenderSystem
//     通过检测 isAlive/query 变化清理 PixiJS 对象"的职责。
//   - 仍在 → 同步 Position 到 sprite.position。
//
// 坐标: Sprite 加在 worldContainer 内的子层（layer0~5）上，Camera.updateTransform
//   已把 pivot/scale/rotation 写到 worldContainer，故 Sprite 只需用世界坐标——
//   相机平移/缩放/旋转(T1.5)自动正确，RenderSystem 不直接碰 zoom/rotation。
//   Position 存的是设备左上角世界坐标（A2 §2.4），Sprite anchor 设 0.5 居中，
//   故 sprite.position = (pos.x + width/2, pos.y + height/2)。
//
// 视口剔除: 屏幕外的 Sprite 仅切 visible=false（不销毁），进入视口再切回。
//   实体仍在 ECS 里，避免频繁进出视口反复 create/destroy。
//
// 纹理查找通过注入的 getTexture 函数（来自 AssetsLoader），使本类不直接 import
//   AssetsLoader，便于单测用 mock。

import { Sprite, Texture, Graphics, Container } from 'pixi.js';
import type { World, EntityHandle } from '../ECS';
import type { Position } from '../components/Position';
import type { SpriteComp } from '../components/SpriteComp';
import type { BuildingComp, LogoVisualState } from '../components/BuildingComp';
import { resolveLogoState } from '../components/BuildingComp';
import type { BeltSegmentComp } from '../components/BeltSegmentComp';
import { beltTextureRotation, beltCornerTransform } from './belt/BeltPathGeometry';
import { BeltPointerRenderer } from '../render/BeltPointerRenderer';
import { BeltVectorRenderer } from '../render/BeltVectorRenderer';
import { BeltItemRenderer } from '../render/BeltItemRenderer';
import { BeltHoverRenderer } from '../render/BeltHoverRenderer';
import { PortHighlightRenderer, PORT_CREATE_TINT, PORT_CREATE_HOVER_TINT } from '../render/PortHighlightRenderer';
import { buildNineSliceBase, buildNineSlicePorts, getBakedNineSliceTexture } from '../render/NineSliceAssembler';
import { emptyPortMask, portMaskFromDef } from '../render/PortMask';
import { getBuildingDefinition, type BuildingDefinition } from '../data/buildings';
import { outputPortCells } from './machine/OutputOps';
import { inputPortCells } from './machine/IntakeOps';
import { CELL_SIZE } from '../render/constants';
import type { BeltSelection } from './belt/BeltSelection';
import type { AtlasGroup } from '../render/AssetsLoader';
import type { SceneLayers } from '../render/SceneRenderer';
import type { Camera } from '../render/Camera';
import type { Renderer } from 'pixi.js';

/** 纹理查找函数（与 AssetsLoader.getTexture 同签名）。注入以便单测。 */
export type TextureLookup = (group: AtlasGroup, key: string) => Texture | undefined;

/** 缓存单个实体的渲染态：根节点 + 上次绑定用的 SpriteComp 摘要（变更时重建）。 */
interface SpriteEntry {
  /**
   * 渲染根节点。whole 设备/普通实体 = Sprite（anchor 0.5）；
   * nineslice 设备（T1.11c）= Container（原点=设备中心），子树 =
   * [九宫格底座容器, equipment Sprite, logo 子树]。position/rotation/scale/visible
   * 的每帧同步数学对两者一致（Container 同名属性）。
   */
  sprite: Sprite | Container;
  /** T1.11c: 本 entry 是否为九宫格底座设备（纹理 diff 键的一部分）。 */
  nineslice: boolean;
  /**
   * billboard 徽标子 Sprite（保持屏幕朝上）；无徽标时为 undefined。
   * T2.8 修订: 此层承载 LOGO 的**半透明 glow 底层**（refining_unit/logo-glow，状态切换不换），
   * 同时作为 logoMain 的旋转锚点容器（billboard 反向旋转挂在这层，主体作为子节点跟随）。
   */
  logo?: Sprite;
  /**
   * T2.8: LOGO 的**不透明主体层**（refining_unit/logo）。状态切换（paused/blocked）只换
   * 这层纹理——用户拍板"替换上层不透明的设备 logo，下方半透明 glow 不替换"。
   * 无徽标设备为 undefined。
   */
  logoMain?: Sprite;
  /** T2.8: 上次应用的 LOGO 视觉状态——仅在状态转换时换纹理（低频，无每帧开销）。 */
  logoState?: LogoVisualState;
  /** T2.8: 暂停徽标程序化兜底（素材缺失时显示，logoMain 的子节点跟随旋转）。 */
  pauseFallback?: Graphics;
  /** T2.8: 堵塞徽标程序化兜底。 */
  blockedFallback?: Graphics;
  /**
   * T2.12 仓库口 Status 面板（`${texture}/status` 白色层帧 × tint），挂在设备
   * 子树内、LOGO 之下（2026-08-24 用户反馈修订：高亮时 LOGO 仍可见且换白色）。
   * 普通设备无此帧 → undefined。创建模式外隐藏（常态灰面板烘在主帧里）。
   */
  statusSprite?: Sprite;
  /** T2.12: Status 面板可见时 LOGO 已切白色变体（避免每帧换纹理）。 */
  depotLogoWhite?: boolean;
  /** 上次绑定时的纹理标识；SpriteComp 的 group/textureKey 变了要换纹理。 */
  group: AtlasGroup;
  textureKey: string;
  layer: number;
  /** 基于 SpriteComp 尺寸 / 纹理尺寸的基准缩放（避免 width/height 与 scale 混用导致拉伸）。 */
  baseScaleX: number;
  baseScaleY: number;
}

/** 视口剔除的安全边距（世界像素）。让刚出屏的实体多保留一段距离再剔除，避免边缘闪烁。 */
const CULL_PADDING = 128;

/** T2.8 状态徽标纹理 key（devices 图集，Pause_Logo.svg / Blocked_Logo.svg）。 */
const PAUSED_LOGO_KEY = 'pause_logo';
const BLOCKED_LOGO_KEY = 'blocked_logo';
/**
 * T2.8 glow 层 tint（glow 帧 2026-08-18 改为白色源，颜色全部由 tint 控制）：
 * 正常/暂停 = 深灰 #494848（与原 SVG 灰 glow 视觉一致）；堵塞 = 红 #B10000
 * （用户要求"堵塞时第二层 logo 也变红"，与端口堵塞色同值）。
 */
const GLOW_TINT_NORMAL = 0x494848;
const GLOW_TINT_BLOCKED = 0xb10000;

/**
 * T2.8 状态徽标程序化兜底的绘制范围（logo Sprite 本地坐标，帧中心为原点）。
 * 与 SVG 素材图标区域同尺度（约帧宽 40%），素材缺失时视觉不缺位。
 */
const FALLBACK_SPAN = 34;

/**
 * 传送带 sprite 是否对齐屏幕整数像素。
 *
 * 修复"传送带外侧灰线"(grid 隐藏时仍可见)：之前用 BELT_OVERLAP=1.02 让相邻 sprite
 * 在 cell 边界重叠 1.28 world px 来盖住亚像素缝隙。但 sprite 内 source [0,40]/[216,256]
 * 朝 cell 边界方向是**透明边距**，重叠区两边都透明 → 显示背景色 #E6E4E4 米白 = 灰线。
 * 改用 roundPixels：sprite 严格 64 world px，但 sprite.position 对齐到屏幕整数像素。
 * 在非整数 zoom(如 1.37/1.91)下，sprite 边界不再落在亚像素上抗锯齿出"半像素透明"，
 * 而是吸收为半个像素的整体偏移，缝隙由透明背景与相邻 sprite 的实际色彩过渡自然覆盖。
 * 整数 zoom(1/4)本来就对齐，roundPixels 是无副作用的恒等变换。
 */
const BELT_ROUND_PIXELS = true;

/**
 * whole 整图路径的 LOGO 主体缩放（2026-08-24 用户反馈: 仓库口 LOGO 稍微缩小）。
 * logoMain 挂在已按 设备px/纹理px 缩放的父 Sprite 下，scale 1 = 原始相对大小；
 * 0.8 = 缩小 20%，让 3×1 设备的 LOGO 不顶满格。nineslice 路径（logoScale 显式
 * 传参）不受影响。PlacementSystem 放置预览同用此值保持所见即所得。
 */
export const LOGO_WHOLE_SCALE = 0.8;

/**
 * 把场景层（layer0~5）按层号取出来，供 Sprite 挂载。
 * SceneLayers 里 layer0~5 是固定数组顺序，此处显式列出保持可读性。
 */
const LAYER_CONTAINERS: (keyof SceneLayers)[] = [
  'layer0Terrain',
  'layer1Grid',
  'layer2Building',
  'layer3Item',
  'layer4Enemy',
  'layer5Effect',
];

export class RenderSystem {
  private world: World;
  private layers: SceneLayers;
  private camera: Camera;
  private getTexture: TextureLookup;
  /** T1.11c: 可选渲染器——nineslice 底座 RenderTexture 烘焙用；缺省（单测）回退逐切片容器。 */
  private renderer?: Renderer;

  /** handle → 渲染态。每帧 diff 维护。 */
  private entries = new Map<EntityHandle, SpriteEntry>();
  /** 传送带 pointer 流动渲染器（T2.0 阶段1）。挂在 layer3Item，盖在带身之上。 */
  private readonly pointerRenderer: BeltPointerRenderer;
  /** 传送带物品渲染器（T2.1）。挂在 layer3Item，与 pointer 同层（二者互斥：有物品隐 pointer）。 */
  private readonly beltItemRenderer: BeltItemRenderer;
  /** 传送带带身矢量渲染器（T2.0 方案A）。挂在 layer2Building，替代传送带 Sprite。 */
  private readonly beltVectorRenderer: BeltVectorRenderer;
  /** 传送带悬停高亮渲染器（橙色四角 L 形 + 呼吸）。挂在 layer2Building。 */
  private readonly beltHoverRenderer: BeltHoverRenderer;
  /** 端口连接高亮渲染器（T2.8: 连接黄 #FFEF00 / 堵塞红）。挂在 layer3Item（盖过设备纹理）。 */
  private readonly portHighlightRenderer: PortHighlightRenderer;
  /** T2.12: 创建模式查询（仓库口 Status 面板显隐用）。 */
  private isBeltCreationActive?: () => boolean;
  /** T2.12: 任意端口格悬停查询（含输入口——存货口高亮用）。 */
  private getHoveredAnyPortCell?: () => { x: number; y: number } | null;
  /** 从游戏开始累积的总毫秒数，驱动 pointer 相位与 hover 呼吸。由 update(deltaMS) 累积。 */
  private elapsedMS = 0;

  constructor(
    world: World,
    layers: SceneLayers,
    camera: Camera,
    getTexture: TextureLookup,
    renderer?: Renderer,
    isBeltCreationActive?: () => boolean,
    getHoveredPortCell?: () => { x: number; y: number } | null,
    getHoveredAnyPortCell?: () => { x: number; y: number } | null,
  ) {
    this.world = world;
    this.layers = layers;
    this.camera = camera;
    this.getTexture = getTexture;
    this.renderer = renderer;
    // T2.12: 创建模式/悬停查询自留（仓库口 Status 面板 + LOGO 白色切换用），
    // 前两个同时转发给 PortHighlightRenderer（普通设备端口染色）。
    this.isBeltCreationActive = isBeltCreationActive;
    this.getHoveredAnyPortCell = getHoveredAnyPortCell;
    this.pointerRenderer = new BeltPointerRenderer(world, layers.layer3Item, getTexture);
    // T2.8 层级修订（从下到上: 带身→物品→设备→端口高亮→箭头）:
    // belowItems 挂 layer2Building 且 zIndex=0.5（带身 0 之上、设备 1 之下）→
    // 所有传送带物品在带身上传输，进入设备 footprint 即被设备纹理遮挡（"钻到设备下方"）。
    const belowItems = new Container({ label: 'belowItems' });
    belowItems.zIndex = 0.5;
    layers.layer2Building.addChild(belowItems);
    this.beltItemRenderer = new BeltItemRenderer(world, layers.layer3Item, belowItems, getTexture);
    this.beltVectorRenderer = new BeltVectorRenderer(world, layers.layer2Building, isBeltCreationActive);
    this.beltHoverRenderer = new BeltHoverRenderer(world, camera, layers.layer2Building);
    this.portHighlightRenderer = new PortHighlightRenderer(
      world, layers.layer3Item, getTexture, isBeltCreationActive, getHoveredPortCell,
    );
  }

  /**
   * 注入传送带选中态（由 main.ts 在构造 SelectionSystem 后调用）。
   * 转发给三个带身渲染器：白边（VectorRenderer）、隐藏 pointer（PointerRenderer）、
   * 屏幕常量斜杠（SelectionRenderer）。
   */
  setBeltSelection(bs: BeltSelection): void {
    this.beltVectorRenderer.setBeltSelection(bs);
    this.pointerRenderer.setBeltSelection(bs);
  }

  /** 转发鼠标位置给悬停渲染器（main.ts onPointerMove 调用）。 */
  setBeltHoverMouse(screenX: number, screenY: number, inside: boolean): void {
    this.beltHoverRenderer.setMouse(screenX, screenY, inside);
  }

  /** 启用/禁用悬停高亮（创建模式 E 下禁用，避免与起点高亮冲突）。 */
  setBeltHoverEnabled(enabled: boolean): void {
    this.beltHoverRenderer.setEnabled(enabled);
  }

  /**
   * 每帧调用：同步 query 结果到 Sprite 集合，并做位置同步与视口剔除。
   * @param deltaMS 自上一帧的毫秒数（来自 Pixi ticker），用于累积 pointer 相位。默认 0 兼容旧调用。
   * @param alpha 仿真周期插值系数（accumulator/SIM_STEP，0~1），传给 BeltItemRenderer 做物品帧间插值。
   */
  update(deltaMS = 0, alpha = 0): void {
    this.elapsedMS += deltaMS;
    const visible = this.world.query('Position', 'SpriteComp');
    const seen = new Set<EntityHandle>(visible);

    // ── 1. 销毁本帧消失的实体对应的 Sprite ──
    for (const [handle, entry] of this.entries) {
      if (!seen.has(handle)) {
        this.disposeEntry(entry);
        this.entries.delete(handle);
      }
    }

    // ── 2. 视口可见世界范围（屏幕四角 world AABB + padding）──
    const view = this.computeVisibleBounds();

    // ── 3. 新增 + 位置/纹理同步 + 剔除 ──
    for (const handle of visible) {
      const pos = this.world.getComponent<Position>(handle, 'Position')!;
      const spr = this.world.getComponent<SpriteComp>(handle, 'SpriteComp')!;
      // 传送带段：带身由 BeltVectorRenderer 矢量渲染（替代 Sprite，消除缩放接缝）。
      // 这里跳过 Sprite 创建；SpriteComp 仍保留（占位/一致性），但不再被本系统渲染。
      if (this.world.getComponent<BeltSegmentComp>(handle, 'BeltSegmentComp')) continue;
      let entry = this.entries.get(handle);
      const building = this.world.getComponent<BuildingComp>(handle, 'BuildingComp');
      const beltSeg = this.world.getComponent<BeltSegmentComp>(handle, 'BeltSegmentComp');

      // 新实体 或 纹理/层级/底座方式变更 → (重新)绑定渲染节点。
      // nineslice 标志参与 diff：whole↔nineslice 切换（迁移期同一 textureKey 可能
      // 两种路径）必须重建，防旧 Sprite 残留（S2 §5.3 "纹理 diff 键防误重建"）。
      const def = building
        ? getBuildingDefinition(building.definitionId)
        : undefined;
      const isNineslice = def?.baseStyle === 'nineslice';
      if (
        !entry ||
        entry.group !== spr.group ||
        entry.textureKey !== spr.textureKey ||
        entry.layer !== spr.layer ||
        entry.nineslice !== isNineslice
      ) {
        if (entry) this.disposeEntry(entry);
        entry = this.createEntry(handle, spr, isNineslice);
        this.entries.set(handle, entry);
      }

      const sprite = entry.sprite;
      // 位置同步: 左上角 → 中心（anchor 0.5）
      sprite.position.set(pos.x + spr.width / 2, pos.y + spr.height / 2);

      // 朝向同步:
      // - 带 BuildingComp 的实体按 direction 旋转（A3 §3.3 世界朝向）。
      // - 带 BeltSegmentComp 的实体使用传送带纹理旋转（Transport_Belt_Move.svg 默认朝下）。
      //   转角段用 belt_corner：CW = 按出口方向旋转；CCW = 按出口方向旋转 + scale.x 取负（水平镜像）。
      //   预览/落盘/渲染三方共用 BeltPathGeometry 的同一套数学，保证一致。
      if (building) {
        sprite.scale.set(entry.baseScaleX, entry.baseScaleY);
        sprite.rotation = (building.direction * Math.PI) / 180;
      } else if (beltSeg) {
        if (beltSeg.isCorner && beltSeg.entryDir !== undefined) {
          const t = beltCornerTransform(beltSeg.entryDir, beltSeg.direction);
          sprite.rotation = t.rotation;
          // CCW 转角需要水平镜像：scale.x 取负值实现镜像，y 保持基准。
          // 注意：每帧都重新 set，避免上一帧的镜像/旋转遗留。
          // 严格 64 world px 精灵：避免朝 cell 外溢出造成"外侧灰线"（详见 BELT_ROUND_PIXELS 注释）。
          sprite.scale.set(t.mirrorH ? -entry.baseScaleX : entry.baseScaleX, entry.baseScaleY);
        } else {
          sprite.scale.set(entry.baseScaleX, entry.baseScaleY);
          sprite.rotation = beltTextureRotation(beltSeg.direction);
        }
      } else {
        sprite.scale.set(entry.baseScaleX, entry.baseScaleY);
        sprite.rotation = 0;
      }

      // billboard 徽标：反向旋转以保持屏幕朝上
      if (entry.logo) {
        entry.logo.rotation = this.camera.displayRotation - sprite.rotation;
        // T2.8 状态视觉: 按设备状态换 LOGO 纹理（paused 深灰暂停 / blocked 红X）。
        // 仅在状态转换时换纹理（低频），正常态不产生任何开销。
        if (building) {
          const st = resolveLogoState(building.paused, building.state);
          if (st !== entry.logoState) {
            entry.logoState = st;
            this.applyLogoVisual(entry, spr, st);
          }
        }
      }

      // T2.12 仓库口 Status 面板显隐/染色 + LOGO 白色切换（仅 statusSprite 存在的
      // 设备产生开销——普通设备 undefined 短路）。悬停匹配按端口世界格计算。
      if (entry.statusSprite && building && def) {
        this.applyDepotStatus(entry, building, def, pos, spr);
      }

      // 视口剔除: 实体世界 AABB 与可见范围无交集 → 隐藏
      sprite.visible = this.intersectsView(pos, spr, view);
    }

    // 传送带带身矢量渲染（T2.0 方案A）：在 Sprite 同步之后，刷新带身 Graphics 位置/朝向/选中变色。
    // 传入 deltaMS 驱动堵塞渐变（黄→红 平滑过渡，帧率无关）。
    this.beltVectorRenderer.update(deltaMS);
    // 传送带 pointer 流动：用 beltPhase + alpha（与物品同源，消除漂移/闪烁）；deltaMS 驱动箭头渐变
    this.pointerRenderer.update(alpha, deltaMS);
    // 传送带物品渲染（T2.1）：按 items 的 progress 画物品位置/纹理（alpha 帧间插值消除卡顿）
    this.beltItemRenderer.update(alpha);
    // 传送带悬停高亮（橙色四角 L 形 + 呼吸）
    this.beltHoverRenderer.update(this.elapsedMS);
    // 端口连接高亮（T2.8: 连接黄 / 堵塞红，逐端口半透明覆盖）；deltaMS 驱动黄→红渐变
    this.portHighlightRenderer.update(deltaMS);
  }

  /** 销毁所有 Sprite（场景切换/ teardown 用）。实体本身不动（由 ECS 管理）。 */
  clear(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
    this.beltVectorRenderer.destroy();
    this.pointerRenderer.destroy();
    this.beltItemRenderer.destroy();
    this.beltHoverRenderer.destroy();
    this.portHighlightRenderer.destroy();
  }

  /** 当前管理的 Sprite entry 数（T1.10 性能/内存监控用）。 */
  get spriteCount(): number {
    return this.entries.size;
  }

  /** 当前视口剔除后可见的 Sprite 数（T1.10 性能/内存监控用）。 */
  get visibleSpriteCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) {
      if (entry.sprite.visible) n++;
    }
    return n;
  }

  // ───────────────────────── 内部 ─────────────────────────

  private createEntry(handle: EntityHandle, spr: SpriteComp, nineslice: boolean): SpriteEntry {
    // T1.11c: 九宫格底座设备——根节点 = Container[底座拼装, equipment Sprite]。
    // texture 字段语义 = equipment 层帧 key（透明底纯设备内容），底座由
    // buildNineSliceBase 按 footprint 平铺 nineslice/* 切片。position/rotation
    // 数学与 whole Sprite 完全一致（update 循环无需分支）。
    if (nineslice) {
      return this.createNinesliceEntry(handle, spr);
    }
    const tex = this.getTexture(spr.group, spr.textureKey) ?? Texture.EMPTY;
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5);
    // sprite 屏幕变换对齐到整数像素：非整数 zoom 下消除亚像素接缝（整数 zoom 无副作用）。
    sprite.roundPixels = BELT_ROUND_PIXELS;
    // 用 scale 而非 width/height，因为后续 update 会根据朝向/镜像调整 scale.y；
    // width/height 与 scale 混用会导致覆盖尺寸（如 sprite.scale.y=1 把高度拉回纹理高度）。
    const baseScaleX = tex.width > 0 ? spr.width / tex.width : 1;
    const baseScaleY = tex.height > 0 ? spr.height / tex.height : 1;
    sprite.scale.set(baseScaleX, baseScaleY);
    this.layerContainer(spr.layer).addChild(sprite);

    // T2.12 仓库口 Status 面板（白色层帧 × tint），挂设备子树内、LOGO 之前 →
    // 渲染顺序: 设备纹理(含常态灰面板) < Status 高亮 < LOGO（2026-08-24 用户反馈:
    // 此前挂 layer3Item 会盖住 LOGO）。帧不存在（普通设备）→ undefined 零开销。
    // 子 scale 1: 父 Sprite 已按 设备px/纹理px 缩放，status 帧与主帧同画布。
    let statusSprite: Sprite | undefined;
    const statusTex = this.getTexture(spr.group, `${spr.textureKey}/status`);
    if (statusTex && statusTex.width > 0) {
      statusSprite = new Sprite(statusTex);
      statusSprite.anchor.set(0.5);
      statusSprite.visible = false;
      sprite.addChild(statusSprite);
    }

    const logoTree = this.buildLogoSubtree(spr, sprite);
    return {
      sprite, nineslice: false,
      ...logoTree,
      statusSprite,
      group: spr.group, textureKey: spr.textureKey, layer: spr.layer, baseScaleX, baseScaleY,
    };
  }

  /**
   * T1.11c: 创建九宫格设备的渲染子树。
   * 根 Container（原点=设备中心）→ [底座+端口, equipment Sprite, logo 子树]。
   * 底座+端口（T1.12: 按 def.ports 派生的四边掩码叠加 port- / lport- / deco- 系
   * 切片，S3 §5.1）：有 renderer 时走 RenderTexture 烘焙（每尺寸+掩码一张缓存纹理，
   * 单 Sprite，与原整帧 mip 行为一致——逐切片 ε 重叠在低 zoom mipmap 半透明区
   * 会双重绘制出暗斑）；无 renderer（单测）回退逐切片容器。
   * baseScale = 1：底座与 equipment 均按世界像素直接定尺寸，不靠根缩放。
   */
  private createNinesliceEntry(handle: EntityHandle, spr: SpriteComp): SpriteEntry {
    const building = this.world.getComponent<BuildingComp>(handle, 'BuildingComp');
    const def = building ? getBuildingDefinition(building.definitionId) : undefined;
    const { w, h } = def?.footprint ?? { w: spr.width / 64, h: spr.height / 64 };
    // 端口掩码从 def.ports 派生（无 def 时全零 = 纯底座，S3 §2 单一真相源）
    const mask = def ? portMaskFromDef(def) : emptyPortMask();

    const root = new Container({ label: `nineslice-device-${spr.textureKey}` });
    root.zIndex = 1; // 设备整体在传送带物品(belowItems 0.5)之上
    if (this.renderer) {
      // 烘焙纹理含 ±4px 窗口边距（透明），anchor 0.5 + scale 1 内容恰覆盖 footprint
      const base = new Sprite(getBakedNineSliceTexture(w, h, mask, this.renderer, this.getTexture));
      base.anchor.set(0.5);
      root.addChild(base);
    } else {
      root.addChild(buildNineSliceBase(w, h, this.getTexture));
      root.addChild(buildNineSlicePorts(w, h, mask, this.getTexture));
    }

    // equipment 层帧（texture 字段）：与底座同设备画布 → anchor 0.5 + 按设备
    // 世界尺寸缩放即可对齐（trim 帧的 texture.width 返回 orig 全画布尺寸）。
    const equipTex = this.getTexture(spr.group, spr.textureKey);
    if (equipTex && equipTex.width > 0) {
      const equip = new Sprite(equipTex);
      equip.anchor.set(0.5);
      equip.width = spr.width;
      equip.height = spr.height;
      root.addChild(equip);
    }

    this.layerContainer(spr.layer).addChild(root);
    // logo 帧为全画布尺寸（orig=设备画布），nineslice 根 scale=1 → 显式缩放到设备世界尺寸
    const glowTex = this.getTexture(spr.group, spr.logoTextureKey ? `${spr.logoTextureKey}-glow` : '');
    const logoScale = glowTex && glowTex.width > 0 ? spr.width / glowTex.width : undefined;
    const logoTree = this.buildLogoSubtree(spr, root, logoScale);
    return {
      sprite: root, nineslice: true,
      ...logoTree,
      group: spr.group, textureKey: spr.textureKey, layer: spr.layer,
      baseScaleX: 1, baseScaleY: 1,
    };
  }

  /**
   * 可选 billboard 徽标层（T2.8 修订为双层结构）：
   *   logo（本层）= 半透明 glow 底层（`${logoTextureKey}-glow`，状态切换**不换**），
   *                同时是 billboard 旋转锚点容器——反向旋转挂在这层，主体子节点跟随。
   *   logoMain（子层）= 不透明主体（logoTextureKey）——paused/blocked 时只替换这层。
   * scale: whole 路径父 Sprite 已按 设备px/纹理px 缩放，logo scale 1 继承即可；
   *   nineslice 路径根容器 scale 恒 1，logo 帧是全画布尺寸（sourceSize=设备画布），
   *   必须显式按 设备px/纹理px 缩放（T1.11c 修复: 否则 logo 以全画布世界尺寸绘制）。
   * T1.11c: 挂载父节点从 Sprite 泛化为 Container（nineslice 根也可带 logo）。
   */
  private buildLogoSubtree(
    spr: SpriteComp,
    parent: Container,
    logoScale?: number,
  ): Pick<SpriteEntry, 'logo' | 'logoMain' | 'pauseFallback' | 'blockedFallback'> {
    if (!spr.logoTextureKey) return {};
    const glowTex = this.getTexture(spr.group, `${spr.logoTextureKey}-glow`) ?? Texture.EMPTY;
    const logo = new Sprite(glowTex);
    logo.anchor.set(0.5);
    logo.scale.set(logoScale ?? 1);
    parent.addChild(logo);

    const mainTex = this.getTexture(spr.group, spr.logoTextureKey) ?? Texture.EMPTY;
    const logoMain = new Sprite(mainTex);
    logoMain.anchor.set(0.5);
    // whole 整图路径: 父 Sprite 已按设备尺寸缩放，logoMain 再乘 LOGO_WHOLE_SCALE(0.8)
    // 稍作缩小（2026-08-24 用户反馈: 仓库口 LOGO 顶满格）；nineslice 路径 logoScale
    // 已按 glow 帧显式换算，保持 1。
    logoMain.scale.set(logoScale ? 1 : LOGO_WHOLE_SCALE);
    logo.addChild(logoMain);

    // T2.8 状态徽标程序化兜底（InventoryUI 占位图先例）: 素材缺失时 Graphics 直画。
    // 挂 logoMain（替换的是主体层），默认隐藏，applyLogoVisual 按需切换。
    const s = FALLBACK_SPAN;
    const pauseFallback = new Graphics({ label: 'pauseLogoFallback' });
    pauseFallback
      .rect(-s * 0.88, -s, s * 0.5, s * 2)
      .rect(s * 0.38, -s, s * 0.5, s * 2)
      .fill({ color: 0x494848 }); // 深灰（与 Pause_Logo.svg 同色）
    pauseFallback.visible = false;
    logoMain.addChild(pauseFallback);

    const blockedFallback = new Graphics({ label: 'blockedLogoFallback' });
    blockedFallback
      .moveTo(-s, -s).lineTo(s, s)
      .moveTo(s, -s).lineTo(-s, s)
      .stroke({ width: s * 0.5, color: 0xe53935, cap: 'round' }); // 红 X（与 Blocked_Logo.svg 同色）
    blockedFallback.visible = false;
    logoMain.addChild(blockedFallback);

    return { logo, logoMain, pauseFallback, blockedFallback };
  }

  /**
   * T2.8: 应用 LOGO 视觉状态——paused/blocked 只换**主体层**（logoMain）纹理；
   * glow 底层纹理不变，但 tint 跟随状态（白源 glow 帧 × tint）:
   * 正常/暂停 = 深灰（原 glow 视觉）、堵塞 = 红（用户要求第二层也变红）。
   * 纹理缺失（如素材未打包）时置 EMPTY 并显示程序化兜底 Graphics，视觉不缺位。
   * 仅在状态转换时调用（update 中 logoState 变更检测）。
   */
  private applyLogoVisual(entry: SpriteEntry, spr: SpriteComp, st: LogoVisualState): void {
    if (!entry.logoMain) return;
    const key =
      st === 'paused' ? PAUSED_LOGO_KEY :
      st === 'blocked' ? BLOCKED_LOGO_KEY :
      spr.logoTextureKey;
    const tex = key ? this.getTexture(spr.group, key) : undefined;
    entry.logoMain.texture = tex ?? Texture.EMPTY;
    // glow 底层染色（白色源帧 × tint）
    if (entry.logo) {
      entry.logo.tint = st === 'blocked' ? GLOW_TINT_BLOCKED : GLOW_TINT_NORMAL;
    }
    if (entry.pauseFallback) {
      entry.pauseFallback.visible = st === 'paused' && !tex;
    }
    if (entry.blockedFallback) {
      entry.blockedFallback.visible = st === 'blocked' && !tex;
    }
  }

  /**
   * T2.12 仓库口 Status 面板（2026-08-24 用户反馈修订）:
   *   - 取货口（有输出口）: 创建模式常显蓝 #80BEE9（"可连接起点"提示），悬停任一
   *     输出端口格 → 淡蓝 #A8D4F5；
   *   - 存货口（无输出口）: 仅悬停其输入端口格时淡蓝（提示"传送带可接入此处"）。
   *   - **高亮时 LOGO 换白色变体**（`${logoTextureKey}_white` 帧；深色源无法用 tint
   *     提亮，走纹理切换，同 T2.8 暂停/堵塞换图机制），白色帧缺失 → 保持原 LOGO。
   * 非创建模式隐藏（常态灰面板烘在主帧里，由本面板覆盖）。
   */
  private applyDepotStatus(
    entry: SpriteEntry,
    building: BuildingComp,
    def: BuildingDefinition,
    pos: Position,
    spr: SpriteComp,
  ): void {
    const s = entry.statusSprite!;
    const create = this.isBeltCreationActive?.() ?? false;
    const hovered = create ? (this.getHoveredAnyPortCell?.() ?? null) : null;
    let hoverOut = false;
    let hoverIn = false;
    let hasOut = false;
    if (hovered) {
      const gx = Math.round(pos.x / CELL_SIZE);
      const gy = Math.round(pos.y / CELL_SIZE);
      for (const c of outputPortCells(gx, gy, def, building.direction)) {
        hasOut = true;
        if (c.x === hovered.x && c.y === hovered.y) hoverOut = true;
      }
      for (const c of inputPortCells(gx, gy, def, building.direction)) {
        if (c.x === hovered.x && c.y === hovered.y) hoverIn = true;
      }
    } else {
      hasOut = def.ports.some((p) => p.type === 'output');
    }
    s.visible = create && (hasOut || hoverIn);
    s.tint = hoverOut || hoverIn ? PORT_CREATE_HOVER_TINT : PORT_CREATE_TINT;

    // LOGO 纹理切换（首次必进: depotLogoWhite 未初始化）。⚠️ logoMain 是 logo(glow
    // 层)的子节点，继承父 tint——applyLogoVisual 常态会把父 tint 设为 #494848。
    // 仓库口**没有 glow 层**（EMPTY 帧），父 tint 只会错误压暗 logoMain——固定提到
    // 白，让 LOGO 按素材原色渲染: 常态 #494848、高亮白色变体。
    if (entry.logoMain && spr.logoTextureKey) {
      const wantWhite = s.visible;
      if (entry.depotLogoWhite === undefined || wantWhite !== entry.depotLogoWhite) {
        entry.depotLogoWhite = wantWhite;
        const key = wantWhite ? `${spr.logoTextureKey}_white` : spr.logoTextureKey;
        const tex = this.getTexture(spr.group, key);
        if (tex) {
          entry.logoMain.texture = tex; // 白色帧缺失 → 保持当前纹理（降级）
          if (entry.logo) entry.logo.tint = 0xffffff;
        }
      }
    }
  }

  private disposeEntry(entry: SpriteEntry): void {
    entry.logo?.removeFromParent();
    entry.logo?.destroy({ children: true }); // 连同 T2.8 fallback 子节点一并销毁
    const sprite = entry.sprite;
    sprite.removeFromParent();
    // T1.11c: nineslice 根是 Container，子树（底座切片/equipment）需随销毁；
    // whole Sprite 路径 logo 已单独移除销毁，children:true 无副作用。
    sprite.destroy({ children: true });
  }

  private layerContainer(layer: number): Container {
    const key = LAYER_CONTAINERS[layer];
    if (!key) {
      // 越界默认落到建筑层（防御性，正常不会触发）
      return this.layers.layer2Building;
    }
    return this.layers[key];
  }

  /** 屏幕四角 → 世界坐标 → AABB（旋转视图下视口是世界中的旋转矩形，四角 min/max 才是完整范围）。 */
  private computeVisibleBounds(): { minX: number; maxX: number; minY: number; maxY: number } {
    const vp = this.viewportOf();
    const corners = [
      this.camera.screenToWorld(0, 0),
      this.camera.screenToWorld(vp.width, 0),
      this.camera.screenToWorld(0, vp.height),
      this.camera.screenToWorld(vp.width, vp.height),
    ];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of corners) {
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.y > maxY) maxY = c.y;
    }
    return {
      minX: minX - CULL_PADDING,
      maxX: maxX + CULL_PADDING,
      minY: minY - CULL_PADDING,
      maxY: maxY + CULL_PADDING,
    };
  }

  /** Camera 当前没有暴露 viewport，这里复用 worldToScreen 的逆——直接从 Camera 取。
   *  Camera.viewport 是 private，故通过一个投影自检拿视口尺寸: 相机中心 → 屏幕 → 偏移。
   *  更直接: 给 Camera 增加只读 viewport 访问器（见 Camera.getViewport）。 */
  private viewportOf(): { width: number; height: number } {
    return this.camera.getViewport();
  }

  /** 实体世界 AABB 是否与可见范围相交。 */
  private intersectsView(
    pos: Position,
    spr: SpriteComp,
    view: { minX: number; maxX: number; minY: number; maxY: number },
  ): boolean {
    return !(
      pos.x + spr.width < view.minX ||
      pos.x > view.maxX ||
      pos.y + spr.height < view.minY ||
      pos.y > view.maxY
    );
  }
}
