// 传送带带身矢量渲染器 — T2.0 方案A
//
// 职责：用 PixiJS Graphics 矢量绘制传送带带身（直段/转角），替代原来的位图 Sprite。
// 背景：位图 Sprite 缩小（zoom≈0.25）时 GPU 双线性采样把纹理透明边距插值成半透明渐变，
// 相邻格叠加 → 格子边界"接缝/灰线"。矢量 Graphics 任意缩放边缘精确 → 无缝。
//
// 设计：
//  - 每帧查询 Position+BeltSegmentComp 实体，diff 维护每段一个 Graphics（挂 layer2Building）。
//  - 形状只画一次（直段/转角由 beltTextureRotation / beltCornerTransform 定位朝向与镜像），
//    仅在段的方向/转角状态变化时重绘（避免每帧 clear 的开销）。
//  - 位置每帧同步到格中心；rotation/scale 每帧按当前 seg 设置（isTail 延长翻转时 seg 会变）。
//
// 与 BeltPointerRenderer 的关系：pointer 是"流动箭头"（layer3Item），本渲染器是"带身"（layer2Building），
// 两者叠加 = 完整传送带视觉。RenderSystem 不再为传送带实体创建 Sprite（见 RenderSystem.update 跳过逻辑）。

import { Graphics, type Container } from 'pixi.js';
import type { World, EntityHandle } from '../ECS';
import type { Position } from '../components/Position';
import type { BeltSegmentComp } from '../components/BeltSegmentComp';
import type { BuildingComp, Direction } from '../components/BuildingComp';
import { beltTextureRotation, beltCornerTransform, directionVector } from '../systems/belt/BeltPathGeometry';
import { inputPortCells, type PortCell } from '../systems/PortGeometry';
import { outputPortCells } from '../systems/machine/OutputOps';
import { getBuildingDefinition } from '../data/buildings';
import type { BeltSelection } from '../systems/belt/BeltSelection';
import { CELL_SIZE } from './constants';
import {
  drawStraightBelt,
  drawStraightBeltStub,
  drawCornerBelt,
  BELT_COLOR_BELT,
  BELT_COLOR_SHELL_SELECTED,
  BELT_COLOR_BELT_SELECTED,
  BELT_COLOR_STATUS_BLOCKED,
  BELT_COLOR_CREATE,
  lerpColor,
  BLOCKED_BLEND_MS,
  type BeltColors,
} from './BeltVectorGeometry';

/** 单个传送带段的渲染态。 */
interface VectorEntry {
  g: Graphics;
  /** 方向/转角签名；变化时重绘形状。 */
  lastKey: string;
  handle: EntityHandle;
  /** 堵塞渐变进度 0~1（0=正常黄，1=堵塞红）。每帧向目标趋近。 */
  blockedBlend: number;
}

/** 由 seg 生成形状签名（直段/转角/方向/镜像任一变化都要重绘）。 */
function segShapeKey(seg: BeltSegmentComp): string {
  return `${seg.isCorner}|${seg.direction}|${seg.entryDir}|${seg.mirrorH}`;
}

/**
 * 传送带带身矢量渲染器。
 *
 * 用法：主循环每帧调用 update()。构造时传入 layer2Building 作为挂载层。
 */
export class BeltVectorRenderer {
  private world: World;
  private layer: Container;
  /** 选中态（SelectionSystem 写）；选中段带身染选中色（#B1B1B1/#FFF56A）。由 RenderSystem 注入。 */
  private beltSelection: BeltSelection | null = null;
  /** 查询是否处于传送带创建模式。创建模式下断头末端(tail)带身黄→蓝渐变。 */
  private isCreateMode: () => boolean;
  /** 延长预览中被隐藏的原尾格（该格由 BeltCreationSystem 预览接管渲染）。 */
  private getHiddenCell?: () => { x: number; y: number } | null;

  /** handle → entry，用于 diff。 */
  private entries = new Map<EntityHandle, VectorEntry>();
  /**
   * 端口格 key → 半格残段 Graphics（2026-09-02）。对接输入端口的供给段在端口格内
   * 的半格延伸（物品 progress 1.0→1.5 走进设备期间有带身可骑）。zIndex 按设备路径
   * 分派（T2.20）: 九宫格设备挂 0（设备之下"钻入"观感）；整图设备挂 2（设备之上，
   * 否则旋转 90°/270° 时残段被不透明端口贴图完全遮住，观感如"没连上"）。
   * key = 端口格坐标。
   */
  private portStubs = new Map<string, { g: Graphics; lastKey: string }>();

