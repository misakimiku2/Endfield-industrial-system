// 传送带矢量几何 — T2.0 方案A
//
// 背景：位图 Sprite 缩小到 zoom≈0.25 时，GPU 双线性采样把纹理的透明边距插值成
// 半透明渐变，相邻格子的渐变叠加 → 格子边界出现"接缝/灰线"。
// 方案A：传送带带身改用 PixiJS Graphics 矢量绘制（与旧 Flutter 项目 PictureInfo 同构），
// 任意缩放时由 GPU 按当前变换矩阵重新光栅化，边缘精确、相邻格内容在格子边界处连续 → 完全无缝。
//
// 本模块为纯函数：把传送带一格的矢量形状画进给定的 Graphics。
// 坐标系统：以格子中心为原点、单位=世界像素（由调用方传入 cellSize）。
// 素材参考：旧项目 Transport_Belt_Move.svg / Transport_Belt_rotate.svg（viewBox 0 0 16.933 16.933）。
//
// 为什么无缝：
//  - 直段：灰壳/黄带在**流动方向全高填满格子**（SVG rect 高度 = viewBox 全高），
//    相邻格沿流动方向边缘完全连续；仅宽度方向收窄（带身造型）。
//  - 转角：外弧半径 = 84.4% 格子（> 半格），弧延伸到格子角落，与相邻直段/转角在
//    格子边界处重叠覆盖 → 角落连续。
//
// 预览染色：旧项目 _makePreviewSvg 把 #ffef00 和 #cecccc 都替换成预览色（整体单色），
// 本模块用 overrideColor 实现同样语义：提供时灰壳/黄带/内角全部用该色。

import type { Graphics } from 'pixi.js';

// ───────────────────────── 素材几何常量（viewBox 0 0 16.933 16.933）─────────────────────────

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

// ───────────────────────── 落盘颜色（与素材一致）─────────────────────────

/** 灰壳颜色（rect3/path5 fill）。 */
export const BELT_COLOR_SHELL = 0xcecccc;
/** 黄带颜色（rect4/circle5 fill）。 */
export const BELT_COLOR_BELT = 0xffef00;

/** 解析颜色：overrideColor 提供则整体用该色（预览），否则用素材灰壳/黄带。 */
function resolveShellColor(overrideColor?: number): number {
  return overrideColor ?? BELT_COLOR_SHELL;
}
function resolveBeltColor(overrideColor?: number): number {
  return overrideColor ?? BELT_COLOR_BELT;
}

// ───────────────────────── 绘制函数 ─────────────────────────

/**
 * 在 g 中绘制一个传送带直段（格子中心为原点，默认方向朝下——黄带纵向）。
 * 调用方负责 rotation 定位到目标方向（beltTextureRotation）。
 *
 * @param g 目标 Graphics（应已 clear()）。
 * @param cellSize 一个格子的世界像素边长。
 * @param overrideColor 预览用：整体单色（旧项目 _makePreviewSvg 语义）；省略=素材原色。
 */
