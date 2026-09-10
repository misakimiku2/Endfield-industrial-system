// 设备预览渲染器 — 放置预览（T1.7）与移动拾取预览（T2.14）共用的渲染组件
// 依据: implementation-phase-1.md T1.7、implementation-phase-2.md T2.14（"移动态逻辑
//       的可复用性（preview/occupy/release 抽象成不绑死单设备的 API）"）、
//       A3 building-spec.md §5、A6 coordinate-spec.md §4.0 (viewRotation 参考系)
//
// 从 PlacementSystem 抽出的预览机制（2026-09-11 T2.14）:
//   - whole 设备（T1.7 v4）: Sprite + PreviewTintFilter 双纹理 mask——设备原图染主体
//     纯色（可放置蓝/不可放置橙红），箭头 mask 纹理精确指示箭头区域 → 白。
//   - nineslice 设备（T1.11c，S2 §5.3）: Container[底座切片拼装, 端口叠加, equipment
//     Sprite, logo]，染色 = 容器内逐 Sprite tint（无整机 mask 帧可用）。
//   - billboard 徽标层反向旋转保持屏幕朝上。
//   - 鼠标=设备中心吸附网格（T1.7 修订）、旋转=世界角（screenAngle − viewRotation，
//     与落盘 direction 同公式）、有效性=canPlace(有效占地)（T2.17 宽高互换同源）。
//
// 使用方式: 每帧 sync(frame) 一次（跟随鼠标/旋转/染色全在此更新），hide() 隐藏，
//   destroy() 销毁。sync 返回本次采样（落盘可直接复用，保证所见即所放）。

import { Sprite, Texture, Container } from 'pixi.js';
import type { Camera } from './Camera';
import type { SceneLayers } from './SceneRenderer';
import type { TextureLookup } from '../systems/RenderSystem';
import type { BuildingDefinition } from '../data/buildings';
import { effectiveFootprint } from '../data/buildings';
import type { Direction } from '../components/BuildingComp';
import type { OccupancyMap } from '../world/OccupancyMap';
import { CELL_SIZE } from './constants';
import { PreviewTintFilter } from './PreviewTintFilter';
import { buildNineSliceBase, buildNineSlicePorts, tintContainer } from './NineSliceAssembler';
import { portMaskFromDef } from './PortMask';
import type { ScreenAngle } from '../systems/RotationPolicy';
import { LOGO_WHOLE_SCALE } from '../systems/RenderSystem';

/** 预览半透明度（T1.7 沿用）。 */
export const PREVIEW_ALPHA = 0.7;
/** 预览染色（与 PreviewTintFilter 的 VALID/INVALID 同色，nineslice 逐 Sprite tint 用）。 */
export const PREVIEW_TINT_VALID = 0x76bbea;
export const PREVIEW_TINT_INVALID = 0xe45050;

/**
 * sprite.rotation 的符号修正。+1 = sprite.rotation = +worldAngle_rad（标准约定）。
 * 若浏览器实测发现设备逆时针转，改 −1 重测。集中在常量便于单点修正。
 */
const ROTATION_SIGN = 1;

/** 一次 sync 的输入快照。 */
export interface PreviewFrame {
  /** 预览的建筑定义（决定纹理/路径/尺寸）。 */
  def: BuildingDefinition;
  camera: Camera;
  /** 有效性检查（canPlace）的占用表——移动态传的是"已释放原占位"后的同一张表。 */
  occupancy: OccupancyMap;
  /** 鼠标世界坐标（调用方先做 screenToWorld）。 */
  mouseWorldX: number;
  mouseWorldY: number;
  /** 屏幕呈现角（按 R 递增，A6 §4.0 相对视图）。 */
  screenAngle: ScreenAngle;
  /** false = 隐藏（鼠标离场等）。 */
  visible: boolean;
}

/** 一次 sync 的结果采样（调用方可直接用于落盘，所见即所放）。 */
export interface PreviewSample {
  /** 世界朝向 = (screenAngle − viewRotation + 360) % 360（与落盘 direction 同公式）。 */
  direction: Direction;
  /** 有效占地左上角 Cell 坐标。 */
  grid: { x: number; y: number };
  /** 有效占地左上角世界像素（严格从 grid 派生）。 */
  world: { x: number; y: number };
  /** 有效占地宽高（Cell，90°/270° 时宽高互换）。 */
  effW: number;
  effH: number;
  /** 当前位置是否可放置（canPlace）。 */
  valid: boolean;
}

