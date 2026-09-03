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

import { FillGradient, type Graphics } from 'pixi.js';
import type { Direction } from '../components/BuildingComp';

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
/** 堵塞态 Status 黄带色（红 #B10000，与设备堵塞色 PORT_BLOCKED_TINT 一致）。 */
export const BELT_COLOR_STATUS_BLOCKED = 0xb10000;
/** 创建模式终点 Status 渐变目标色（蓝 #80BEE9，与输出端口 PORT_CREATE_TINT 一致）。 */
export const BELT_COLOR_CREATE = 0x80bee9;

/** 堵塞渐变时长（ms）：黄→红（带身 Status）/ 黄→橙（箭头）的过渡时间。 */
export const BLOCKED_BLEND_MS = 250;

/**
 * 两个 RGB 颜色（0xRRGGBB）线性插值。t∈[0,1]：0=a、1=b。
 * 传送带堵塞渐变用（黄 → 红 / 箭头黄 → 橙）。
 */
export function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/** 带身染色选项。shellColor/beltColor 缺省时用素材原色；选中态/预览染色均通过此传入。 */
export interface BeltColors {
  shellColor?: number;
  beltColor?: number;
  /** 黄带(Status)渐变（直段沿带身方向，转角沿对角线 0,0→1,1）；存在时优先于 beltColor。 */
  beltGradient?: { from: number; to: number };
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
export function drawStraightBelt(g: Graphics, cellSize: number, colors?: BeltColors, dir?: Direction): void {
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
  const beltW = STRAIGHT_BELT_W * s;
  const beltX = (-STRAIGHT_BELT_W / 2) * s;
  if (colors?.beltGradient) {
    // 创建模式终点：沿带身长度方向"段首(黄) → 段尾(蓝)"渐变。
    // 用 FillGradient textureSpace='global'（start/end 是 Graphics 本地像素绝对坐标），
    // 纹理从 start 沿 start→end 方向延伸 dist 像素，正好覆盖整条黄带（cellSize），
    // 完全平滑、无阶梯。注意必须显式指定 'global'，默认 'local' 会把坐标当归一化 0~1。
    // 段尾方向 = direction（beltTextureRotation 把本地 +y 旋转到 direction 方向）：
    //   - dir=90(下)/270(上): 段尾在本地 +y（下），start=-half 段首上、end=+half 段尾下。
    //   - dir=0(右)/180(左):  段尾在本地 -y（上），start=+half 段首下、end=-half 段尾上。
    const { from, to } = colors.beltGradient;
    const _d = dir ?? 90;
    const half = cellSize / 2;
    const tailAtBottom = _d === 90 || _d === 270;
    const startY = tailAtBottom ? -half : +half;
    const endY = tailAtBottom ? +half : -half;
    const grad = new FillGradient({
      type: 'linear',
      start: { x: 0, y: startY },
      end: { x: 0, y: endY },
      colorStops: [
        { offset: 0, color: from },
        { offset: 1, color: to },
      ],
      // textureSpace='global'：start/end 是 Graphics 本地像素绝对坐标（未旋转）
      textureSpace: 'global',
    });
    g.beginPath();
    g.rect(beltX, -cellSize / 2, beltW, cellSize).fill(grad);
  } else {
    g.beginPath();
    g.rect(beltX, -cellSize / 2, beltW, cellSize).fill({ color: belt });
  }
}

/**
 * 在 g 中绘制一个**半格长度**的传送带直段残段（格子中心为原点，默认方向朝下）。
 * 覆盖本地 y ∈ [-cellSize/2, 0]（进入侧半格，默认）或 [0, +cellSize/2]（出口侧半格，
 * exitHalf=true）——本地 +y = 流向，beltTextureRotation 把本地 +y 旋转到 direction 方向。
 * 用途（2026-09-02）:
 *   · 输入对接: 供给段在端口格内的**进入侧**半格——物品 progress 1.0→1.5 走进设备
 *     期间有带身可骑，传送带视觉"连进端口"（钻入设备观感）。
 *   · 输出接出: 接收段在端口格内的**出口侧**半格——物品 progress=0 从端口格中心
 *     冒出，带身从设备下方接出（钻出设备观感，同日补全）。
 * 渲染层挂在设备之下（zIndex 低于设备）。
 * @param g 目标 Graphics（应已 clear()）。
 * @param cellSize 一个格子的世界像素边长。
 * @param colors 染色；缺省 shell=#CECCCC、belt=#FFEF00。预览态传预览色。
 * @param exitHalf true 画出口侧半格（输出端），false 画进入侧半格（输入端，默认）。
 */
export function drawStraightBeltStub(
  g: Graphics,
  cellSize: number,
  colors?: BeltColors,
  exitHalf = false,
): void {
  const s = cellSize / BELT_SVG_SIZE;
  const shell = colors?.shellColor ?? BELT_COLOR_SHELL;
  const belt = colors?.beltColor ?? BELT_COLOR_BELT;
  const half = cellSize / 2;
  const y0 = exitHalf ? 0 : -half;
  // 灰壳 + 黄带，宽度与整段一致，长度取指定侧半格
  g.beginPath();
  g.rect((-STRAIGHT_SHELL_W / 2) * s, y0, STRAIGHT_SHELL_W * s, half).fill({ color: shell });
  g.beginPath();
  g.rect((-STRAIGHT_BELT_W / 2) * s, y0, STRAIGHT_BELT_W * s, half).fill({ color: belt });
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

  // ── 黄带环（circle5）：外弧 beltOuter → H → 内弧 cornerR ──
  // 注意：黄带环与灰壳环不是同一组内外弧。
  //   外弧圆心 = (c - beltOuter, c - beltOuter)，半径 beltOuter；
  //   内弧圆心 = (c, c)，半径 cornerR（不是灰壳的 CORNER_R_INNER）。
  g.beginPath();
  const beltPath = g.moveTo(c, c - beltOuter)
    .arcToSvg(beltOuter, beltOuter, 0, 0, 0, c - beltOuter, c)
    .lineTo(beltOuter - c, c)
    .arcToSvg(cornerR, cornerR, 0, 0, 1, c, beltOuter - c)
    .closePath();
  if (colors?.beltGradient) {
    // 创建模式终点：沿黄带环外弧（物品路径）从入口（下）→ 出口（右）"段首(黄)→段尾(蓝)"渐变。
    // 由 Transport_Belt_rotate.svg 可知黄带环外弧与内弧同心，圆心均为格子右下角 (c,c)：
    //   外弧半径 = beltOuter(12.9646)，内弧半径 = cornerR(3.96875)。
    // 用 N 个扇环小片拼合，外侧落在外弧上，内侧落在内弧上，每段 fill lerp 颜色。
    const { from, to } = colors.beltGradient;
    // 1) 先铺一层底色 from（黄），防止分段间出现针尖缝隙。
    beltPath.fill({ color: from });
    // 2) 同心分段渐变。
    const N = 40;
    const cx = c;
    const cy = c;
    const outerR = beltOuter;
    const innerR = cornerR;
    for (let i = 0; i < N; i++) {
      const t0 = i / N;
      const t1 = (i + 1) / N;
      // 物品从入口（下）到出口（右），在外弧上对应从标准角 π（左）→ 3π/2（上）。
      const a0 = Math.PI + (Math.PI / 2) * t0;
      const a1 = Math.PI + (Math.PI / 2) * t1;
      const color = lerpColor(from, to, (t0 + t1) / 2);
      const ox0 = cx + outerR * Math.cos(a0), oy0 = cy + outerR * Math.sin(a0);
      const ox1 = cx + outerR * Math.cos(a1), oy1 = cy + outerR * Math.sin(a1);
      const ix1 = cx + innerR * Math.cos(a1), iy1 = cy + innerR * Math.sin(a1);
      const ix0 = cx + innerR * Math.cos(a0), iy0 = cy + innerR * Math.sin(a0);
      g.beginPath();
      g.moveTo(ox0, oy0);
      // 外弧：sweep=0，从 a0(π) → a1(3π/2)
      g.arcToSvg(outerR, outerR, 0, 0, 0, ox1, oy1);
      g.lineTo(ix1, iy1);
      // 内弧：sweep=1，从 ix1,iy1(3π/2) → ix0,iy0(π)
      g.arcToSvg(innerR, innerR, 0, 0, 1, ix0, iy0);
      g.closePath();
      g.fill({ color });
    }
  } else {
    beltPath.fill({ color: belt });
  }

  // ── 内角灰三角（circle6）：填满黄带内弧拐角的灰壳 ──
  g.beginPath();
  g.moveTo(c, c - cornerR)
    .arcToSvg(cornerR, cornerR, 0, 0, 0, c - cornerR, c)
    .lineTo(shellOuter - c, c)
    .arcToSvg(inner, inner, 0, 0, 1, c, c - inner)
    .closePath()
    .fill({ color: shell });
}
