// 放置系统 — 设备放置预览 + 放置落盘
// 依据: implementation-phase-1.md T1.7、A3 building-spec.md §5 (建造流程)、§3.3 (方向约定)、
//       A6 coordinate-spec.md §4.0 (viewRotation 参考系)、§2.3 (snapToCell)、§3 (网格吸附)
//
// 职责:
//   - 维护"放置模式"状态机（idle ↔ placing）
//   - placing 态下显示半透明预览 Sprite，跟随鼠标、吸附网格
//   - R 键旋转预览（相对视图），screenAngle 递增
//   - 左键确认 → 落盘创建真实 ECS 实体 + 占用 footprint (A3 §5)
//   - 右键 / ESC → 退出放置模式
//
// 预览不进 ECS（它是 UI 态），落盘才创建真实体。预览 Sprite 挂在 layer2Building
// （worldContainer 子层，受相机变换支配），退出放置模式时移除。
//
// ── R 键相对视图（本任务最易写错处，A6 §4.0 + A3 §3.3）──
//
// 玩家按 R 的手感是**屏幕相对**的：视图旋转后按 R，设备在屏幕上看起来转 90°。
// 实现核心: 维护 screenAngle（屏幕呈现角 0/90/180/270），按 R 永远 screenAngle += 90。
// **绝不直接对 direction 加 90**——这是防止出错的根本。
//
// 换算关系（A6 §4.0）: 世界朝向 = (屏幕朝向 − viewRotation + 360) % 360
//   即视图转 90° 后按一次 R(屏幕+90)，世界朝向不变(90−90=0)；连按两次才让世界+90。
//
// 关键统一: 预览 Sprite 在 buildingLayer(worldContainer 子层)，其 rotation 是**世界空间**内
//   的旋转角度，再被 camera 整体变换到屏幕。要在屏幕上呈现 screenAngle，预览 Sprite 的世界
//   rotation 必须 = screenAngle − viewRotation —— 这正是落盘时写入 BuildingComponent.direction
//   的同一公式。故预览渲染与落盘**共用同一世界角度**，无双轨，所见即所存。
//
// sprite.rotation 符号: PixiJS rotation 正值=顺时针(y 向下坐标系下视觉顺时针)。
//   设备 SVG 默认 0°朝向"朝右"(A3 §3.3)，按 R 期望屏幕顺时针转 90°。
//   故 sprite.rotation = +worldAngle_rad（worldAngle = screenAngle − viewRotation）。
//   若浏览器实测发现反向（设备逆时针转），改 ROTATION_SIGN 即可，单点修正。

import { Sprite, Texture } from 'pixi.js';
import type { World } from '../ECS';
import type { Camera } from '../render/Camera';
import type { SceneLayers } from '../render/SceneRenderer';
import type { TextureLookup } from './RenderSystem';
import type { AtlasGroup } from '../render/AssetsLoader';
import type { BuildingDefinition } from '../data/buildings';
import type { Direction } from '../components/BuildingComp';
import type { OccupancyMap } from '../world/OccupancyMap';
import { CELL_SIZE } from '../render/constants';
import { PreviewTintFilter } from '../render/PreviewTintFilter';
import { createBufferSlots } from './machine/BufferOps';

/** 放置模式状态。 */
export type PlacementMode = 'idle' | 'placing';

/** 屏幕呈现角（按 R 递增的量，0/90/180/270）。 */
type ScreenAngle = 0 | 90 | 180 | 270;

/**
 * sprite.rotation 的符号修正。+1 = sprite.rotation = +worldAngle_rad（标准约定）。
 * 若浏览器实测发现设备逆时针转，改 −1 重测。集中在常量便于单点修正。
 */
const ROTATION_SIGN = 1;

/**
 * 预览半透明度。
 * 染色由 PreviewTintFilter 完成（主体纯色 + 箭头白），不再用 Sprite.tint。
 */
const PREVIEW_ALPHA = 0.7;

/**
 * 放置系统。
 *
 * 输入由 main.ts 转发（不直接监听 DOM，避免与 CameraController 双监听冲突）:
 *   - onPointerDown(screenX, screenY, button): 鼠标按下（左键=确认，右键=取消）
 *   - onKeyDown(code): 键盘（KeyR=旋转，Escape=取消）
 *   - update(dt): 主循环每帧调用，更新预览跟随鼠标
 */
