// 工具栏 (InventoryUI) — 设备选择 UI
// 依据: implementation-phase-1.md T1.7 工具栏技术选型
//
// 技术选型: PixiJS Container，挂在 overlayLayer（屏幕空间层 6，A2 §4）。
// **不挂 worldContainer** —— 否则会随 Ctrl+R 视图旋转、随相机平移/缩放移动。
// 工具栏要钉死在屏幕底部，永远固定位置。
//
// 理由 (T1.7 技术选型原文):
//   (1) 与现有 HUD/help Text（main.ts 全是 PixiJS Text）同栈，不引入第二套 DOM 渲染体系；
//   (2) 图集已就绪，按钮图标直接 getTexture('devices', '<设备key>') 复用 T1.3 打包的纹理；
//   (3) 输入走 PixiJS 事件系统（eventMode:'static' + pointerdown），与相机输入同一套 pointer 流，
//       互斥好处理（点工具栏时 stopPropagation 抑制相机拖拽）。
//
// 占位图: 缺 SVG 的设备（shredding/fitting/moulding/seed_picking/planting）由
//   PlaceholderTextureFactory 用 Graphics 画 footprint 边框 + 设备名 + Port 标记，
//   generateTexture 生成纹理缓存。补 SVG 后只需重跑 pack-assets，本工厂对有纹理的设备不再触发。

import { Container, Graphics, Sprite, Text, Texture, type Renderer } from 'pixi.js';
import { TOOLBAR_BUILDINGS, getBuildingDefinition, type BuildingDefinition } from '../data/buildings';
import type { TextureLookup } from '../systems/RenderSystem';
import { CELL_SIZE } from '../render/constants';
import { buildNineSliceBase } from '../render/NineSliceAssembler';

/** 按钮尺寸（屏幕像素）。图标区 + 名字区。 */
const BTN_SIZE = 64;
const BTN_GAP = 8;
const TOOLBAR_PADDING = 12;
/** 工具栏距屏幕底部的边距。 */
const TOOLBAR_BOTTOM_MARGIN = 16;

/** 按钮配色。 */
const COLOR_BG = 0x2a2a2a;
const COLOR_BG_HOVER = 0x3a3a3a;
const COLOR_BG_ACTIVE = 0x1a4a1a;
const COLOR_BORDER = 0x555555;
const COLOR_BORDER_ACTIVE = 0x4ade80; // 绿色高亮
const COLOR_TEXT_NAME = 0xbbbbbb;

/**
 * 占位图纹理工厂。
 * 对缺 SVG 的设备（getTexture 返回 undefined）用 Graphics 画一个识别性占位图，
 * generateTexture 生成纹理并缓存。补 SVG 后这些设备不再走此路径。
 */
class PlaceholderTextureFactory {
  private cache = new Map<string, Texture>();
  private renderer: Renderer;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  /** 取某设备的占位图纹理（缓存）。 */
  get(def: BuildingDefinition): Texture {
    const cached = this.cache.get(def.id);
    if (cached) return cached;

    const g = new Graphics();
    const size = 64; // 占位图固定 64×64 逻辑像素，按钮里按 BTN_SIZE 缩放显示
    // 背景填充
    g.rect(0, 0, size, size).fill({ color: 0x444444 });
    // footprint 边框（按 footprint 比例画内框，区分 3×3 / 5×5）
    const fw = def.footprint.w;
    const fh = def.footprint.h;
    const maxF = Math.max(fw, fh);
    const innerSize = size * 0.7;
    const cellPx = innerSize / maxF;
    const offsetX = (size - cellPx * fw) / 2;
    const offsetY = (size - cellPx * fh) / 2;
    // 画 footprint 网格
    for (let dy = 0; dy < fh; dy++) {
      for (let dx = 0; dx < fw; dx++) {
        g.rect(offsetX + dx * cellPx + 1, offsetY + dy * cellPx + 1, cellPx - 2, cellPx - 2)
          .stroke({ width: 1, color: 0x888888 });
      }
    }
    // Port 标记：默认方向下 input 在底(dy=h-1) output 在顶(dy=0)，画小方块
    for (const port of def.ports) {
      const px = offsetX + port.position.dx * cellPx + cellPx / 2;
      const py = offsetY + port.position.dy * cellPx + cellPx / 2;
      const portColor = port.type === 'input' ? 0x60a5fa : port.type === 'output' ? 0xf59e0b : 0x22d3ee;
      g.rect(px - 3, py - 3, 6, 6).fill({ color: portColor });
    }
    // 设备名首字（中心大字）
    const label = new Text({
      text: def.name.charAt(0),
      style: { fontFamily: 'system-ui, sans-serif', fontSize: 20, fill: 0xffffff, fontWeight: 'bold' },
    });
    label.anchor.set(0.5);
    label.x = size / 2;
    label.y = size / 2;
    g.addChild(label);

    const tex = this.renderer.generateTexture(g);
    // 立即销毁临时 Graphics（纹理已生成）；label 是 g 的子节点，随 g 销毁
    g.destroy();
    this.cache.set(def.id, tex);
    return tex;
  }

