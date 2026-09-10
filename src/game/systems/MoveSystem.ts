// 移动系统 — 已放置设备的搬迁（T2.14: 长按拾取 + R 旋转 + 左键重放 / 右键·ESC 取消）
// 依据: implementation-phase-2.md T2.14、A3 building-spec.md §2.2 (Port 旋转数学)、
//       A2 world-model.md §7 (占位表 release/occupy)、A6 §4.0 (viewRotation 参考系)
//
// 交互结构（T1.8 前瞻约束的落地）:
//   - SelectionSystem pointerdown 记时间戳 + 命中设备，pointerup 短按(<300ms) = 选中；
//     长按 ≥300ms 由 SelectionSystem 的定时器升级为本系统的 enterMove(handle)。
//   - 进入拾取态: 原占位 release（原位置可被其他操作占用）+ 真身 Sprite 隐藏 +
//     半透明预览（DevicePreview，与放置预览同款）跟随鼠标吸附网格。
//   - R 旋转: screenAngle += 90（相对视图，与放置系统同一 RotationPolicy）。
//   - 左键重放: canPlace(新朝向有效占地) 成功 → 更新 Position/direction + occupy 新占位；
//     失败 → 预览红 + 震动反馈，保持在移动态。
//   - 右键/ESC 取消: 设备放回原位原朝向（原占位重新 occupy）。
//
// 运行时状态保留（A2 §7 release/occupy 的组合语义）:
//   移动本质是 delete + place 的组合但**同一实体贯穿**——Position/direction 是仅有的
//   两个被改写的字段，BuildingComp 的 bufferInput/bufferOutput/progress/elapsed/
//   currentRecipeId 全部原样保留。搬迁期间的"离线"复用 T2.8 暂停语义: 临时置
//   comp.paused = true（不推进计时/不吞吐/放行已预约物品），结束（重放或取消）时还原
//   进入前的值——MachineSystem 零改动即获得"搬迁过程中不参与生产/轮询"。
//
// 传送带/物流连接: 连接判定（findFeederBelt/portStatuses/collectReceiverBelts）全部
//   是每 Tick 从几何实时计算的纯派生值，Port 世界坐标随 Position/direction 变化自动
//   重算；comp.outputPollQueue 中失效的带 handle 由 T2.21 队列同步自动剔除。传送带
//   不跟随移动（有意限制，需人工重新接驳）。
//
// Phase 3 前瞻（组操作原型）: enterMove/rotate/tryCommit/cancel + DevicePreview/
//   occupyFootprint/releaseFootprint 均不绑死"单设备"实现细节——组移动只需把
//   单 handle 换成 handle 集合、逐台校验目标格同时空闲。

import type { World, EntityHandle } from '../ECS';
import type { Camera } from '../render/Camera';
import type { SceneLayers } from '../render/SceneRenderer';
import type { RenderSystem, TextureLookup } from './RenderSystem';
import type { BuildingDefinition } from '../data/buildings';
import { getBuildingDefinition, effectiveFootprint } from '../data/buildings';
import type { BuildingComp, Direction } from '../components/BuildingComp';
import type { Position } from '../components/Position';
import type { OccupancyMap } from '../world/OccupancyMap';
import { CELL_SIZE } from '../render/constants';
import { DevicePreview, type PreviewSample } from '../render/DevicePreview';
import { nextScreenAngle, type ScreenAngle } from './RotationPolicy';

/** 放置失败（占位冲突）时预览震动反馈的持续时间 (ms)。 */
const SHAKE_MS = 220;
/** 震动幅度（世界像素）。 */
const SHAKE_AMPLITUDE = 4;
/** 震动频率（Hz，视觉上"抖两下"）。 */
const SHAKE_HZ = 34;

/**
 * 移动系统。
 *
 * 输入由 main.ts 转发（不直接监听 DOM）:
 *   - enterMove(handle): SelectionSystem 长按定时器 / 弹窗「移动」按钮调用
 *   - setMouse(screenX, screenY, inside): pointermove 转发
 *   - tryCommit(): 左键 pointerdown（重放）
 *   - cancel(): 右键 pointerdown / ESC 键 / 外部模式切换
 *   - rotate(): R 键
 *   - update(dt): 主循环每帧调用，预览跟随鼠标 + 震动反馈
 */
export class MoveSystem {
  private world: World;
  private occupancy: OccupancyMap;
  private camera: Camera;
  private renderSystem: RenderSystem;
  private readonly devicePreview: DevicePreview;

