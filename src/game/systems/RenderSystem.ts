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

import { Sprite, Texture, type Container } from 'pixi.js';
import type { World, EntityHandle } from '../ECS';
import type { Position } from '../components/Position';
import type { SpriteComp } from '../components/SpriteComp';
import type { BuildingComp } from '../components/BuildingComp';
import type { BeltSegmentComp } from '../components/BeltSegmentComp';
import { beltTextureRotation, beltCornerTransform } from './belt/BeltPathGeometry';
import { BeltPointerRenderer } from '../render/BeltPointerRenderer';
import { BeltVectorRenderer } from '../render/BeltVectorRenderer';
import { BeltHoverRenderer } from '../render/BeltHoverRenderer';
import type { BeltSelection } from './belt/BeltSelection';
import type { AtlasGroup } from '../render/AssetsLoader';
import type { SceneLayers } from '../render/SceneRenderer';
import type { Camera } from '../render/Camera';

/** 纹理查找函数（与 AssetsLoader.getTexture 同签名）。注入以便单测。 */
export type TextureLookup = (group: AtlasGroup, key: string) => Texture | undefined;

/** 缓存单个实体的渲染态：Sprite + 上次绑定用的 SpriteComp 摘要（变更时重建）。 */
interface SpriteEntry {
  sprite: Sprite;
  /** billboard 徽标子 Sprite，保持屏幕朝上；无徽标时为 undefined。 */
  logo?: Sprite;
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

  /** handle → 渲染态。每帧 diff 维护。 */
  private entries = new Map<EntityHandle, SpriteEntry>();
  /** 传送带 pointer 流动渲染器（T2.0 阶段1）。挂在 layer3Item，盖在带身之上。 */
  private readonly pointerRenderer: BeltPointerRenderer;
  /** 传送带带身矢量渲染器（T2.0 方案A）。挂在 layer2Building，替代传送带 Sprite。 */
  private readonly beltVectorRenderer: BeltVectorRenderer;
  /** 传送带悬停高亮渲染器（橙色四角 L 形 + 呼吸）。挂在 layer2Building。 */
  private readonly beltHoverRenderer: BeltHoverRenderer;
  /** 从游戏开始累积的总毫秒数，驱动 pointer 相位与 hover 呼吸。由 update(deltaMS) 累积。 */
  private elapsedMS = 0;

  constructor(
    world: World,
    layers: SceneLayers,
    camera: Camera,
    getTexture: TextureLookup,
  ) {
    this.world = world;
    this.layers = layers;
    this.camera = camera;
    this.getTexture = getTexture;
    this.pointerRenderer = new BeltPointerRenderer(world, layers.layer3Item, getTexture);
    this.beltVectorRenderer = new BeltVectorRenderer(world, layers.layer2Building);
    this.beltHoverRenderer = new BeltHoverRenderer(world, camera, layers.layer2Building);
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
   */
  update(deltaMS = 0): void {
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

      // 新实体 或 纹理/层级变更 → (重新)绑定 Sprite
      if (
        !entry ||
        entry.group !== spr.group ||
        entry.textureKey !== spr.textureKey ||
        entry.layer !== spr.layer
      ) {
        if (entry) this.disposeEntry(entry);
        entry = this.createEntry(handle, spr);
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
      const building = this.world.getComponent<BuildingComp>(handle, 'BuildingComp');
      const beltSeg = this.world.getComponent<BeltSegmentComp>(handle, 'BeltSegmentComp');
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
      }

      // 视口剔除: 实体世界 AABB 与可见范围无交集 → 隐藏
      sprite.visible = this.intersectsView(pos, spr, view);
    }

    // 传送带带身矢量渲染（T2.0 方案A）：在 Sprite 同步之后，刷新带身 Graphics 位置/朝向/选中变色
    this.beltVectorRenderer.update();
    // 传送带 pointer 流动（T2.0 阶段1）：刷新 pointer 位置/朝向/选中 tint
    this.pointerRenderer.update(this.elapsedMS);
    // 传送带悬停高亮（橙色四角 L 形 + 呼吸）
    this.beltHoverRenderer.update(this.elapsedMS);
  }

  /** 销毁所有 Sprite（场景切换/ teardown 用）。实体本身不动（由 ECS 管理）。 */
  clear(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
    this.beltVectorRenderer.destroy();
    this.pointerRenderer.destroy();
    this.beltHoverRenderer.destroy();
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

  private createEntry(_handle: EntityHandle, spr: SpriteComp): SpriteEntry {
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

    // 可选 billboard 徽标层：作为子 Sprite 叠加，并在 update 中反向旋转保持屏幕朝上
    // 注意：这里 scale 保持 1，让 logo 继承父 Sprite 的缩放；若单独设置 width/height 会再被父缩放一次导致过小
    let logo: Sprite | undefined;
    if (spr.logoTextureKey) {
      const logoTex = this.getTexture(spr.group, spr.logoTextureKey) ?? Texture.EMPTY;
      logo = new Sprite(logoTex);
      logo.anchor.set(0.5);
      logo.scale.set(1);
      sprite.addChild(logo);
    }

    return { sprite, logo, group: spr.group, textureKey: spr.textureKey, layer: spr.layer, baseScaleX, baseScaleY };
  }

  private disposeEntry(entry: SpriteEntry): void {
    entry.logo?.removeFromParent();
    entry.logo?.destroy();
    const sprite = entry.sprite;
    sprite.removeFromParent();
    sprite.destroy();
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
