// 世界网格渲染器 — 背景底色 + 动态网格线 + 边缘渐隐 + 暗角
// 依据: A2 world-model.md §5 (视觉风格)、§4 (层级模型)、implementation-phase-1.md T1.4
//
// 渲染分层 (A2 §5.4 渲染顺序):
//   1. 背景底色 #E6E4E4 — 屏幕空间，铺满视口
//   2. 网格线 #D6D4D4 1px 64px间距 — 屏幕空间，只画可见范围，像素对齐
//   3. (中间是建筑/物品/敌人/效果层)
//   4. 暗角 rgba(0,0,0,0.15) 径向渐变 — 最顶层
//
// 网格线"边缘渐隐" (A2 §5.2): 屏幕中心区域网格线完全不透明，越靠屏幕边缘越透明，
//   到边缘完全消失。实现方式: 把每条网格线分段绘制，每段按其屏幕位置距视口中心的
//   归一化距离设置 stroke alpha。这样不需要 alpha mask (PixiJS 的 Sprite mask 在
//   纹理 resize 时存在悬挂 GPU 引用导致崩溃的问题，见 AlphaMaskPipe/BindGroup)。
//
// 性能: 网格线每帧根据相机可见范围重绘(视口内约 30 条线，每条分若干段，开销极小)；
//       像素对齐(Math.round)避免亚像素模糊；暗角纹理只在 resize 时重建。

import { Container, Graphics, Sprite, Texture, CanvasSource } from 'pixi.js';
import { Camera } from './Camera';
import { CELL_SIZE, COLOR_GRID_BG, COLOR_GRID_LINE } from './constants';

/**
 * 边缘渐隐: 网格线 alpha 按距视口中心的归一化距离衰减。
 * 距离用视口对角线的一半归一化 (0=中心, 1.0=屏幕四角)。
 * 用对角线而非短边归一化，保证宽屏(如 1791×1089)左右边缘的归一化距离 < 1.0，
 * 网格在那里只是变淡而非完全消失。
 * - [0, FADE_START] 内 alpha = 1 (完全不透明)
 * - (FADE_START, 1.0] 内 alpha 从 1 线性衰减到 FADE_MIN (边缘保留淡淡可见，不全黑)
 */
const FADE_START = 0.55; // 归一化距离 0~0.55 内完全不衰减
/** 边缘(归一化距离=1.0, 即四角)处保留的最小 alpha。0=完全消失, 0.25=淡淡可见。 */
const FADE_MIN = 0.25;
/** 网格线分段数 (每条线分多少段，段内 alpha 一致)。越多越平滑，性能略降。 */
const LINE_SEGMENTS = 12;

/** 暗角: 完全透明区域半径占视口对角线一半的比例 (0~1, 1=到屏幕角)。 */
const VIGNETTE_INNER_RATIO = 0.45;
/** 暗角最暗处(屏幕角)的 alpha。 */
const VIGNETTE_MAX_ALPHA = 0.2;

export class GridRenderer {
  private camera: Camera;
  private viewport: { width: number; height: number };

  /** 背景底色矩形 (屏幕空间，铺满视口)。 */
  private bg: Graphics;
  /** 网格线图形 (屏幕空间，每帧重绘，分段设 alpha 实现边缘渐隐)。 */
  private gridLines: Graphics;
  /** 暗角 Sprite (径向渐变纹理，屏幕空间，最顶层)。 */
  private vignette: Sprite;

  constructor(
    gridLayer: Container,
    overlayLayer: Container,
    camera: Camera,
    viewport: { width: number; height: number },
  ) {
    this.camera = camera;
    this.viewport = viewport;

    this.bg = new Graphics();
    this.gridLines = new Graphics();

    gridLayer.addChild(this.bg, this.gridLines);

    // 暗角 (最顶层)
    this.vignette = new Sprite(Texture.EMPTY);
    overlayLayer.addChild(this.vignette);

    this.rebuildStatic();
  }

  /** 视口尺寸变化时调用: 重建背景、暗角纹理(尺寸相关的静态部分)。 */
  setViewport(size: { width: number; height: number }): void {
    this.viewport = size;
    this.rebuildStatic();
  }

  /**
   * 用原生 Canvas 2D 生成一张径向渐变纹理。
   * 用 createRadialGradient (而非 PixiJS FillGradient)，因为后者在 global space 下
   * 坐标映射行为不可靠。Canvas 2D 语义明确、100% 可控。
   */
  private makeGradientTexture(
    width: number,
    height: number,
    gradientFn: (ctx: CanvasRenderingContext2D) => void,
  ): Texture {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const ctx = canvas.getContext('2d')!;
    gradientFn(ctx);
    const source = new CanvasSource({ resource: canvas });
    return new Texture({ source });
  }