/**
 * 设备预览（放置/移动共用）。不进 ECS，挂在 layer2Building（受相机变换支配），
 * zIndex 10000 浮于已放置设备之上。
 */
export class DevicePreview {
  private readonly layers: SceneLayers;
  private readonly getTexture: TextureLookup;

  /** 预览渲染根（whole = Sprite，nineslice = Container）。 */
  private preview: Container | null = null;
  /** whole 路径的染色 filter（nineslice 路径为 null）。 */
  private filter: PreviewTintFilter | null = null;
  /** 当前预览是否为 nineslice 路径（null = 尚未创建）。 */
  private nineslice: boolean | null = null;
  /** 当前预览显示的纹理 key（def 变化时换内容）。 */
  private textureKey: string | null = null;
  /** billboard 徽标子 Sprite（preview 子节点，跟随染色并保持屏幕朝上）。 */
  private logo: Sprite | null = null;

  constructor(layers: SceneLayers, getTexture: TextureLookup) {
    this.layers = layers;
    this.getTexture = getTexture;
  }

  /** 预览根节点（震动偏移等每帧附加效果用；未创建时 null）。 */
  get node(): Container | null {
    return this.preview;
  }

  /**
   * 每帧同步：确保预览节点与 def 匹配（whole/nineslice 路径 + 内容）、定位吸附网格、
   * 设置旋转、按 canPlace 切换染色。返回本次采样；frame.visible=false 时只隐藏并返回 null。
   */
  sync(frame: PreviewFrame): PreviewSample | null {
    if (!frame.visible) {
      this.hide();
      return null;
    }
    const { def } = frame;
    this.ensure(def);
    const preview = this.preview!;

    const wp = def.footprint.w * CELL_SIZE; // sprite 内容世界像素宽（0° 朝向，未旋转）
    const hp = def.footprint.h * CELL_SIZE;

    // 换内容（def 或 textureKey 变化时）
    if (this.textureKey !== def.texture) {
      if (this.nineslice) {
        this.rebuildNineslice(def, wp, hp);
      } else {
        const sprite = preview as Sprite;
        const tex = this.getTexture('devices', def.texture) ?? Texture.EMPTY;
        sprite.texture = tex;
        sprite.width = wp;
        sprite.height = hp;
        // 同步注入箭头 mask（双纹理 filter 用，精确识别箭头变白，避免端口灰色缝隙误染）
        this.filter!.setMask(this.getTexture('devices', `${def.texture}_arrow_mask`));
      }
      this.textureKey = def.texture;
    }

    // billboard 徽标层：作为 preview 子 Sprite，跟随染色并保持屏幕朝上
    if (def.logoTextureKey) {
      if (!this.logo) {
        this.logo = new Sprite(Texture.EMPTY);
        this.logo.anchor.set(0.5);
        this.logo.alpha = PREVIEW_ALPHA;
        preview.addChild(this.logo);
      }
      const logoTex = this.getTexture('devices', def.logoTextureKey) ?? Texture.EMPTY;
      if (this.logo.texture !== logoTex) {
        this.logo.texture = logoTex;
        // whole: 根 Sprite 已按 设备px/纹理px 缩放，scale 继承后乘 LOGO_WHOLE_SCALE
        // 稍作缩小（与 RenderSystem 已放置设备一致）；nineslice: 根 scale=1，
        // logo 帧是全画布尺寸（orig=设备画布）→ 显式缩放到设备世界尺寸（T1.11c 修复）
        this.logo.scale.set(this.nineslice && logoTex.width > 0 ? wp / logoTex.width : LOGO_WHOLE_SCALE);
      }
      this.logo.visible = true;
    } else if (this.logo) {
      this.logo.visible = false;
    }

    // 旋转: 世界角度 = screenAngle − viewRotation（A6 §4.0），与落盘 direction 同公式。
    // 先算角度 → 有效占地（T2.17: 90°/270° 时宽高互换），预览锚点/占用检查与落盘共用。
    const view = frame.camera.viewRotation;
    const direction = (((frame.screenAngle - view) % 360) + 360) % 360 as Direction;
    const { w: effW, h: effH } = effectiveFootprint(def.footprint, direction);

    // 世界坐标 → 以鼠标为中心算有效占地左上角（T1.7 修订：鼠标=设备中心）
    const place = placementFromMouse(frame.mouseWorldX, frame.mouseWorldY, effW, effH);

    // 根节点 position = 有效占地中心（whole 的 Sprite anchor 0.5 / nineslice 子树以
    // 原点为中心）。sprite 内容恒按 0° 尺寸 wp×hp 绘制、由 rotation 整体旋转——
    // 90°/270° 时视觉恰好覆盖互换后的 effW×effH 占地，中心重合即对齐（T2.17）。
    preview.position.set(
      place.topLeftWorld.x + (effW * CELL_SIZE) / 2,
      place.topLeftWorld.y + (effH * CELL_SIZE) / 2,
    );
    preview.rotation = ROTATION_SIGN * (direction * Math.PI) / 180;
    // 同步 filter mask 旋转，使端口箭头跟随预览一起转（whole 路径）
    this.filter?.setRotation(preview.rotation);

    // billboard 徽标反向旋转（保持屏幕朝上）
    if (this.logo && def.logoTextureKey) {
      this.logo.rotation = frame.camera.displayRotation - preview.rotation;
    }

    // 有效性反馈: whole → filter 切主体纯色；nineslice → 逐 Sprite tint
    const valid = frame.occupancy.canPlace(place.topLeftGrid.x, place.topLeftGrid.y, effW, effH);
    if (this.nineslice) {
      tintContainer(preview, valid ? PREVIEW_TINT_VALID : PREVIEW_TINT_INVALID);
    } else {
      this.filter!.setValid(valid);
    }

    preview.visible = true;
    return {
      direction,
      grid: place.topLeftGrid,
      world: place.topLeftWorld,
      effW,
      effH,
      valid,
    };
  }

