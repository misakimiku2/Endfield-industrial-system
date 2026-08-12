// 传送带悬停高亮渲染器 — T2.0 选择/悬停重构
// 设计依据：Transport_1.svg 的"选择框"（layer1，#ffcb00 四角 L 形边框）。
//
// 职责：
//   - 鼠标悬停在传送带段上时，在该格画 4 个橙色 L 形角（四角边框）。
//   - 四角随时间平稳呼吸（向内收拢再展开），周期 1.6s。
//   - 创建模式(E)下、鼠标离开 canvas 时不显示。
//
// 复用：pickBeltSegmentAt（SelectionSystem 导出）做命中检测，camera.screenToWorld 做坐标转换。
// 单个 Graphics 每帧重画（只有 1 格，开销可忽略）。

import { Graphics, type Container } from 'pixi.js';
import type { World } from '../ECS';
import type { Camera } from './Camera';
import type { Position } from '../components/Position';
import { pickBeltSegmentAt } from '../systems/SelectionSystem';
import { CELL_SIZE } from './constants';

/** 四角边框颜色（Transport_1.svg layer1 fill = #FFCB00）。 */
const HOVER_CORNER_COLOR = 0xffcb00;
/** L 形角线宽（世界像素，对应 SVG stroke-width 换算 ≈5px）。 */
const CORNER_W = 5;
/** L 形角臂长（世界像素，对应 SVG 臂长 ≈15px）。 */
const CORNER_L = 15;
/** 呼吸：外角距格边的基准（px），收拢时最大 = BASE + AMP。 */
const BREATH_BASE = 2;
const BREATH_AMP = 3;
/** 呼吸周期（毫秒）。 */
const BREATH_PERIOD_MS = 1600;

/**
 * 传送带悬停高亮渲染器。鼠标悬停时显示橙色四角 L 形边框 + 呼吸。
 *
 * 用法：main.ts onPointerMove 调 setMouse；RenderSystem.update 调 update(elapsedMS)；
 * 创建模式(E)切换时调 setEnabled。
 */
export class BeltHoverRenderer {
  private world: World;
  private camera: Camera;
  private g: Graphics;

  /** 鼠标屏幕坐标 + 是否在 canvas 内（外部每次 move 调 setMouse 更新）。 */
  private mouseSX = 0;
  private mouseSY = 0;
  private mouseInside = false;
  /** 是否启用（创建模式 E 下禁用，避免与起点高亮冲突）。 */
  private enabled = true;

  constructor(world: World, camera: Camera, layer: Container) {
    this.world = world;
    this.camera = camera;
    this.g = new Graphics({ label: 'beltHover' });
    this.g.zIndex = 15000; // 盖在带身之上、预览之下
    this.g.visible = false;
    layer.addChild(this.g);
  }

  /** 外部转发鼠标屏幕坐标（main.ts onPointerMove 调用）。 */
  setMouse(screenX: number, screenY: number, inside: boolean): void {
    this.mouseSX = screenX;
    this.mouseSY = screenY;
    this.mouseInside = inside;
  }

  /** 启用/禁用（创建模式 E 下禁用）。 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** 每帧刷新悬停高亮（主循环 RenderSystem.update 调用）。 */
  update(elapsedMS: number): void {
    if (!this.enabled || !this.mouseInside) {
      this.g.visible = false;
      return;
    }
    const w = this.camera.screenToWorld(this.mouseSX, this.mouseSY);
    const handle = pickBeltSegmentAt(this.world, w.x, w.y);
    if (handle === null) {
      this.g.visible = false;
      return;
    }
    const pos = this.world.getComponent<Position>(handle, 'Position');
    if (!pos) {
      this.g.visible = false;
      return;
    }
    // 定位到格左上角（L 形角用相对格左上角的本地坐标）
    this.g.position.set(pos.x, pos.y);
    this.g.visible = true;
    // 呼吸：margin 随时间正弦变化（向内收拢）
    const phase = (elapsedMS % BREATH_PERIOD_MS) / BREATH_PERIOD_MS;
    const margin = BREATH_BASE + BREATH_AMP * (0.5 + 0.5 * Math.sin(phase * Math.PI * 2));
    this.drawCorners(margin);
  }

  /**
   * 画 4 个 L 形角到 g（相对格左上角，不旋转——四角永远朝四方）。
   * L 形 = 垂直段（宽 W、长 L）+ 水平段（长 L、宽 W）合并的实心多边形。
   */
  private drawCorners(margin: number): void {
    const g = this.g;
    const cs = CELL_SIZE;
    const w = CORNER_W;
    const L = CORNER_L;
    const m = margin;
    const rm = cs - m; // 右边距（从右边界向内 m）
    const bm = cs - m; // 下边距
    g.clear();
    g.beginPath();
    // 左上角：外角 (m,m)，向右画水平段、向下画垂直段
    g.moveTo(m, m)
      .lineTo(m + L, m)
      .lineTo(m + L, m + w)
      .lineTo(m + w, m + w)
      .lineTo(m + w, m + L)
      .lineTo(m, m + L)
      .closePath();
    // 右上角：水平段向左、垂直段向下
    g.moveTo(rm, m)
      .lineTo(rm - L, m)
      .lineTo(rm - L, m + w)
      .lineTo(rm - w, m + w)
      .lineTo(rm - w, m + L)
      .lineTo(rm, m + L)
      .closePath();
    // 左下角：垂直段向上、水平段向右
    g.moveTo(m, bm)
      .lineTo(m + L, bm)
      .lineTo(m + L, bm - w)
      .lineTo(m + w, bm - w)
      .lineTo(m + w, bm - L)
      .lineTo(m, bm - L)
      .closePath();
    // 右下角：垂直段向上、水平段向左
    g.moveTo(rm, bm)
      .lineTo(rm - L, bm)
      .lineTo(rm - L, bm - w)
      .lineTo(rm - w, bm - w)
      .lineTo(rm - w, bm - L)
      .lineTo(rm, bm - L)
      .closePath();
    g.fill({ color: HOVER_CORNER_COLOR });
  }

  /** 销毁。 */
  destroy(): void {
    this.g.removeFromParent();
    this.g.destroy();
  }
}