  /** 是否处于移动态。 */
  private moving = false;
  /** 移动中的设备 handle。 */
  private handle: EntityHandle | null = null;
  /** 移动中的设备定义（enterMove 时解析）。 */
  private def: BuildingDefinition | null = null;
  /** 进入移动态时的原位（footprint 左上角 Cell）与原朝向——取消时重占占位用。 */
  private origin: { gx: number; gy: number; direction: Direction } | null = null;
  /** 进入移动态前的 comp.paused 值（离线语义: 移动期间临时置 true，结束时还原）。 */
  private pausedBefore = false;
  /** 屏幕呈现角（初始 = 原朝向换算到当前视图，保证进入时朝向不变）。 */
  private screenAngle: ScreenAngle = 0;

  /** 当前鼠标屏幕坐标 / 是否在 canvas 内。 */
  private mouseScreenX = 0;
  private mouseScreenY = 0;
  private mouseInside = false;

  /** 最近一次预览采样（tryCommit/getPreviewInfo 用；未渲染过时 null）。 */
  private lastSample: PreviewSample | null = null;
  /** 震动反馈截止时刻（performance.now() 时钟；0 = 无震动）。 */
  private shakeUntil = 0;

  constructor(
    world: World,
    occupancy: OccupancyMap,
    camera: Camera,
    layers: SceneLayers,
    getTexture: TextureLookup,
    renderSystem: RenderSystem,
  ) {
    this.world = world;
    this.occupancy = occupancy;
    this.camera = camera;
    this.renderSystem = renderSystem;
    this.devicePreview = new DevicePreview(layers, getTexture);
  }

  // ───────────────────────── 状态查询 ─────────────────────────

  /** 当前是否处于移动态。 */
  isMoving(): boolean {
    return this.moving;
  }

  /** 移动中的设备 handle（非移动态返回 null）。 */
  getMovingHandle(): EntityHandle | null {
    return this.moving ? this.handle : null;
  }

  /**
   * 最近一次预览采样（调试/验收用）: 目标格、世界朝向、是否可放置。
   * 非移动态或预览尚未渲染过时返回 null。
   */
  getPreviewInfo(): { grid: { x: number; y: number }; direction: Direction; valid: boolean } | null {
    if (!this.moving || this.lastSample === null) return null;
    return {
      grid: { ...this.lastSample.grid },
      direction: this.lastSample.direction,
      valid: this.lastSample.valid,
    };
  }

  // ───────────────────────── 模式控制 ─────────────────────────

  /**
   * 进入移动态（长按 ≥300ms / 弹窗「移动」按钮）。
   * 原占位立即 release（原位置可被其他操作占用）+ 真身 Sprite 隐藏 + 设备临时离线
   * （复用 T2.8 暂停语义，进入前的 paused 值在重放/取消时还原）。
   * 已在移动态时先取消旧目标（放回原位）再拾取新目标。
   *
   * @returns true = 成功进入移动态
   */
  enterMove(handle: EntityHandle): boolean {
    if (this.moving) this.cancel();
    if (!this.world.isAlive(handle)) return false;
    const comp = this.world.getComponent<BuildingComp>(handle, 'BuildingComp');
    const pos = this.world.getComponent<Position>(handle, 'Position');
    if (!comp || !pos) return false; // 非设备实体（如测试 Sprite）不可移动
    const def = getBuildingDefinition(comp.definitionId);
    if (!def) return false;

    // 世界像素 → grid（Position 必然网格吸附，round 防御浮点误差）
    const gx = Math.round(pos.x / CELL_SIZE);
    const gy = Math.round(pos.y / CELL_SIZE);
    const direction = comp.direction;

    // ① 原位释放: footprint 占位让出（A2 §7），原位置可被其他操作占用
    this.occupancy.releaseFootprint(gx, gy, def, direction);
    // ② 离线: 复用 T2.8 暂停语义（不推进计时/不吞吐；进度保留在 comp 字段里）
    this.pausedBefore = comp.paused;
    comp.paused = true;
    // ③ 真身隐藏（预览接管视觉；RenderSystem 每帧维持该实体的 visible=false）
    this.renderSystem.setSpriteHidden(handle, true);

    this.handle = handle;
    this.def = def;
    this.origin = { gx, gy, direction };
    // 屏幕角初始化 = 原朝向换算到当前视图（worldAngle = screenAngle − viewRotation
    // 应等于原 direction）→ 进入移动态时朝向不变，按 R 才 +90。
    this.screenAngle = ((direction + this.camera.viewRotation) % 360) as ScreenAngle;
    this.lastSample = null;
    this.moving = true;
    return true;
  }

  /** R 键: 预览顺时针旋转 90°（相对视图，四档循环；Port 朝向跟随）。 */
  rotate(): void {
    if (!this.moving) return;
    this.screenAngle = nextScreenAngle(this.screenAngle);
  }

  /** 更新鼠标屏幕坐标 + 是否在 canvas 内（main 的 pointermove 转发）。 */
  setMouse(screenX: number, screenY: number, inside: boolean): void {
    this.mouseScreenX = screenX;
    this.mouseScreenY = screenY;
    this.mouseInside = inside;
  }

