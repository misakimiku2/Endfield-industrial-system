// 放置系统 — 设备放置预览 + 放置落盘
// 依据: implementation-phase-1.md T1.7、A3 building-spec.md §5 (建造流程)、§3.3 (方向约定)、
//       A6 coordinate-spec.md §4.0 (viewRotation 参考系)、§2.3 (snapToCell)、§3 (网格吸附)
//
// 职责:
//   - 维护"放置模式"状态机（idle ↔ placing）
//   - placing 态下显示半透明预览 Sprite，跟随鼠标、吸附网格（预览渲染委托
//     DevicePreview——T2.14 起与移动拾取预览共用同一组件，保证所见即所放双口径一致）
//   - R 键旋转预览（相对视图），screenAngle 递增
//   - 左键确认 → 落盘创建真实 ECS 实体 + 占用 footprint (A3 §5)
//   - 右键 / ESC → 退出放置模式
//
// 预览不进 ECS（它是 UI 态），落盘才创建真实体。
//
// ── R 键相对视图（本任务最易写错处，A6 §4.0 + A3 §3.3）──
//
// 玩家按 R 的手感是**屏幕相对**的：视图旋转后按 R，设备在屏幕上看起来转 90°。
// 实现核心: 维护 screenAngle（屏幕呈现角 0/90/180/270），按 R 永远 screenAngle += 90。
// **绝不直接对 direction 加 90**——这是防止出错的根本。
//
// 换算关系（A6 §4.0）: 世界朝向 = (屏幕朝向 − viewRotation + 360) % 360
//   即视图转 90° 后按一次 R(屏幕+90)，世界朝向不变(90−90=0)；连按两次才让世界+90。

import type { World } from '../ECS';
import type { Camera } from '../render/Camera';
import type { SceneLayers } from '../render/SceneRenderer';
import type { TextureLookup } from './RenderSystem';
import type { AtlasGroup } from '../render/AssetsLoader';
import type { BuildingDefinition } from '../data/buildings';
import { effectiveFootprint } from '../data/buildings';
import type { Direction } from '../components/BuildingComp';
import type { OccupancyMap } from '../world/OccupancyMap';
import { CELL_SIZE } from '../render/constants';
import { DevicePreview, placementFromMouse } from '../render/DevicePreview';
import { createBufferSlots } from './machine/BufferOps';
import { nextScreenAngle, type ScreenAngle } from './RotationPolicy';

/** 放置模式状态。 */
export type PlacementMode = 'idle' | 'placing';

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
  /** 预览渲染（T2.14 抽出 DevicePreview，与移动拾取预览共用）。 */
  private readonly devicePreview: DevicePreview;

  /** 当前模式。 */
  mode: PlacementMode = 'idle';
  /** 当前选中的建筑定义（placing 态下非 null）。 */
  private currentDef: BuildingDefinition | null = null;
  /** 屏幕呈现角（按 R 递增）。 */
  private screenAngle: ScreenAngle = 0;

  /** 当前鼠标屏幕坐标（由 main 转发 pointermove 更新，或 update 时由调用方设置）。 */
  private mouseScreenX = 0;
  private mouseScreenY = 0;
  /** 鼠标是否在 canvas 内（用于 update 时决定是否显示预览）。 */
  private mouseInside = false;

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
    this.devicePreview = new DevicePreview(layers, getTexture);
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
    this.devicePreview.hide(); // 内容/位置由下一帧 update 的 sync 刷新
  }

  /** 退出放置模式（右键/ESC/切按钮时调用）。 */
  exitMode(): void {
    this.mode = 'idle';
    this.currentDef = null;
    this.devicePreview.hide();
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
      // T2.17 起四档全开放: 90°/270° 旋转时非正方形占地宽高互换（effectiveFootprint），
      // 端口旋转、占用、渲染中心全部按有效占地计算，预览与落盘所见即所存。
      if (this.currentDef) {
        this.screenAngle = nextScreenAngle(this.screenAngle);
      }
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
    if (this.mode !== 'placing' || !this.currentDef) return;
    const w = this.camera.screenToWorld(this.mouseScreenX, this.mouseScreenY);
    this.devicePreview.sync({
      def: this.currentDef,
      camera: this.camera,
      occupancy: this.occupancy,
      mouseWorldX: w.x,
      mouseWorldY: w.y,
      screenAngle: this.screenAngle,
      visible: this.mouseInside,
    });
  }

  // ───────────────────────── 内部 ─────────────────────────

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
    // 先算朝向 → 有效占地（T2.17: 90°/270° 宽高互换），与预览同算法保证所见即所放
    const direction = this.worldAngleFromScreen();
    const { w: effW, h: effH } = effectiveFootprint(def.footprint, direction);
    const place = placementFromMouse(world.x, world.y, effW, effH);
    const grid = place.topLeftGrid;
    const snap = place.topLeftWorld;

    if (!this.occupancy.canPlace(grid.x, grid.y, effW, effH)) {
      // 无法放置：预览已是橙红（DevicePreview.sync 设的 tint），此处不额外动作
      return;
    }

    const handle = this.world.createEntity();
    this.world.addComponent(handle, 'Position', { x: snap.x, y: snap.y });
    this.world.addComponent(handle, 'BuildingComp', {
      definitionId: def.id,
      direction,
      state: 'idle' as const,
      paused: false, // T2.8: 玩家手动暂停（默认运行中）
      bufferInput: createBufferSlots(def.inputSlotCount), // T2.4: 放置即建输入缓冲区（全空槽）
      bufferOutput: createBufferSlots(def.outputSlotCount), // T2.5: 输出缓冲区（一槽一物，全空槽）
      inputPollIndex: 0, // T2.10: 输入轮询指针从定义序首口（左）开始
      outputPollQueue: [], // T2.21: 输出轮询队列=接收传送带 handle，首次有货出料时按创建序发现填入
      currentRecipeId: null, // T2.5: 生产计时字段（A8 §3.1），放置时无生产任务
      progress: 0,
      elapsed: 0,
      depotOutputItemId: null, // T2.15: 取货口产出物品（null=用定义默认源矿，弹窗可改）
    });
    this.world.addComponent(handle, 'SpriteComp', {
      group: 'devices' as AtlasGroup,
      textureKey: def.texture,
      logoTextureKey: def.logoTextureKey,
      // sprite 内容尺寸恒为 0° 朝向（未旋转）尺寸；90°/270° 的视觉旋转由
      // RenderSystem 按 direction 旋转、以有效占地中心为锚完成（T2.17）
      width: def.footprint.w * CELL_SIZE,
      height: def.footprint.h * CELL_SIZE,
      layer: 2,
    });
    this.occupancy.occupyFootprint(grid.x, grid.y, def, direction);

    // 保持放置模式，可连放（验收"左键点另一位置→第二个设备出现"）
    // 预览继续跟随鼠标，下一帧 sync 会更新 tint（新位置可能 valid/invalid）
  }

  /** 销毁预览节点与 filter（teardown 用）。 */
  destroy(): void {
    this.devicePreview.destroy();
  }
}
