// 设备详情弹窗 (T2.15) — 点击已放置设备弹出，承载电源开关（暂停正式入口）+
// 设备信息 + 生产状态摘要（吸收 T2.9b 临时读数）+ 删除按钮 + 仓库口产出物品选择。
// 依据: doc/implementation-phase-2.md T2.15；样式复刻基准 = 旧 Flutter 项目
//       C:\Users\Misaki\Desktop\git\Endfield\lib\widgets\{building_detail_dialog,
//       building_synthesis_panel, building_depot_panel, building_shared_widgets,
//       processing_indicator, synthesis_grid, depot_grid_tile}.dart（尺寸/颜色逐项抄录，
//       token 对照表见 DeviceDialog.css 头注）。
//
// 技术形态: **DOM overlay**（任务卡允许 DOM/Pixi 二选一，T2.15 开发时定）。
//   - 弹窗根节点是 canvas 的兄弟元素（挂在 body 上）——点击弹窗/遮罩根本不会落到
//     app.canvas 的原生监听上，事件隔离天然成立（与工具栏"包围盒排除"方案不同）；
//   - window 上的 pointerup 虽会收到，但 SelectionSystem 无 pendingPress，天然 no-op；
//   - 键盘 gate 由 main.ts 在 capture 相位注册（弹窗开着时吞掉全部游戏快捷键，仅放行 ESC）。
//
// 图标来源: 不新增任何美术资产——ui/devices/items 三张图集的帧经 CSS sprite
//   （background-position 负偏移）直接引用；物品格的渐变底/等级色条按旧项目
//   synthesis_grid._getGridSvg 的 SVG 字符串 1:1 生成 data URI。
//
// 打开时机: 选中即弹窗（双向绑定）——main.ts 每帧把 selection.getSelected() 喂给
//   syncSelection(): 点设备 → 打开/切换；点空白/ESC/关闭按钮/遮罩 → 关闭并清选中；
//   删除按钮 → 回调 main（DeleteSystem + 清选中）后由选中联动关闭。放置点击与
//   传送带模式点击不经选中系统，不会误弹。
//
// 刷新: 100ms 局部定时器（旧项目 building_synthesis_panel 同款节奏）。只改文本/样式/
//   类名，**不重建带 CSS 动画的节点**（指示器箭头/三角每帧重建会让 animation 重置），
//   配方行只在配方变化时重建。

import './DeviceDialog.css';
import type { World, EntityHandle } from '../ECS';
import type { BuildingComp } from '../components/BuildingComp';
import type { BuildingDefinition } from '../data/buildings';
import { getBuildingDefinition } from '../data/buildings';
import type { ItemRegistry } from '../data/items';
import type { Recipe } from '../data/recipes';
import { portStatuses } from '../systems/machine/PortStatusOps';

/** 简化版取货口的兜底产出物品（与 DepotOps.DEPOT_SOURCE_ITEM 同值；避免循环依赖不直接 import）。 */
const FALLBACK_DEPOT_ITEM = 'originium_ore';

/** 图集 JSON/PNG 的 URL（与 AssetsLoader 同一约定: Vite 以根路径 serve public/）。 */
const ATLAS_JSON_URL = {
  devices: '/spritesheets/devices.json',
  items: '/spritesheets/items.json',
  ui: '/spritesheets/ui.json',
} as const;
const ATLAS_PNG_URL = {
  devices: '/spritesheets/devices.png',
  items: '/spritesheets/items.png',
  ui: '/spritesheets/ui.png',
} as const;
type AtlasGroup = keyof typeof ATLAS_JSON_URL;

interface AtlasFrame { x: number; y: number; w: number; h: number }
interface AtlasData {
  size: { w: number; h: number };
  frames: Map<string, AtlasFrame>;
}

/** 物品格/选择格的等级配色（synthesis_grid._getGridSvg 抄录）。 */
const LEVEL_GRADIENT_END: Record<number, string> = { 2: '#93e8a4', 3: '#6d9bf1', 4: '#b73cc5' };
const LEVEL_TAG: Record<number, string> = { 2: '#44aa00', 3: '#0082ea', 4: '#b73cc5' };

/** 弹窗信息栏 LOGO 的图集帧映射（旧项目对 LOGO SVG 染白；图集内 _white/logo 帧即染白版）。 */
const LOGO_SPRITES: Record<string, { group: AtlasGroup; key: string }> = {
  refining_unit: { group: 'ui', key: 'refining_unit_logo' },
  depot_unloader: { group: 'devices', key: 'depot_unloader_logo_white' },
  depot_loader: { group: 'devices', key: 'depot_loader_logo_white' },
};

/** 产出物品选择面板的 4 标签页（旧资源面板 tab 序 + items.ts 类目映射）。 */
const PICKER_TABS: Array<{ label: string; category: string; iconKey: string }> = [
  { label: '植物', category: 'plant', iconKey: 'plant_icon' },
  { label: '矿物', category: 'mineral_ore', iconKey: 'mineral_ore_icon' },
  { label: '可用物品', category: 'usable_items', iconKey: 'usable_items_icon' },
  { label: '产物', category: 'aic_products', iconKey: 'products_icon' },
];

export interface DeviceDialogDeps {
  world: World;
  /** itemId → 中文名（main.ts 组合根的 itemName）。 */
  itemName(id: string): string;
  /** equipmentId → 配方列表（main.ts 组合根的 recipeIndex）。 */
  recipeIndex: Map<string, Recipe[]>;
  /** 物品注册表（产出选择面板的数据源）。 */
  items: ItemRegistry;
  /** 删除按钮回调（main.ts: DeleteSystem.deleteBuilding + 清选中 + game.update）。 */
  onDelete(handle: EntityHandle): void;
  /** 用户途径关闭（关闭按钮/遮罩）回调（main.ts: selection.clearSelection）。 */
  onClose(): void;
}

/** 物品格动态引用（合成面板输入/输出格、仓库口物品格共用）。 */
interface TileRefs {
  root: HTMLDivElement;
  bg: HTMLDivElement;
  icon: HTMLDivElement;
  count: HTMLDivElement;
}

export class DeviceDialog {
  /** 弹窗根节点（fixed 全屏: 遮罩 + 面板），构造时挂到 body。 */
  readonly root: HTMLDivElement;

  private readonly deps: DeviceDialogDeps;
  /** 面板容器（每次 openFor 重建内容）。 */
  private readonly panel: HTMLDivElement;
  private handle: EntityHandle | null = null;
  private open = false;
  private refreshTimer: number | null = null;

  /** 图集 JSON 懒加载缓存（构造即预取，点开设备时通常已就绪）。 */
  private atlasPromise: Promise<unknown> | null = null;
  private atlases: Partial<Record<AtlasGroup, AtlasData>> = {};