  /**
   * 重建尺寸相关的静态图形: 背景底色 + 暗角纹理。
   * 暗角是普通 Sprite (非 mask)，resize 时 destroy+recreate 纹理安全。
   */
  private rebuildStatic(): void {
    const { width, height } = this.viewport;
    const cx = width / 2;
    const cy = height / 2;
    const cornerDist = Math.sqrt(cx * cx + cy * cy); // 中心到屏幕角的像素距离

    // 背景底色 #E6E4E4 铺满视口
    this.bg.clear();
    this.bg.rect(0, 0, width, height).fill(COLOR_GRID_BG);

    // 暗角: 释放旧纹理再重建 (普通 Sprite 安全)
    // 内外半径都用对角线归一化，保证宽屏下暗角分布均匀(和网格渐隐语义一致)。
    if (this.vignette.texture !== Texture.EMPTY) {
      this.vignette.texture.destroy(true);
    }
    const vignetteInnerR = cornerDist * VIGNETTE_INNER_RATIO;
    this.vignette.texture = this.makeGradientTexture(width, height, (ctx) => {
      const grad = ctx.createRadialGradient(cx, cy, vignetteInnerR, cx, cy, cornerDist);
      grad.addColorStop(0, 'rgba(0,0,0,0)'); // 中心透明
      grad.addColorStop(1, `rgba(0,0,0,${VIGNETTE_MAX_ALPHA})`); // 屏幕角暗
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
    });
    this.vignette.position.set(0, 0);
  }

  /**
   * 计算屏幕某点距视口中心的归一化距离。
   * 用视口对角线的一半归一化: 0=中心, 1.0=屏幕四角。
   * 宽屏下左右边缘的归一化距离 < 1.0 (网格只变淡不消失)。
   */
  private normDistFromCenter(sx: number, sy: number): number {
    const dx = sx - this.viewport.width / 2;
    const dy = sy - this.viewport.height / 2;
    const cx = this.viewport.width / 2;
    const cy = this.viewport.height / 2;
    const halfDiag = Math.sqrt(cx * cx + cy * cy); // 中心到角的距离
    return Math.sqrt(dx * dx + dy * dy) / halfDiag;
  }

  /** 归一化距离 → alpha (边缘渐隐)。边缘保留 FADE_MIN，不完全消失。 */
  private fadeAlpha(normDist: number): number {
    if (normDist <= FADE_START) return 1;
    if (normDist >= 1) return FADE_MIN;
    return 1 - (1 - FADE_MIN) * (normDist - FADE_START) / (1 - FADE_START);
  }

  /**
   * 每帧更新网格线: 根据相机可见范围重绘，分段设 alpha 实现边缘渐隐。
   * 网格线在世界空间等间距 64px，转到屏幕空间后位置随相机变。
   * 每条线沿其长度方向分成 LINE_SEGMENTS 段，每段按中点的归一化距离设 alpha。
   */
  update(): void {
    const { width, height } = this.viewport;

    const topLeft = this.camera.screenToWorld(0, 0);
    const bottomRight = this.camera.screenToWorld(width, height);

    const startGX = Math.floor(topLeft.x / CELL_SIZE);
    const endGX = Math.ceil(bottomRight.x / CELL_SIZE);
    const startGY = Math.floor(topLeft.y / CELL_SIZE);
    const endGY = Math.ceil(bottomRight.y / CELL_SIZE);

    this.gridLines.clear();

    // 垂直线: 每条线在屏幕 x=const，沿 y 方向分段
    for (let gx = startGX; gx <= endGX; gx++) {
      const worldX = gx * CELL_SIZE;
      const screen = this.camera.worldToScreen(worldX, 0);
      const x = Math.round(screen.x);
      if (x < -1 || x > width + 1) continue;
      for (let s = 0; s < LINE_SEGMENTS; s++) {
        const y0 = (s / LINE_SEGMENTS) * height;
        const y1 = ((s + 1) / LINE_SEGMENTS) * height;
        const yMid = (y0 + y1) / 2;
        const alpha = this.fadeAlpha(this.normDistFromCenter(x, yMid));
        if (alpha <= 0.01) continue;
        this.gridLines
          .moveTo(x, y0)
          .lineTo(x, y1)
          .stroke({ width: 1, color: COLOR_GRID_LINE, alpha });
      }
    }

    // 水平线: 每条线在屏幕 y=const，沿 x 方向分段
    for (let gy = startGY; gy <= endGY; gy++) {
      const worldY = gy * CELL_SIZE;
      const screen = this.camera.worldToScreen(0, worldY);
      const y = Math.round(screen.y);
      if (y < -1 || y > height + 1) continue;
      for (let s = 0; s < LINE_SEGMENTS; s++) {
        const x0 = (s / LINE_SEGMENTS) * width;
        const x1 = ((s + 1) / LINE_SEGMENTS) * width;
        const xMid = (x0 + x1) / 2;
        const alpha = this.fadeAlpha(this.normDistFromCenter(xMid, y));
        if (alpha <= 0.01) continue;
        this.gridLines
          .moveTo(x0, y)
          .lineTo(x1, y)
          .stroke({ width: 1, color: COLOR_GRID_LINE, alpha });
      }
    }
  }
}
