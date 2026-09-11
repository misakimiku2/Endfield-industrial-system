// 设备详情弹窗 (T2.15) — 点击已放置设备弹出，承载电源开关（暂停正式入口）+
// 设备信息 + 生产状态摘要（吸收 T2.9b 临时读数）+ 移动/删除按钮 + 仓库口产出物品选择。
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
import { portStatuses, incomingInputItems } from '../systems/machine/PortStatusOps';
import { tryAcceptItem } from '../systems/machine/BufferOps';
import { AtlasSprites, type AtlasGroup } from './AtlasSprites';
import { ItemDescriptionDialog } from './ItemDescriptionDialog';

/** 简化版取货口的兜底产出物品（与 DepotOps.DEPOT_SOURCE_ITEM 同值；避免循环依赖不直接 import）。 */
const FALLBACK_DEPOT_ITEM = 'originium_ore';

/** 物品格/选择格的等级配色（synthesis_grid._getGridSvg 抄录）。 */
const LEVEL_GRADIENT_END: Record<number, string> = { 2: '#93e8a4', 3: '#6d9bf1', 4: '#b73cc5' };
const LEVEL_TAG: Record<number, string> = { 2: '#44aa00', 3: '#0082ea', 4: '#b73cc5' };

/** 物品格等级色条的 path（两种尺寸各自抄录，不按比例缩放——旧项目是两张独立 SVG）。 */
const TILE_TAG_PATH: Record<number, string> = {
  // 128×128 格（synthesis_grid._getGridSvg）
  128: 'm 1,118 c 2,5.8 7.6,10 14,10 h 98 c 6.4,0 12,-4.2 14,-10 z',
  // 94×94 物品栏格（building_resource_panel.gridTileSvg）
  94: 'M 0.62286269,86.67038 C 2.1269947,90.943986 6.1932067,93.993161 11.000205,93.999896 '
    + 'h 72.000299 c 4.807005,-0.0066 8.873217,-3.05591 10.377348,-7.329516 z',
};

/** 弹窗信息栏 LOGO 的图集帧映射（旧项目对 LOGO SVG 染白；图集内 _white/logo 帧即染白版）。 */
const LOGO_SPRITES: Record<string, { group: AtlasGroup; key: string }> = {
  refining_unit: { group: 'ui', key: 'refining_unit_logo' },
  depot_unloader: { group: 'devices', key: 'depot_unloader_logo_white' },
  depot_loader: { group: 'devices', key: 'depot_loader_logo_white' },
};

/**
 * 加号图标 — 内联 src/assets/svg/add.svg（旧项目拖放提示用的同一枚图标:
 * 4 段分离圆角条拼成的加号，非普通十字）。原 SVG 的 inkscape 元数据已剥离，
 * fill 改 currentColor（颜色由 .efd-add-icon 的 color 控制，遮罩态取 #555555）。
 */
const ADD_SVG =
  '<svg viewBox="0 0 31.160156 31.160156" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
  + '<path fill="currentColor" transform="matrix(0.73,0,0,0.73,-1668.0199,-616.025)" d="m 2306.3014,843.86986 '
  + 'c -1.8973,0 -3.4247,1.5274 -3.4247,3.42466 v 9.58904 c 0,1.89726 1.5274,3.42466 3.4247,3.42466 1.8972,0 '
  + '3.4246,-1.5274 3.4246,-3.42466 v -9.58904 c 0,-1.89726 -1.5274,-3.42466 -3.4246,-3.42466 z m -17.9179,17.91792 '
  + 'c -1.8973,0 -3.4247,1.5274 -3.4247,3.42466 0,1.89726 1.5274,3.42465 3.4247,3.42465 h 9.589 c 1.8973,0 '
  + '3.4247,-1.52739 3.4247,-3.42465 0,-1.89726 -1.5274,-3.42466 -3.4247,-3.42466 z m 26.2467,0 c -1.8972,0 '
  + '-3.4246,1.5274 -3.4246,3.42466 0,1.89726 1.5274,3.42465 3.4246,3.42465 h 9.5891 c 1.8972,0 3.4246,-1.52739 '
  + '3.4246,-3.42465 0,-1.89726 -1.5274,-3.42466 -3.4246,-3.42466 z m -8.3288,8.32887 c -1.8973,0 -3.4247,1.5274 '
  + '-3.4247,3.42466 v 9.58904 c 0,1.89726 1.5274,3.42466 3.4247,3.42466 1.8972,0 3.4246,-1.5274 '
  + '3.4246,-3.42466 v -9.58904 c 0,-1.89726 -1.5274,-3.42466 -3.4246,-3.42466 z"/></svg>';

/** 图钉图标（旧项目 Icons.push_pin；填 currentColor，颜色由 .efd-rcard-pin 的 color 切换）。 */
const PIN_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">'
  + '<path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7'
  + 'l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>';

/** 左侧物品栏的 4 标签页（旧 _tabLabels + items.ts 类目映射；取货口「添加物品」共用）。 */
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
  /** 移动按钮回调（T2.14；main.ts: 关弹窗清选中 + MoveSystem.enterMove）。 */
  onMove(handle: EntityHandle): void;
  /** 用户途径关闭（关闭按钮/遮罩）回调（main.ts: selection.clearSelection）。 */
  onClose(): void;
}

