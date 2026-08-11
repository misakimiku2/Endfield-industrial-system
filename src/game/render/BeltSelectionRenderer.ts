// 传送带选中视觉渲染器 — T2.0 链管理（屏幕常量斜杠 + 黄色遮罩）
//
// 用户需求（参考 Transport.svg）:
//   - 选中带身的黄色区域(#FFEF00) 作为遮罩，里面显示**屏幕常量**的 45° 斜杠(#eec213)。
//   - 斜杠大小/方向恒定，不随滚轮缩放变化（锚定屏幕）；黄色遮罩随带身缩放/旋转。
//
// 实现原理（已数学验证，zoom 无覆盖盲区）:
//   Camera 对 worldContainer: scale=zoom, rotation=-displayRotation, pivot=相机中心。
//   stripeG 作为 worldContainer 子级（经 container 定位到格中心），scale=1、rotation=displayRotation。
//   ⇒ stripeG 本地坐标 p 映射到屏幕 = worldToScreen(格中心) + zoom·p（旋转抵消，方向锁屏）。
//   ⇒ 在 stripeG 本地按「PERIOD/zoom」间距画斜线，屏幕间距恒为 PERIOD；本地跨度用世界单位
//     （±CELL_SIZE）→ 屏幕跨度 ±CELL_SIZE·zoom，永远覆盖整格（无高 zoom 盲区）。
//   斜线粗细同理用 (PERIOD/2)/zoom，屏幕粗细恒为 PERIOD/2。
//
//   黄色遮罩 maskG 与带身 body 相同 transform（世界坐标，随带身缩放/旋转），
//   通过 PixiJS StencilMask 在屏幕空间裁剪 stripeG → 自然支持转角（复用弧形几何）。
//
// 结构（每个选中段）:
//   layer2Building → container(position=格中心, mask=maskG, zIndex 高)
//                     ├─ maskG(transform=带身 transform, 画黄色形, StencilMask 不显色)
//                     └─ stripeG(scale=1, rotation=displayRotation, 画斜线)
//   关键: container.mask=maskG（而非 stripeG.mask=maskG），使 PixiJS 把 maskG 画进 stencil
//   时关颜色写入，maskG 不作为普通子级显色（与 BeltPointerRenderer 的 cellWrap.mask 同路径）。
//   斜线随 zoom 变化重画（间距/粗细=PERIOD/zoom）；rotation 每帧更新（旋转过渡连续）。

import { Graphics, Container } from 'pixi.js';
import type { World, EntityHandle } from '../ECS';
import type { Camera } from './Camera';
import type { BeltSelection } from '../systems/belt/BeltSelection';
import type { BeltSegmentComp } from '../components/BeltSegmentComp';
import type { Position } from '../components/Position';
import { beltTextureRotation, beltCornerTransform } from '../systems/belt/BeltPathGeometry';
import { drawBeltYellowShape, BELT_COLOR_STRIPE } from './BeltVectorGeometry';
import { CELL_SIZE } from './constants';

/** 斜杠屏幕周期（px）：斜线 + 间隙，1:1。 */
const STRIPE_PERIOD = 8;
/** 斜线本地（世界）跨度：覆盖整格黄带（黄带约 53% 格宽，留裕量）。 */
const STRIPE_EXTENT = CELL_SIZE;
/** zoom 变化超过此阈值才重画斜线（避免每帧重画）。 */
const STRIPE_REDRAW_ZOOM_EPS = 0.01;

/** 单个选中段的渲染态。 */
interface SelEntry {
  /** 定位到格中心、以 maskG 为蒙版的容器（世界坐标）。 */
  container: Container;
  /** 黄色形蒙版（与带身 body 同 transform，StencilMask 不显色）。 */
  maskG: Graphics;
  /** 屏幕常量斜线（每帧 rotation=displayRotation；zoom 变时重画间距）。 */
  stripeG: Graphics;
  handle: EntityHandle;
}

/**
 * 传送带选中视觉渲染器。
 *
 * 用法：主循环每帧调用 update()。选中态由 BeltSelection 提供（setBeltSelection 注入）。
 * 选中集合变化时自动增删 per-段 container；zoom 变化时重画所有斜线（保持屏幕等距）。
 */
export class BeltSelectionRenderer {
  private world: World;
  private layer: Container;
  private camera: Camera;
  private beltSelection: BeltSelection | null = null;

  /** handle → entry，用于 diff。 */
  private entries = new Map<EntityHandle, SelEntry>();
  /** 上次画斜线时的 zoom（变化超阈值则重画）。 */
  private lastStripeZoom = -1;

  constructor(world: World, layer: Container, camera: Camera) {
    this.world = world;
    this.layer = layer;
    this.camera = camera;
  }

  /** 注入选中态（由 RenderSystem.setBeltSelection 转发）。 */
  setBeltSelection(bs: BeltSelection): void {
    this.beltSelection = bs;
  }