export class PlacementSystem {
  private world: World;
  private occupancy: OccupancyMap;
  private camera: Camera;
  private layers: SceneLayers;
  private getTexture: TextureLookup;

  /** 当前模式。 */
  mode: PlacementMode = 'idle';
  /** 当前选中的建筑定义（placing 态下非 null）。 */
  private currentDef: BuildingDefinition | null = null;
  /** 屏幕呈现角（按 R 递增）。 */
  private screenAngle: ScreenAngle = 0;
  /**
   * 预览 Sprite（placing 态下挂 buildingLayer，idle 时隐藏）。
   *
   * 染色方式（用户要求"设备整体直接变蓝、端口箭头变白"）:
   *   PreviewTintFilter 双纹理 mask 方案——设备原图染主体纯色（蓝/橙红），
   *   箭头 mask 纹理精确指示箭头区域 → 白。mask 由 pack-assets 构建期在矢量层
   *   分离箭头生成（不依赖颜色识别，避免端口灰色抗锯齿缝隙误染）。
   *
   *   仅作用于预览 Sprite；已放置设备用原图无 filter，保持原始外观。
   */
  private preview: Sprite | null = null;
  /** 预览染色 filter（主体纯色 + 箭头 mask 白）。按 canPlace 切换蓝/橙红。 */
  private previewFilter: PreviewTintFilter | null = null;
  /** 预览当前显示的纹理 key（def 变化时换纹理）。 */
  private previewTextureKey: string | null = null;
  /** 预览的 billboard 徽标子 Sprite（preview 的子节点，跟随 filter 染色并保持屏幕朝上）。 */
  private previewLogo: Sprite | null = null;

  /** 当前鼠标屏幕坐标（由 main 转发 pointermove 更新，或 update 时由调用方设置）。 */
  private mouseScreenX = 0;
  private mouseScreenY = 0;
  /** 鼠标是否在 canvas 内（用于 update 时决定是否显示预览）。 */
  private mouseInside = false;

  /** 预览当前是否有效（canPlace），用于 tint 反馈。外部只读。 */
  private previewValid = true;

  constructor(
    world: World,
    occupancy: OccupancyMap,
    camera: Camera,
    layers: SceneLayers,
    getTexture: TextureLookup,
  ) {
    this.world = world;
    this.occupancy = occupancy;
    this.camera = camera;
    this.layers = layers;
    this.getTexture = getTexture;
  }

  // ───────────────────────── 模式控制 ─────────────────────────

  /**
   * 进入放置模式（工具栏点击设备时调用）。
   * 若已在 placing 同一设备 → 切换关闭（toggle 语义，验收"再点同按钮取消"）。
   * 若已在 placing 不同设备 → 切换到新设备，screenAngle 重置。
   */
  enterMode(def: BuildingDefinition): void {
    if (this.mode === 'placing' && this.currentDef?.id === def.id) {
      this.exitMode();
      return;
    }
    this.currentDef = def;
    this.screenAngle = 0; // 每次进入重置屏幕角
    this.mode = 'placing';
    this.ensurePreview();
    this.preview!.visible = true;
    this.refreshPreview();
  }

  /** 退出放置模式（右键/ESC/切按钮时调用）。 */
  exitMode(): void {
    this.mode = 'idle';
    this.currentDef = null;
    if (this.preview) {
      this.preview.visible = false;
    }
  }

  /** 当前是否处于放置模式。 */
  isPlacing(): boolean {
    return this.mode === 'placing';
  }

  /** 当前选中的建筑 id（idle 态返回 null）。 */
  getCurrentDefinitionId(): string | null {
    return this.currentDef?.id ?? null;
  }

  /** 当前屏幕呈现角（调试/验收用）。 */
  getScreenAngle(): ScreenAngle {
    return this.screenAngle;
  }

  // ───────────────────────── 输入（由 main 转发）─────────────────────────