export function drawStraightBelt(g: Graphics, cellSize: number, overrideColor?: number): void {
  const s = cellSize / BELT_SVG_SIZE; // viewBox → world 缩放
  const shell = resolveShellColor(overrideColor);
  const belt = resolveBeltColor(overrideColor);
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
 * @param overrideColor 预览用：整体单色（旧项目 _makePreviewSvg 语义）；省略=素材原色。
 */
export function drawCornerBelt(g: Graphics, cellSize: number, overrideColor?: number): void {
  const s = cellSize / BELT_SVG_SIZE;
  const c = BELT_CENTER * s; // 半格（world px）
  const shell = resolveShellColor(overrideColor);
  const belt = resolveBeltColor(overrideColor);

  // viewBox → world 的常见点（相对格子中心）：
  //   shellOuter = 14.2875*s（灰壳外半径），beltOuter = 12.9646*s，inner = 2.6458*s，cornerR = 3.9688*s
  const shellOuter = CORNER_SHELL_R_OUTER * s;
  const beltOuter = CORNER_BELT_R_OUTER * s;
  const inner = CORNER_R_INNER * s;
  const cornerR = CORNER_CORNER_R * s;

  // ── 灰壳环（path5）：外弧 14.2875 → H 14.2875 → 内弧 2.6458 ──
  // 外弧：M (16.933,2.646) A r14.2875 → (2.646,16.933)。相对中心：
  //   起点 (c, c - shellOuter)，终点 (c - shellOuter, c)。sweep=0（SVG 逆时针）。
  // H 14.2875 → x 到 viewBox 14.2875 → world (shellOuter - c)。
  // 内弧：A r2.6458 sweep=1 → 终点 (c, c - inner)。
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

// ───────────────────────── 选中态几何（T2.0 链管理）─────────────────────────

/**
 * 选中白边宽度（viewBox 单位）= (14.2875 − 11.641667)/2。
 * 换算: 1.3229 / 16.933 × CELL_SIZE(64) ≈ 5.0 世界像素（与用户参考图 Transport.svg 一致）。
 */
export const SELECTION_RIM = 1.322916;

/** 选中斜杠颜色（用户参考图 Transport.svg 的 Strips1_1 pattern fill #eec213）。 */
export const BELT_COLOR_STRIPE = 0xeec213;

/**
 * 绘制传送带的「黄色区域」形状（供选中斜杠的 StencilMask 用）。
 * 直段 = 黄带 rect；转角 = 黄带弧环（circle5 path）。
 * 形状与 drawStraightBelt/drawCornerBelt 的黄色部分完全一致，确保蒙版与带身黄底对齐。
 *
 * 调用方负责与带身相同的 rotation/scale 定位（beltTextureRotation / beltCornerTransform）。
 * 填充色对 StencilMask 无意义（仅取形状），用白色占位。
 */
export function drawBeltYellowShape(g: Graphics, cellSize: number, isCorner: boolean): void {
  const s = cellSize / BELT_SVG_SIZE;
  if (!isCorner) {
    g.beginPath();
    g.rect(
      (-STRAIGHT_BELT_W / 2) * s,
      -cellSize / 2,
      STRAIGHT_BELT_W * s,
      cellSize,
    ).fill({ color: 0xffffff });
    return;
  }
  const c = BELT_CENTER * s;
  const shellOuter = CORNER_SHELL_R_OUTER * s;
  const beltOuter = CORNER_BELT_R_OUTER * s;
  const inner = CORNER_R_INNER * s;
  // 与 drawCornerBelt 的黄带环（circle5）完全相同的 path
  g.beginPath();
  g.moveTo(c, c - beltOuter)
    .arcToSvg(beltOuter, beltOuter, 0, 0, 0, c - beltOuter, c)
    .lineTo(shellOuter - c, c)
    .arcToSvg(inner, inner, 0, 0, 1, c, c - inner)
    .closePath()
    .fill({ color: 0xffffff });
}

/**
 * 绘制直段选中白边底层（filled，画在灰壳之前）。
 * 白 rect 宽 = 灰壳宽 + 2×RIM（=14.2875，与 Transport.svg rect2 一致），全高。
 * 灰壳(11.64)叠在上面 → 左右各露出 RIM(≈5px) 白边。
 */
export function drawStraightBeltSelectionUnderlay(g: Graphics, cellSize: number): void {
  const s = cellSize / BELT_SVG_SIZE;
  const w = (STRAIGHT_SHELL_W + 2 * SELECTION_RIM) * s;
  g.beginPath();
  g.rect(-w / 2, -cellSize / 2, w, cellSize).fill({ color: 0xffffff });
}

/**
 * 绘制转角选中白边（stroked，画在带身之后）。
 * 转角的灰壳外弧已抵格子边缘，无法用「更宽填充底」(会溢出格子角)，改用沿灰壳轮廓描白边。
 * width = 2×RIM（≈10px，向内/外各 5px），描整个灰壳带轮廓 → 白色边框。
 */
export function drawCornerBeltSelectionBorder(g: Graphics, cellSize: number): void {
  const s = cellSize / BELT_SVG_SIZE;
  const c = BELT_CENTER * s;
  const shellOuter = CORNER_SHELL_R_OUTER * s;
  const inner = CORNER_R_INNER * s;
  g.beginPath();
  g.moveTo(c, c - shellOuter)
    .arcToSvg(shellOuter, shellOuter, 0, 0, 0, c - shellOuter, c)
    .lineTo(shellOuter - c, c)
    .arcToSvg(inner, inner, 0, 0, 1, c, c - inner)
    .closePath()
    .stroke({ color: 0xffffff, width: 2 * SELECTION_RIM * s });
}