  /**
   * 左键重放: 在当前预览位置尝试落盘。
   * canPlace 失败 → 预览红（DevicePreview 染色）+ 震动反馈，保持在移动态。
   * 成功 → 更新 Position/direction + occupy 新占位 + 还原离线态/真身显示，退出移动态。
   *
   * @returns true = 重放成功
   */
  tryCommit(): boolean {
    if (!this.moving || this.def === null) return false;
    const sample = this.sampleNow();
    if (sample === null) return false;
    if (!sample.valid) {
      this.shakeUntil = performance.now() + SHAKE_MS; // 震动反馈，保持在移动态
      return false;
    }
    const handle = this.handle!;
    const comp = this.world.getComponent<BuildingComp>(handle, 'BuildingComp');
    const pos = this.world.getComponent<Position>(handle, 'Position');
    if (!comp || !pos) {
      this.cancel(); // 防御: 实体在移动期间被外部销毁 → 走取消清理
      return false;
    }
    // 同一实体贯穿: 只改写 Position/direction，缓冲区/进度/配方全部保留
    pos.x = sample.world.x;
    pos.y = sample.world.y;
    comp.direction = sample.direction;
    this.occupancy.occupyFootprint(sample.grid.x, sample.grid.y, this.def, sample.direction);
    // 还原离线态与真身显示
    comp.paused = this.pausedBefore;
    this.renderSystem.setSpriteHidden(handle, false);
    this.exitMode();
    return true;
  }

  /**
   * 取消（右键/ESC/外部模式切换）: 设备放回原位原朝向（原占位重新 occupy），
   * 还原离线态与真身显示，退出移动态。Position/direction 在移动期间从未被改动，
   * 无需恢复。防御: 实体已销毁 → 只清理移动态，不碰占用表（clearAllPlaced 等已清）。
   */
  cancel(): void {
    if (!this.moving) return;
    const handle = this.handle!;
    const def = this.def!;
    const origin = this.origin!;
    if (this.world.isAlive(handle)) {
      const comp = this.world.getComponent<BuildingComp>(handle, 'BuildingComp');
      if (comp) {
        const eff = effectiveFootprint(def.footprint, origin.direction);
        // 原位理论上必然空闲（移动期间放置/传送带创建均被门控拦截）；被占说明
        // 调试钩子绕过了门控——覆盖占位保"设备回原位"语义，并告警留痕。
        if (!this.occupancy.canPlace(origin.gx, origin.gy, eff.w, eff.h)) {
          console.warn(
            `[MoveSystem] 取消移动: 原位 (${origin.gx},${origin.gy}) 已被其他内容占用（调试钩子？），覆盖占位`,
          );
        }
        this.occupancy.occupyFootprint(origin.gx, origin.gy, def, origin.direction);
        comp.paused = this.pausedBefore;
      }
      this.renderSystem.setSpriteHidden(handle, false);
    }
    this.exitMode();
  }

  // ───────────────────────── 主循环 ─────────────────────────

  /**
   * 每帧调用: 预览跟随鼠标 + 有效性染色 + 震动反馈（重放失败后的短暂抖动）。
   */
  update(_deltaMS: number): void {
    if (!this.moving || this.def === null) return;
    const sample = this.sampleNow();
    if (sample === null) return;
    // 震动: 重放失败的可见反馈——在吸附位置上叠加衰减正弦横移（不改动采样/落盘坐标）
    const node = this.devicePreview.node;
    if (node !== null && performance.now() < this.shakeUntil) {
      const t = performance.now();
      node.x += Math.sin((t / 1000) * SHAKE_HZ * Math.PI * 2) * SHAKE_AMPLITUDE;
    }
  }

  /** 销毁预览（teardown 用）。 */
  destroy(): void {
    this.devicePreview.destroy();
  }

  // ───────────────────────── 内部 ─────────────────────────

  /** 退出移动态（commit/cancel 的公共收尾；占用/组件恢复由两者各自负责）。 */
  private exitMode(): void {
    this.moving = false;
    this.handle = null;
    this.def = null;
    this.origin = null;
    this.lastSample = null;
    this.shakeUntil = 0;
    this.devicePreview.hide();
  }

  /** 以当前鼠标位置采样预览（update/tryCommit 共用，保证所见即所放）。 */
  private sampleNow(): PreviewSample | null {
    if (!this.moving || this.def === null) return null;
    const w = this.camera.screenToWorld(this.mouseScreenX, this.mouseScreenY);
    this.lastSample = this.devicePreview.sync({
      def: this.def,
      camera: this.camera,
      occupancy: this.occupancy,
      mouseWorldX: w.x,
      mouseWorldY: w.y,
      screenAngle: this.screenAngle,
      visible: this.mouseInside,
    });
    return this.lastSample;
  }
}