  /**
   * 更新鼠标屏幕坐标 + 是否在 canvas 内（main 的 pointermove 转发）。
   */
  setMouse(screenX: number, screenY: number, inside: boolean): void {
    this.mouseScreenX = screenX;
    this.mouseScreenY = screenY;
    this.mouseInside = inside;
  }

  /**
   * 鼠标按下（main 的 pointerdown 转发）。
   * @param button 0=左键(确认放置)，2=右键(取消)
   */
  onPointerDown(_screenX: number, _screenY: number, button: number): void {
    if (this.mode !== 'placing') return;
    if (button === 0) {
      // 左键: 尝试放置
      this.tryCommit();
    } else if (button === 2) {
      // 右键: 取消放置
      this.exitMode();
    }
  }

  /**
   * 键盘按下（main 的 keydown 转发）。只在 placing 态响应 R/Escape。
   * @param code KeyboardEvent.code（'KeyR' / 'Escape'）
   */
  onKeyDown(code: string): void {
    if (this.mode !== 'placing') return; // R 监听只在放置模式激活（用户强调）
    if (code === 'KeyR') {
      // R: 屏幕顺时针旋转 90°。绝不直接碰 direction（防错根本）。
      this.screenAngle = ((this.screenAngle + 90) % 360) as ScreenAngle;
      this.refreshPreview();
    } else if (code === 'Escape') {
      this.exitMode();
    }
  }

  // ───────────────────────── 主循环 ─────────────────────────

  /**
   * 每帧调用：更新预览跟随鼠标 + 有效性反馈。
   * @param _deltaMS 上一帧到本帧毫秒数（预留，Phase 1 暂未用）
   */
  update(_deltaMS: number): void {
    if (this.mode !== 'placing' || !this.preview || !this.currentDef) return;
    if (!this.mouseInside) {
      // 鼠标离开 canvas 时隐藏预览（避免预览停在最后位置）
      this.preview.visible = false;
      return;
    }
    this.preview.visible = true;
    this.refreshPreview();
  }

  // ───────────────────────── 内部 ─────────────────────────

  /** 确保预览 Sprite + 染色 filter 已创建（懒创建，首次 enterMode 时建）。 */
  private ensurePreview(): void {
    if (this.preview) return;
    this.preview = new Sprite(Texture.EMPTY);
    this.preview.anchor.set(0.5);
    this.preview.alpha = PREVIEW_ALPHA;
    this.preview.visible = false;
    // 高 zIndex: 预览浮在已放置设备之上（layer2Building 已开 sortableChildren）
    this.preview.zIndex = 10000;
    // 染色 filter: 主体纯色 + 端口白（可放置=蓝 / 不可放置=橙红）
    this.previewFilter = new PreviewTintFilter();
    this.preview.filters = [this.previewFilter];
    this.layers.layer2Building.addChild(this.preview);
  }