  /** 隐藏预览（保留节点，下次 sync 复用）。 */
  hide(): void {
    if (this.preview) this.preview.visible = false;
  }

  /** 销毁预览节点与 filter（teardown 用）。 */
  destroy(): void {
    if (this.preview) {
      this.preview.removeFromParent();
      this.preview.destroy({ children: true });
      this.preview = null;
      this.logo = null; // 子节点会随 preview 一起销毁
    }
    this.filter?.destroy();
    this.filter = null;
    this.nineslice = null;
  }

  // ───────────────────────── 内部 ─────────────────────────

  /**
   * 确保预览根节点已创建且路径类型（whole/nineslice）匹配。
   * 路径类型变化时销毁重建（whole 的 Sprite+filter ↔ nineslice 的 Container）。
   */
  private ensure(def: BuildingDefinition): void {
    const nineslice = def.baseStyle === 'nineslice';
    if (this.preview && this.nineslice === nineslice) return;
    if (this.preview) {
      this.preview.removeFromParent();
      this.preview.destroy({ children: true });
      this.preview = null;
      this.logo = null;
      this.filter?.destroy();
      this.filter = null;
    }
    this.nineslice = nineslice;
    this.textureKey = null; // 强制重建内容
    if (nineslice) {
      this.preview = new Container({ label: 'devicePreview-nineslice' });
    } else {
      const sprite = new Sprite(Texture.EMPTY);
      sprite.anchor.set(0.5);
      // 染色 filter: 主体纯色 + 端口白（可放置=蓝 / 不可放置=橙红）
      this.filter = new PreviewTintFilter();
      sprite.filters = [this.filter];
      this.preview = sprite;
    }
    this.preview.alpha = PREVIEW_ALPHA;
    this.preview.visible = false;
    // 高 zIndex: 预览浮在已放置设备之上（layer2Building 已开 sortableChildren）
    this.preview.zIndex = 10000;
    this.layers.layer2Building.addChild(this.preview);
  }

