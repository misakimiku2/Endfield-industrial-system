// 选中系统 — 点击设备选中 + 屏幕空间选中框
// 依据: implementation-phase-1.md T1.8、A3 building-spec.md §1 (selectable)、
//       A2 world-model.md §2.4 (Position=左上角)、A6 §4 (worldToScreen)
//
// 交互结构（T1.8 前瞻约束，为 Phase 2 T2.14 长按移动预留）:
//   - 用 pointerdown/pointerup 结构，不用 click 事件
//   - pointerdown: 记录按下时间戳 + 命中的设备（不立即 commit，不吞后续事件）
//   - pointerup: 判定"短按(<300ms) → 选中/取消"；长按(≥300ms) Phase 1 无移动语义，
//     不产生任何选中变更。Phase 2 只需在 pointerdown 后挂 300ms 定时器:
//     定时器触发前 pointerup = 选中（走本类原逻辑），定时器触发 = 升级为移动态。
//
// 命中测试: 遍历带 Position+SpriteComp+BuildingComp 的实体，用 footprint 世界 AABB
//   做点包含测试（Phase 1 全部 footprint 为正方形，旋转不改变 AABB，A3 §6）。
//   同时尊重 BuildingDefinition.selectable（A3 §1 字段，Phase 1 全 true）。
//
// 选中框渲染: 屏幕空间 Graphics（挂 overlayLayer，zIndex 负数 = 工具栏之下）。
//   每帧用 camera.worldToScreen 求设备 footprint 四角 → 白色矩形描边。
//   屏幕空间画法保证线宽恒定屏幕像素（不随 zoom 变粗/变细），
//   并天然跟随相机平移/缩放/旋转过渡（worldToScreen 用 displayRotation）。
//   纯白色 4px 主线（用户要求: 粗一些、不要黑色描边）。

import { Graphics } from 'pixi.js';
import type { World, EntityHandle } from '../ECS';
import type { Camera } from '../render/Camera';
import type { SceneLayers } from '../render/SceneRenderer';
import type { Position } from '../components/Position';
import type { SpriteComp } from '../components/SpriteComp';
import type { BuildingComp } from '../components/BuildingComp';
import { getBuildingDefinition } from '../data/buildings';

/** 短按阈值 (ms)。pointerup 时按下时长 < 此值 → 选中；≥ 此值 = 长按（Phase 2 移动态用）。 */
export const SELECTION_SHORT_PRESS_MS = 300;

/** 选中框主线宽（屏幕像素，用户要求加粗）。 */
const SELECTION_LINE_WIDTH = 4;
/** 选中框主线颜色（纯白，T1.8 验收标准）。 */
const SELECTION_LINE_COLOR = 0xffffff;

/**
 * 命中测试: 屏幕点对应世界坐标 (wx,wy) 落在哪个设备的 footprint AABB 内。
 *
 * 只考虑带 BuildingComp 的实体（T1.7 的语义对象），不会误选同样带 SpriteComp
 * 的传送带/敌人/测试 Sprite。尊重 def.selectable；def 缺失时按可选处理
 * （防御性，正常不会发生）。
 *
 * @returns 命中的实体 handle；未命中返回 null。
 */
export function pickBuildingAt(
  world: World,
  wx: number,
  wy: number,
): EntityHandle | null {
  for (const handle of world.query('Position', 'SpriteComp', 'BuildingComp')) {
    const building = world.getComponent<BuildingComp>(handle, 'BuildingComp')!;
    const def = getBuildingDefinition(building.definitionId);
    if (def && !def.selectable) continue;

    const pos = world.getComponent<Position>(handle, 'Position')!;
    const spr = world.getComponent<SpriteComp>(handle, 'SpriteComp')!;
    // 世界 AABB: Position = footprint 左上角 (A2 §2.4)，宽高 = cells × CELL_SIZE。
    // Phase 1 footprint 全正方形，direction 旋转不改变 AABB (A3 §6)。
    if (
      wx >= pos.x && wx <= pos.x + spr.width &&
      wy >= pos.y && wy <= pos.y + spr.height
    ) {
      return handle;
    }
  }
  return null;
}

/**
 * 计算选中框的屏幕四边形顶点（footprint 四角经 worldToScreen 投影）。
 * 实体已销毁/缺组件时返回 null。
 */
export function buildingScreenPolygon(
  camera: Camera,
  world: World,
  handle: EntityHandle,
): Array<{ x: number; y: number }> | null {
  if (!world.isAlive(handle)) return null;
  const pos = world.getComponent<Position>(handle, 'Position');
  const spr = world.getComponent<SpriteComp>(handle, 'SpriteComp');
  if (!pos || !spr) return null;

  return [
    camera.worldToScreen(pos.x, pos.y),
    camera.worldToScreen(pos.x + spr.width, pos.y),
    camera.worldToScreen(pos.x + spr.width, pos.y + spr.height),
    camera.worldToScreen(pos.x, pos.y + spr.height),
  ];
}

/**
 * 选中系统。
 *
 * 输入由 main.ts 转发（不直接监听 DOM，避免与 CameraController 双监听冲突）:
 *   - onPointerDown(screenX, screenY, button, now): 记录时间戳 + 命中设备
 *   - onPointerUp(now): 短按提交选中/取消
 *   - update(): 每帧重绘选中框（跟随相机），并清理已销毁实体
 */