  /** 每帧同步选中段的视觉。 */
  update(): void {
    const bs = this.beltSelection;
    // 收集当前选中段（遍历所有段过滤；T2.0 规模下开销可忽略）
    const selected: EntityHandle[] = [];
    if (bs && bs.size > 0) {
      for (const h of this.world.query('Position', 'BeltSegmentComp')) {
        if (bs.has(h)) selected.push(h);
      }
    }
    const seen = new Set(selected);

    // 1. 销毁不再选中的段
    for (const [handle, e] of this.entries) {
      if (!seen.has(handle) || !this.world.isAlive(handle)) {
        e.container.destroy({ children: true });
        this.entries.delete(handle);
      }
    }

    if (selected.length === 0) return;

    // 2. 新增
    for (const handle of selected) {
      if (!this.entries.has(handle)) {
        this.createEntry(handle);
      }
    }

    // 3. 每帧更新 stripeG 旋转（跟随视图旋转过渡）；zoom 变化时重画斜线间距/粗细
    const dispRot = this.camera.displayRotation;
    const zoom = this.camera.zoom;
    const zoomChanged = Math.abs(zoom - this.lastStripeZoom) > STRIPE_REDRAW_ZOOM_EPS;
    if (zoomChanged) {
      this.lastStripeZoom = zoom;
    }
    for (const e of this.entries.values()) {
      e.stripeG.rotation = dispRot;
      if (zoomChanged) {
        this.drawStripes(e.stripeG, zoom);
      }
    }
  }

  /** 为一个新选中的段创建 per-段结构（maskG 形状/transform 与 stripeG 斜线均按当前 zoom 画一次）。 */
  private createEntry(handle: EntityHandle): void {
    const seg = this.world.getComponent<BeltSegmentComp>(handle, 'BeltSegmentComp')!;
    const pos = this.world.getComponent<Position>(handle, 'Position')!;

    const container = new Container({ label: 'beltSel' });
    container.zIndex = 10000; // 盖在带身 body 之上
    container.position.set(pos.x + CELL_SIZE / 2, pos.y + CELL_SIZE / 2);

    // maskG：与带身 body 完全相同的 transform（直段 beltTextureRotation / 转角 beltCornerTransform）
    const maskG = new Graphics({ label: 'beltSelMask' });
    if (seg.isCorner && seg.entryDir !== undefined) {
      const t = beltCornerTransform(seg.entryDir, seg.direction);
      maskG.rotation = t.rotation;
      maskG.scale.set(t.mirrorH ? -1 : 1, 1);
    } else {
      maskG.rotation = beltTextureRotation(seg.direction);
      maskG.scale.set(1, 1);
    }
    drawBeltYellowShape(maskG, CELL_SIZE, seg.isCorner);

    // stripeG：屏幕常量斜线（本地坐标，间距/粗细随 zoom；rotation 每帧由 update 设）
    const stripeG = new Graphics({ label: 'beltSelStripe' });
    this.drawStripes(stripeG, this.camera.zoom);
    stripeG.rotation = this.camera.displayRotation;

    container.addChild(maskG, stripeG);
    // 关键: 把 maskG 设为**父容器**的 mask（非 stripeG 的 mask）。
    // 这样 PixiJS 渲染 container 时把 maskG 画进 stencil（关颜色写入，不显色），
    // 再渲染其余子级（stripeG）时按 stencil 裁剪——maskG 本身不会作为普通子级可见
    // （与 BeltPointerRenderer 的 cellWrap.mask=cellMask 同一可靠路径）。
    // 若改成 stripeG.mask=maskG，maskG 会作为常规子级额外显色（白色/黄色形残留）。
    container.mask = maskG;
    this.layer.addChild(container);

    this.entries.set(handle, { container, maskG, stripeG, handle });
  }

  /**
   * 在 stripeG 本地（世界）坐标画 45° 斜线（y = x + cv）。
   * 间距 = PERIOD/zoom、粗细 = (PERIOD/2)/zoom → 屏幕间距/粗细恒定（net screen scale = zoom）。
   * 跨度 ±STRIPE_EXTENT（世界）→ 屏幕 ±STRIPE_EXTENT·zoom，覆盖整格。
   */
  private drawStripes(g: Graphics, zoom: number): void {
    g.clear();
    const spacing = STRIPE_PERIOD / zoom;
    const width = STRIPE_PERIOD / 2 / zoom;
    const ext = STRIPE_EXTENT;
    g.beginPath();
    for (let cv = -2 * ext; cv <= 2 * ext; cv += spacing) {
      g.moveTo(-ext, -ext + cv);
      g.lineTo(ext, ext + cv);
    }
    g.stroke({ color: BELT_COLOR_STRIPE, width });
  }

  /** 销毁全部 per-段结构。 */
  destroy(): void {
    for (const e of this.entries.values()) {
      e.container.destroy({ children: true });
    }
    this.entries.clear();
  }
}
