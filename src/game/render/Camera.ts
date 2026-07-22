// 相机系统 — 2D 俯视相机的平移与缩放
// 依据: A6 coordinate-spec.md (三层坐标转换、Camera、相机约束), A2 §8 (世界边界)
//
// Camera 是纯逻辑类（不依赖 PixiJS），维护相机中心和缩放，提供
// World↔Screen 转换。视口宽高由外部（PixiJS Application）通过
// setViewport 更新。每帧 updateTransform 把相机变换写到一个 worldContainer
// 上，使世界内容随之平移/缩放。
//
// 边界策略: 让世界边缘正好贴住视口边缘（既不露黑底，也不允许看到世界外）。
// 相机中心被约束在 [halfView, worldSize - halfView]；当世界小于视口时居中。

import {
  CELL_SIZE,
  WORLD_WIDTH_PX,
  WORLD_HEIGHT_PX,
  CAMERA_ZOOM_MIN,
  CAMERA_ZOOM_MAX,
  CAMERA_ZOOM_DEFAULT,
} from './constants';
import type { Container } from 'pixi.js';

export interface ViewportSize {
  width: number; // 视口宽（屏幕像素 / CSS 像素）
  height: number;
}

export class Camera {
  /** 相机中心的世界 X 坐标（世界像素）。 */
  x: number;
  /** 相机中心的世界 Y 坐标（世界像素）。 */
  y: number;
  /** 缩放倍率 (1.0 = 1 世界像素 = 1 屏幕像素)。 */
  zoom: number;

  private viewport: ViewportSize;
  /** 相机变换写入目标（PixiJS 世界容器）。update 时同步其 position/scale。 */
  private worldContainer: Container | null = null;

  constructor(viewport: ViewportSize) {
    this.viewport = viewport;
    this.zoom = CAMERA_ZOOM_DEFAULT;
    // 初始中心置于世界中央
    this.x = WORLD_WIDTH_PX / 2;
    this.y = WORLD_HEIGHT_PX / 2;
  }

  /** 绑定 PixiJS 世界容器；此后每帧 updateTransform 会同步其变换。 */
  bindWorldContainer(container: Container): void {
    this.worldContainer = container;
  }

  /** 视口尺寸变化（窗口 resize）时调用。变化后重新 clamp 相机中心。 */
  setViewport(size: ViewportSize): void {
    this.viewport = size;
    this.clampPosition();
  }

  // ───────────────────────── 坐标转换 (A6 §4) ─────────────────────────

  /** 世界像素坐标 → 屏幕像素坐标 (A6 §4)。 */
  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    const cx = this.viewport.width / 2;
    const cy = this.viewport.height / 2;
    return {
      x: (wx - this.x) * this.zoom + cx,
      y: (wy - this.y) * this.zoom + cy,
    };
  }

  /** 屏幕像素坐标 → 世界像素坐标 (A6 §4)。 */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const cx = this.viewport.width / 2;
    const cy = this.viewport.height / 2;
    return {
      x: (sx - cx) / this.zoom + this.x,
      y: (sy - cy) / this.zoom + this.y,
    };
  }

  // ───────────────────────── 操作 ─────────────────────────

  /**
   * 在世界坐标系中平移相机（正值向右/下）。
   * 用于中键拖拽：传入 worldDelta = screenDelta / zoom。
   */
  panByWorld(dx: number, dy: number): void {
    this.setPosition(this.x + dx, this.y + dy);
  }

  /**
   * 以指定的屏幕坐标点为锚点缩放（滚轮缩放核心）。
   * 保证锚点屏幕坐标在缩放前后不变——即"以鼠标为中心放大/缩小"。
   *
   * @param screenAnchor 锚点的屏幕坐标（通常是鼠标位置）
   * @param newZoom      目标缩放（会先 clamp 到 [min,max]）
   */
  zoomAt(screenAnchor: { x: number; y: number }, newZoom: number): void {
    const clampedZoom = clamp(newZoom, CAMERA_ZOOM_MIN, CAMERA_ZOOM_MAX);
    if (clampedZoom === this.zoom) return;

    // 锚点的世界坐标在缩放前后应保持其屏幕位置不变:
    //   screen = (world - camCenter) * zoom + viewportCenter
    // 保持 screen 不变 → (world - camCenter_new) * newZoom = (world - camCenter_old) * zoom
    // 解出 camCenter_new = world - (world - camCenter_old) * zoom / newZoom
    const anchorWorld = this.screenToWorld(screenAnchor.x, screenAnchor.y);
    const newX = anchorWorld.x - (anchorWorld.x - this.x) * (this.zoom / clampedZoom);
    const newY = anchorWorld.y - (anchorWorld.y - this.y) * (this.zoom / clampedZoom);

    this.zoom = clampedZoom;
    this.setPosition(newX, newY);
  }

  /** 直接设置缩放（以视口中心为锚点）。 */
  setZoom(zoom: number): void {
    const cx = this.viewport.width / 2;
    const cy = this.viewport.height / 2;
    this.zoomAt({ x: cx, y: cy }, zoom);
  }

  /** 设置相机中心并 clamp 到世界边界内。 */
  setPosition(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.clampPosition();
  }

  /**
   * 把相机变换同步到 PixiJS 世界容器。
   * PixiJS 的世界坐标系与本项目一致（原点左上、y 向下），但相机的
   * "中心对齐"语义需要先平移视口中心再缩放:
   *   spriteScreen = worldContainer.position + worldPos * worldContainer.scale
   * 推导: screen = (world - camCenter) * zoom + viewportCenter
   *       = world*zoom + (viewportCenter - camCenter*zoom)
   * 故 position = viewportCenter - camCenter * zoom，scale = zoom。
   */
  updateTransform(): void {
    if (!this.worldContainer) return;
    this.worldContainer.scale.set(this.zoom);
    this.worldContainer.position.set(
      this.viewport.width / 2 - this.x * this.zoom,
      this.viewport.height / 2 - this.y * this.zoom,
    );
  }

  // ───────────────────────── 边界 ─────────────────────────

  /**
   * 将相机中心 clamp 到世界边界内 (A6 §4.1, A2 §8)。
   * 让世界边缘正好贴住视口边缘：相机中心 ∈ [halfView, worldSize - halfView]。
   * 当世界小于视口（极小缩放）时，相机居中，世界整体居中显示。
   */
  private clampPosition(): void {
    const halfW = this.viewport.width / 2 / this.zoom;
    const halfH = this.viewport.height / 2 / this.zoom;

    if (WORLD_WIDTH_PX >= halfW * 2) {
      this.x = clamp(this.x, halfW, WORLD_WIDTH_PX - halfW);
    } else {
      this.x = WORLD_WIDTH_PX / 2;
    }
    if (WORLD_HEIGHT_PX >= halfH * 2) {
      this.y = clamp(this.y, halfH, WORLD_HEIGHT_PX - halfH);
    } else {
      this.y = WORLD_HEIGHT_PX / 2;
    }
  }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export { CELL_SIZE }; // 便于消费方从 camera 模块一并引入（可选）