  constructor(
    world: World,
    layer: Container,
    isCreateMode?: () => boolean,
    getHiddenCell?: () => { x: number; y: number } | null,
  ) {
    this.world = world;
    this.layer = layer;
    this.isCreateMode = isCreateMode ?? (() => false);
    this.getHiddenCell = getHiddenCell;
  }

  /** 注入选中态（由 RenderSystem.setBeltSelection 转发）。 */
  setBeltSelection(bs: BeltSelection): void {
    this.beltSelection = bs;
  }

  /**
   * 每帧同步所有传送带段的矢量带身。
   * @param deltaMS 自上一帧毫秒数（驱动堵塞渐变，帧率无关）。
   */
  update(deltaMS = 0): void {
    const visible = this.world.query('Position', 'BeltSegmentComp');
    const seen = new Set<EntityHandle>(visible);
    // 堵塞渐变步长（线性插值，固定时长；deltaMS=0 时瞬间到位，兼容旧调用）
    const blendStep = deltaMS > 0 ? deltaMS / BLOCKED_BLEND_MS : 1;
    const createMode = this.isCreateMode();

    // 1. 销毁消失实体的 Graphics
    for (const [handle, entry] of this.entries) {
      if (!seen.has(handle)) {
        entry.g.removeFromParent();
        entry.g.destroy();
        this.entries.delete(handle);
      }
    }

    if (visible.length === 0) {
      this.updatePortStubs([]);
      return;
    }

    // 2. 新增 + 同步
    const hiddenCell = this.getHiddenCell?.() ?? null;
    // 端口索引（端口内半格残段判定用，与 findFeederBelt/findReceiverBelt 同一来源）。
    // above = 残段是否画在设备贴图之上：整图设备（仓库口等，美术端口格侧边不透明）
    // 旋转 90°/270° 时残段若挂设备之下会被完全遮住（T2.20），故抬到设备之上；
    // 九宫格设备（精炼炉）维持设备之下的"钻入"观感不变。
    const ports = new Map<string, { cell: PortCell; above: boolean }>();
    const outPorts = new Map<string, { cell: PortCell; above: boolean }>();
    for (const bHandle of this.world.query('BuildingComp', 'Position')) {
      const bComp = this.world.getComponent<BuildingComp>(bHandle, 'BuildingComp');
      const bPos = this.world.getComponent<Position>(bHandle, 'Position');
      if (!bComp || !bPos) continue;
      const def = getBuildingDefinition(bComp.definitionId);
      if (!def) continue;
      const above = def.baseStyle !== 'nineslice';
      const bgx = Math.round(bPos.x / CELL_SIZE);
      const bgy = Math.round(bPos.y / CELL_SIZE);
      for (const cell of inputPortCells(bgx, bgy, def, bComp.direction)) {
        ports.set(`${cell.x},${cell.y}`, { cell, above });
      }
      for (const cell of outputPortCells(bgx, bgy, def, bComp.direction)) {
        outPorts.set(`${cell.x},${cell.y}`, { cell, above });
      }
    }
    const portStubs: Array<{ key: string; gx: number; gy: number; dir: Direction; selected: boolean; blocked: boolean; blend: number; exitHalf: boolean; above: boolean }> = [];
    for (const handle of visible) {
      const seg = this.world.getComponent<BeltSegmentComp>(handle, 'BeltSegmentComp')!;
      const pos = this.world.getComponent<Position>(handle, 'Position')!;

      let entry = this.entries.get(handle);
      if (!entry) {
        const g = new Graphics();
        this.layer.addChild(g);
        entry = { g, lastKey: '', handle, blockedBlend: 0 };
        this.entries.set(handle, entry);
      }

      // 延长预览中的原尾格：隐藏带身（该格由创建系统预览渲染接管，避免双层叠印）
      entry.g.visible = !(
        hiddenCell &&
        Math.round(pos.x / CELL_SIZE) === hiddenCell.x &&
        Math.round(pos.y / CELL_SIZE) === hiddenCell.y
      );

      // 位置：格中心（矢量几何以格子中心为原点）
      entry.g.position.set(pos.x + CELL_SIZE / 2, pos.y + CELL_SIZE / 2);

      // 朝向：与 RenderSystem 原 Sprite 逻辑一致
      if (seg.isCorner && seg.entryDir !== undefined) {
        const t = beltCornerTransform(seg.entryDir, seg.direction);
        entry.g.rotation = t.rotation;
        entry.g.scale.set(t.mirrorH ? -1 : 1, 1);
      } else {
        entry.g.rotation = beltTextureRotation(seg.direction);
        entry.g.scale.set(1, 1);
      }

      // 形状重绘（方向/转角/选中态/堵塞态/创建终点态变化时，或堵塞渐变进行中）
      const selected = this.beltSelection?.has(handle) ?? false;
      const blocked = seg.blocked === true;
      // 创建模式下断头末端(tail)带身 Status 黄→蓝渐变（替代整格蓝占位）
      const createTail = createMode && seg.isTail === true;
      // 堵塞渐变进度向目标（0↔1）线性趋近
      const target = blocked ? 1 : 0;
      const b = entry.blockedBlend;
      entry.blockedBlend = b < target ? Math.min(target, b + blendStep)
        : b > target ? Math.max(target, b - blendStep) : b;
      const blend = entry.blockedBlend;
      const key = segShapeKey(seg) + (selected ? '|sel' : '') + (blocked ? '|blocked' : '') + (createTail ? '|create' : '');
      // 渐变进行中（0<blend<1）颜色连续变化 → 也需重绘；到 0/1 后仅 key 变化才重绘
      if (entry.lastKey !== key || (blend > 0 && blend < 1)) {
        entry.g.clear();
        // 染色优先级: 选中态 > 堵塞态 > 创建终点态(黄→蓝渐变) > 素材原色。
        // 选中态：带身整体染选中色（灰壳#B1B1B1/黄带#FFF56A）；
        // 堵塞态：仅 Status 黄带从黄 lerp 到红 #B10000（灰壳 base 保持原色）；
        // 创建终点态：仅 Status 黄带沿带身方向黄 → 蓝 #80BEE9 渐变。
        let colors: BeltColors | undefined;
        if (selected) {
          colors = { shellColor: BELT_COLOR_SHELL_SELECTED, beltColor: BELT_COLOR_BELT_SELECTED };
        } else if (blocked || blend > 0) {
          colors = { beltColor: lerpColor(BELT_COLOR_BELT, BELT_COLOR_STATUS_BLOCKED, blend) };
        } else if (createTail) {
          // 创建模式终点：沿"段首 → 段尾"方向 黄 → 蓝 渐变（段首黄、段尾蓝，末端始终蓝）
          colors = { beltGradient: { from: BELT_COLOR_BELT, to: BELT_COLOR_CREATE } };
        }
        if (seg.isCorner) {
          drawCornerBelt(entry.g, CELL_SIZE, colors);
        } else {
          drawStraightBelt(entry.g, CELL_SIZE, colors, seg.direction);
        }
        entry.lastKey = key;
      }

      // 端口内半格残段收集（见 updatePortStubs），两类判定与连接语义同口径:
      // ① 输入对接（进入侧半格）: 出口相邻格是输入端口，且段方向 = 逆端口朝向指入
      //    （findFeederBelt 同口径）
      if (ports.size > 0) {
        const fdv = directionVector(seg.direction);
        const fx = Math.round(pos.x / CELL_SIZE) + fdv.x;
        const fy = Math.round(pos.y / CELL_SIZE) + fdv.y;
        const hit = ports.get(`${fx},${fy}`);
        if (
          hit !== undefined &&
          seg.direction === (((hit.cell.outward + 180) % 360) as Direction)
        ) {
          portStubs.push({
            key: `${hit.cell.x},${hit.cell.y}`,
            gx: hit.cell.x,
            gy: hit.cell.y,
            dir: seg.direction,
            selected,
            blocked,
            blend,
            exitHalf: false,
            above: hit.above,
          });
        }
      }
      // ② 输出接出（出口侧半格，2026-09-02 补全）: 入口相邻格是输出端口，且入口
      //    朝向 = 端口朝外方向（沿端口朝向接出，findReceiverBelt 的朝向侧对齐形态）
      if (outPorts.size > 0) {
        const entryDir = seg.entryDir ?? seg.direction;
        const edv = directionVector(entryDir);
        const px = Math.round(pos.x / CELL_SIZE) - edv.x;
        const py = Math.round(pos.y / CELL_SIZE) - edv.y;
        const hit = outPorts.get(`${px},${py}`);
        if (hit !== undefined && entryDir === hit.cell.outward) {
          portStubs.push({
            key: `${hit.cell.x},${hit.cell.y}`,
            gx: hit.cell.x,
            gy: hit.cell.y,
            dir: hit.cell.outward,
            selected,
            blocked,
            blend,
            exitHalf: true,
            above: hit.above,
          });
        }
      }
    }

    this.updatePortStubs(portStubs);
  }