export class SelectionSystem {
  private world: World;
  private camera: Camera;
  /** 屏幕空间选中框（overlayLayer 子节点，工具栏之下）。 */
  private graphics: Graphics;
  /** 当前选中的实体；null = 未选中。 */
  private selected: EntityHandle | null = null;
  /** pointerdown 记录的按压上下文（T1.8 前瞻约束）。 */
  private pendingPress: { hit: EntityHandle | null; time: number } | null = null;
  /** 最近一次绘制时选中框的屏幕左上角（HUD/调试用，未选中时为 null）。 */
  private lastBoxTopLeft: { x: number; y: number } | null = null;

  constructor(world: World, camera: Camera, layers: SceneLayers) {
    this.world = world;
    this.camera = camera;
    this.graphics = new Graphics({ label: 'selectionBox' });
    // 负 zIndex → 永远在 overlayLayer 常规 UI（工具栏 zIndex 0）之下，
    // 避免选中框盖到工具栏按钮；仍高于 worldContainer（overlayLayer 整体在上）。
    this.graphics.zIndex = -10;
    this.graphics.visible = false;
    layers.overlayLayer.addChild(this.graphics);
  }

  /**
   * 鼠标按下（main 的 pointerdown 转发）。
   * 只消费左键；中键拖拽/右键由相机/放置系统处理。
   * 这里只记录，不 commit、不 preventDefault/stopPropagation（前瞻约束）。
   */
  onPointerDown(screenX: number, screenY: number, button: number, now: number): void {
    if (button !== 0) return;
    const world = this.camera.screenToWorld(screenX, screenY);
    this.pendingPress = {
      hit: pickBuildingAt(this.world, world.x, world.y),
      time: now,
    };
  }

  /**
   * 鼠标抬起（main 的 pointerup 转发）。
   * 短按(<300ms) → 提交选中（命中设备=选中，命中空白=取消）。
   * 长按(≥300ms) → Phase 1 无移动语义，不改变选中（Phase 2 由定时器接管为移动态）。
   */
  onPointerUp(now: number): void {
    if (!this.pendingPress) return;
    const { hit, time } = this.pendingPress;
    this.pendingPress = null; // 一次性消费
    if (now - time < SELECTION_SHORT_PRESS_MS) {
      this.selected = hit;
      if (hit === null) {
        // 点空白 → 取消选中: 必须立即隐藏并清除已绘制的选中框。
        // 否则 Graphics 会保留最后一张几何，框"印在画布上"，
        // 且 update() 因 selected===null 直接 return，永远不会清掉它。
        this.hideBox();
      }
    }
  }

  /**
   * 每帧调用（在 camera.updateTransform 之后）:
   *   选中实体存活 → 重绘选中框（跟随相机）；已销毁 → 清空选中态。
   */
  update(): void {
    if (this.selected === null) {
      // 防御: 未选中时确保不残留旧几何（正常路径已在 onPointerUp/clearSelection 隐藏，
      // 这里兜底，防止任何遗漏路径把框留在画布上）。
      this.hideBox();
      return;
    }
    if (!this.world.isAlive(this.selected)) {
      // 实体被销毁（如 T1.9 删除）→ 选中态清空，选中框消失
      this.selected = null;
      this.hideBox();
      return;
    }
    this.drawBox();
  }

  /** 当前选中的实体 handle（调试/验收/T1.9 删除用）。 */
  getSelected(): EntityHandle | null {
    return this.selected;
  }

  /**
   * 最近一次绘制的选中框屏幕左上角（调试/HUD 用）。
   * 未选中或坐标非法时返回 null。
   */
  getBoxTopLeft(): { x: number; y: number } | null {
    return this.lastBoxTopLeft;
  }

  /** 清空选中态（T1.9 删除设备后调用，或外部重置）。 */
  clearSelection(): void {
    this.selected = null;
    this.hideBox();
  }

  /**
   * 隐藏并清除选中框图形（清空 lastBoxTopLeft）。
   * selected===null 时的所有出口都必须经过这里。
   */
  private hideBox(): void {
    this.lastBoxTopLeft = null;
    this.graphics.visible = false;
    this.graphics.clear();
  }

  /** 销毁选中框（teardown 用）。 */
  destroy(): void {
    this.graphics.removeFromParent();
    this.graphics.destroy();
  }

  // ───────────────────────── 内部 ─────────────────────────

  /** 重绘选中框: footprint 四角 → 屏幕四边形 → 白色描边 + 深色外描边。 */
  private drawBox(): void {
    const pts = buildingScreenPolygon(this.camera, this.world, this.selected!);
    if (!pts) {
      // 实体刚被销毁但 update 尚未跑（防御），隐藏即可
      this.hideBox();
      return;
    }

    // 防御: 任一顶点非有限值（NaN/Infinity）时跳过绘制并隐藏，
    // 避免脏坐标渲染出异常位置/形状的图形。
    for (const p of pts) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        console.warn('[SelectionSystem] 选中框坐标非有限值，已隐藏:', pts);
        this.lastBoxTopLeft = null;
        this.graphics.visible = false;
        this.graphics.clear();
        return;
      }
    }

    // 像素对齐（取整）→ 线条更锐利，避免落在半像素上发糊
    const snapped = pts.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));

    const g = this.graphics;
    g.clear();
    // 纯白主线 (验收标准: 白色选中框，矩形描边；用户要求无黑边、线加粗)
    g.poly(snapped).stroke({ width: SELECTION_LINE_WIDTH, color: SELECTION_LINE_COLOR, alpha: 1 });
    g.visible = true;
    this.lastBoxTopLeft = { x: snapped[0].x, y: snapped[0].y };
  }
}