  destroy(): void {
    for (const tex of this.cache.values()) tex.destroy(true);
    this.cache.clear();
  }
}

/** 单个按钮的内部态。 */
interface ButtonState {
  def: BuildingDefinition;
  container: Container;
  bg: Graphics;
  icon: Sprite;
  nameText: Text;
  hover: boolean;
}

/**
 * 工具栏 UI。
 *
 * 用法:
 *   const ui = new InventoryUI(renderer, overlayLayer, getTexture, onSelect);
 *   overlayLayer.addChild(ui.container);
 *   ui.layout(screenWidth, screenHeight);  // resize 时重排
 *   ui.setActive(definitionId | null);     // 高亮选中态
 */
export class InventoryUI {
  readonly container: Container;
  private getTexture: TextureLookup;
  private onSelect: (id: string) => void;
  private placeholder: PlaceholderTextureFactory;
  /** T1.11c: nineslice 设备的组合图标缓存（底座拼装+equipment 一次性烘焙成 RenderTexture）。 */
  private renderer: Renderer;
  private ninesliceIcons = new Map<string, Texture>();

  private buttons: ButtonState[] = [];
  /** 当前高亮的设备 id（null = 无选中）。 */
  private activeId: string | null = null;
  /** 背景条 Graphics。 */
  private bgBar: Graphics;

  constructor(
    renderer: Renderer,
    getTexture: TextureLookup,
    onSelect: (id: string) => void,
  ) {
    this.getTexture = getTexture;
    this.onSelect = onSelect;
    this.renderer = renderer;
    this.placeholder = new PlaceholderTextureFactory(renderer);

    this.container = new Container({ label: 'inventoryUI' });
    // 工具栏整体在屏幕空间，事件冒泡到此即可
    this.container.eventMode = 'static';

    this.bgBar = new Graphics();
    this.container.addChild(this.bgBar);

    this.buildButtons();
  }

  /** 挂载到 overlayLayer（由 main 调用）。 */
  attachTo(overlayLayer: Container): void {
    overlayLayer.addChild(this.container);
  }

  /** 构建按钮（按 TOOLBAR_BUILDINGS 顺序）。 */
  private buildButtons(): void {
    for (const id of TOOLBAR_BUILDINGS) {
      const def = getBuildingDefinition(id);
      if (!def) continue;
      this.buttons.push(this.makeButton(def));
    }
  }

  /** 创建单个按钮。 */
  private makeButton(def: BuildingDefinition): ButtonState {
    const container = new Container({ label: `btn-${def.id}` });
    container.eventMode = 'static';

    const bg = new Graphics();
    this.drawButtonBg(bg, false, false);
    container.addChild(bg);

    // 图标：优先用真实纹理，缺纹理用占位图。
    // nineslice 设备的 texture 帧是透明底 equipment（底座不在帧里）——直接用会显示
    // 悬浮部件，改为把"底座拼装+equipment"一次性烘焙成组合图标（T1.11c）。
    const realTex =
      def.baseStyle === 'nineslice' ? this.getNinesliceIcon(def) : this.getTexture('devices', def.texture);
    const iconTex = realTex ?? this.placeholder.get(def);
    const icon = new Sprite(iconTex);
    icon.anchor.set(0.5);
    icon.x = BTN_SIZE / 2;
    icon.y = BTN_SIZE / 2 - 6; // 略上移给名字留位
    // 图标按 80% 按钮尺寸显示
    const iconScale = (BTN_SIZE * 0.8) / Math.max(icon.texture.width, icon.texture.height);
    icon.scale.set(iconScale);
    container.addChild(icon);

    const nameText = new Text({
      text: def.name,
      style: { fontFamily: 'system-ui, sans-serif', fontSize: 10, fill: COLOR_TEXT_NAME, align: 'center' },
    });
    nameText.anchor.set(0.5, 1);
    nameText.x = BTN_SIZE / 2;
    nameText.y = BTN_SIZE - 3;
    container.addChild(nameText);

    const state: ButtonState = { def, container, bg, icon, nameText, hover: false };

    // 悬停态
    container.on('pointerenter', () => {
      state.hover = true;
      this.drawButtonBg(bg, state.hover, this.activeId === def.id);
    });
    container.on('pointerleave', () => {
      state.hover = false;
      this.drawButtonBg(bg, state.hover, this.activeId === def.id);
    });
    // 点击选中 → 通知回调 + 阻止冒泡（避免触发 canvas 的放置/相机拖拽）
    container.on('pointerdown', (e: PointerEvent) => {
      e.stopPropagation();
      this.onSelect(def.id);
    });

    this.container.addChild(container);
    return state;
  }

