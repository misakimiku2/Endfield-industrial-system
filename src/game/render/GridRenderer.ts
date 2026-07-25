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
   *
   * 旋转感知 (T1.5): 视图旋转后，世界网格线在屏幕上不再轴对齐——worldX=const
   * 的竖直线在 rot=90 时变成屏幕上的水平线。因此不能再用"每条线屏幕 x 恒定"
   * 的画法。本实现把每条世界网格线（一条无限长直线）投影到屏幕：取线上两点
   * 转 worldToScreen 得到屏幕直线，再裁剪到视口矩形 [0,w]×[0,h]，沿裁剪后
   * 线段分段设 alpha。这样任意 viewRotation 下网格线方向与位置都正确。
   *
   * 性能: 可见网格线数随旋转后 AABB 变化（正方形视口下 0°/180° 与 90°/270°
   * 的可见线数互换），每条分 LINE_SEGMENTS 段，开销与 T1.4 同量级。
   */
  update(): void {
    const { width, height } = this.viewport;

    // 可见世界范围: 取屏幕四角的世界坐标求 AABB（旋转视图下视口是世界中的
    // 旋转矩形，四角的 min/max 才是完整覆盖范围；两角法只在 0/180° 充分）。
    const corners = [
      this.camera.screenToWorld(0, 0),
      this.camera.screenToWorld(width, 0),
      this.camera.screenToWorld(0, height),
      this.camera.screenToWorld(width, height),
    ];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of corners) {
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.y > maxY) maxY = c.y;
    }

    const startGX = Math.floor(minX / CELL_SIZE);
    const endGX = Math.ceil(maxX / CELL_SIZE);
    const startGY = Math.floor(minY / CELL_SIZE);
    const endGY = Math.ceil(maxY / CELL_SIZE);

    this.gridLines.clear();

    // 世界竖直网格线 (worldX = gx*CELL_SIZE): 投影到屏幕成一条直线，裁剪到视口。
    for (let gx = startGX; gx <= endGX; gx++) {
      const worldX = gx * CELL_SIZE;
      // 取线上足够远的两点确定屏幕直线（覆盖整个视口对角线尺度即可）
      const p0 = this.camera.worldToScreen(worldX, minY);
      const p1 = this.camera.worldToScreen(worldX, maxY);
      this.strokeScreenLine(p0.x, p0.y, p1.x, p1.y, width, height);
    }

    // 世界水平网格线 (worldY = gy*CELL_SIZE): 同理。
    for (let gy = startGY; gy <= endGY; gy++) {
      const worldY = gy * CELL_SIZE;
      const p0 = this.camera.worldToScreen(minX, worldY);
      const p1 = this.camera.worldToScreen(maxX, worldY);
      this.strokeScreenLine(p0.x, p0.y, p1.x, p1.y, width, height);
    }
  }

  /**
   * 把一条屏幕直线（由两端点给出，可能延伸到视口外）裁剪到视口矩形，
   * 然后沿裁剪后的线段分成 LINE_SEGMENTS 段，每段按中点距视口中心的归一化
   * 距离设 alpha（边缘渐隐），stroke 到 gridLines。
   *
   * 用参数化裁剪: 点 = p0 + t*(p1-p0)，t∈[0,1]。求 t 进入/离开视口矩形的
   * 区间 [t0,t1]，无交集则跳过。
   */
  private strokeScreenLine(
    x0: number, y0: number, x1: number, y1: number,
    width: number, height: number,
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    // 参数化裁剪到 [0,width]×[0,height]
    let t0 = 0;
    let t1 = 1;
    const clip = (p: number, d: number, lo: number, hi: number): boolean => {
      // 对每个边界求 t：p + t*d ∈ [lo, hi]
      if (Math.abs(d) < 1e-9) {
        // 平行于该轴：若 p 不在 [lo,hi] 内则整条线在区域外
        return p >= lo && p <= hi;
      }
      const ta = (lo - p) / d;
      const tb = (hi - p) / d;
      const tEnter = Math.min(ta, tb);
      const tExit = Math.max(ta, tb);
      if (tEnter > t0) t0 = tEnter;
      if (tExit < t1) t1 = tExit;
      return t0 <= t1;
    };
    if (!clip(x0, dx, 0, width)) return;
    if (!clip(y0, dy, 0, height)) return;
    if (t0 >= t1) return;

    const sx0 = x0 + dx * t0;
    const sy0 = y0 + dy * t0;
    const sx1 = x0 + dx * t1;
    const sy1 = y0 + dy * t1;

    // 沿裁剪后线段分段，每段按中点归一化距离设 alpha
    for (let s = 0; s < LINE_SEGMENTS; s++) {
      const f0 = s / LINE_SEGMENTS;
      const f1 = (s + 1) / LINE_SEGMENTS;
      const mx = sx0 + (sx1 - sx0) * (f0 + f1) / 2;
      const my = sy0 + (sy1 - sy0) * (f0 + f1) / 2;
      const alpha = this.fadeAlpha(this.normDistFromCenter(mx, my));
      if (alpha <= 0.01) continue;
      this.gridLines
        .moveTo(sx0 + (sx1 - sx0) * f0, sy0 + (sy1 - sy0) * f0)
        .lineTo(sx0 + (sx1 - sx0) * f1, sy0 + (sy1 - sy0) * f1)
        .stroke({ width: 1, color: COLOR_GRID_LINE, alpha });
    }
  }
}
