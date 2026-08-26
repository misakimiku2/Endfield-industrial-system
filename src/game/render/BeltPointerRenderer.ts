// 传送带 pointer 流动渲染器 — T2.0 / v10 重构（带面纹理化）
// 依据: 旧 Flutter 项目 transport_belt_renderer.dart（直段线性 + 转角圆弧）
//       + 2026-08-27 用户十轮实测迭代定案（见 implementation-phase-2.md 第 6~10 条）。
//
// v10 核心: 箭头不是"按格的实体 Sprite"，而是**带面本身的流动纹理**——
//   每条链一个 Graphics，沿整链路径（直线段 + 转角圆弧，按弧长）均匀布置矢量箭头，
//   随 beltPhase 整体前移（相位 = 全局时钟 + chainId 派生偏移，同链扶梯连续、异链独立）。
//   箭头只在链路径范围内绘制（路径尽头自然终结）→ 设备门口/链首尾永远干净，
//   转角由圆弧采样天然平滑，跨格无断层、无截断。
//   物品渲染在箭头之上（物品 z=0.5 > 箭头 z=0.25，同在 layer2Building）——物品经过时
//   盖住脚下的一段箭头，"一格显示箭头还是物品"由遮挡关系自动成立，零判定逻辑。
//
// 为什么必须这样（v6~v9 四种按格方案全部被用户实拍否决的复盘）:
//   按格显隐 → 门口/队列步进的吸收间隙闪动（v6/v7）；
//   按格蒙版裁剪 → 箭头过格被平切、截断（v8）；
//   恒显 + 物品遮挡 → 指针与物品速率独立，物品盖不住箭头，转角/门口浮空垃圾（v9）。
//   箭头的正确定位是"带面的流动纹理"（背景材质），不是"按格占位的实体"（前景）。
//
// 箭头密度: 每格 1 枚（间距 = CELL_SIZE 弧长），与 v6 前观感一致；转角按弧长
// （1/4 圆 = CELL*π/2 ≈ 100.5px）参与弧长累计，拐弯处间距均匀、方向沿切线。
//
// 堵塞: 链级 blocked（BeltSystem 判定）→ 整链箭头黄→橙渐变（#E6956F，用户指定）。
// 选中: 被选中段的箭头画成白色（T1.8 选中态视觉）。

import { Graphics, Container } from 'pixi.js';
import type { World, EntityHandle } from '../ECS';
import type { Position } from '../components/Position';
import type { BeltSegmentComp } from '../components/BeltSegmentComp';
import type { Direction } from '../components/BuildingComp';
import type { BeltSelection } from '../systems/belt/BeltSelection';
import { CELL_SIZE } from './constants';
import { BeltSystem } from '../systems/BeltSystem';
import { lerpColor, BLOCKED_BLEND_MS } from './BeltVectorGeometry';

/** 常态箭头 tint（黄 #DFB615）。 */
const POINTER_TINT_NORMAL = 0xdfb615;
/** 堵塞时箭头 tint（用户指定 #E6956F）。 */
const POINTER_TINT_BLOCKED = 0xe6956f;
/** pointer 在 layer2Building 内的 zIndex: 带身(0) 之上、物品(0.5) 之下。 */
const POINTER_Z_INDEX = 0.25;
/** 箭头间距 = 每格 1 枚（弧长，世界像素）。 */
const POINTER_SPACING = CELL_SIZE;
/** 转角 1/4 圆弧的弧长（半径 = 半格）。 */
const CORNER_ARC_LENGTH = (CELL_SIZE * Math.PI) / 2;
/** 直线段弧长采样步（圆弧 8px/步、直线 16px/步，足够平滑且每帧重绘开销极小）。 */
const STRAIGHT_STEP = 16;
const ARC_STEP = 8;
/** 箭头矢量形状（朝上，单位=世界像素；箭头头 + 短杆，总高 ~16px，与旧贴图观感一致）。 */
const CHEVRON_POINTS: Array<[number, number]> = [
  [0, -8], [7, 3], [2.5, 3], [2.5, 8], [-2.5, 8], [-2.5, 3], [-7, 3],
];

/** 方向对应的角度（弧度），right=0, down=π/2, left=π, up=3π/2。 */
function directionAngle(dir: Direction): number {
  switch (dir) {
    case 0:   return 0;
    case 90:  return Math.PI / 2;
    case 180: return Math.PI;
    case 270: return (3 * Math.PI) / 2;
  }
}

/** 方向 → 序号：up=0, right=1, down=2, left=3（箭头旋转角 = 序号×π/2，默认朝上）。 */
function directionToIndex(dir: Direction): number {
  switch (dir) {
    case 270: return 0;
    case 0:   return 1;
    case 90:  return 2;
    case 180: return 3;
  }
}

/**
 * 链相位偏移（[0,1)）——从 chainId 确定性派生（无状态、每帧一致）。
 * 同链各段同偏移（扶梯连续）；不同链偏移不同（并行带互相独立）。
 */