  /**
   * 同步"端口内半格残段"（2026-09-02）: 对接输入端口的供给段在其端口格内画**进入侧**
   * 半格带身（物品 progress 1.0→1.5 走进设备期间有带身可骑）；输出端口的接收段在其
   * 端口格内画**出口侧**半格带身（物品 progress=0 从端口格中心冒出，带身从设备下方
   * 接出）。zIndex（T2.20）: 九宫格设备挂 0（设备 zIndex=1 之下，"钻入/钻出"观感，
   * 与走进/走出设备的物品 belowItems 0.5 一致）；**整图设备挂 2（设备之上）**——其
   * 端口格贴图侧边不透明（旋转后尤甚），残段挂之下会被完全遮住、看起来像没连上。
   * 染色跟随所属段（选中/堵塞渐变）。key = 端口格坐标（一格一带下每口至多一段）。
   */
  private updatePortStubs(
    portStubs: Array<{ key: string; gx: number; gy: number; dir: Direction; selected: boolean; blocked: boolean; blend: number; exitHalf: boolean; above: boolean }>,
  ): void {
    const seen = new Set<string>();
    for (const f of portStubs) {
      if (seen.has(f.key)) continue; // 同端口多带防御（一格一带下不可达）
      seen.add(f.key);
      let stub = this.portStubs.get(f.key);
      if (!stub) {
        const g = new Graphics();
        this.layer.addChild(g);
        stub = { g, lastKey: '' };
        this.portStubs.set(f.key, stub);
      }
      // 残段恒挂设备之下（zIndex 0，与带身同层）——"钻入设备"观感: 可见部分为
      // 设备美术的透明边距，边框/面板始终盖在残段之上（T2.20 二次修订:
      // 曾改挂设备之上修正旋转不可见，但会盖住设备边框，已回退）
      stub.g.zIndex = 0;
      stub.g.position.set(f.gx * CELL_SIZE + CELL_SIZE / 2, f.gy * CELL_SIZE + CELL_SIZE / 2);
      stub.g.rotation = beltTextureRotation(f.dir);
      stub.g.scale.set(1, 1);
      const key = `${f.dir}|${f.selected ? 1 : 0}|${f.blocked ? 1 : 0}|${f.exitHalf ? 1 : 0}`;
      if (stub.lastKey !== key || (f.blend > 0 && f.blend < 1)) {
        stub.g.clear();
        let colors: BeltColors | undefined;
        if (f.selected) {
          colors = { shellColor: BELT_COLOR_SHELL_SELECTED, beltColor: BELT_COLOR_BELT_SELECTED };
        } else if (f.blocked || f.blend > 0) {
          colors = { beltColor: lerpColor(BELT_COLOR_BELT, BELT_COLOR_STATUS_BLOCKED, f.blend) };
        }
        // 水平方向（0/180）镜像修正（T2.20）: ±π/2 旋转会把本地"上/下半格"转到
        // 水平流动的背侧（竖直 90/270 的 0/π 旋转天然正确）——取反 exitHalf 使
        // 残段恒落在靠段一侧（朝向带子/设备 mouth）
        const horizontal = f.dir === 0 || f.dir === 180;
        drawStraightBeltStub(stub.g, CELL_SIZE, colors, horizontal ? !f.exitHalf : f.exitHalf);
        stub.lastKey = key;
      }
    }
    for (const [key, stub] of this.portStubs) {
      if (!seen.has(key)) {
        stub.g.removeFromParent();
        stub.g.destroy();
        this.portStubs.delete(key);
      }
    }
  }

  /** 销毁所有带身 Graphics。 */
  destroy(): void {
    for (const entry of this.entries.values()) {
      entry.g.removeFromParent();
      entry.g.destroy();
    }
    this.entries.clear();
    for (const stub of this.portStubs.values()) {
      stub.g.removeFromParent();
      stub.g.destroy();
    }
    this.portStubs.clear();
  }
}