  /**
   * 刷新预览：换纹理/尺寸、定位到吸附网格、设置旋转、按 canPlace 切换 filter 颜色。
   *
   * 染色: PreviewTintFilter 双纹理 mask 采样——箭头 mask 指示区域 → 白，
   *   设备主体 → 纯色（可放置=蓝 #76BBEA / 不可放置=橙红 #FF8233）。
   */
  private refreshPreview(): void {
    if (!this.preview || !this.currentDef) return;
    const def = this.currentDef;

    const wp = def.footprint.w * CELL_SIZE; // footprint 世界像素宽
    const hp = def.footprint.h * CELL_SIZE;

    // 换纹理/尺寸（def 或 textureKey 变化时）
    if (this.previewTextureKey !== def.texture) {
      const tex = this.getTexture('devices', def.texture) ?? Texture.EMPTY;
      this.preview.texture = tex;
      this.preview.width = wp;
      this.preview.height = hp;
      this.previewTextureKey = def.texture;
      // 同步注入箭头 mask（双纹理 filter 用，精确识别箭头变白，避免端口灰色缝隙误染）
      this.previewFilter!.setMask(this.getTexture('devices', `${def.texture}_arrow_mask`));
    }

    // billboard 徽标层：作为 preview 子 Sprite，跟随 PreviewTintFilter 染色并保持屏幕朝上
    if (def.logoTextureKey) {
      if (!this.previewLogo) {
        this.previewLogo = new Sprite(Texture.EMPTY);
        this.previewLogo.anchor.set(0.5);
        this.previewLogo.alpha = PREVIEW_ALPHA;
        this.preview.addChild(this.previewLogo);
      }
      const logoTex = this.getTexture('devices', def.logoTextureKey) ?? Texture.EMPTY;
      if (this.previewLogo.texture !== logoTex) {
        this.previewLogo.texture = logoTex;
        // 继承父 Sprite 的缩放，避免再单独设 width/height 导致叠加缩小
        this.previewLogo.scale.set(1);
      }
      this.previewLogo.visible = true;
    } else if (this.previewLogo) {
      this.previewLogo.visible = false;
    }

    // 屏幕坐标 → 世界坐标 → 以鼠标为中心算 footprint 左上角（T1.7 修订：鼠标=设备中心）
    const world = this.camera.screenToWorld(this.mouseScreenX, this.mouseScreenY);
    const { w, h } = def.footprint;
    const place = placementFromMouse(world.x, world.y, w, h);
    // Sprite anchor 0.5 → position = 左上角世界 + 半宽高 = 设备中心（= 鼠标位置）
    this.preview.position.set(place.topLeftWorld.x + wp / 2, place.topLeftWorld.y + hp / 2);

    // 旋转: 世界角度 = screenAngle − viewRotation（A6 §4.0），与落盘 direction 同公式
    const worldAngle = this.worldAngleFromScreen();
    this.preview.rotation = ROTATION_SIGN * (worldAngle * Math.PI) / 180;
    // 同步 filter mask 旋转，使端口箭头跟随预览一起转
    this.previewFilter!.setRotation(this.preview.rotation);

    // billboard 徽标反向旋转（保持屏幕朝上）
    if (this.previewLogo && def.logoTextureKey) {
      this.previewLogo.rotation = this.camera.displayRotation - this.preview.rotation;
    }

    // 有效性反馈: filter 切换主体纯色（蓝↔橙红），箭头始终白
    this.previewValid = this.occupancy.canPlace(place.topLeftGrid.x, place.topLeftGrid.y, w, h);
    this.previewFilter!.setValid(this.previewValid);
  }

  /**
   * 计算当前的世界朝向 = (screenAngle − viewRotation + 360) % 360 (A6 §4.0)。
   * 预览容器.rotation 与落盘 BuildingComponent.direction 共用此值。
   */
  private worldAngleFromScreen(): Direction {
    const view = this.camera.viewRotation;
    return (((this.screenAngle - view) % 360) + 360) % 360 as Direction;
  }

  /**
   * 尝试落盘放置（左键确认时）。
   * canPlace 失败时不放置（预览已是红色反馈），成功则创建真实体 + 占用 footprint。
   */
  private tryCommit(): void {
    if (!this.currentDef) return;
    const def = this.currentDef;
    const world = this.camera.screenToWorld(this.mouseScreenX, this.mouseScreenY);
    const { w, h } = def.footprint;
    // 鼠标=设备中心 → footprint 左上角（与预览同算法，保证所见即所放）
    const place = placementFromMouse(world.x, world.y, w, h);
    const grid = place.topLeftGrid;
    const snap = place.topLeftWorld;

    if (!this.occupancy.canPlace(grid.x, grid.y, w, h)) {
      // 无法放置：预览已是橙红（refreshPreview 设的 tint），此处不额外动作
      return;
    }

    const direction = this.worldAngleFromScreen();
    const handle = this.world.createEntity();
    this.world.addComponent(handle, 'Position', { x: snap.x, y: snap.y });
    this.world.addComponent(handle, 'BuildingComp', {
      definitionId: def.id,
      direction,
      state: 'idle' as const,
      bufferInput: createBufferSlots(def.inputSlotCount), // T2.4: 放置即建输入缓冲区（全空槽）
      bufferOutput: createBufferSlots(def.outputSlotCount), // T2.5: 输出缓冲区（一槽一物，全空槽）
      currentRecipeId: null, // T2.5: 生产计时字段（A8 §3.1），放置时无生产任务
      progress: 0,
      elapsed: 0,
    });
    this.world.addComponent(handle, 'SpriteComp', {
      group: 'devices' as AtlasGroup,
      textureKey: def.texture,
      logoTextureKey: def.logoTextureKey,
      width: w * CELL_SIZE,
      height: h * CELL_SIZE,
      layer: 2,
    });
    this.occupancy.occupyFootprint(grid.x, grid.y, def, direction);

    // 保持放置模式，可连放（验收"左键点另一位置→第二个设备出现"）
    // 预览继续跟随鼠标，refreshPreview 会在下一帧更新 tint（新位置可能 valid/invalid）
  }

