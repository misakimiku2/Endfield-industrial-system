// 选中系统 — 点击设备/传送带段选中
// 依据: implementation-phase-1.md T1.8、implementation-phase-2.md T2.0 §链管理、
//       A3 building-spec.md §1 (selectable)、A2 world-model.md §2.4 (Position=左上角)、
//       A6 §4 (worldToScreen)
//
// 交互结构（T1.8 前瞻约束，为 Phase 2 T2.14 长按移动预留）:
//   - 用 pointerdown/pointerup 结构，不用 click 事件
//   - pointerdown: 记录按下时间戳 + 命中的目标（不立即 commit，不吞后续事件）
//   - pointerup: 判定"短按(<300ms) → 选中/取消"；长按(≥300ms) Phase 1 无移动语义，
//     不产生任何选中变更。Phase 2 只需在 pointerdown 后挂 300ms 定时器:
//     定时器触发前 pointerup = 选中（走本类原逻辑），定时器触发 = 升级为移动态。
//
// 命中测试:
//   - 设备: 遍历 Position+SpriteComp+BuildingComp，footprint 世界 AABB 点包含测试
//     （Phase 1 footprint 全正方形，旋转不改 AABB，A3 §6）。尊重 def.selectable。
//   - 传送带段（T2.0）: 遍历 Position+SpriteComp+BeltSegmentComp，1×1 格 AABB 测试。
//   - 设备格与传送带格互斥（防穿模），同一世界点不会同时命中两者。
//
// 选中态（T2.0 起）: 设备与传送带链**互斥**——
//   - 选设备 → 单实体 screen-space 选中框（footprint 黄填充 + 白描边，T1.8 视觉）。
//   - 单击传送带段 → 选中**该单格**；双击同一格 → 升级为**整条链**。
//     带身选中视觉（屏幕常量斜杠 + 白边）移交 BeltSelectionRenderer / BeltVectorRenderer，
//     本系统只维护选中态并写入共享 BeltSelection（每帧重算），不再画 screen-space 带身框。

import { Graphics } from 'pixi.js';
import type { World, EntityHandle } from '../ECS';
import type { Camera } from '../render/Camera';
import type { SceneLayers } from '../render/SceneRenderer';
import type { Position } from '../components/Position';
import type { SpriteComp } from '../components/SpriteComp';
import type { BuildingComp } from '../components/BuildingComp';
import type { BeltSegmentComp } from '../components/BeltSegmentComp';
import { getBuildingDefinition } from '../data/buildings';
import { queryChain } from './belt/BeltChainOps';
import type { BeltSelection } from './belt/BeltSelection';

/** 短按阈值 (ms)。pointerup 时按下时长 < 此值 → 选中；≥ 此值 = 长按（Phase 2 移动态用）。 */
export const SELECTION_SHORT_PRESS_MS = 300;
/** 传送带双击阈值 (ms)：两次单击同一格且间隔 < 此值 → 升级为整链选中。 */
const DOUBLE_CLICK_MS = 350;

/** 选中框主线宽基准（屏幕像素，zoom=1 时的线宽；随 zoom 等比缩放）。 */
const SELECTION_LINE_WIDTH_AT_ZOOM_1 = 4;
/** 选中框最小线宽（屏幕像素），防止缩到最小时线条消失/过糊。 */
const SELECTION_LINE_WIDTH_MIN = 1.5;
/** 选中框填充色（黄色，选中区域整体染色，浅色地面上高可见）。 */
const SELECTION_FILL_COLOR = 0xffd500;
/** 选中框填充透明度（越高越醒目，但会盖住设备细节）。 */
const SELECTION_FILL_ALPHA = 0.25;
/** 选中框主线颜色（纯白，T1.8 验收标准）。 */
const SELECTION_LINE_COLOR = 0xffffff;

/** 统一选中目标: 设备（单实体）或传送带段（点击的段 + 其 chainId + 是否整链）。两者互斥。 */
export type SelectionTarget =
  | { kind: 'device'; handle: EntityHandle }
  | { kind: 'belt'; handle: EntityHandle; chainId: string; wholeChain: boolean };