function chainPhaseOf(chainId: string): number {
  let h = 0;
  for (let i = 0; i < chainId.length; i++) {
    h = (h * 31 + chainId.charCodeAt(i)) % 997;
  }
  return h / 997;
}

/** 链路径上的一点（世界坐标 + 朝向弧度 + 累计弧长）。朝向与旧 Sprite rotation 约定一致。 */
interface PathSample {
  x: number;
  y: number;
  rotation: number;
  /** 累计弧长（自链首起，世界像素）。 */
  s: number;
  /** 所属段 handle（选中高亮用）。 */
  handle: EntityHandle;
}

/** 单条链的渲染态。 */
interface ChainEntry {
  gfx: Graphics;
  /** 堵塞渐变进度 0~1（箭头黄 → 橙）。每帧向目标趋近。 */
  blockedBlend: number;
}

/**
 * 传送带 pointer 渲染器（v10 带面纹理化）。
 *
 * 用法：在主循环每帧调用 update(alpha, deltaMS)。
 */
export class BeltPointerRenderer {
  private world: World;
  private layer: Container;
  /** chainId → 渲染态。每帧 diff 维护（链删除时销毁 Graphics）。 */
  private chains = new Map<string, ChainEntry>();
  /** 选中态（SelectionSystem 写）。 */
  private beltSelection: BeltSelection | null = null;

  constructor(world: World, layer: Container) {
    this.world = world;
    this.layer = layer;
  }

  /** 注入选中态（由 RenderSystem.setBeltSelection 转发）。 */
  setBeltSelection(bs: BeltSelection): void {
    this.beltSelection = bs;
  }

  /**
   * 每帧重绘所有链的箭头纹理。
   * @param alpha 仿真周期插值系数（accumulator/SIM_STEP，0~1）。相位用 BeltSystem.beltPhase
   *   作时间源（与物品同源），消除漂移/闪烁。
   */
  update(alpha: number, deltaMS = 0): void {
    const visible = this.world.query('Position', 'BeltSegmentComp');
    const seenChains = new Set<string>();

    // 1. 按 chainId 分组（段按 segmentIndex 排序 = 流向顺序）
    const chainsSegs = new Map<string, Array<{ handle: EntityHandle; seg: BeltSegmentComp; pos: Position }>>();
    for (const handle of visible) {
      const seg = this.world.getComponent<BeltSegmentComp>(handle, 'BeltSegmentComp');
      const pos = this.world.getComponent<Position>(handle, 'Position');
      if (!seg || !pos) continue;
      let list = chainsSegs.get(seg.chainId);
      if (!list) {
        list = [];
        chainsSegs.set(seg.chainId, list);
      }
      list.push({ handle, seg, pos });
    }
    for (const list of chainsSegs.values()) {
      list.sort((a, b) => (a.seg.segmentIndex ?? 0) - (b.seg.segmentIndex ?? 0));
    }

    // 2. 全局相位。相位推进 → 箭头沿流向前进；wrap 时整体前移一个间距（周期图案无缝）。
    const globalPhase = BeltSystem.beltPhase + alpha * BeltSystem.beltPhaseDelta;
    const blendStep = deltaMS > 0 ? deltaMS / BLOCKED_BLEND_MS : 1;

    // 3. 逐链重绘
    for (const [chainId, list] of chainsSegs) {
      seenChains.add(chainId);
      let entry = this.chains.get(chainId);
      if (!entry) {
        const gfx = new Graphics({ label: `pointer-${chainId}` });
        gfx.zIndex = POINTER_Z_INDEX;
        this.layer.addChild(gfx);
        entry = { gfx, blockedBlend: 0 };
        this.chains.set(chainId, entry);
      }

      // 3a. 链级堵塞渐变（链内任一段 blocked → 整链箭头变橙）
      const chainBlocked = list.some((s) => s.seg.blocked === true);
      const target = chainBlocked ? 1 : 0;
      entry.blockedBlend = entry.blockedBlend < target
        ? Math.min(target, entry.blockedBlend + blendStep)
        : entry.blockedBlend > target
          ? Math.max(target, entry.blockedBlend - blendStep)
          : entry.blockedBlend;
      const chainColor = lerpColor(POINTER_TINT_NORMAL, POINTER_TINT_BLOCKED, entry.blockedBlend);

      // 3b. 展开链路径为弧长采样表（直线 64px；转角 1/4 圆弧，切线连续）
      const samples: PathSample[] = [];
      let acc = 0;
      const push = (x: number, y: number, rotation: number, step: number, handle: EntityHandle) => {
        samples.push({ x, y, rotation, s: acc, handle });
        acc += step;
      };
      for (const { handle, seg, pos } of list) {
        if (seg.isCorner && seg.entryDir !== undefined) {
          // 转角: 圆心 = 格中心 + pivot*半格（pivot 数学与旧 drawItemAt/物品渲染同源）
          const wc = { x: pos.x + CELL_SIZE / 2, y: pos.y + CELL_SIZE / 2 };
          const pivot = cornerPivot(seg.entryDir, seg.direction);
          const cxw = wc.x + (pivot.x * CELL_SIZE) / 2;
          const cyw = wc.y + (pivot.y * CELL_SIZE) / 2;
          const startAngle = Math.atan2(-pivot.y, -pivot.x);
          const dirIdx = (d: Direction) => (d === 270 ? 0 : d === 0 ? 1 : d === 90 ? 2 : 3);
          const diff = (dirIdx(seg.direction) - dirIdx(seg.entryDir) + 4) % 4;
          const deltaAngle = diff === 3 ? -Math.PI / 2 : Math.PI / 2;
          const steps = Math.ceil(CORNER_ARC_LENGTH / ARC_STEP);
          for (let k = 0; k < steps; k++) {
            const t = k / steps;
            const ang = startAngle + deltaAngle * t;
            push(
              cxw + (CELL_SIZE / 2) * Math.cos(ang),
              cyw + (CELL_SIZE / 2) * Math.sin(ang),
              ang + deltaAngle + Math.PI / 2,
              CORNER_ARC_LENGTH / steps,
              handle,
            );
          }
        } else {
          // 直段: 入口边中点 → 出口边中点，线性。
          // 旋转用 directionToIndex*π/2（与旧 Sprite 约定一致: 上0°/右90°/下180°/左270°，
          // CHEVRON_POINTS 默认朝上）——不要用 directionAngle（其 0°=右，会整体差 90°）。
          const ang = directionAngle(seg.direction);
          const rot = directionToIndex(seg.direction) * (Math.PI / 2);
          const sx = pos.x + CELL_SIZE / 2 - Math.cos(ang) * (CELL_SIZE / 2);
          const sy = pos.y + CELL_SIZE / 2 - Math.sin(ang) * (CELL_SIZE / 2);
          const dxu = Math.cos(ang);
          const dyu = Math.sin(ang);
          const steps = Math.ceil(CELL_SIZE / STRAIGHT_STEP);
          for (let k = 0; k < steps; k++) {
            push(
              sx + dxu * ((CELL_SIZE * k) / steps),
              sy + dyu * ((CELL_SIZE * k) / steps),
              rot,
              CELL_SIZE / steps,
              handle,
            );
          }
        }
      }
      const totalLen = acc;

      // 3c. 沿弧长布箭头: 首枚偏移 = 相位*间距（相位推进 → 箭头前移；wrap = 平移一个间距，
      //     周期图案无缝）。采样点 s 单调增，顺序推进查找（双指针均单调，O(样本+箭头)）。
      entry.gfx.clear();
      const offset = ((globalPhase + chainPhaseOf(chainId)) % 1) * POINTER_SPACING;
      let si = 0;
      for (let s = offset; s < totalLen; s += POINTER_SPACING) {
        while (si + 1 < samples.length && samples[si + 1].s <= s) si++;
        const sp = samples[si];
        const selected = this.beltSelection?.has(sp.handle) ?? false;
        this.drawChevron(entry.gfx, sp.x, sp.y, sp.rotation, selected ? 0xffffff : chainColor);
      }
    }

    // 4. 销毁消失链的 Graphics
    for (const [chainId, entry] of this.chains) {
      if (!seenChains.has(chainId)) {
        entry.gfx.removeFromParent();
        entry.gfx.destroy();
        this.chains.delete(chainId);
      }
    }
  }