  // ── 动态节点引用（按面板类型选择性填充；均为构建一次、刷新只改样式）──
  private switchEl: HTMLDivElement | null = null;
  private indicatorBox: HTMLDivElement | null = null;
  private indicatorArrows: HTMLDivElement | null = null;
  private indicatorPaused: HTMLDivElement | null = null;
  private indicatorBlocked: HTMLDivElement | null = null;
  private countdownText: HTMLSpanElement | null = null;
  private countdownPaused: HTMLDivElement | null = null;
  private countdownBlocked: HTMLDivElement | null = null;
  private progressWrap: HTMLDivElement | null = null;
  private progressFill: HTMLDivElement | null = null;
  // 合成面板输入/输出格（旧 SynthesisGrid 复刻: 轨道连接器 + 物品格 + 格下计数）
  private inputGridBox: HTMLDivElement | null = null;
  private outputGridBox: HTMLDivElement | null = null;
  private inputTile: TileRefs | null = null;
  private outputTile: TileRefs | null = null;
  private inputCountEl: HTMLDivElement | null = null;
  private outputCountEl: HTMLDivElement | null = null;
  private inputConnector: { el: HTMLDivElement; active: HTMLDivElement } | null = null;
  private outputConnector: { el: HTMLDivElement; active: HTMLDivElement } | null = null;
  private connKey = ''; // 端口连接态去重（变化才重建活动覆盖层）
  private inputConns: boolean[] = []; // 最近一次端口连接态（物品飞行选分支用）
  private outputConns: boolean[] = [];
  private mainRow: HTMLDivElement | null = null; // FittedBox 缩放目标
  private mainNaturalW = 0;
  private recipeBar: HTMLDivElement | null = null;
  private recipeShownKey: string | null = null; // 配方行重建去重（id 或 'empty'）
  // 仓库取货口
  private cardName: HTMLDivElement | null = null;
  private cardImg: HTMLDivElement | null = null;
  private gridTile: TileRefs | null = null;
  private connectorEl: HTMLDivElement | null = null;
  private capsuleBtn: HTMLButtonElement | null = null;
  private depotPreview: HTMLDivElement | null = null;
  private pickerRoot: HTMLDivElement | null = null;
  private pickerPill: HTMLDivElement | null = null;
  private pickerGrid: HTMLDivElement | null = null;
  private pickerTab = 0;
  private pickerAddMode = false;

  constructor(deps: DeviceDialogDeps) {
    this.deps = deps;

    this.root = document.createElement('div');
    this.root.className = 'efd-dialog-root';
    this.root.hidden = true;

    // 遮罩: 点击关闭（showDialog barrier 同语义，不透传到画布）
    const barrier = document.createElement('div');
    barrier.className = 'efd-dialog-barrier';
    barrier.addEventListener('click', () => this.closeByUser());

    // 水印（endfield-industries logo，白 2%，距顶 80 / 距左 740 / 800px）
    const watermark = document.createElement('img');
    watermark.className = 'efd-dialog-watermark';
    watermark.src = '/window/endfield-industries.svg';
    watermark.alt = '';
    watermark.draggable = false;

    this.panel = document.createElement('div');
    this.panel.className = 'efd-dialog';
    this.panel.appendChild(watermark);

    // 面板内点击不再上抛（防御: 弹窗自身的点击不应触发任何画布语义）
    this.panel.addEventListener('click', (e) => e.stopPropagation());

    this.root.appendChild(barrier);
    this.root.appendChild(this.panel);
    document.body.appendChild(this.root);

    void this.ensureAtlas(); // 预取图集 JSON，首次打开即有图标
  }

  // ═════════════════════ 外部接口 ═════════════════════

  isOpen(): boolean {
    return this.open;
  }

  /** 当前弹窗对应的设备 handle（未打开为 null）。 */
  getHandle(): EntityHandle | null {
    return this.handle;
  }

  /**
   * 选中联动（main.ts 每帧调用）: 选中设备 → 打开/切换；取消选中 → 关闭。
   * handle 未变化时是廉价 no-op（一个比较），可放心每帧调。
   */
  syncSelection(handle: EntityHandle | null): void {
    if (handle === this.handle) return;
    if (handle === null) {
      this.close();
      return;
    }
    this.openFor(handle);
  }

  /** 用户途径关闭（关闭按钮/遮罩）: 关闭并通知 main 清选中。 */
  closeByUser(): void {
    this.close();
    this.deps.onClose();
  }