  /** 销毁预览 Sprite（teardown 用）。 */
  destroy(): void {
    if (this.preview) {
      this.preview.removeFromParent();
      this.preview.destroy();
      this.preview = null;
      this.previewLogo = null; // 子节点会随 preview 一起销毁
    }
  }
}

// ───────────────────────── 坐标工具（A2 §2.3，与 verify 脚本同实现）─────────────────────────

/**
 * 以**鼠标位置为设备中心**，计算 footprint 左上角 Cell 的 grid 坐标与世界像素坐标。
 *
 * 直觉约定（T1.7 修订）：玩家点击的位置应是设备**中心**，不是左上角。故从鼠标世界坐标
 * 减去半个 footprint 的像素偏移，得到左上角的"候选世界坐标"，再吸附到网格。
 *
 * ⚠️ 关键（修复"视觉与占用检查错位"bug）：topLeftWorld 必须**从 topLeftGrid 派生**，
 *   即 topLeftWorld = topLeftGrid * CELL。绝不能 grid 与 world 用不同舍入各自独立吸附——
 *   否则当候选坐标小数部分 ≥ 0.5 时，二者进位不一致，导致"预览画在 A，却检查 B"
 *   （用户看到不重叠却报橙红）。故 grid 与 world 必须用**同一**舍入函数。
 *
 * ⚠️ 舍入方向（修复"设备偏左上角"反馈，T1.7 第二轮修订）:
 *   早期版本用 floor（向下取整），对任意鼠标位置 topLeftGrid 总是偏小，导致设备中心
 *   **系统性偏左上**最多半格（如 3×3 设备中心比鼠标恒偏 (−32,−32)）。用户反馈
 *   "设备没出现在鼠标中间，偏左上角"。改用 round（向最近 Cell 取整）后，吸附方向
 *   对称：设备中心对鼠标的偏移在 ±半格内随机分布（而非恒向左上），鼠标更接近设备中心。
 *
 * 算法:
 *   tlx = mouseWorldX − halfFootprintPx            ← 左上角候选世界 X（未吸附）
 *   topLeftGrid  = round(tlx / CELL)               ← 左上角 Cell（向最近取整）
 *   topLeftWorld = topLeftGrid * CELL              ← 左上角世界像素（从 grid 派生，保证一致）
 *
 * @param mouseWorldX/Y  鼠标的世界像素坐标
 * @param w/h            footprint 宽高（Cell 数）
 * @returns topLeftGrid {x,y} = 左上角 Cell；topLeftWorld {x,y} = 左上角世界像素（从 grid 派生）
 */
function placementFromMouse(
  mouseWorldX: number,
  mouseWorldY: number,
  w: number,
  h: number,
): { topLeftGrid: { x: number; y: number }; topLeftWorld: { x: number; y: number } } {
  const halfW = (w * CELL_SIZE) / 2;
  const halfH = (h * CELL_SIZE) / 2;
  // 左上角的候选世界坐标（未吸附）
  const tlx = mouseWorldX - halfW;
  const tly = mouseWorldY - halfH;
  // grid 向最近 Cell 取整；world 严格从 grid 派生（topLeftGrid * CELL），保证视觉与占用一致
  const gridX = Math.round(tlx / CELL_SIZE);
  const gridY = Math.round(tly / CELL_SIZE);
  return {
    topLeftGrid: { x: gridX, y: gridY },
    topLeftWorld: { x: gridX * CELL_SIZE, y: gridY * CELL_SIZE },
  };
}