/** 拖拽来源（旧 building_shared_widgets.InventoryDragSource）。 */
type DragSource = 'itemPanel' | 'inputGrid' | 'outputGrid';

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

  /** 图集 sprite 访问（与物品说明弹窗共用同一实例）。 */
  private readonly sprites = new AtlasSprites();
  /** 物品说明二级弹窗（T2.22；点击物品栏格子/输入输出格/配方卡迷你格打开）。 */
  private readonly itemDesc: ItemDescriptionDialog;

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
  // ── 左侧物品栏（旧 _buildResourcePanel: 440×520 + 4 标签页 + 4 列物品网格）──
  private resPanel: HTMLDivElement | null = null;
  private resPill: HTMLDivElement | null = null;
  private resGrid: HTMLDivElement | null = null;
  private resScrollTrack: HTMLDivElement | null = null;
  private resScrollThumb: HTMLDivElement | null = null;
  private resTab = 0;
  private resScrollFadeTimer: number | null = null;
  // ── 配方一览二级弹窗（旧 RecipeListDialog: 960×560 + 2 列配方卡 + 图钉）──
  private recipeListEl: HTMLDivElement | null = null;
  private recipeListGrid: HTMLDivElement | null = null;
  private recipeListSub: HTMLDivElement | null = null;
  private recipeListShownKey = '';
  // ── 全部收取按钮（旧 CollectAllButton: 300×68.3，在配方条右侧）──
  private collectBtn: HTMLButtonElement | null = null;
  // ── 拖拽投放（旧 InventoryDragSource / DragTarget）──
  private drag: { source: DragSource; itemId: string; startX: number; startY: number; active: boolean } | null = null;
  private dragGhost: HTMLDivElement | null = null;
  /** 拖拽结束后紧跟的 click 要吞掉（否则会顺带打开物品说明/选中产出）。 */
  private dragSuppressClick = false;
  // 存货口在途物品列表（旧 DepotLoaderPanel 的多物品卡片）
  private depotIncoming: HTMLDivElement | null = null;
  private depotIncomingKey = '';
  // 取货口「添加物品」模式（旧 _isAddMode: 左侧物品栏格子显示 + 图标）
  private pickerAddMode = false;
  /** 物品栏上次按哪种模式渲染（addMode 变化才重建格子，避免每 100ms 重建 DOM）。 */
  private resAddModeShown = false;

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

    // 二级弹窗: 物品说明（共用同一 AtlasSprites 实例，不重复加载图集）
    this.itemDesc = new ItemDescriptionDialog({
      sprites: this.sprites,
      itemName: deps.itemName,
      items: deps.items,
    });

    void this.sprites.ensureAtlas(); // 预取图集 JSON，首次打开即有图标
    // 图集迟到场景: 打开态下补刷一次。物品栏必须**重建**——首填时图集未就绪会让
    // resourceItems() 的"图集有帧"过滤掉全部物品，只刷图标救不回来。
    this.sprites.onReady(() => {
      if (!this.open) return;
      this.refreshResourcePanel();
      this.refresh();
    });
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
    this.depotIncoming = null;
    this.depotIncomingKey = '';
    this.pickerAddMode = false;
    this.resPanel = null;
    this.resPill = null;
    this.resGrid = null;
    this.resScrollTrack = null;
    this.resScrollThumb = null;
    this.resTab = 0;
    if (this.resScrollFadeTimer !== null) {
      clearTimeout(this.resScrollFadeTimer);
      this.resScrollFadeTimer = null;
    }
    this.closeRecipeList();
    this.itemDesc.close();
    this.collectBtn = null;
    this.resAddModeShown = false;
  }

  // ═════════════════════ 图集访问 ═════════════════════

  private frame(group: AtlasGroup, key: string): ReturnType<AtlasSprites['frame']> {
    return this.sprites.frame(group, key);
  }

  /** 见 AtlasSprites.spriteStyle。 */
  private spriteStyle(
    el: HTMLElement, group: AtlasGroup, key: string, dw: number, dh: number,
    mode: 'image' | 'mask' = 'image',
  ): boolean {
    return this.sprites.spriteStyle(el, group, key, dw, dh, mode);
  }

  /** 物品图标（items 图集帧，key = itemId）。 */
  private itemIconStyle(el: HTMLElement, itemId: string, dw: number, dh: number): boolean {
    return this.sprites.itemIconStyle(el, itemId, dw, dh);
  }

  /**
   * 物品格渐变底 SVG data URI（synthesis_grid._getGridSvg 1:1 复刻）。
   * opts.size=94 走 building_resource_panel.gridTileSvg（物品栏格子: 圆角 11 +
   * 独立的等级色条 path）；opts.hover 把底色换成 #252525（旧项目悬停态）。
   */
  private tileBgStyle(
    el: HTMLDivElement, level: number | null,
    opts?: { size?: number; hover?: boolean },
  ): void {
    const size = opts?.size ?? 128;
    const radius = size === 128 ? 15 : 11;
    const stop = opts?.hover === true ? '#252525' : '#696969';
    const endColor = (level !== null && LEVEL_GRADIENT_END[level]) || '#dddddd';
    const tagColor = (level !== null && LEVEL_TAG[level]) || '#ebebeb';
    const hasItem = level !== null;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">` +
      `<stop offset="0" stop-color="${stop}"/><stop offset="0.7" stop-color="${stop}"/>` +
      `<stop offset="1" stop-color="${endColor}"/></linearGradient></defs>` +
      `<rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="${hasItem ? 'url(#g)' : stop}"/>` +
      `${hasItem ? `<path d="${TILE_TAG_PATH[size]}" fill="${tagColor}"/>` : ''}` +
      `</svg>`;
    el.style.backgroundImage = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }

  /** 创建带 sprite 标记的图标元素（data-w/h = 目标盒，applySprites 据此算缩放）。 */
  private makeSprite(spec: string, w: number, h: number, mode: 'image' | 'mask' = 'image'): HTMLDivElement {
    return this.sprites.makeSprite(spec, w, h, mode);
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

    this.refreshResourcePanel(); // 物品栏首填（图集未就绪时图标由 onReady 补刷）
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

  /**
   * 内容区: 左侧物品栏(440×520) + 20px 间距 + 右区（旧 building_detail_dialog Row 布局）。
   * T2.22 前右区靠 padding-left:480px 占位，物品栏落地后改为真实两列。
   */
  private buildBody(def: BuildingDefinition): HTMLDivElement {
    const body = document.createElement('div');
    body.className = 'efd-dialog-body';
    body.appendChild(this.buildResourcePanel());
    const right = document.createElement('div');
    right.className = 'efd-body-right';
    if (def.depot === 'unload') {
      right.appendChild(this.buildDepotPanel('unload'));
    } else if (def.depot === 'load') {
      right.appendChild(this.buildDepotPanel('load'));
    } else {
      right.appendChild(this.buildSynthesisPanel(def));
    }
    body.appendChild(right);
    return body;
  }

  // ═════════════════════ 左侧物品栏 ═════════════════════

  /**
   * 物品栏面板（旧 _buildResourcePanel + _buildTabBar + _buildGridArea 1:1 复刻）:
   * 440×520 #373737 圆角 15 → [24] 标签页胶囊 375×32 [24] → 物品网格 395.66×438（4 列
   * 93.44×93.62，间距 7.3）+ 右侧 10×438 自定义滚动条（滚动时淡入，800ms 后淡出）。
   *
   * 交互: 悬停显示物品名 tooltip；单击打开物品说明弹窗；**取货口「添加物品」模式下**
   * 格子叠加 + 图标，单击即选定该物品为产出（旧 _isAddMode 语义）。
   */
  private buildResourcePanel(): HTMLDivElement {
    const panel = document.createElement('div');
    panel.className = 'efd-res';
    panel.dataset.drop = 'panel'; // 放置目标: 拖入格内物品 = 收纳

    // 标签页（与产出选择同 4 类目，复用同一套图标与胶囊几何）
    const tabs = document.createElement('div');
    tabs.className = 'efd-picker-tabs';
    this.resPill = document.createElement('div');
    this.resPill.className = 'efd-picker-tabs-pill';
    tabs.appendChild(this.resPill);
    PICKER_TABS.forEach((t, i) => {
      const tab = document.createElement('button');
      tab.className = 'efd-picker-tab';
      tab.title = t.label;
      tab.style.left = `${i * 93.75}px`;
      tab.appendChild(this.makeSprite(`ui/${t.iconKey}`, 20, 20, 'mask'));
      tab.appendChild(Object.assign(document.createElement('span'), { textContent: t.label }));
      tab.addEventListener('click', () => {
        this.resTab = i;
        this.refreshResourcePanel();
      });
      tabs.appendChild(tab);
    });
    panel.appendChild(tabs);

    // 物品网格（滚动容器）
    const gridWrap = document.createElement('div');
    gridWrap.className = 'efd-res-grid-wrap';
    this.resGrid = document.createElement('div');
    this.resGrid.className = 'efd-res-grid';
    this.resGrid.addEventListener('scroll', () => {
      this.showResScrollbar();
      this.syncResScrollbar();
    });
    gridWrap.appendChild(this.resGrid);
    panel.appendChild(gridWrap);

    // 自定义滚动条 10×438（右侧 6.085，top 72；thumb 高度按内容比推算，钳 30~438）
    const track = document.createElement('div');
    track.className = 'efd-res-scrollbar';
    this.resScrollTrack = track;
    const thumb = document.createElement('div');
    thumb.className = 'efd-res-scroll-thumb';
    this.resScrollThumb = thumb;
    track.appendChild(thumb);
    this.bindResThumbDrag(thumb);
    panel.appendChild(track);

    this.resPanel = panel;
    return panel;
  }

  /** 滚动条淡入 + 800ms 后淡出（旧 _onGridScrolled）。 */
  private showResScrollbar(): void {
    if (this.resScrollTrack === null) return;
    this.resScrollTrack.classList.add('visible');
    if (this.resScrollFadeTimer !== null) clearTimeout(this.resScrollFadeTimer);
    this.resScrollFadeTimer = window.setTimeout(() => {
      this.resScrollTrack?.classList.remove('visible');
      this.resScrollFadeTimer = null;
    }, 800);
  }

  /** 滚动条 thumb 位置/高度同步（旧 _buildGridScrollbar 的 ListenableBuilder）。 */
  private syncResScrollbar(): void {
    if (this.resGrid === null || this.resScrollTrack === null || this.resScrollThumb === null) return;
    const el = this.resGrid;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) {
      this.resScrollTrack.style.display = 'none';
      return;
    }
    this.resScrollTrack.style.display = 'block';
    const trackH = this.resScrollTrack.clientHeight; // 随面板高度自适应（小窗口 <438）
    const thumbH = Math.min(Math.max((trackH * trackH) / (trackH + max), 30), trackH);
    const top = (el.scrollTop / max) * (trackH - thumbH);
    this.resScrollThumb.style.height = `${thumbH}px`;
    this.resScrollThumb.style.top = `${top}px`;
  }

  /**
   * 滚动条 thumb 拖拽（旧 _buildGridScrollbar 的 onVerticalDragStart/Update/End）:
   * 按下记录起点，移动按「拇指位移 × (maxScroll / 可滑行程)」换算 scrollTop；
   * 拖拽中拇指加深（0.7）且不淡出，松手重新计时淡出。pointer capture 保证移出
   * 拇指后 move/up 仍送达（否则快速拖动会丢事件、卡在拖拽态）。
   */
  private bindResThumbDrag(thumb: HTMLDivElement): void {
    let dragging = false;
    let startY = 0;
    let startScrollTop = 0;

    thumb.addEventListener('pointerdown', (e) => {
      if (this.resGrid === null) return;
      e.preventDefault();
      dragging = true;
      startY = e.clientY;
      startScrollTop = this.resGrid.scrollTop;
      thumb.setPointerCapture(e.pointerId);
      this.resScrollTrack?.classList.add('dragging');
      this.resScrollTrack?.classList.add('visible'); // 拖拽期间不淡出
      if (this.resScrollFadeTimer !== null) {
        clearTimeout(this.resScrollFadeTimer);
        this.resScrollFadeTimer = null;
      }
    });
    thumb.addEventListener('pointermove', (e) => {
      if (!dragging || this.resGrid === null) return;
      const trackH = this.resScrollTrack?.clientHeight ?? 0;
      const thumbH = thumb.clientHeight;
      const range = trackH - thumbH;
      if (range <= 0) return;
      const max = this.resGrid.scrollHeight - this.resGrid.clientHeight;
      const delta = ((e.clientY - startY) * max) / range;
      this.resGrid.scrollTop = Math.min(Math.max(startScrollTop + delta, 0), max);
    });
    const endDrag = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      if (thumb.hasPointerCapture(e.pointerId)) thumb.releasePointerCapture(e.pointerId);
      this.resScrollTrack?.classList.remove('dragging');
      this.showResScrollbar(); // 松手重新计时淡出
    };
    thumb.addEventListener('pointerup', endDrag);
    thumb.addEventListener('pointercancel', endDrag);
  }

  /** 当前标签页的物品 id 列表（类目过滤 + 图集有帧 + 中文名排序）。 */
  private resourceItems(): string[] {
    const out: string[] = [];
    const category = PICKER_TABS[this.resTab].category;
    for (const [id, item] of this.deps.items.byId) {
      if (item.category !== category) continue;
      if (this.frame('items', id) === null) continue;
      out.push(id);
    }
    return out.sort((a, b) => this.deps.itemName(a).localeCompare(this.deps.itemName(b), 'zh'));
  }

  /** 标签页选中态 + 物品格重建（切换标签页 / 添加模式变化时调用）。 */
  private refreshResourcePanel(): void {
    if (this.resPanel === null || this.resPill === null || this.resGrid === null) return;
    this.resPill.style.left = `${this.resTab * 93.75}px`;
    this.resPanel.querySelectorAll<HTMLButtonElement>('.efd-picker-tab').forEach((t, i) => {
      t.classList.toggle('active', i === this.resTab);
    });

    this.resGrid.innerHTML = '';
    for (const id of this.resourceItems()) {
      const tile = document.createElement('button');
      tile.className = 'efd-res-tile';
      const bg = document.createElement('div');
      bg.className = 'efd-res-tile-bg';
      const def = this.deps.items.byId.get(id);
      this.tileBgStyle(bg, def?.level ?? 1, { size: 94 });
      const img = document.createElement('div');
      img.className = 'efd-res-tile-img';
      this.itemIconStyle(img, id, 93, 93);
      tile.appendChild(bg);
      tile.appendChild(img);

      // 按下并拖出 = 拖该物品投料（仅非添加模式；添加模式下格子是"选产出"按钮）
      if (!this.pickerAddMode) {
        tile.addEventListener('pointerdown', (e) => this.armDrag('itemPanel', id, e));
      }
      if (this.pickerAddMode) {
        // 添加模式: 半透明遮罩 + add 图标（旧 showAddIcon: 未悬停白底黑图标 0.4 /
        // 悬停黑底白图标 0.3），点击选定产出
        const add = document.createElement('div');
        add.className = 'efd-res-tile-add';
        const addIcon = document.createElement('div');
        addIcon.className = 'efd-icon-sprite';
        this.spriteStyle(addIcon, 'ui', 'add', 40, 40, 'mask');
        add.appendChild(addIcon);
        tile.appendChild(add);
        tile.addEventListener('click', () => this.selectDepotOutput(id));
      } else {
        // 普通模式: 悬停 tooltip（物品名）+ 单击打开物品说明
        const tip = document.createElement('div');
        tip.className = 'efd-res-tile-tip';
        tip.textContent = this.deps.itemName(id);
        tile.appendChild(tip);
        tile.addEventListener('click', () => {
          if (this.dragSuppressClick) return; // 刚拖完: 不当作点击
          this.itemDesc.open(id);
        });
      }
      // 悬停换底（旧 ResourceGridTileState._hovering → gridTileSvg(isHovered:true)）
      tile.addEventListener('pointerenter', () => {
        this.tileBgStyle(bg, def?.level ?? 1, { size: 94, hover: true });
      });
      tile.addEventListener('pointerleave', () => {
        this.tileBgStyle(bg, def?.level ?? 1, { size: 94 });
      });
      this.resGrid.appendChild(tile);
    }
    if (this.resGrid.children.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'efd-picker-empty';
      empty.textContent = '该分类下暂无物品';
      this.resGrid.appendChild(empty);
    }
    this.syncResScrollbar();
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
    // 输入格: 既是拖拽源（可拖回物品栏收纳）又是放置目标（从物品栏拖入投料）
    this.inputTile.root.dataset.drop = 'input';
    this.inputTile.root.dataset.drag = 'inputGrid';
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
    // 输出格: 仅拖拽源（拖回物品栏 = 收取全部产物）
    this.outputTile.root.dataset.drag = 'outputGrid';
    this.outputCountEl = this.makeUnderCount(this.outputGridBox, 0, tileTop + 134);
    if (nOut > 0) {
      this.outputConnector = this.buildTrackJoints(nOut, false, rowH);
      this.outputGridBox.appendChild(this.outputConnector.el);
    }
    main.appendChild(this.outputGridBox);

    this.mainNaturalW = (nIn > 0 ? 416 : 128) + 22 + 112 + (nOut > 0 ? 416 : 128);
    mainWrap.appendChild(main);
    panel.appendChild(mainWrap);

    // 底部: 当前自动生产中的配方（旧 800×76.8 Stack:
    //   信息区 348.16[含背景] | 配方按钮 @326 | 竖分隔线 @448 | 全部收取 @524）
    const section = document.createElement('div');
    section.className = 'efd-recipe-section';
    const label = document.createElement('div');
    label.className = 'efd-recipe-label';
    label.textContent = '当前自动生产中的配方';

    const bar = document.createElement('div');
    bar.className = 'efd-recipe-bar';

    // 信息区（点它 = 打开配方一览，旧项目 InformationBackground 的 GestureDetector）
    this.recipeBar = document.createElement('div');
    this.recipeBar.className = 'efd-recipe-info';
    const barBg = this.makeSprite('ui/information_bg', 348.16, 76.8);
    barBg.style.position = 'absolute';
    barBg.style.inset = '0';
    this.recipeBar.appendChild(barBg);
    this.recipeBar.addEventListener('click', () => this.openRecipeList());
    bar.appendChild(this.recipeBar);

    // 配方按钮 43.52×43.52（Recipe_button: 白圆 + #636363 放大镜，两色 → image 模式）
    const rbtn = document.createElement('button');
    rbtn.className = 'efd-recipe-btn';
    rbtn.title = '配方一览';
    rbtn.appendChild(this.makeSprite('ui/recipe_button', 43.52, 43.52));
    rbtn.addEventListener('click', () => this.openRecipeList());
    bar.appendChild(rbtn);

    const vsep = document.createElement('div');
    vsep.className = 'efd-recipe-vsep';
    bar.appendChild(vsep);

    // 全部收取 300×68.33（Collect_button 是单色 #ffef01 → mask 染 原色/hover/禁用 三态）
    const collect = document.createElement('button');
    collect.className = 'efd-collect';
    collect.appendChild(this.makeSprite('ui/collect_button', 300, 68.33, 'mask'));
    collect.appendChild(Object.assign(document.createElement('span'), {
      className: 'efd-collect-text', textContent: '全部收取',
    }));
    collect.addEventListener('click', () => this.collectAllOutput());
    this.collectBtn = collect;
    bar.appendChild(collect);

    section.appendChild(label);
    section.appendChild(bar);
    panel.appendChild(section);
    return panel;
  }

  /** 「全部收取」(旧 CollectAllButton): 清空输出缓冲，堵塞态随之解除。 */
  private collectAllOutput(): void {
    if (this.handle === null) return;
    const comp = this.deps.world.getComponent<BuildingComp>(this.handle, 'BuildingComp');
    if (!comp) return;
    for (const slot of comp.bufferOutput) {
      slot.itemId = null;
      slot.count = 0;
    }
    if (comp.state === 'blocked') comp.state = 'idle'; // 输出腾位 → 交回 MachineSystem 重判
    this.refresh();
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
    const refs: TileRefs = { root, bg, icon, count: document.createElement('div') };
    this.bindTileItemTap(refs);
    return refs;
  }

  /**
   * 物品格交互（旧 synthesis_grid）: 点击 → 打开物品说明；按下并拖动（>5px）
   * → 拖出格内物品（仅输入/输出格有 data-drag，仓库口格子不参与拖拽）。
   */
  private bindTileItemTap(tile: TileRefs): void {
    tile.root.classList.add('efd-tile-tap');
    tile.root.addEventListener('click', () => {
      if (this.dragSuppressClick) return; // 刚拖完: 不当作点击
      const id = tile.root.dataset.item;
      if (id) this.itemDesc.open(id);
    });
    tile.root.addEventListener('pointerdown', (e) => {
      const src = tile.root.dataset.drag as DragSource | undefined;
      if (src === undefined) return; // 仓库口格子等非拖拽源
      this.armDrag(src, tile.root.dataset.item ?? '', e);
    });
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

  private flightIconCache = new Map<string, string>();

  private ensureItemsImage(): Promise<HTMLImageElement | null> {
    return this.sprites.ensureItemsImage();
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
    const refs: TileRefs = { root, bg, icon, count };
    this.bindTileItemTap(refs);
    return refs;
  }

  /** 动作按钮行（旧 ActionButton: 44×44 图标 + 文字 14px w500 白）。T2.14 起为 移动 + 删除。 */
  private buildActionRow(): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'efd-action-row';
    // 移动（T2.14）: 关弹窗 + 对该设备进入移动态（main.ts 回调；拾取后 R 旋转/左键重放/右键·ESC 取消）
    const move = document.createElement('button');
    move.className = 'efd-action-btn';
    move.appendChild(this.makeSprite('ui/move', 44, 44));
    move.appendChild(Object.assign(document.createElement('span'), { textContent: '移动' }));
    move.addEventListener('click', () => {
      if (this.handle !== null) this.deps.onMove(this.handle);
    });
    row.appendChild(move);
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

  // ═════════════════════ 拖拽投放（旧 InventoryDragSource / DragTarget）═════════════════════

  /**
   * 指针按下 → 预备拖拽。**旧项目是长按 450ms（LongPressDraggable delay），
   * 用户明确要求"正常拖拽"** → 改为位移超过 5px 即进入拖拽态；未超阈值松手 =
   * 普通点击，原有行为（打开物品说明 / 选中产出）完全不变。
   */
  private armDrag(source: DragSource, itemId: string, e: PointerEvent): void {
    if (e.button !== 0 || itemId === '') return;
    this.drag = { source, itemId, startX: e.clientX, startY: e.clientY, active: false };
    const onMove = (ev: PointerEvent): void => this.onDragMove(ev);
    const onUp = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.onDragEnd(ev);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  private onDragMove(e: PointerEvent): void {
    const d = this.drag;
    if (d === null) return;
    if (!d.active) {
      if (Math.abs(e.clientX - d.startX) < 5 && Math.abs(e.clientY - d.startY) < 5) return;
      d.active = true;
      this.makeDragGhost(d.itemId);
      this.markDropTargets(d.source);
    }
    if (this.dragGhost !== null) {
      // 右下偏移 28px: 鼠标压在目标格中心时，正中央的拖放提示（加号/文案）会被
      // 80×80 的 ghost 整个盖住；偏移后既保持跟手又露出目标中心（用户实测反馈）。
      this.dragGhost.style.left = `${e.clientX - 40 + 28}px`;
      this.dragGhost.style.top = `${e.clientY - 40 + 28}px`;
    }
    this.updateDropHover(e.clientX, e.clientY);
  }

  private onDragEnd(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    if (d === null) return;
    if (d.active) {
      this.dragSuppressClick = true; // 吞掉随后的 click（见 bindTileItemTap / 物品栏格子）
      window.setTimeout(() => { this.dragSuppressClick = false; }, 0);
      this.applyDrop(d.source, this.dropTargetAt(e.clientX, e.clientY), d.itemId);
    }
    this.clearDragVisuals();
  }

  /** 拖拽反馈（旧 feedback: 80×80 #373737 圆角 10 白边 + 68×68 物品图，opacity .85）。 */
  private makeDragGhost(itemId: string): void {
    const ghost = document.createElement('div');
    ghost.className = 'efd-drag-ghost';
    const img = document.createElement('div');
    img.className = 'efd-icon-sprite';
    this.itemIconStyle(img, itemId, 68, 68);
    ghost.appendChild(img);
    document.body.appendChild(ghost);
    this.dragGhost = ghost;
  }

  /**
   * 标出本次拖拽可放置的目标并铺提示遮罩（旧 SynthesisGrid/资源面板的拖放提示:
   * 模糊遮罩 + 中央 add 图标 + 涟漪动画 + 底部文案；悬停到目标上时 add 旋转 90°
   * 放大 1.15 并加深、文字下滑淡出——见 .efd-drop-hint 的 efd-drag-over 态）。
   */
  private markDropTargets(source: DragSource): void {
    const target = source === 'itemPanel' ? this.inputTile?.root : this.resPanel;
    if (target === undefined || target === null) return;
    target.classList.add('efd-droppable');

    const hint = document.createElement('div');
    hint.className = source === 'itemPanel' ? 'efd-drop-hint tile' : 'efd-drop-hint panel';
    for (let i = 0; i < 2; i++) {
      const ripple = document.createElement('i');
      ripple.className = 'efd-ripple';
      hint.appendChild(ripple);
    }
    // add 图标用内联 SVG（旧项目 add.svg，见 ADD_SVG）——不用图集 ui/add 帧:
    // 帧只有约 32px，放大到 90px 会明显发虚（用户实测反馈"太糊"）。
    const addIcon = document.createElement('i');
    addIcon.className = 'efd-add-icon';
    addIcon.innerHTML = ADD_SVG;
    hint.appendChild(addIcon);
    hint.appendChild(Object.assign(document.createElement('span'), {
      className: 'efd-drop-text',
      textContent: source === 'itemPanel' ? '拖到此处输入' : '拖动到此收纳物品',
    }));
    target.appendChild(hint);
  }

  private updateDropHover(x: number, y: number): void {
    const el = this.dropElementAt(x, y);
    this.panel.querySelectorAll('.efd-drag-over').forEach((n) => {
      if (n !== el) n.classList.remove('efd-drag-over');
    });
    if (el !== null) el.classList.add('efd-drag-over');
  }

  /** 命中检测: 只看本次标记为可放置的 [data-drop]（ghost 是 pointer-events:none，不挡）。 */
  private dropElementAt(x: number, y: number): HTMLElement | null {
    const el = document.elementFromPoint(x, y);
    return el?.closest<HTMLElement>('[data-drop].efd-droppable') ?? null;
  }

  private dropTargetAt(x: number, y: number): string | null {
    return this.dropElementAt(x, y)?.dataset.drop ?? null;
  }

  private clearDragVisuals(): void {
    this.dragGhost?.remove();
    this.dragGhost = null;
    this.panel.querySelectorAll('.efd-drop-hint').forEach((n) => n.remove());
    this.panel.querySelectorAll('.efd-droppable, .efd-drag-over').forEach((n) => {
      n.classList.remove('efd-droppable', 'efd-drag-over');
    });
  }

  /**
   * 落点生效（旧 building_detail_dialog.onAcceptWithDetails）:
   * - **物品栏 → 输入格**: 逐件 `tryAcceptItem` 补满输入槽（旧项目同款语义:
   *   一次拖入即 `inputItemIdCount = maxInputItemCount`）。槽已锁异类物品时一件也
   *   进不去（tryAcceptItem 拒绝），不会出现混料。
   * - **输入格 → 物品栏**: 清空输入缓冲，并**解除配方锁 + 重置计时**——残留
   *   progress>0 会让生产引擎的「progress<=0 才启动」永不成立，后续物品只堆积在
   *   输入端不生产（旧项目踩过并已在注释里记下的坑，这里同款处理）。
   * - **输出格 → 物品栏**: 清空输出缓冲（等同「全部收取」）。
   */
  private applyDrop(source: DragSource, target: string | null, itemId: string): void {
    if (target === null) return;
    const comp = this.handle !== null
      ? this.deps.world.getComponent<BuildingComp>(this.handle, 'BuildingComp') : null;
    const def = comp ? getBuildingDefinition(comp.definitionId) : undefined;
    if (!comp || !def) return;

    if (source === 'itemPanel' && target === 'input') {
      const cap = def.bufferCapacity;
      let n = 0;
      while (n < cap && tryAcceptItem(comp.bufferInput, itemId, cap)) n++;
    } else if (source === 'inputGrid' && target === 'panel') {
      for (const s of comp.bufferInput) {
        s.itemId = null;
        s.count = 0;
      }
      comp.currentRecipeId = null;
      comp.progress = 0;
      comp.elapsed = 0;
      comp.state = 'idle';
    } else if (source === 'outputGrid' && target === 'panel') {
      for (const s of comp.bufferOutput) {
        s.itemId = null;
        s.count = 0;
      }
      if (comp.state === 'blocked') comp.state = 'idle';
    }
    this.refresh();
  }

  // ═════════════════════ 配方一览（旧 RecipeListDialog）═════════════════════

  /**
   * 配方一览二级弹窗 (960×560 #161616 圆角 16 边框 #444，padding 24):
   *   头: [26] 标题「可自动生产的配方一览」20px w600 + 副标题设备名 14px #A6A6A6 + 关闭
   *   体: 2 列网格（gap 16，childAspectRatio 3.5 → 行高 128）配方卡
   * 卡片 = 配方名行 + 白底卡(80 高): 输入×2 →「>>>」+秒数 → 输出×2 → 竖线 → 图钉。
   *
   * 图钉 = **锁定配方**（写 comp.pinnedRecipeId，T2.22）——语义是"优先"而非强制:
   * 锁定配方当前可生产时用它，否则回退常规匹配（旧项目是硬性 activeRecipeId，
   * 锁定后异类原料会让设备一直空转；改成软优先后只影响多配方可匹配时的取舍）。
   */
  private buildRecipeList(): HTMLDivElement {
    const root = document.createElement('div');
    root.className = 'efd-rlist-root';
    root.hidden = true;

    const barrier = document.createElement('div');
    barrier.className = 'efd-rlist-barrier';
    barrier.addEventListener('click', () => this.closeRecipeList());

    const panel = document.createElement('div');
    panel.className = 'efd-rlist';

    const head = document.createElement('div');
    head.className = 'efd-rlist-head';
    const spacer = document.createElement('div');
    spacer.className = 'efd-rlist-head-spacer';
    const titles = document.createElement('div');
    titles.className = 'efd-rlist-titles';
    const title = document.createElement('div');
    title.className = 'efd-rlist-title';
    title.textContent = '可自动生产的配方一览';
    this.recipeListSub = document.createElement('div');
    this.recipeListSub.className = 'efd-rlist-sub';
    titles.appendChild(title);
    titles.appendChild(this.recipeListSub);
    const close = document.createElement('button');
    close.className = 'efd-infobar-close';
    close.title = '关闭';
    close.appendChild(this.makeSprite('ui/close_button', 26, 26));
    close.addEventListener('click', () => this.closeRecipeList());
    head.appendChild(spacer);
    head.appendChild(titles);
    head.appendChild(close);

    this.recipeListGrid = document.createElement('div');
    this.recipeListGrid.className = 'efd-rlist-grid';

    panel.appendChild(head);
    panel.appendChild(this.recipeListGrid);
    panel.addEventListener('click', (e) => e.stopPropagation());

    root.appendChild(barrier);
    root.appendChild(panel);
    this.root.appendChild(root);
    return root;
  }

  private openRecipeList(): void {
    if (this.handle === null) return;
    const comp = this.deps.world.getComponent<BuildingComp>(this.handle, 'BuildingComp');
    if (!comp) return;
    const def = getBuildingDefinition(comp.definitionId);
    if (!def) return;

    if (this.recipeListEl === null) this.recipeListEl = this.buildRecipeList();
    if (this.recipeListSub !== null) this.recipeListSub.textContent = def.name;
    this.recipeListShownKey = `${this.handle}|${comp.pinnedRecipeId ?? ''}`;
    this.renderRecipeCards(this.deps.recipeIndex.get(comp.definitionId) ?? []);
    this.recipeListEl.hidden = false;
    this.applySprites();
  }

  private closeRecipeList(): void {
    if (this.recipeListEl !== null) this.recipeListEl.hidden = true;
    this.recipeListShownKey = '';
  }

  /** 配方卡网格重建（图钉态/设备切换时调用）。 */
  private renderRecipeCards(recipes: Recipe[]): void {
    if (this.recipeListGrid === null) return;
    const comp = this.handle !== null
      ? this.deps.world.getComponent<BuildingComp>(this.handle, 'BuildingComp') : null;
    const pinnedId = comp?.pinnedRecipeId ?? null;
    const levelOf = (id: string): number => this.deps.items.byId.get(id)?.level ?? 1;

    this.recipeListGrid.innerHTML = '';
    if (recipes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'efd-rlist-empty';
      empty.textContent = '该设备暂无可用配方';
      this.recipeListGrid.appendChild(empty);
      return;
    }

    for (const r of recipes) {
      const card = document.createElement('div');
      card.className = 'efd-rcard';

      const head = document.createElement('div');
      head.className = 'efd-rcard-head';
      head.appendChild(Object.assign(document.createElement('i'), { className: 'efd-rcard-doc' }));
      head.appendChild(Object.assign(document.createElement('span'), { textContent: this.recipeName(r) }));
      card.appendChild(head);

      const body = document.createElement('div');
      body.className = 'efd-rcard-body';

      // 输入（最多 2 组；组是"或"关系 → 取首个备选；tag 原子无单一图标 → 空位）
      for (let i = 0; i < 2; i++) {
        const atom = r.inputs[i]?.alternatives[0];
        const id = atom !== undefined && atom.kind === 'item' ? atom.ref : null;
        body.appendChild(this.makeMiniTile(id, atom?.count ?? 1, id !== null ? levelOf(id) : 1));
      }

      const spacerL = document.createElement('div');
      spacerL.className = 'efd-rcard-spacer';
      body.appendChild(spacerL);

      const run = document.createElement('div');
      run.className = 'efd-rcard-run';
      const chevs = document.createElement('div');
      chevs.className = 'efd-rcard-chevs';
      for (let i = 0; i < 3; i++) chevs.appendChild(document.createElement('i'));
      run.appendChild(chevs);
      run.appendChild(Object.assign(document.createElement('span'), {
        className: 'efd-rcard-time', textContent: `${Math.round(r.time / 1000)}秒`,
      }));
      body.appendChild(run);

      const spacerR = document.createElement('div');
      spacerR.className = 'efd-rcard-spacer';
      body.appendChild(spacerR);

      // 输出（主产物 + 副产物，最多 2 个）
      for (let i = 0; i < 2; i++) {
        const out = r.outputs[i];
        const id = out?.itemId ?? null;
        body.appendChild(this.makeMiniTile(id, out?.count ?? 1, id !== null ? levelOf(id) : 1));
      }

      body.appendChild(Object.assign(document.createElement('div'), { className: 'efd-rcard-gap' }));
      body.appendChild(Object.assign(document.createElement('div'), { className: 'efd-rcard-vsep' }));
      body.appendChild(Object.assign(document.createElement('div'), { className: 'efd-rcard-gap' }));

      const pin = document.createElement('button');
      pin.className = `efd-rcard-pin${r.id === pinnedId ? ' pinned' : ''}`;
      pin.title = r.id === pinnedId ? '取消固定该配方' : '固定该配方（优先生产）';
      pin.innerHTML = PIN_SVG;
      pin.addEventListener('click', () => this.mutateComp((c) => {
        c.pinnedRecipeId = c.pinnedRecipeId === r.id ? null : r.id;
      }));
      body.appendChild(pin);

      card.appendChild(body);
      this.recipeListGrid.appendChild(card);
    }
    this.applySprites();
  }

  /** 配方名（旧 Recipe.name；本项目的 Recipe 无 name 字段 → 用主产物中文名）。 */
  private recipeName(r: Recipe): string {
    const main = this.deps.itemName(r.outputs[0].itemId);
    return r.outputs.length > 1 ? `${main} +${r.outputs.length - 1}` : main;
  }

  /** 配方卡迷你物品格（旧 MiniItemTile: 54×54 #333333 圆角4 边框#666 + 底部数量色条）。 */
  private makeMiniTile(itemId: string | null, count: number, level: number): HTMLDivElement {
    const el = document.createElement('div');
    el.className = itemId === null ? 'efd-mini empty' : 'efd-mini';
    if (itemId === null) return el; // 空位: 透明 + 边框 + 对角线（旧 DiagonalSlashPainter）
    const img = document.createElement('div');
    img.className = 'efd-mini-img';
    this.itemIconStyle(img, itemId, 50, 50);
    const tag = document.createElement('div');
    tag.className = 'efd-mini-tag';
    tag.style.backgroundColor = LEVEL_TAG[level] ?? '#ebebeb';
    tag.classList.toggle('on-light', level < 2);
    tag.textContent = String(count);
    el.appendChild(img);
    el.appendChild(tag);
    el.addEventListener('click', () => this.itemDesc.open(itemId));
    return el;
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

    // 1. 卡片区 265×128
    //    取货口: 仓库卡（名称 + ∞ 数量 + 右侧大图）
    //    存货口: 在途物品列表（旧 DepotLoaderPanel: 多台传送带送来的物品，各显示件数）
    if (kind === 'unload') {
      const card = document.createElement('div');
      card.className = 'efd-warehouse-card';
      const cardImgWrap = document.createElement('div');
      cardImgWrap.className = 'efd-warehouse-card-img';
      this.cardImg = document.createElement('div');
      this.cardImg.className = 'efd-icon-sprite';
      cardImgWrap.appendChild(this.cardImg);
      this.cardName = document.createElement('div');
      this.cardName.className = 'efd-warehouse-card-name';
      const qty = document.createElement('div');
      qty.className = 'efd-warehouse-card-qty';
      qty.appendChild(this.makeSprite('ui/depot_icon', 38.72, 34.03));
      qty.appendChild(document.createTextNode('∞'));
      card.appendChild(cardImgWrap);
      card.appendChild(this.cardName);
      card.appendChild(qty);
      rowEl.appendChild(card);
    } else {
      this.depotIncoming = document.createElement('div');
      this.depotIncoming.className = 'efd-depot-incoming';
      rowEl.appendChild(this.depotIncoming);
    }

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

      // 产出选择走左侧物品栏（旧项目同款: 添加模式下物品栏格子显示 + 图标）
      main.appendChild(wrap);
    } else {
      main.appendChild(wrap);
    }

    panel.appendChild(main);
    return panel;
  }

  /**
   * 存货口面板刷新 (旧 DepotLoaderPanel): 在途物品列表 + 物品格显示当前进入项。
   * 存货口是无限汇——物品入库即消失，没有"仓库库存"可读，能显示的只有
   * **接入传送带上正在送来的物品**（incomingInputItems，只读）。
   * 列表内容变化才重建 DOM（100ms 刷新下避免每轮重建）。
   */
  private refreshDepotLoader(def: BuildingDefinition, comp: BuildingComp): void {
    if (this.handle === null) return;
    const incoming = incomingInputItems(this.deps.world, this.handle, comp, def);
    const first = incoming[0]?.itemId ?? null;

    // 物品格: 首件在途物品（无在途 → 保留空态 No 图标）
    if (this.gridTile !== null) {
      const noEl = this.gridTile.root.querySelector<HTMLElement>('.efd-tile-empty-icon');
      if (noEl !== null) noEl.style.display = first === null ? 'flex' : 'none';
      this.tileBgStyle(this.gridTile.bg, null);
      if (first === null) {
        this.gridTile.icon.style.backgroundImage = 'none';
        this.gridTile.icon.style.display = 'none';
        this.gridTile.count.textContent = '';
        delete this.gridTile.root.dataset.item;
      } else {
        this.itemIconStyle(this.gridTile.icon, first, 128, 128);
        this.gridTile.icon.style.display = 'block';
        this.gridTile.count.textContent = String(incoming[0].count);
        this.gridTile.root.dataset.item = first;
      }
    }

    if (this.depotIncoming === null) return;
    const key = incoming.map((i) => `${i.itemId}:${i.count}`).join(',');
    if (key === this.depotIncomingKey) return;
    this.depotIncomingKey = key;
    this.depotIncoming.innerHTML = '';
    if (incoming.length === 0) {
      this.depotIncoming.appendChild(Object.assign(document.createElement('div'), {
        className: 'efd-depot-inc-empty', textContent: '暂无物品入库',
      }));
      return;
    }
    for (const { itemId, count } of incoming) {
      const row = document.createElement('div');
      row.className = 'efd-depot-inc-item';
      const icon = document.createElement('div');
      icon.className = 'efd-icon-sprite';
      this.itemIconStyle(icon, itemId, 44, 44);
      row.appendChild(icon);
      row.appendChild(Object.assign(document.createElement('div'), {
        className: 'efd-depot-inc-name', textContent: this.deps.itemName(itemId),
      }));
      row.appendChild(Object.assign(document.createElement('div'), {
        className: 'efd-depot-inc-qty', textContent: String(count),
      }));
      row.addEventListener('click', () => this.itemDesc.open(itemId));
      this.depotIncoming.appendChild(row);
    }
  }

  /** 取货口「添加物品」模式: 点物品栏格子 → 写入该物品为实例产出（旧 onAddItem）。 */
  private selectDepotOutput(id: string): void {
    const comp = this.handle !== null
      ? this.deps.world.getComponent<BuildingComp>(this.handle, 'BuildingComp') : null;
    if (comp) comp.depotOutputItemId = id; // MachineSystem 下一 Tick 生效
    this.pickerAddMode = false;
    this.refresh();
  }

  /**
   * 取货口胶囊按钮（旧 _toggleDepotAddMode）: 有物品 → 移除物品（回退定义默认源矿）；
   * 无物品 → 切换「添加物品」模式（左侧物品栏格子显示 + 图标）。
   */
  private toggleDepotAddMode(): void {
    if (this.handle === null) return;
    const comp = this.deps.world.getComponent<BuildingComp>(this.handle, 'BuildingComp');
    if (!comp) return;
    if (comp.depotOutputItemId != null && !this.pickerAddMode) {
      comp.depotOutputItemId = null;
      this.refresh();
      return;
    }
    this.pickerAddMode = !this.pickerAddMode;
    this.refresh();
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

    this.applySprites(); // 图集就绪后才有图标；迟就绪由 onReady 补刷

    // 电源开关
    if (this.switchEl !== null) {
      this.switchEl.classList.toggle('is-on', !comp.paused);
      this.switchEl.classList.toggle('is-off', comp.paused);
    }

    // 取货口「添加物品」模式切换 → 物品栏格子重挂（+ 图标 / tooltip 二选一）
    if (this.pickerAddMode !== this.resAddModeShown) {
      this.resAddModeShown = this.pickerAddMode;
      this.refreshResourcePanel();
    }

    if (this.depotPreview !== null) {
      this.refreshDepot(def, comp);
    } else {
      this.refreshSynthesis(def, comp);
    }

    // 配方一览开着时同步图钉态（锁定配方变化才重建卡片，避免每 100ms 重建 DOM）
    if (this.recipeListEl !== null && !this.recipeListEl.hidden) {
      const key = `${String(this.handle)}|${comp.pinnedRecipeId ?? ''}`;
      if (key !== this.recipeListShownKey) {
        this.recipeListShownKey = key;
        this.renderRecipeCards(this.deps.recipeIndex.get(comp.definitionId) ?? []);
      }
    }
  }

  /**
   * ESC 分层关闭 (T2.22): 先关二级弹窗（物品说明 → 配方一览），都没有才轮到主弹窗。
   * @returns true = 已消费这次 ESC（main.ts 不再关主弹窗）。
   */
  handleEscape(): boolean {
    if (this.itemDesc.isOpen()) {
      this.itemDesc.close();
      return true;
    }
    if (this.recipeListEl !== null && !this.recipeListEl.hidden) {
      this.closeRecipeList();
      return true;
    }
    return false;
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

    // 「全部收取」启用态（旧 hasCollectableOutput: 有输出带时需 ≥2 件——避免单件
    // 被传走的瞬间按钮闪烁；无输出带时只要有一件即可收取）
    if (this.collectBtn !== null) {
      const hasBelt = this.outputConns.some((c) => c);
      const enabled = hasBelt ? outputCount >= 2 : outputCount > 0;
      this.collectBtn.disabled = !enabled;
      this.collectBtn.classList.toggle('disabled', !enabled);
    }

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
      tile.root.dataset.item = itemId; // 点击打开物品说明用
    } else {
      tile.icon.style.backgroundImage = 'none';
      tile.icon.style.display = 'none';
      delete tile.root.dataset.item;
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

  /** 仓库口面板刷新: 取货口产出物品卡片/胶囊态；存货口在途物品列表。 */
  private refreshDepot(def: BuildingDefinition, comp: BuildingComp): void {
    if (def.depot === 'load') {
      this.refreshDepotLoader(def, comp);
      return;
    }

    const outputItemId = comp.depotOutputItemId ?? def.depotOutputItem ?? FALLBACK_DEPOT_ITEM;
    const configured = comp.depotOutputItemId != null;

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

  /**
   * 把标记了 data-sprite / data-item-icon 的节点补上图集背景（refresh 每轮重设，幂等）。
   * 范围: 主面板 + 配方一览（二级弹窗节点不在 panel 内，单独刷）。
   */
  private applySprites(): void {
    this.sprites.applySprites(this.panel);
    if (this.recipeListEl !== null) this.sprites.applySprites(this.recipeListEl);
  }
}