  /** 重画按钮背景（按 hover/active 态变色）。 */
  private drawButtonBg(g: Graphics, hover: boolean, active: boolean): void {
    g.clear();
    const fill = active ? COLOR_BG_ACTIVE : hover ? COLOR_BG_HOVER : COLOR_BG;
    const border = active ? COLOR_BORDER_ACTIVE : COLOR_BORDER;
    const borderWidth = active ? 2 : 1;
    g.roundRect(0, 0, BTN_SIZE, BTN_SIZE, 6)
      .fill({ color: fill })
      .stroke({ width: borderWidth, color: border });
  }

  /**
   * 根据屏幕尺寸重排工具栏（横排居中钉底部）。
   * @param screenWidth  app.screen.width
   * @param screenHeight app.screen.height
   */
  layout(screenWidth: number, screenHeight: number): void {
    const n = this.buttons.length;
    const totalWidth = n * BTN_SIZE + (n - 1) * BTN_GAP + TOOLBAR_PADDING * 2;
    const barHeight = BTN_SIZE + TOOLBAR_PADDING * 2;
    // 横排居中，钉底部
    const barX = (screenWidth - totalWidth) / 2;
    const barY = screenHeight - barHeight - TOOLBAR_BOTTOM_MARGIN;

    this.container.position.set(barX, barY);

    // 重画背景条
    this.bgBar.clear();
    this.bgBar.roundRect(0, 0, totalWidth, barHeight, 8)
      .fill({ color: 0x1a1a1a, alpha: 0.85 })
      .stroke({ width: 1, color: 0x444444 });

    // 排列按钮
    let x = TOOLBAR_PADDING;
    const y = TOOLBAR_PADDING;
    for (const btn of this.buttons) {
      btn.container.position.set(x, y);
      x += BTN_SIZE + BTN_GAP;
    }
  }

  /**
   * 设置选中态高亮。
   * @param id 选中的 definitionId；null 清除所有高亮
   */
  setActive(id: string | null): void {
    this.activeId = id;
    for (const btn of this.buttons) {
      const active = btn.def.id === id;
      this.drawButtonBg(btn.bg, btn.hover, active);
    }
  }

  /** 当前高亮的设备 id。 */
  getActiveId(): string | null {
    return this.activeId;
  }

  /**
   * T1.11c: 生成/缓存 nineslice 设备的组合图标纹理。
   * 底座切片拼装 + equipment Sprite → generateTexture（resolution 4 对齐
   * DEVICE_RASTER_SCALE，与 whole 设备图标的纹素密度一致）。
   */
  private getNinesliceIcon(def: BuildingDefinition): Texture | null {
    const cached = this.ninesliceIcons.get(def.id);
    if (cached) return cached;
    const { w, h } = def.footprint;
    const container = buildNineSliceBase(w, h, this.getTexture);
    const equipTex = this.getTexture('devices', def.texture);
    if (equipTex && equipTex.width > 0) {
      const equip = new Sprite(equipTex);
      equip.anchor.set(0.5);
      equip.width = w * CELL_SIZE;
      equip.height = h * CELL_SIZE;
      container.addChild(equip);
    }
    const tex = this.renderer.generateTexture({ target: container, resolution: 4, antialias: true });
    container.destroy({ children: true });
    if (tex.width === 0) return null; // 切片帧缺失（图集未重跑）→ 回落占位图
    this.ninesliceIcons.set(def.id, tex);
    return tex;
  }

  /** 销毁（teardown 用）。 */
  destroy(): void {
    this.placeholder.destroy();
    for (const tex of this.ninesliceIcons.values()) tex.destroy(true);
    this.ninesliceIcons.clear();
    this.container.destroy({ children: true });
  }
}

// 便于消费方从本模块一并引入（可选）
export { CELL_SIZE };