/** 鼠标修饰键状态（main.ts 从 PointerEvent.shiftKey/ctrlKey 透传）。 */
export interface PointerMods {
  shift: boolean;
  ctrl: boolean;
}

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
 * 命中测试: 屏幕点对应世界坐标 (wx,wy) 落在哪个传送带段的格子内（T2.0）。
 *
 * 传送带段为 1×1 Cell（Position=格子左上角，SpriteComp.width/height=CELL_SIZE）。
 * 与设备格互斥（防穿模），不会与 pickBuildingAt 同时命中同一格。
 *
 * @returns 命中的段 handle；未命中返回 null。
 */
export function pickBeltSegmentAt(
  world: World,
  wx: number,
  wy: number,
): EntityHandle | null {
  for (const handle of world.query('Position', 'SpriteComp', 'BeltSegmentComp')) {
    const pos = world.getComponent<Position>(handle, 'Position')!;
    const spr = world.getComponent<SpriteComp>(handle, 'SpriteComp')!;
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
 * 统一命中: 先设备后传送带（两者格互斥，顺序不影响正确性；设备优先保留 T1.8 语义）。
 * 返回的 belt 目标 wholeChain 恒为 false（单格）；双击升级由 onPointerUp 处理。
 * @returns SelectionTarget 或 null（点空白）。
 *
 * 注意：EntityHandle 是 number（encodeHandle 生成，首个实体可能为 0），必须用 `!== null`
 *       判空——`if (handle)` 会把 handle=0 误判为未命中（曾导致第一个传送带段无法选中）。
 */
export function pickTargetAt(world: World, wx: number, wy: number): SelectionTarget | null {
  const dev = pickBuildingAt(world, wx, wy);
  if (dev !== null) return { kind: 'device', handle: dev };
  const belt = pickBeltSegmentAt(world, wx, wy);
  if (belt !== null) {
    const seg = world.getComponent<BeltSegmentComp>(belt, 'BeltSegmentComp')!;
    return { kind: 'belt', handle: belt, chainId: seg.chainId, wholeChain: false };
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
 *   - onPointerDown(screenX, screenY, button, now): 记录时间戳 + 命中目标
 *   - onPointerUp(now): 短按提交选中/取消（传送带支持双击升级整链）
 *   - update(): 每帧重绘设备选中框（跟随相机）+ 重算传送带选中态写入 BeltSelection
 */
export class SelectionSystem {
  private world: World;
  private camera: Camera;
  /** 屏幕空间选中框（overlayLayer 子节点，工具栏之下）。 */
  private graphics: Graphics;
  /** 当前选中的目标（设备或传送带段 anchor）；null = 未选中。多选时为最近点击的段/设备。 */
  private selected: SelectionTarget | null = null;
  /** pointerdown 记录的按压上下文（含修饰键，T1.8 前瞻约束）。 */
  private pendingPress: { target: SelectionTarget | null; time: number; mods: PointerMods } | null = null;
  /** 上一次单击传送带段的记录（双击检测用）。 */
  private lastBeltClick: { handle: EntityHandle; time: number } | null = null;
  /** Shift 范围连选的起点（= 上次普通单击的传送带段）；Ctrl/Shift 操作不更新它（与文件选择一致）。 */
  private anchorBelt: EntityHandle | null = null;
  /** 最近一次绘制时选中框的屏幕左上角（HUD/调试用，未选中时为 null）。 */
  private lastBoxTopLeft: { x: number; y: number } | null = null;
  /** 传送带选中态共享对象（渲染器读）；可选，未注入时带身选中视觉不渲染。 */
  private beltSelection: BeltSelection | null = null;

  constructor(world: World, camera: Camera, layers: SceneLayers, beltSelection?: BeltSelection) {
    this.world = world;
    this.camera = camera;
    this.beltSelection = beltSelection ?? null;
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
  onPointerDown(screenX: number, screenY: number, button: number, now: number, mods: PointerMods = { shift: false, ctrl: false }): void {
    if (button !== 0) return;
    const w = this.camera.screenToWorld(screenX, screenY);
    this.pendingPress = {
      target: pickTargetAt(this.world, w.x, w.y),
      time: now,
      mods,
    };
  }

  /**
   * 鼠标抬起（main 的 pointerup 转发）。
   * 短按(<300ms) → 提交选中:
   *   - 命中设备 → 选中设备；
   *   - 命中传送带段 → 单击选中该单格；若与上次单击同段且 <DOUBLE_CLICK_MS → 升级整链；
   *   - 命中空白 → 取消选中。
   * 长按(≥300ms) → Phase 1 无移动语义，不改变选中。
   */
  onPointerUp(now: number): void {
    if (!this.pendingPress) return;
    const { target, time, mods } = this.pendingPress;
    this.pendingPress = null; // 一次性消费
    if (now - time >= SELECTION_SHORT_PRESS_MS) return; // 长按不选中

    if (target === null) {
      // 点空白：无修饰键 → 清空所有选中；Ctrl/Shift 保留现有选中（便于继续多选）
      if (!mods.shift && !mods.ctrl) this.commitClear();
      return;
    }
    if (target.kind === 'belt') {
      if (mods.shift) {
        // Shift：范围连选（anchor → target，同链）；anchor 不变（与文件选择一致）
        this.selectRange(target);
        this.selected = target;
      } else if (mods.ctrl) {
        // Ctrl：切换该格选中态；anchor 不变
        this.beltSelection?.toggle(target.handle);
        this.selected = target;
      } else {
        // 普通单击/双击：替换选中，并更新 Shift 起点
        const last = this.lastBeltClick;
        const isDouble =
          last !== null &&
          last.handle === target.handle &&
          now - last.time < DOUBLE_CLICK_MS;
        if (isDouble) {
          // 双击 → 整链
          this.beltSelection?.set(queryChain(this.world, target.chainId));
          this.selected = { ...target, wholeChain: true };
          this.lastBeltClick = null; // 双击后清空，避免三连击误判
        } else {
          this.beltSelection?.set([target.handle]);
          this.selected = { ...target, wholeChain: false };
          this.lastBeltClick = { handle: target.handle, time: now };
        }
        this.anchorBelt = target.handle;
      }
    } else {
      // 设备 → 清 belt 选中 + 双击记忆 + anchor
      this.lastBeltClick = null;
      this.anchorBelt = null;
      this.beltSelection?.clear();
      this.selected = target;
    }
  }

  /** 清空所有选中（belt 多选 + 设备 anchor + Shift 起点 + 双击记忆）。 */
  private commitClear(): void {
    this.selected = null;
    this.anchorBelt = null;
    this.lastBeltClick = null;
    this.beltSelection?.clear();
    this.hideHighlight();
  }

  /**
   * Shift 范围连选：选中 anchorBelt → target 之间（同链）的所有段。
   * 同链时按 segmentIndex 升序取闭区间 [anchor, target]；不同链/无 anchor → 退化为只选 target。
   * anchorBelt 不变（下次 Shift 仍从同一 anchor 起，与文件选择一致）。
   */
  private selectRange(target: Extract<SelectionTarget, { kind: 'belt' }>): void {
    if (this.anchorBelt === null || !this.world.isAlive(this.anchorBelt)) {
      this.beltSelection?.set([target.handle]);
      this.anchorBelt = target.handle;
      return;
    }
    const anchorSeg = this.world.getComponent<BeltSegmentComp>(this.anchorBelt, 'BeltSegmentComp');
    if (!anchorSeg || anchorSeg.chainId !== target.chainId) {
      // 不同链：退化为只选 target，并把 anchor 移到 target
      this.beltSelection?.set([target.handle]);
      this.anchorBelt = target.handle;
      return;
    }
    const chain = queryChain(this.world, target.chainId);
    // 按 segmentIndex 升序（链首→链尾）定链内顺序
    chain.sort((a, b) => {
      const sa = this.world.getComponent<BeltSegmentComp>(a, 'BeltSegmentComp')!;
      const sb = this.world.getComponent<BeltSegmentComp>(b, 'BeltSegmentComp')!;
      return sa.segmentIndex - sb.segmentIndex;
    });
    const ai = chain.indexOf(this.anchorBelt);
    const ti = chain.indexOf(target.handle);
    if (ai < 0 || ti < 0) {
      this.beltSelection?.set([target.handle]);
      this.anchorBelt = target.handle;
      return;
    }
    const lo = Math.min(ai, ti);
    const hi = Math.max(ai, ti);
    this.beltSelection?.set(chain.slice(lo, hi + 1));
  }

  /**
   * 每帧调用（在 camera.updateTransform 之后）:
   *   - 重算传送带选中态写入 BeltSelection（wholeChain→queryChain，单格→[handle]）；
   *   - 设备选中 → 重绘 screen-space 选中框；传送带选中 → 不画 screen 框（视觉在带身渲染器）；
   *   - 目标已销毁/链已空 → 清空选中态。
   */
  update(): void {
    // 设备选中：重绘 screen-space 选中框（跟随相机）；已销毁则清空
    if (this.selected?.kind === 'device') {
      if (!this.world.isAlive(this.selected.handle)) {
        this.commitClear();
        return;
      }
      this.drawDeviceBox(this.selected.handle);
      return;
    }
    // belt：beltSelection 由交互（onPointerUp/selectRange）直接维护，这里不再每帧 clear+set
    // （多选需要持久集合）。只做 anchor/选中段销毁清理 + HUD 参考坐标。
    if (this.selected?.kind === 'belt' && !this.world.isAlive(this.selected.handle)) {
      this.commitClear();
      return;
    }
    // 非 device 时不画 screen 框（带身选中视觉在 BeltVectorRenderer/BeltPointerRenderer）
    this.graphics.visible = false;
    this.graphics.clear();
    const beltHandle = this.selected?.kind === 'belt' ? this.selected.handle : null;
    const pos = beltHandle !== null ? this.world.getComponent<Position>(beltHandle, 'Position') : null;
    this.lastBoxTopLeft = pos ? this.camera.worldToScreen(pos.x, pos.y) : null;
  }

  /**
   * 当前选中的**设备** handle（T1.9 删除/调试用）。
   * 传送带选中时返回 null（链删除走 getSelectedChain + BeltChainOps）。
   */
  getSelected(): EntityHandle | null {
    return this.selected?.kind === 'device' ? this.selected.handle : null;
  }

  /**
   * 当前选中的**传送带链**（点击的段 handle + chainId + 是否整链）。
   * 设备选中或未选中时返回 null。供 main.ts 的 Delete 分支用（wholeChain→整链删，否则单段删）。
   * 点击的段若已被单段删除，返回 null（防御）。
   */
  getSelectedChain(): { handle: EntityHandle; chainId: string; wholeChain: boolean } | null {
    if (this.selected?.kind !== 'belt') return null;
    if (!this.world.isAlive(this.selected.handle)) return null;
    return {
      handle: this.selected.handle,
      chainId: this.selected.chainId,
      wholeChain: this.selected.wholeChain,
    };
  }

  /**
   * 最近一次绘制的选中框屏幕左上角（调试/HUD 用）。
   * 未选中时返回 null。
   */
  getBoxTopLeft(): { x: number; y: number } | null {
    return this.lastBoxTopLeft;
  }

  /** 清空选中态（删除设备/链后调用，或外部重置）。同步清 BeltSelection 与双击记忆。 */
  clearSelection(): void {
    this.commitClear();
  }

  /**
   * 隐藏并清除选中框图形（清空 lastBoxTopLeft）。
   * selected===null 时的所有出口都必须经过这里。
   */
  private hideHighlight(): void {
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

  /** 重绘设备选中框: footprint 四角 → 屏幕四边形 → 黄填充 + 白描边。 */
  private drawDeviceBox(handle: EntityHandle): void {
    const pts = buildingScreenPolygon(this.camera, this.world, handle);
    if (!pts) {
      // 实体刚被销毁但 update 尚未跑（防御），隐藏即可
      this.hideHighlight();
      return;
    }

    // 防御: 任一顶点非有限值（NaN/Infinity）时跳过绘制并隐藏，
    // 避免脏坐标渲染出异常位置/形状的图形。
    for (const p of pts) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        console.warn('[SelectionSystem] 选中框坐标非有限值，已隐藏:', pts);
        this.hideHighlight();
        return;
      }
    }

    // 像素对齐（取整）→ 线条更锐利，避免落在半像素上发糊
    const snapped = pts.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));

    const g = this.graphics;
    g.clear();
    // 填充层: 半透明黄色铺满 footprint，选中设备一眼可辨
    g.poly(snapped).fill({ color: SELECTION_FILL_COLOR, alpha: SELECTION_FILL_ALPHA });
    // 纯白主线 (验收标准: 白色选中框，矩形描边；用户要求无黑边、线加粗)
    // 线宽 = 基准 × zoom（下限保护），使线相对设备在任何缩放级别下观感一致
    const lineWidth = Math.max(
      SELECTION_LINE_WIDTH_MIN,
      SELECTION_LINE_WIDTH_AT_ZOOM_1 * this.camera.zoom,
    );
    g.poly(snapped).stroke({ width: lineWidth, color: SELECTION_LINE_COLOR, alpha: 1 });
    g.visible = true;
    this.lastBoxTopLeft = { x: snapped[0].x, y: snapped[0].y };
  }
}