  /** 关闭弹窗（ESC/遮罩/关闭按钮/选中清空联动）。不重建面板（下次 openFor 重建）。 */
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.handle = null;
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.root.hidden = true;
    this.panel.querySelectorAll('.efd-infobar, .efd-hsep, .efd-power-row, .efd-dialog-body')
      .forEach((n) => n.remove());
    this.switchEl = null;
    this.indicatorBox = null;
    this.indicatorArrows = null;
    this.indicatorPaused = null;
    this.indicatorBlocked = null;
    this.countdownText = null;
    this.countdownPaused = null;
    this.countdownBlocked = null;
    this.progressWrap = null;
    this.progressFill = null;
    this.inputGridBox = null;
    this.outputGridBox = null;
    this.inputTile = null;
    this.outputTile = null;
    this.inputCountEl = null;
    this.outputCountEl = null;
    this.inputConnector = null;
    this.outputConnector = null;
    this.connKey = '';
    this.inputConns = [];
    this.outputConns = [];
    this.mainRow = null;
    this.mainNaturalW = 0;
    this.recipeBar = null;
    this.recipeShownKey = null;
    this.cardName = null;
    this.cardImg = null;
    this.gridTile = null;
    this.connectorEl = null;
    this.capsuleBtn = null;
    this.depotPreview = null;
    this.pickerRoot = null;
    this.pickerPill = null;
    this.pickerGrid = null;
    this.pickerTab = 0;
    this.pickerAddMode = false;
  }

  // ═════════════════════ 图集访问 ═════════════════════

  private ensureAtlas(): Promise<unknown> {
    if (this.atlasPromise === null) {
      const groups = Object.keys(ATLAS_JSON_URL) as AtlasGroup[];
      this.atlasPromise = Promise.all(
        groups.map(async (g) => {
          try {
            const res = await fetch(ATLAS_JSON_URL[g]);
            const json = (await res.json()) as {
              meta: { size: { w: number; h: number } };
              frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>;
            };
            const frames = new Map<string, AtlasFrame>();
            for (const [name, f] of Object.entries(json.frames)) {
              frames.set(name.replace(/\.png$/, ''), f.frame);
            }
            return [g, { size: json.meta.size, frames }] as const;
          } catch {
            console.warn(`[DeviceDialog] 图集 ${g} JSON 加载失败，弹窗图标降级为空`);
            return [g, undefined] as const;
          }
        }),
      ).then((entries) => {
        this.atlases = Object.fromEntries(entries) as Partial<Record<AtlasGroup, AtlasData>>;
        // 图集迟到场景: 打开态下补刷一次，把已建好的节点补上图标
        if (this.open) this.refresh();
        return this.atlases;
      });
    }
    return this.atlasPromise;
  }

  private frame(group: AtlasGroup, key: string): AtlasFrame | null {
    return this.atlases[group]?.frames.get(key) ?? null;
  }

  /**
   * 图集帧 → CSS sprite 样式（contain 缩放到 dw×dh 目标盒）。
   * 元素实际盒 = 帧缩放后尺寸（父容器 flex 居中），图集未就绪返回 false。
   * mode='mask' 用于需要染色的白色图标: mask 定位帧 + CSS background-color 上色
   * （等价旧项目 SvgPicture colorFilter srcIn）。
   */
  private spriteStyle(
    el: HTMLElement, group: AtlasGroup, key: string, dw: number, dh: number,
    mode: 'image' | 'mask' = 'image',
  ): boolean {
    const f = this.frame(group, key);
    if (f === null) {
      el.style.backgroundImage = 'none';
      return false;
    }
    const scale = Math.min(dw / f.w, dh / f.h);
    const { w: aw, h: ah } = this.atlases[group]!.size;
    const size = `${aw * scale}px ${ah * scale}px`;
    const pos = `${-f.x * scale}px ${-f.y * scale}px`;
    if (mode === 'mask') {
      el.style.setProperty('-webkit-mask-image', `url("${ATLAS_PNG_URL[group]}")`);
      el.style.setProperty('-webkit-mask-size', size);
      el.style.setProperty('-webkit-mask-position', pos);
      el.style.maskImage = `url("${ATLAS_PNG_URL[group]}")`;
      el.style.maskSize = size;
      el.style.maskPosition = pos;
      el.style.backgroundImage = 'none';
    } else {
      el.style.backgroundImage = `url("${ATLAS_PNG_URL[group]}")`;
      el.style.backgroundSize = size;
      el.style.backgroundPosition = pos;
    }
    el.style.width = `${f.w * scale}px`;
    el.style.height = `${f.h * scale}px`;
    return true;
  }

  /** 物品图标（items 图集帧，key = itemId）。 */
  private itemIconStyle(el: HTMLElement, itemId: string, dw: number, dh: number): boolean {
    return this.spriteStyle(el, 'items', itemId, dw, dh);
  }

  /** 物品格渐变底 SVG data URI（synthesis_grid._getGridSvg 1:1 复刻）。 */
  private tileBgStyle(el: HTMLDivElement, level: number | null): void {
    const endColor = (level !== null && LEVEL_GRADIENT_END[level]) || '#dddddd';
    const tagColor = (level !== null && LEVEL_TAG[level]) || '#ebebeb';
    const hasItem = level !== null;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">` +
      `<stop offset="0" stop-color="#696969"/><stop offset="0.7" stop-color="#696969"/>` +
      `<stop offset="1" stop-color="${endColor}"/></linearGradient></defs>` +
      `<rect x="0" y="0" width="128" height="128" rx="15" ry="15" fill="${hasItem ? 'url(#g)' : '#696969'}"/>` +
      `${hasItem ? `<path d="m 1,118 c 2,5.8 7.6,10 14,10 h 98 c 6.4,0 12,-4.2 14,-10 z" fill="${tagColor}"/>` : ''}` +
      `</svg>`;
    el.style.backgroundImage = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }

  /** 创建带 sprite 标记的图标元素（data-w/h = 目标盒，applySprites 据此算缩放）。 */
  private makeSprite(spec: string, w: number, h: number, mode: 'image' | 'mask' = 'image'): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'efd-icon-sprite';
    el.dataset.sprite = spec;
    el.dataset.w = String(w);
    el.dataset.h = String(h);
    if (mode === 'mask') el.dataset.mode = 'mask';
    return el;
  }

  // ═════════════════════ 打开/构建 ═════════════════════

  private openFor(handle: EntityHandle): void {
    const comp = this.deps.world.getComponent<BuildingComp>(handle, 'BuildingComp');
    const def = comp ? getBuildingDefinition(comp.definitionId) : undefined;
    if (!comp || !def) return; // 防御: 选中了非设备/已销毁实体

    this.close(); // 清旧面板与定时器（不改选中，切设备时不触发 onClose）
    this.handle = handle;
    this.open = true;
    this.root.hidden = false;

    this.panel.appendChild(this.buildInfoBar(def));
    this.panel.appendChild(this.buildHsep());
    this.panel.appendChild(this.buildPowerRow());
    this.panel.appendChild(this.buildBody(def));

    this.refresh(); // 首刷（图集未就绪时图标由 ensureAtlas 的补刷兜底）
    this.refreshTimer = window.setInterval(() => this.refresh(), 100);
  }

  /** 顶部信息栏（77px: LOGO | 名称 | 耗电 | 关闭）。 */
  private buildInfoBar(def: BuildingDefinition): HTMLDivElement {
    const bar = document.createElement('div');
    bar.className = 'efd-infobar';

    const logo = document.createElement('div');
    logo.className = 'efd-infobar-logo';
    const logoSprite = LOGO_SPRITES[def.id];
    if (logoSprite) {
      logo.appendChild(this.makeSprite(`${logoSprite.group}/${logoSprite.key}`, 42, 42));
    }
    bar.appendChild(logo);

    bar.appendChild(this.buildVsep());

    const name = document.createElement('div');
    name.className = 'efd-infobar-name';
    name.textContent = def.name;
    bar.appendChild(name);

    // 耗电功率值: 仅生产类设备显示（旧项目仓库口/分流器等无此段）
    if (def.depot === undefined) {
      bar.appendChild(this.buildVsep());
      const power = document.createElement('div');
      power.className = 'efd-infobar-power';
      power.textContent = `耗电功率值：${def.powerConsumption}W`;
      bar.appendChild(power);
    }

    const spacer = document.createElement('div');
    spacer.className = 'efd-infobar-spacer';
    bar.appendChild(spacer);

    const close = document.createElement('button');
    close.className = 'efd-infobar-close';
    close.title = '关闭';
    close.appendChild(this.makeSprite('ui/close_button', 26, 26));
    close.addEventListener('click', () => this.closeByUser());
    bar.appendChild(close);

    const pad = document.createElement('div');
    pad.className = 'efd-infobar-close-spacer';
    bar.appendChild(pad);
    return bar;
  }

  private buildVsep(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'efd-vsep';
    return el;
  }

  private buildHsep(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'efd-hsep';
    return el;
  }

  /** 电源开关行（120×28 胶囊双联「开/关」，写 comp.paused）。 */
  private buildPowerRow(): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'efd-power-row';

    const sw = document.createElement('div');
    sw.className = 'efd-power-switch';
    const slider = document.createElement('div');
    slider.className = 'efd-power-switch-slider';
    const tabs = document.createElement('div');
    tabs.className = 'efd-power-switch-tabs';
    const onTab = document.createElement('div');
    onTab.className = 'efd-power-switch-tab on';
    onTab.textContent = '开';
    const offTab = document.createElement('div');
    offTab.className = 'efd-power-switch-tab off';
    offTab.textContent = '关';
    tabs.appendChild(onTab);
    tabs.appendChild(offTab);
    sw.appendChild(slider);
    sw.appendChild(tabs);
    this.switchEl = sw;

    // 旧项目: 点「开」=取消暂停（仅关态可点），点「关」=暂停（仅开态可点）
    onTab.addEventListener('click', () => this.mutateComp((c) => { c.paused = false; }));
    offTab.addEventListener('click', () => this.mutateComp((c) => { c.paused = true; }));
    row.appendChild(sw);
    return row;
  }

  private buildBody(def: BuildingDefinition): HTMLDivElement {
    const body = document.createElement('div');
    body.className = 'efd-dialog-body';
    if (def.depot === 'unload') {
      body.appendChild(this.buildDepotPanel('unload'));
    } else if (def.depot === 'load') {
      body.appendChild(this.buildDepotPanel('load'));
    } else {
      body.appendChild(this.buildSynthesisPanel(def));
    }
    return body;
  }

  // ═════════════════════ 生产设备面板 ═════════════════════

  /**
   * 生产面板（旧 DefaultSynthesisPanel + SynthesisGrid 1:1 复刻）:
   * 输入[轨道连接器+物品格+格下计数] |（11px）状态列（112px）|（11px）输出[物品格+计数+轨道连接器]。
   * 行高 = max(端口数×62, 128)（TrackJointsConnector 几何）；整行按旧 FittedBox scaleDown
   * 缩放放进「右区」（body 左侧预留 480px = 旧资源面板 440 + 间距，Phase 2 无资源面板但布局位保留）。
   */
  private buildSynthesisPanel(def: BuildingDefinition): HTMLDivElement {
    const panel = document.createElement('div');
    panel.className = 'efd-synthesis';

    // 顶部动作行: 删除（旧 ActionButton 样式；移动按钮待 T2.14 落地后补）
    panel.appendChild(this.buildActionRow());

    const nIn = def.ports.filter((p) => p.type === 'input').length;
    const nOut = def.ports.filter((p) => p.type === 'output').length;
    const rowH = Math.max(Math.max(nIn, nOut) * 62, 128); // defaultRowH
    const tileTop = (rowH - 128) / 2; // originalGridBoxY

    const mainWrap = document.createElement('div');
    mainWrap.className = 'efd-synthesis-main-wrap';
    const main = document.createElement('div');
    main.className = 'efd-synthesis-main';
    this.mainRow = main;

    // ── 输入格组（轨道连接器在左）──
    this.inputGridBox = document.createElement('div');
    this.inputGridBox.className = 'efd-grid-box';
    this.inputGridBox.style.width = `${nIn > 0 ? 416 : 128}px`;
    this.inputGridBox.style.height = `${rowH}px`;
    if (nIn > 0) {
      this.inputConnector = this.buildTrackJoints(nIn, true, rowH);
      this.inputGridBox.appendChild(this.inputConnector.el);
    }
    this.inputTile = this.makeTileAt(this.inputGridBox, nIn > 0 ? 288 : 0, tileTop);
    this.inputCountEl = this.makeUnderCount(this.inputGridBox, nIn > 0 ? 288 : 0, tileTop + 134);
    main.appendChild(this.inputGridBox);

    // ── 状态列（112px，高度 rowH+74，内容整体垂直居中）──
    const mid = document.createElement('div');
    mid.className = 'efd-synthesis-mid';
    mid.style.height = `${rowH + 74}px`;
    this.indicatorBox = document.createElement('div');
    this.indicatorBox.className = 'efd-synthesis-indicator';
    this.indicatorBox.style.height = `${rowH}px`;
    this.indicatorArrows = this.buildArrows();
    this.indicatorPaused = this.buildStateIndicator('paused');
    this.indicatorBlocked = this.buildStateIndicator('blocked');
    this.indicatorBox.appendChild(this.indicatorArrows);
    this.indicatorBox.appendChild(this.indicatorPaused);
    this.indicatorBox.appendChild(this.indicatorBlocked);
    this.countdownText = document.createElement('span');
    const countdown = document.createElement('div');
    countdown.className = 'efd-countdown';
    countdown.appendChild(this.countdownText);
    // 进度槽（旧项目三态: 生产=进度条常显（未加工也画 0 轨道）/暂停=「生产已暂停」/阻塞=「阻塞」）
    const progressSlot = document.createElement('div');
    progressSlot.className = 'efd-progress-slot';
    this.progressWrap = document.createElement('div');
    this.progressWrap.className = 'efd-progress';
    const track = document.createElement('div');
    track.className = 'efd-progress-track';
    this.progressFill = document.createElement('div');
    this.progressFill.className = 'efd-progress-fill';
    const knob = document.createElement('div');
    knob.className = 'efd-progress-knob';
    this.progressWrap.appendChild(track);
    this.progressWrap.appendChild(this.progressFill);
    this.progressWrap.appendChild(knob);
    this.countdownPaused = this.buildStateText('paused', '生产已暂停');
    this.countdownBlocked = this.buildStateText('blocked', '阻塞');
    progressSlot.appendChild(this.progressWrap);
    progressSlot.appendChild(this.countdownPaused);
    progressSlot.appendChild(this.countdownBlocked);
    mid.appendChild(this.indicatorBox);
    mid.appendChild(countdown);
    mid.appendChild(progressSlot);
    main.appendChild(mid);

    // ── 输出格组（轨道连接器在右）──
    this.outputGridBox = document.createElement('div');
    this.outputGridBox.className = 'efd-grid-box';
    this.outputGridBox.style.width = `${nOut > 0 ? 416 : 128}px`;
    this.outputGridBox.style.height = `${rowH}px`;
    this.outputTile = this.makeTileAt(this.outputGridBox, 0, tileTop);
    this.outputCountEl = this.makeUnderCount(this.outputGridBox, 0, tileTop + 134);
    if (nOut > 0) {
      this.outputConnector = this.buildTrackJoints(nOut, false, rowH);
      this.outputGridBox.appendChild(this.outputConnector.el);
    }
    main.appendChild(this.outputGridBox);

    this.mainNaturalW = (nIn > 0 ? 416 : 128) + 22 + 112 + (nOut > 0 ? 416 : 128);
    mainWrap.appendChild(main);
    panel.appendChild(mainWrap);

    // 底部: 当前自动生产中的配方
    const section = document.createElement('div');
    section.className = 'efd-recipe-section';
    const label = document.createElement('div');
    label.className = 'efd-recipe-label';
    label.textContent = '当前自动生产中的配方';
    this.recipeBar = document.createElement('div');
    this.recipeBar.className = 'efd-recipe-bar';
    const barBg = this.makeSprite('ui/information_bg', 348.16, 76.8);
    barBg.style.position = 'absolute';
    barBg.style.inset = '0';
    this.recipeBar.appendChild(barBg);
    section.appendChild(label);
    section.appendChild(this.recipeBar);
    panel.appendChild(section);
    return panel;
  }

  /** 在指定容器内放一个 128×128 物品格（绝对定位）并登记引用。 */
  private makeTileAt(parent: HTMLElement, left: number, top: number): TileRefs {
    const root = document.createElement('div');
    root.className = 'efd-tile';
    root.style.position = 'absolute';
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    const bg = document.createElement('div');
    bg.className = 'efd-tile-bg';
    const imgWrap = document.createElement('div');
    imgWrap.className = 'efd-tile-img';
    const icon = document.createElement('div');
    icon.className = 'efd-icon-sprite';
    imgWrap.appendChild(icon);
    root.appendChild(bg);
    root.appendChild(imgWrap);
    parent.appendChild(root);
    return { root, bg, icon, count: document.createElement('div') };
  }

  /** 格下计数文本（旧 SynthesisGrid: countY = 格顶+128+6，20px w500，满仓变红）。 */
  private makeUnderCount(parent: HTMLElement, left: number, top: number): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'efd-under-count';
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    parent.appendChild(el);
    return el;
  }

  /**
   * 轨道连接器（旧 TrackJointsConnector/Painter 1:1，288×端口数×62）。
   * 输入侧灰色（interface #8D8C8C / link #6E6E6E / 白圆点），输出侧金色
   * （#B38626 / #8D6E32 / #EBAD26 圆点）；已连接端口叠加发光折线 + 传送带残段
   * （橙色渐变 + 流动箭头，活动覆盖层由 refresh 按连接态重建）。
   */
  private buildTrackJoints(n: number, isInput: boolean, height: number): { el: HTMLDivElement; active: HTMLDivElement } {
    const el = document.createElement('div');
    el.className = `efd-trackjoints ${isInput ? 'in' : 'out'}`;
    el.style.height = `${height}px`;
    const rect = (cls: string, left: number, top: number, w: number, h: number): void => {
      const d = document.createElement('div');
      d.className = cls;
      d.style.left = `${left}px`;
      d.style.top = `${top}px`;
      d.style.width = `${w}px`;
      d.style.height = `${h}px`;
      el.appendChild(d);
    };
    const circle = (cls: string, cx: number, cy: number): void => {
      const d = document.createElement('div');
      d.className = cls;
      d.style.left = `${cx - 6}px`;
      d.style.top = `${cy - 6}px`;
      el.appendChild(d);
    };

    const devCY = (n * 62) / 2;
    const X = (x: number): number => (isInput ? x : 288 - x); // 输出侧镜像

    // 垂直骨干 + 汇流横线 + 格端圆点
    rect('tj-link tj-backbone', X(212.5) - (isInput ? 5 : 0), 0, 5, height);
    rect('tj-link tj-window', Math.min(X(211.5), X(288)), devCY - 3.3, 76.5, 6.6);
    circle(isInput ? 'tj-dot' : 'tj-dot gold', X(288), devCY);
    for (let i = 0; i < n; i++) {
      const cy = i * 62 + 31;
      rect('tj-link', Math.min(X(174), X(209)), cy - 3.3, 35, 6.6);
      rect('tj-interface', Math.min(X(168), X(175)), cy - 27, 7, 54);
      circle(isInput ? 'tj-dot' : 'tj-dot gold', X(175), cy);
    }

    const active = document.createElement('div');
    active.className = 'tj-active';
    el.appendChild(active);
    return { el, active };
  }

  /**
   * 活动覆盖层（已连接端口）: 发光折线（单条 SVG path，stroke-linejoin round——与旧
   * drawPath 等价，div 拼段会在缩放下出现抗锯齿接缝）+ 带渐变残段 + 流动箭头。
   */
  private refreshTrackActive(
    active: HTMLDivElement, conns: boolean[], isInput: boolean,
  ): void {
    active.innerHTML = '';
    const n = conns.length;
    const devCY = (n * 62) / 2;
    const H = n * 62;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'tj-active-svg');
    svg.setAttribute('width', '288');
    svg.setAttribute('height', String(H));
    svg.setAttribute('viewBox', `0 0 288 ${H}`);
    const color = isInput ? '#ffffff' : '#ebad26';
    conns.forEach((connected, i) => {
      if (!connected) return;
      const cy = i * 62 + 31;
      const d = isInput
        ? `M 175 ${cy} L 210 ${cy} L 210 ${devCY} L 288 ${devCY}`
        : `M 113 ${cy} L 78 ${cy} L 78 ${devCY} L 0 ${devCY}`;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', '3');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('fill', 'none');
      svg.appendChild(path);
    });
    active.appendChild(svg);
    conns.forEach((connected, i) => {
      if (!connected) return;
      const cy = i * 62 + 31;
      // 传送带残段: 渐变轨 + 上下描边 + 两枚流动箭头（箭头自带 opacity 关键帧渐变）
      const stub = document.createElement('div');
      stub.className = `tj-belt ${isInput ? 'in' : 'out'}`;
      stub.style.left = isInput ? '0px' : '120px';
      stub.style.top = `${cy - 27}px`;
      const arrows = document.createElement('div');
      arrows.className = 'tj-belt-arrows';
      for (let a = 0; a < 2; a++) arrows.appendChild(document.createElement('div'));
      stub.appendChild(arrows);
      active.appendChild(stub);
    });
  }

  /**
   * 物品飞行触发（事件驱动，main.ts 转发 machineSystem 事件）:
   * `input` 事件 = 传送带送进一件（门口预约瞬间，飞入格）；`output` 事件 = 传送带
   * 取走一件（飞出格）。**逐事件触发，频率严格等于真实物流节奏**——计数差采样会在
   * 到货/消费同帧相抵时漏件（实测: 输出通畅时动画只出一次，堵塞后消费停止才恢复）。
   * 飞行时长自适应实测事件间隔（钳 300~5000ms、首件 1500ms，旧 _createItemAnimations
   * 同款）。分支用事件携带的端口下标（与连接器分支同序），未连接时退回首个已连接。
   */
  notifyEvent(e: { type: string; handle: EntityHandle; portIndex?: number }): void {
    if (!this.open || e.handle !== this.handle) return;
    if (this.depotPreview !== null) return; // 仓库口面板无轨道连接器
    if (e.type !== 'input' && e.type !== 'output') return;
    const isInput = e.type === 'input';
    const conns = isInput ? this.inputConns : this.outputConns;
    let branch = e.portIndex ?? -1;
    if (conns[branch] !== true) branch = conns.indexOf(true); // 防御: 序错位 → 首个已连接
    if (branch < 0) return; // 该侧未接带 → 无轨道可飞
    const conn = isInput ? this.inputConnector : this.outputConnector;
    if (conn === null) return;

    const comp = this.deps.world.getComponent<BuildingComp>(this.handle, 'BuildingComp');
    if (!comp) return;
    const slots = isInput ? comp.bufferInput : comp.bufferOutput;
    const itemId = slots.find((s) => s.itemId !== null)?.itemId ?? null;
    if (itemId === null) return;
    // 飞行时长固定 1500ms（旧项目默认值）——多带交替供料时事件间隔忽长忽短，
    // 自适应会让速度时快时慢（用户实测"有的快有的慢得离谱"）；频率已由逐事件
    // 触发保证与真实物流一致，速度恒定即可。
    this.spawnFlightItem(conn.el, isInput, branch, itemId);
  }

  /**
   * 放飞一枚物品图标: 在残段同尺寸的裁剪容器（168×54, overflow hidden）里从左缘
   * 滑入、滑出右缘被裁掉（与箭头同一蒙版行为，恒定透明度 0.9），播完自删。
   * 缓动: 输入「快→慢」（easeOutCubic，冲离传送带后减速进格）、输出「慢→快」
   * （easeInCubic，缓慢离开格后加速上带）——用户指定的方向性。
   */
  private spawnFlightItem(
    container: HTMLElement, isInput: boolean, branch: number, itemId: string,
  ): void {
    const cy = branch * 62 + 31;
    const clip = document.createElement('div');
    clip.className = 'efd-flight-clip';
    clip.style.left = isInput ? '0px' : '120px'; // 残段横向位置: 输入在骨干左/输出在骨干右
    clip.style.top = `${cy - 27}px`;
    const item = document.createElement('div');
    item.className = 'efd-flight-item';
    this.applyFlightIcon(item, itemId);
    item.style.animation = `efd-item-sweep 1500ms ${isInput ? 'cubic-bezier(0.33, 1, 0.68, 1)' : 'cubic-bezier(0.32, 0, 0.67, 0)'} forwards`;
    item.addEventListener('animationend', () => clip.remove());
    clip.appendChild(item);
    container.appendChild(clip);
  }

  /**
   * 飞行物品图标: 图集大图（4096²）直接 GPU 缩采样到 40px 会有运动锯齿——
   * 改用 Canvas 以 imageSmoothingQuality=high 预重采样成目标尺寸的位图
   * （一次性代价 + 缓存，等价旧项目 cacheWidth 预缩放思路）。图集图片未就绪时
   * 先用 CSS sprite 兜底，就绪后补上。
   */
  private applyFlightIcon(el: HTMLElement, itemId: string): void {
    const size = 40;
    const cached = this.flightIconCache.get(`${itemId}@${size}`);
    if (cached !== undefined) {
      el.style.backgroundImage = `url("${cached}")`;
      el.style.backgroundSize = '100% 100%';
      el.style.backgroundPosition = '0 0'; // 清掉 CSS sprite 兜底路径的负偏移，否则图标被切出画布外
      return;
    }
    this.itemIconStyle(el, itemId, size, size); // 兜底: CSS sprite 直缩
    void this.ensureItemsImage().then((img) => {
      const f = this.frame('items', itemId);
      if (f === null || img === null || !el.isConnected) return;
      const key = `${itemId}@${size}`;
      let url = this.flightIconCache.get(key);
      if (url === undefined) {
        const canvas = document.createElement('canvas');
        canvas.width = size * 2; // 2x 超采样，CSS 缩回一半进一步抗锯齿
        canvas.height = size * 2;
        const ctx = canvas.getContext('2d');
        if (ctx === null) return;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, f.x, f.y, f.w, f.h, 0, 0, canvas.width, canvas.height);
        url = canvas.toDataURL('image/png');
        this.flightIconCache.set(key, url);
      }
      if (el.isConnected) {
        el.style.backgroundImage = `url("${url}")`;
        el.style.backgroundSize = '100% 100%';
        el.style.backgroundPosition = '0 0'; // 同上: 覆盖兜底路径的图集负偏移
      }
    });
  }

  private itemsImagePromise: Promise<HTMLImageElement | null> | null = null;
  private flightIconCache = new Map<string, string>();

  private ensureItemsImage(): Promise<HTMLImageElement | null> {
    if (this.itemsImagePromise === null) {
      this.itemsImagePromise = new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = ATLAS_PNG_URL.items;
      });
    }
    return this.itemsImagePromise;
  }

  /** 生成一个 128×128 物品格并登记引用（bg/icon/count 供刷新）。 */
  private makeTile(parent: HTMLElement): TileRefs {
    const root = document.createElement('div');
    root.className = 'efd-tile';
    const bg = document.createElement('div');
    bg.className = 'efd-tile-bg';
    const imgWrap = document.createElement('div');
    imgWrap.className = 'efd-tile-img';
    const icon = document.createElement('div');
    icon.className = 'efd-icon-sprite';
    imgWrap.appendChild(icon);
    const count = document.createElement('div');
    count.className = 'efd-tile-count';
    root.appendChild(bg);
    root.appendChild(imgWrap);
    root.appendChild(count);
    parent.appendChild(root);
    return { root, bg, icon, count };
  }

  /** 动作按钮行（旧 ActionButton: 44×44 图标 + 文字 14px w500 白）。 */
  private buildActionRow(): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'efd-action-row';
    const del = document.createElement('button');
    del.className = 'efd-action-btn';
    del.appendChild(this.makeSprite('ui/recycle', 44, 44));
    del.appendChild(Object.assign(document.createElement('span'), { textContent: '删除' }));
    del.addEventListener('click', () => {
      if (this.handle !== null) this.deps.onDelete(this.handle);
    });
    row.appendChild(del);
    return row;
  }

  // ═════════════════════ 仓库口面板 ═════════════════════

  private buildDepotPanel(kind: 'unload' | 'load'): HTMLDivElement {
    const panel = document.createElement('div');
    panel.className = 'efd-depot';
    panel.appendChild(this.buildActionRow());

    const main = document.createElement('div');
    main.className = 'efd-depot-main';

    const wrap = document.createElement('div');
    wrap.className = 'efd-depot-card-wrap';
    this.depotPreview = wrap;
    const rowEl = document.createElement('div');
    rowEl.className = 'efd-depot-row';

    // 1. 仓库卡 265×128（名称 + ∞ 数量 + 右侧大图）
    const card = document.createElement('div');
    card.className = 'efd-warehouse-card';
    const cardImgWrap = document.createElement('div');
    cardImgWrap.className = 'efd-warehouse-card-img';
    this.cardImg = document.createElement('div');
    this.cardImg.className = 'efd-icon-sprite';
    cardImgWrap.appendChild(this.cardImg);
    this.cardName = document.createElement('div');
    this.cardName.className = 'efd-warehouse-card-name';
    this.cardName.textContent = kind === 'load' ? '——' : ''; // 存货口首版只读: 无物品概念
    const qty = document.createElement('div');
    qty.className = 'efd-warehouse-card-qty';
    const depotIcon = this.makeSprite('ui/depot_icon', 38.72, 34.03);
    qty.appendChild(depotIcon);
    qty.appendChild(document.createTextNode(kind === 'unload' ? '∞' : '——'));
    card.appendChild(cardImgWrap);
    card.appendChild(this.cardName);
    card.appendChild(qty);
    rowEl.appendChild(card);

    // 2. 连接线 75px（有产出配置时金色）
    this.connectorEl = document.createElement('div');
    this.connectorEl.className = 'efd-depot-connector';
    this.connectorEl.appendChild(document.createElement('i'));
    rowEl.appendChild(this.connectorEl);

    // 3. 物品格 128×128（存货口空态叠加 No 图标）
    this.gridTile = this.makeTile(rowEl);
    if (kind === 'load') {
      const no = document.createElement('div');
      no.className = 'efd-tile-empty-icon';
      no.appendChild(this.makeSprite('ui/no', 60, 60));
      this.gridTile.root.appendChild(no);
    }

    // 4. 轨道 168×54（dialog_track 帧 + 两枚游动箭头）
    const track = document.createElement('div');
    track.className = `efd-depot-track ${kind === 'unload' ? 'out' : 'in'}`;
    track.appendChild(this.makeSprite('ui/dialog_track', 168, 55));
    const arrows = document.createElement('div');
    arrows.className = 'efd-track-arrows';
    for (let i = 0; i < 2; i++) {
      const a = document.createElement('div');
      a.className = 'efd-track-arrow';
      arrows.appendChild(a);
    }
    track.appendChild(arrows);
    rowEl.appendChild(track);

    wrap.appendChild(rowEl);

    // 5. 取货口: 胶囊按钮（添加/移除物品）+ 产出选择面板；存货口: 只读
    if (kind === 'unload') {
      const btn = document.createElement('button');
      btn.className = 'efd-capsule-btn';
      const btnLabel = document.createElement('span');
      btn.appendChild(this.makeSprite('ui/add', 16, 16));
      btn.appendChild(btnLabel);
      btn.addEventListener('click', () => this.toggleDepotAddMode());
      this.capsuleBtn = btn;
      // 位置: 物品格下方（left = 265 卡 + 75 连接线, top = 128 + 16）
      btn.style.left = '340px';
      btn.style.top = '144px';
      wrap.appendChild(btn);
      wrap.style.minHeight = '184px';

      this.pickerRoot = this.buildPicker();
      this.pickerRoot.hidden = true;
      main.appendChild(this.pickerRoot);
      main.appendChild(wrap);
    } else {
      main.appendChild(wrap);
    }

    panel.appendChild(main);
    return panel;
  }

  /** 取货口产出选择面板（旧资源面板: 4 标签页胶囊 + 4 列物品网格）。 */
  private buildPicker(): HTMLDivElement {
    const root = document.createElement('div');
    root.className = 'efd-picker';

    const tabs = document.createElement('div');
    tabs.className = 'efd-picker-tabs';
    this.pickerPill = document.createElement('div');
    this.pickerPill.className = 'efd-picker-tabs-pill';
    tabs.appendChild(this.pickerPill);
    PICKER_TABS.forEach((t, i) => {
      const tab = document.createElement('button');
      tab.className = 'efd-picker-tab';
      tab.title = t.label;
      tab.style.left = `${i * 93.75}px`; // 绝对定位横向排开（与 pill 同步距）
      tab.appendChild(this.makeSprite(`ui/${t.iconKey}`, 20, 20, 'mask'));
      tab.appendChild(Object.assign(document.createElement('span'), { textContent: t.label }));
      tab.addEventListener('click', () => {
        this.pickerTab = i;
        this.refreshPicker();
      });
      tabs.appendChild(tab);
    });
    root.appendChild(tabs);

    const gridWrap = document.createElement('div');
    gridWrap.className = 'efd-picker-grid-wrap';
    this.pickerGrid = document.createElement('div');
    this.pickerGrid.className = 'efd-picker-grid';
    gridWrap.appendChild(this.pickerGrid);
    root.appendChild(gridWrap);
    return root;
  }

  private toggleDepotAddMode(): void {
    if (this.handle === null) return;
    const comp = this.deps.world.getComponent<BuildingComp>(this.handle, 'BuildingComp');
    if (!comp) return;
    if (comp.depotOutputItemId != null && !this.pickerAddMode) {
      // 有物品 → 移除物品（回退到定义默认源矿）
      comp.depotOutputItemId = null;
      this.refresh();
      return;
    }
    this.pickerAddMode = !this.pickerAddMode;
    this.refresh();
  }

  /** 选择面板物品列表（按当前标签页类目过滤；仅含图集有帧的物品，按中文名排序）。 */
  private pickerItems(): string[] {
    const out: string[] = [];
    for (const [id, item] of this.deps.items.byId) {
      if (item.category !== PICKER_TABS[this.pickerTab].category) continue;
      if (this.frame('items', id) === null) continue;
      out.push(id);
    }
    return out.sort((a, b) => this.deps.itemName(a).localeCompare(this.deps.itemName(b), 'zh'));
  }

  private refreshPicker(): void {
    if (this.pickerRoot === null || this.pickerPill === null || this.pickerGrid === null) return;
    this.pickerPill.style.left = `${this.pickerTab * 93.75}px`;
    this.pickerRoot.querySelectorAll<HTMLButtonElement>('.efd-picker-tab').forEach((t, i) => {
      t.classList.toggle('active', i === this.pickerTab);
    });
    this.pickerGrid.innerHTML = '';
    for (const id of this.pickerItems()) {
      const tile = document.createElement('button');
      tile.className = 'efd-picker-tile';
      tile.title = this.deps.itemName(id);
      const bg = document.createElement('div');
      bg.className = 'efd-tile-bg';
      bg.style.borderRadius = '11px';
      this.tileBgStyle(bg, null);
      const img = document.createElement('div');
      img.className = 'efd-icon-sprite';
      img.style.position = 'absolute';
      img.style.left = '50%';
      img.style.top = '50%';
      img.style.transform = 'translate(-50%, -50%)';
      this.itemIconStyle(img, id, 64, 64);
      const add = document.createElement('div');
      add.className = 'efd-picker-tile-add';
      const addIcon = document.createElement('div');
      addIcon.className = 'efd-icon-sprite';
      this.spriteStyle(addIcon, 'ui', 'add', 31, 31);
      add.appendChild(addIcon);
      tile.appendChild(bg);
      tile.appendChild(img);
      tile.appendChild(add);
      tile.addEventListener('click', () => {
        const comp = this.handle !== null
          ? this.deps.world.getComponent<BuildingComp>(this.handle, 'BuildingComp') : null;
        if (comp) {
          comp.depotOutputItemId = id; // T2.15: 写入实例产出物品（MachineSystem 下一 Tick 生效）
        }
        this.pickerAddMode = false;
        this.refresh();
      });
      this.pickerGrid.appendChild(tile);
    }
    if (this.pickerGrid.children.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'efd-picker-empty';
      empty.textContent = '该分类下暂无物品';
      this.pickerGrid.appendChild(empty);
    }
  }

  // ═════════════════════ 100ms 局部刷新 ═════════════════════

  private mutateComp(fn: (comp: BuildingComp) => void): void {
    if (this.handle === null) return;
    const comp = this.deps.world.getComponent<BuildingComp>(this.handle, 'BuildingComp');
    if (!comp) return;
    fn(comp);
    this.refresh();
  }

  private refresh(): void {
    if (!this.open || this.handle === null) return;
    const comp = this.deps.world.getComponent<BuildingComp>(this.handle, 'BuildingComp');
    const def = comp ? getBuildingDefinition(comp.definitionId) : undefined;
    if (!comp || !def) {
      this.close(); // 实体已销毁（防御；常规删除路径由选中清空联动关闭）
      return;
    }

    this.applySprites(); // 图集就绪后才有图标；迟就绪由 ensureAtlas 补刷

    // 电源开关
    if (this.switchEl !== null) {
      this.switchEl.classList.toggle('is-on', !comp.paused);
      this.switchEl.classList.toggle('is-off', comp.paused);
    }

    if (this.depotPreview !== null) {
      this.refreshDepot(def, comp);
    } else {
      this.refreshSynthesis(def, comp);
    }
  }

  /** 生产设备面板刷新: 指示器/倒计时/进度条/缓冲格/轨道连接态/配方行。 */
  private refreshSynthesis(def: BuildingDefinition, comp: BuildingComp): void {
    const cap = def.bufferCapacity;
    const recipe = comp.currentRecipeId !== null
      ? (this.deps.recipeIndex.get(comp.definitionId) ?? []).find((r) => r.id === comp.currentRecipeId)
      : undefined;
    const inputCount = comp.bufferInput.reduce((n, s) => n + s.count, 0);
    const outputCount = comp.bufferOutput.reduce((n, s) => n + s.count, 0);
    const level = recipe?.level ?? null;

    // 缓冲格 + 格下计数（吸收 T2.9b 读数; 满仓变红，旧 SynthesisGrid 同款）
    const firstItem = (slots: BuildingComp['bufferInput']): string | null =>
      slots.find((s) => s.itemId !== null)?.itemId ?? null;
    this.updateTile(this.inputTile, firstItem(comp.bufferInput), inputCount, cap, level);
    this.updateTile(this.outputTile, firstItem(comp.bufferOutput), outputCount, cap, level);
    this.setUnderCount(this.inputCountEl, inputCount, cap);
    this.setUnderCount(this.outputCountEl, outputCount, cap);

    // 轨道连接态（端口是否接带 → 活动覆盖层; 连接态变化才重建）+ 物品飞行触发
    if ((this.inputConnector !== null || this.outputConnector !== null) && this.handle !== null) {
      const st = portStatuses(this.deps.world, this.handle, comp, def);
      this.inputConns = st.input.map((p) => p.connected);
      this.outputConns = st.output.map((p) => p.connected);
      const key = this.inputConns.map((c) => (c ? 1 : 0)).join('')
        + '|' + this.outputConns.map((c) => (c ? 1 : 0)).join('');
      if (key !== this.connKey) {
        this.connKey = key;
        if (this.inputConnector !== null) {
          this.refreshTrackActive(this.inputConnector.active, this.inputConns, true);
        }
        if (this.outputConnector !== null) {
          this.refreshTrackActive(this.outputConnector.active, this.outputConns, false);
        }
      }
      // 物品飞行触发改为事件驱动（notifyEvent，main.ts 转发 machineSystem 事件）——
      // 计数差采样会在「到货+消费同帧相抵」时漏触发（实测: 输出通畅时动画只出一次，
      // 堵塞后消费停止才恢复），事件流不会丢件。
    }

    // FittedBox scaleDown 等价: 行自然宽超出右区时整行等比缩小
    if (this.mainRow !== null) {
      const avail = this.mainRow.parentElement?.clientWidth ?? 0;
      if (avail > 0) {
        this.mainRow.style.zoom = String(Math.min(1, avail / this.mainNaturalW));
      }
    }

    // 状态判定（旧项目口径）:
    //   isReady = 有配方且加工位空（输入空 + progress≤0）→ 文案"就绪"
    //   isCrafting = 有配方且非暂停/非阻塞且非就绪 → 箭头动画 + 倒计时 + 进度
    const isActive = recipe !== undefined && !comp.paused && comp.state !== 'blocked';
    const isReady = isActive && inputCount === 0 && comp.progress <= 0;
    const isCrafting = isActive && !isReady;

    // 指示器三态（节点常驻，仅切换 display）
    if (this.indicatorArrows !== null && this.indicatorPaused !== null && this.indicatorBlocked !== null) {
      this.indicatorArrows.style.display = comp.paused || comp.state === 'blocked' ? 'none' : 'flex';
      this.indicatorArrows.classList.toggle('idle', !isCrafting);
      this.indicatorPaused.style.display = comp.paused ? 'flex' : 'none';
      this.indicatorBlocked.style.display = !comp.paused && comp.state === 'blocked' ? 'flex' : 'none';
    }
    // 倒计时文案（仅 秒数/就绪; 暂停与阻塞的文案在进度槽，旧项目同款分工）
    if (this.countdownText !== null && this.countdownPaused !== null && this.countdownBlocked !== null) {
      if (comp.paused || comp.state === 'blocked') {
        this.countdownText.textContent = '';
      } else if (isCrafting && recipe !== undefined) {
        const remaining = Math.round((recipe.time / 1000) * (1 - Math.min(comp.progress, 1)));
        this.countdownText.textContent = `${Math.max(0, remaining)}秒`;
      } else if (isReady) {
        this.countdownText.textContent = '就绪';
      } else {
        this.countdownText.textContent = '';
      }
    }
    // 进度槽三态（旧项目: 进度条常显——未加工也画 0 轨道 + 端点圆）
    if (this.progressWrap !== null && this.countdownPaused !== null && this.countdownBlocked !== null) {
      this.progressWrap.style.display = comp.paused || comp.state === 'blocked' ? 'none' : 'block';
      this.countdownPaused.style.display = comp.paused ? 'flex' : 'none';
      this.countdownBlocked.style.display = !comp.paused && comp.state === 'blocked' ? 'flex' : 'none';
      if (this.progressFill !== null) {
        const p = isCrafting ? Math.min(comp.progress, 1) : 0;
        this.progressFill.style.width = `${140 * p}px`;
      }
    }

    // 配方行（只在配方变化时重建，避免每 100ms 重建 DOM）
    if (this.recipeBar !== null) {
      const key = recipe?.id ?? 'empty';
      if (key !== this.recipeShownKey) {
        this.recipeShownKey = key;
        this.recipeBar.querySelectorAll(':scope > :not([data-sprite])').forEach((n) => n.remove());
        if (recipe !== undefined) {
          for (const input of recipe.inputs) {
            const atom = input.alternatives[0];
            if (!atom) continue;
            if (atom.kind === 'item') {
              this.recipeBar.appendChild(this.makeRecipeIcon(atom.ref, 56));
            } else {
              // 类别匹配原子（如"任意植物类别"）: 无单一图标，渲染文字小片
              const chip = document.createElement('span');
              chip.style.cssText = 'color:#aaaaaa;font-size:12px;font-weight:500;';
              chip.textContent = `任意${atom.ref}`;
              this.recipeBar.appendChild(chip);
            }
          }
          const run = document.createElement('div');
          run.className = 'efd-recipe-run';
          const tris = document.createElement('div');
          tris.className = 'efd-recipe-run-triangles';
          for (let i = 0; i < 3; i++) tris.appendChild(document.createElement('div'));
          const t = document.createElement('div');
          t.className = 'efd-recipe-time';
          t.textContent = `${Math.round(recipe.time / 1000)}秒`;
          run.appendChild(tris);
          run.appendChild(t);
          this.recipeBar.appendChild(run);
          for (const out of recipe.outputs) {
            this.recipeBar.appendChild(this.makeRecipeIcon(out.itemId, 56));
          }
        } else {
          const empty = document.createElement('div');
          empty.className = 'efd-recipe-empty';
          empty.textContent = '本设备可自动生产的配方一览';
          this.recipeBar.appendChild(empty);
        }
      }
    }
  }

  /** 单个缓冲格刷新（物品图 + 等级渐变底；计数显示在格下方，见 setUnderCount）。 */
  private updateTile(
    tile: TileRefs | null, itemId: string | null, _count: number, _cap: number, level: number | null,
  ): void {
    if (tile === null) return;
    this.tileBgStyle(tile.bg, itemId !== null ? level : null);
    if (itemId !== null) {
      this.itemIconStyle(tile.icon, itemId, 128, 128);
      tile.icon.style.display = 'block';
    } else {
      tile.icon.style.backgroundImage = 'none';
      tile.icon.style.display = 'none';
    }
  }

  /** 格下计数（旧 SynthesisGrid: 20px w500 #DDDDDD，满仓 #FF4444）。 */
  private setUnderCount(el: HTMLDivElement | null, count: number, cap: number): void {
    if (el === null) return;
    el.textContent = String(count);
    el.classList.toggle('full', count >= cap);
  }

  /** 生产中指示器: 3 枚方向箭头（16×36，交错呼吸动画；idle 整组压暗到 0.2）。 */
  private buildArrows(): HTMLDivElement {
    const arrows = document.createElement('div');
    arrows.className = 'efd-arrows idle';
    for (let i = 0; i < 3; i++) {
      const a = this.makeSprite('ui/directional', 16, 36);
      a.classList.add('efd-arrow'); // 呼吸动画/交错延迟/闲置压暗都挂这个类
      arrows.appendChild(a);
    }
    return arrows;
  }

  /** 暂停/阻塞指示器: 20×4 条 + 36×36 关闭图标 + 条（图标 mask 染色，颜色由类切换）。 */
  private buildStateIndicator(kind: 'paused' | 'blocked'): HTMLDivElement {
    const box = document.createElement('div');
    box.className = `efd-state-indicator ${kind}`;
    box.style.display = 'none';
    box.appendChild(Object.assign(document.createElement('div'), { className: 'efd-state-bar' }));
    const icon = this.makeSprite('ui/close_button', 36, 36, 'mask');
    icon.classList.add('efd-state-icon'); // 背景色（灰/红）由 .efd-state-indicator.<kind> 切换
    box.appendChild(icon);
    box.appendChild(Object.assign(document.createElement('div'), { className: 'efd-state-bar' }));
    return box;
  }

  /** 暂停/阻塞文字行: 20×4 条 + 8px + 文字 + 8px + 条。 */
  private buildStateText(kind: 'paused' | 'blocked', text: string): HTMLDivElement {
    const box = document.createElement('div');
    box.className = `efd-state-text ${kind}`;
    box.style.display = 'none';
    box.appendChild(Object.assign(document.createElement('div'), { className: 'efd-state-bar' }));
    box.appendChild(document.createTextNode(text));
    box.appendChild(Object.assign(document.createElement('div'), { className: 'efd-state-bar' }));
    return box;
  }

  private makeRecipeIcon(itemId: string, size: number): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'efd-icon-sprite';
    el.dataset.itemIcon = itemId;
    el.dataset.itemSize = String(size);
    return el;
  }

  /** 仓库口面板刷新: 取货口产出物品卡片/胶囊态/选择面板可见性。 */
  private refreshDepot(def: BuildingDefinition, comp: BuildingComp): void {
    if (def.depot === 'load') return; // 存货口首版只读（无限汇，无内部状态可显示）

    const outputItemId = comp.depotOutputItemId ?? def.depotOutputItem ?? FALLBACK_DEPOT_ITEM;
    const configured = comp.depotOutputItemId != null;

    // 选择面板与预览区切换
    if (this.pickerRoot !== null && this.depotPreview !== null) {
      this.pickerRoot.hidden = !this.pickerAddMode;
      this.depotPreview.style.display = this.pickerAddMode ? 'none' : 'block';
      if (this.pickerAddMode) this.refreshPicker();
    }

    if (this.cardName !== null) {
      this.cardName.textContent = this.deps.itemName(outputItemId);
    }
    if (this.cardImg !== null) {
      this.itemIconStyle(this.cardImg, outputItemId, 256, 256);
    }
    if (this.gridTile !== null) {
      this.tileBgStyle(this.gridTile.bg, null);
      this.itemIconStyle(this.gridTile.icon, outputItemId, 128, 128);
      this.gridTile.icon.style.display = 'block';
      this.gridTile.count.textContent = '';
    }
    if (this.connectorEl !== null) {
      this.connectorEl.classList.toggle('active', configured);
    }
    if (this.capsuleBtn !== null) {
      const label = this.capsuleBtn.querySelector('span');
      this.capsuleBtn.classList.remove('add', 'remove', 'cancel', 'has-item');
      if (configured) {
        if (label) label.textContent = '移除物品';
        this.capsuleBtn.classList.add('remove', 'has-item');
      } else if (this.pickerAddMode) {
        if (label) label.textContent = '取消选择';
        this.capsuleBtn.classList.add('cancel');
      } else {
        if (label) label.textContent = '添加物品';
        this.capsuleBtn.classList.add('add');
      }
    }
  }

  /** 把标记了 data-sprite / data-item-icon 的节点补上图集背景（refresh 每轮重设，幂等）。 */
  private applySprites(): void {
    this.panel.querySelectorAll<HTMLElement>('[data-sprite]').forEach((el) => {
      const spec = el.dataset.sprite ?? '';
      const slash = spec.indexOf('/');
      if (slash <= 0) return;
      const group = spec.slice(0, slash) as AtlasGroup;
      const key = spec.slice(slash + 1);
      this.spriteStyle(
        el, group, key,
        Number(el.dataset.w ?? '26'), Number(el.dataset.h ?? '26'),
        el.dataset.mode === 'mask' ? 'mask' : 'image',
      );
    });
    this.panel.querySelectorAll<HTMLElement>('[data-item-icon]').forEach((el) => {
      const size = Number(el.dataset.itemSize ?? '56');
      this.itemIconStyle(el, el.dataset.itemIcon ?? '', size, size);
    });
  }
}
