// 传送带矢量几何 — T2.0 方案A
//
// 背景：位图 Sprite 缩小到 zoom≈0.25 时，GPU 双线性采样把纹理的透明边距插值成
// 半透明渐变，相邻格子的渐变叠加 → 格子边界出现"接缝/灰线"。
// 方案A：传送带带身改用 PixiJS Graphics 矢量绘制（与旧 Flutter 项目 PictureInfo 同构），
// 任意缩放时由 GPU 按当前变换矩阵重新光栅化，边缘精确、相邻格内容在格子边界处连续 → 完全无缝。
//
// 本模块为纯函数：把传送带一格的矢量形状画进给定的 Graphics。
// 坐标系统：以格子中心为原点、单位=世界像素（由调用方传入 cellSize）。
// 素材参考：Transport_Belt_Move.svg / Transport_Belt_rotate.svg（viewBox 0 0 16.933334）。
//
// 染色：colors 指定 shellColor/beltColor（选中态 #B1B1B1/#FFF56A、预览整体单色）；
//       缺省时用素材原色 #CECCCC/#FFEF00。

import type { Graphics } from 'pixi.js';

// ───────────────────────── 素材几何常量（viewBox 0 0 16.933334）─────────────────────────

/** SVG viewBox 尺寸（素材逻辑单位）。 */
export const BELT_SVG_SIZE = 16.933333;

/** 直段灰壳宽度（viewBox 单位）：rect3 width=11.641667。占格子 68.75%。 */
const STRAIGHT_SHELL_W = 11.641667;
/** 直段黄带宽度（viewBox 单位）：rect4 width=8.995833。占格子 53.13%。 */
const STRAIGHT_BELT_W = 8.995833;

/** 转角灰壳外弧半径（viewBox 单位）：path5 r=14.2875。占格子 84.4%。 */
const CORNER_SHELL_R_OUTER = 14.2875;
/** 转角黄带外弧半径（viewBox 单位）：circle5 r=12.964583。占格子 76.6%。 */
const CORNER_BELT_R_OUTER = 12.964583;
/** 转角内弧半径（viewBox 单位）：内圆角 r=2.645833。占格子 15.6%。 */
const CORNER_R_INNER = 2.645833;
/** 转角内角小三角半径（viewBox 单位）：circle6 r=3.96875。 */
const CORNER_CORNER_R = 3.96875;

/** 格子中心在 viewBox 坐标系中的坐标（viewBox/2）。 */
const BELT_CENTER = BELT_SVG_SIZE / 2;

// ───────────────────────── 颜色 ─────────────────────────

/** 灰壳默认色（rect3/path5 fill = #CECCCC）。 */
export const BELT_COLOR_SHELL = 0xcecccc;
/** 黄带默认色（rect4/circle5 fill = #FFEF00）。 */
export const BELT_COLOR_BELT = 0xffef00;
/** 选中态灰壳色（Transport_1.svg rect3 = #B1B1B1）。 */
export const BELT_COLOR_SHELL_SELECTED = 0xb1b1b1;
/** 选中态黄带色（Transport_1.svg rect4 = #FFF56A）。 */
export const BELT_COLOR_BELT_SELECTED = 0xfff56a;

/** 带身染色选项。shellColor/beltColor 缺省时用素材原色；选中态/预览染色均通过此传入。 */
export interface BeltColors {
  shellColor?: number;
  beltColor?: number;
}

// ───────────────────────── 绘制函数 ─────────────────────────

/**
 * 在 g 中绘制一个传送带直段（格子中心为原点，默认方向朝下——黄带纵向）。
 * 调用方负责 rotation 定位到目标方向（beltTextureRotation）。
 *
 * @param g 目标 Graphics（应已 clear()）。
 * @param cellSize 一个格子的世界像素边长。
 * @param colors 染色；缺省 shell=#CECCCC、belt=#FFEF00。选中态传 #B1B1B1/#FFF56A。
 */