  /** 销毁所有链 Graphics。 */
  destroy(): void {
    for (const entry of this.chains.values()) {
      entry.gfx.removeFromParent();
      entry.gfx.destroy();
    }
    this.chains.clear();
  }

  /**
   * 画一枚箭头（矢量，朝向由 rotation 决定；顶点手工旋转后填充）。
   * 顶点表 CHEVRON_POINTS 朝上（-y 为前），rotation 与旧 Sprite 约定一致。
   */
  private drawChevron(gfx: Graphics, x: number, y: number, rotation: number, color: number): void {
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    let first = true;
    for (const [vx, vy] of CHEVRON_POINTS) {
      const wx = x + vx * cos - vy * sin;
      const wy = y + vx * sin + vy * cos;
      if (first) {
        gfx.moveTo(wx, wy);
        first = false;
      } else {
        gfx.lineTo(wx, wy);
      }
    }
    gfx.closePath().fill({ color });
  }
}

/** 转角圆心（相对格中心，单位=半格）。pivot = 进入边向量 + 出口边向量。 */
function cornerPivot(entryDir: Direction, exitDir: Direction): { x: number; y: number } {
  let eX = 0, eY = 0;
  if (entryDir === 270) eY = 0.5;
  else if (entryDir === 90) eY = -0.5;
  else if (entryDir === 180) eX = 0.5;
  else if (entryDir === 0) eX = -0.5;
  let xX = 0, xY = 0;
  if (exitDir === 270) xY = -0.5;
  else if (exitDir === 90) xY = 0.5;
  else if (exitDir === 180) xX = -0.5;
  else if (exitDir === 0) xX = 0.5;
  return { x: eX + xX, y: eY + xY };
}