  /**
   * 重建 nineslice 预览内容：清空根容器，放入底座拼装 + 端口叠加 + equipment Sprite。
   * 端口按 def.ports 派生掩码叠加（T1.12，S3 §5.1）——预览与已放置设备同构，
   * tintContainer 逐 Sprite 染色自动覆盖端口/装饰条。logo 子 Sprite 由 sync 统一管理。
   */
  private rebuildNineslice(def: BuildingDefinition, wp: number, hp: number): void {
    const preview = this.preview!;
    // 移除旧子节点（logo 除外——logo 由 sync 复用）
    for (const child of [...preview.children]) {
      if (child === this.logo) continue;
      child.destroy();
    }
    preview.addChild(buildNineSliceBase(def.footprint.w, def.footprint.h, this.getTexture));
    preview.addChild(buildNineSlicePorts(def.footprint.w, def.footprint.h, portMaskFromDef(def), this.getTexture));
    const equipTex = this.getTexture('devices', def.texture);
    if (equipTex && equipTex.width > 0) {
      const equip = new Sprite(equipTex);
      equip.anchor.set(0.5);
      equip.width = wp;
      equip.height = hp;
      preview.addChild(equip);
    }
  }
}

// ───────────────────── 坐标工具（A2 §2.3，与 verify 脚本同实现）─────────────────────

/**
 * 以**鼠标位置为设备中心**，计算 footprint 左上角 Cell 的 grid 坐标与世界像素坐标。
 *
 * 直觉约定（T1.7 修订）：玩家点击的位置应是设备**中心**，不是左上角。故从鼠标世界坐标
 * 减去半个 footprint 的像素偏移，得到左上角的"候选世界坐标"，再吸附到网格。
 *
 * ⚠️ 关键（修复"视觉与占用检查错位"bug）：topLeftWorld 必须**从 topLeftGrid 派生**，
 *   即 topLeftWorld = topLeftGrid * CELL。绝不能 grid 与 world 用不同舍入各自独立吸附——
 *   否则当候选坐标小数部分 ≥ 0.5 时，二者进位不一致，导致"预览画在 A，却检查 B"
 *   （用户看到不重叠却报橙红）。故 grid 与 world 必须用**同一**舍入函数。
 *
 * ⚠️ 舍入方向（修复"设备偏左上角"反馈，T1.7 第二轮修订）:
 *   早期版本用 floor（向下取整），对任意鼠标位置 topLeftGrid 总是偏小，导致设备中心
 *   **系统性偏左上**最多半格（如 3×3 设备中心比鼠标恒偏 (−32,−32)）。用户反馈
 *   "设备没出现在鼠标中间，偏左上角"。改用 round（向最近 Cell 取整）后，吸附方向
 *   对称：设备中心对鼠标的偏移在 ±半格内随机分布（而非恒向左上），鼠标更接近设备中心。
 *
 * 算法:
 *   tlx = mouseWorldX − halfFootprintPx            ← 左上角候选世界 X（未吸附）
 *   topLeftGrid  = round(tlx / CELL)               ← 左上角 Cell（向最近取整）
 *   topLeftWorld = topLeftGrid * CELL              ← 左上角世界像素（从 grid 派生，保证一致）
 *
 * @param mouseWorldX/Y  鼠标的世界像素坐标
 * @param w/h            footprint 宽高（Cell 数）
 * @returns topLeftGrid {x,y} = 左上角 Cell；topLeftWorld {x,y} = 左上角世界像素（从 grid 派生）
 */
export function placementFromMouse(
  mouseWorldX: number,
  mouseWorldY: number,
  w: number,
  h: number,
): { topLeftGrid: { x: number; y: number }; topLeftWorld: { x: number; y: number } } {
  const halfW = (w * CELL_SIZE) / 2;
  const halfH = (h * CELL_SIZE) / 2;
  // 左上角的候选世界坐标（未吸附）
  const tlx = mouseWorldX - halfW;
  const tly = mouseWorldY - halfH;
  // grid 向最近 Cell 取整；world 严格从 grid 派生（topLeftGrid * CELL），保证视觉与占用一致
  const gridX = Math.round(tlx / CELL_SIZE);
  const gridY = Math.round(tly / CELL_SIZE);
  return {
    topLeftGrid: { x: gridX, y: gridY },
    topLeftWorld: { x: gridX * CELL_SIZE, y: gridY * CELL_SIZE },
  };
}