export function drawStraightBelt(g: Graphics, cellSize: number, colors?: BeltColors): void {
  const s = cellSize / BELT_SVG_SIZE; // viewBox → world 缩放
  const shell = colors?.shellColor ?? BELT_COLOR_SHELL;
  const belt = colors?.beltColor ?? BELT_COLOR_BELT;
  // 灰壳：全高矩形，宽度收窄，居中
  g.beginPath();
  g.rect(
    (-STRAIGHT_SHELL_W / 2) * s,
    -cellSize / 2,
    STRAIGHT_SHELL_W * s,
    cellSize,
  ).fill({ color: shell });
  // 黄带：全高矩形，宽度更窄，居中
  g.beginPath();
  g.rect(
    (-STRAIGHT_BELT_W / 2) * s,
    -cellSize / 2,
    STRAIGHT_BELT_W * s,
    cellSize,
  ).fill({ color: belt });
}

/**
 * 在 g 中绘制一个传送带转角（格子中心为原点，默认"下→右"转角——外凸在右下）。
 * 调用方负责 rotation/mirror 定位到目标方向（beltCornerTransform）。
 *
 * 转角形状 = 四分之一圆环（灰壳）+ 内侧黄带环 + 内角灰三角，精确复刻
 * Transport_Belt_rotate.svg 的 path5/circle5/circle6。
 *
 * 坐标换算：viewBox [0,16.933]²，格子中心 = (8.467, 8.467)。设半格 c = 8.467*s，
 * 则 viewBox 点 (vx, vy) → world (vx*s - c, vy*s - c)。
 *
 * @param g 目标 Graphics（应已 clear()）。
 * @param cellSize 一个格子的世界像素边长。
 * @param colors 染色；缺省用素材原色。
 */
export function drawCornerBelt(g: Graphics, cellSize: number, colors?: BeltColors): void {
  const s = cellSize / BELT_SVG_SIZE;
  const c = BELT_CENTER * s; // 半格（world px）
  const shell = colors?.shellColor ?? BELT_COLOR_SHELL;
  const belt = colors?.beltColor ?? BELT_COLOR_BELT;

  // viewBox → world 的常见点（相对格子中心）：
  //   shellOuter = 14.2875*s（灰壳外半径），beltOuter = 12.9646*s，inner = 2.6458*s，cornerR = 3.9688*s
  const shellOuter = CORNER_SHELL_R_OUTER * s;
  const beltOuter = CORNER_BELT_R_OUTER * s;
  const inner = CORNER_R_INNER * s;
  const cornerR = CORNER_CORNER_R * s;

  // ── 灰壳环（path5）：外弧 14.2875 → H 14.2875 → 内弧 2.6458 ──
  g.beginPath();
  g.moveTo(c, c - shellOuter)
    .arcToSvg(shellOuter, shellOuter, 0, 0, 0, c - shellOuter, c)
    .lineTo(shellOuter - c, c)
    .arcToSvg(inner, inner, 0, 0, 1, c, c - inner)
    .closePath()
    .fill({ color: shell });

  // ── 黄带环（circle5）：外弧 12.9646 → H 14.2875 → 内弧 2.6458 ──
  g.beginPath();
  g.moveTo(c, c - beltOuter)
    .arcToSvg(beltOuter, beltOuter, 0, 0, 0, c - beltOuter, c)
    .lineTo(shellOuter - c, c)
    .arcToSvg(inner, inner, 0, 0, 1, c, c - inner)
    .closePath()
    .fill({ color: belt });

  // ── 内角灰三角（circle6）：填满黄带内弧拐角的灰壳 ──
  g.beginPath();
  g.moveTo(c, c - cornerR)
    .arcToSvg(cornerR, cornerR, 0, 0, 0, c - cornerR, c)
    .lineTo(shellOuter - c, c)
    .arcToSvg(inner, inner, 0, 0, 1, c, c - inner)
    .closePath()
    .fill({ color: shell });
}
