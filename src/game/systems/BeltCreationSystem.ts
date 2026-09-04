// 传送带创建系统 — T2.0 阶段1：基础创建与预览（重构版）
// 依据: implementation-phase-2.md T2.0、A9 §6 (传送带创建与编辑系统)
// 移植参考: 旧 Flutter 项目 transport_belt.dart（多锚点交互）+ belt_direction_utils.dart（双层寻路）
//
// 职责:
//   - 维护"传送带创建模式"状态机（idle ↔ hover ↔ preview）
//   - 按 E 进入/退出；右键 / ESC / 再按 E 退出（右键/ESC 直接丢弃当前预览段，不落盘）
//   - hover 态高亮设备输出端口与已有断头传送带末端
//   - 点击起点 → 移动鼠标显示蓝色预览路径（动量L形 + BFS绕障）
//   - 多锚点：preview 态左键把当前鼠标格作为中继锚点继续延伸折线
//   - 落盘模型为左键逐段提交：preview 态每次左键把预览新段落盘为真实传送带段（addWaypoint → commitCells）
//
// 创建模式下普通设备选中逻辑由 main.ts 暂停转发，避免冲突。

import { Container, Graphics } from 'pixi.js';
import type { World, EntityHandle } from '../ECS';
import type { Camera } from '../render/Camera';
import type { SceneLayers } from '../render/SceneRenderer';
import type { OccupancyMap } from '../world/OccupancyMap';
import { getBuildingDefinition } from '../data/buildings';
import type { BuildingComp, Direction } from '../components/BuildingComp';
import type { Position } from '../components/Position';
import type { BeltSegmentComp } from '../components/BeltSegmentComp';
import { CELL_SIZE } from '../render/constants';
import { drawStraightBelt, drawStraightBeltStub, drawCornerBelt } from '../render/BeltVectorGeometry';
import {
  beltCornerTransform,
  beltTextureRotation,
  turnInfoFromDirections,
  directionVector,
  type CellTurnInfo,
} from './belt/BeltPathGeometry';
import {
  findPath,
  calculateMomentumPath,
  directionBetween,
  keyOf,
  type GridCell,
  type IsBlocked,
  type FindPathOptions,
} from './belt/BeltPathfinding';
// T2.16 终点对接: 吸附几何（纯逻辑）+ 输入端口格索引（与吸入判定同源）
import {
  dockRedirect,
  applySnapToCells,
  dockInfoOf,
  portKey,
  type DockInfo,
  type DockSnap,
} from './belt/BeltDockOps';
import { collectInputPortCells } from './machine/IntakeOps';
// 端口旋转数学（T2.6 起与 MachineSystem 共享，单一事实来源）
import { rotatePort, portOutwardBase, rotateDirection } from './PortGeometry';

/** 创建模式状态。 */
export type BeltMode = 'idle' | 'hover' | 'preview';

/** 起点类型。 */
export type StartKind = 'port' | 'tail';

/** 路径起点信息。 */
interface StartPoint {
  kind: StartKind;
  /** 起点格（端口格 / 断头段所在格）。 */
  cell: GridCell;
  /** 第一段传送带的绝对朝向。 */
  direction: Direction;
  /**
   * 链首继承的进入方向（computePathCells/computeTurnInfos 的 startDir）。
   * port 起点 = 端口朝向；tail 起点 = 原尾段 entryDir ?? direction——
   * 转角尾格物品沿 entryDir 进入，后续转向判定（含 180° 折返禁止）以它为基准。
   */
  entryDirection: Direction;
  /** 仅 port 起点使用：来源设备。 */
  buildingHandle?: EntityHandle;
  /** 仅 port 起点使用：端口索引。 */
  portIndex?: number;
  /** 仅 tail 起点使用：断头段实体。 */
  segmentHandle?: EntityHandle;
}

/** 预览路径中的单个格子（含该格流向）。 */
interface PathCell extends GridCell {
  /** 该格的出方向（直段=流向；转角段=出口方向）。 */
  direction: Direction;
}

/** 预览半透明度。 */
const PREVIEW_ALPHA = 0.7;
/** 预览可放置颜色（蓝，与 BeltPreviewTintFilter VALID 一致）。 */
const COLOR_PREVIEW_VALID = 0x76bbea;
/** 预览不可放置颜色（红）。 */
const COLOR_PREVIEW_INVALID = 0xe45050;

/** chainId 计数器，避免纯时间戳冲突。 */
let chainCounter = 0;

/**
 * 传送带创建系统。
 *
 * 输入由 main.ts 转发:
 *   - toggleMode(): E 键切换进入/退出
 *   - setMouse(screenX, screenY, inside): 鼠标位置
 *   - onPointerDown(button): hover 态左键选起点，preview 态左键落盘一段并延伸；右键直接退出（不落盘）
 *   - update(dt): 主循环每帧调用，刷新高亮与预览
 */
export class BeltCreationSystem {
  private world: World;
  private occupancy: OccupancyMap;
  private camera: Camera;
  private layers: SceneLayers;

  /** 当前模式。 */
  private mode: BeltMode = 'idle';
  /** 已选中的起点（preview 态有效）。 */
  private startPoint: StartPoint | null = null;
  /** 已确认的中继锚点序列（含起点格）。 */
  private anchors: GridCell[] = [];
  /** 已落盘的真实传送带格子序列（不含 port 起点格；tail 起点时前缀含原尾格；点击一次落盘一段）。 */
  private fullPath: GridCell[] = [];
  /** 已落盘实体的 handle，按格子 key 索引（用于更新尾格方向/isTail）。 */
  private committedHandles = new Map<string, EntityHandle>();
  /** 已落盘段的 chainId（首次落盘时确定）。 */
  private committedChainId: string | null = null;
  /** 新段 segmentIndex 的接续基址（tail 起点首次落盘 = 原尾段 segmentIndex，port = 0）。 */
  private committedBaseIndex = 0;
  /** 当前 lastAnchor 的出方向——延长时作为 startingDirection（首次 = 起点方向）。 */
  private lastAnchorDirection: Direction = 0;
  /** 鼠标是否在 canvas 内。 */
  private mouseInside = false;
  /** 当前鼠标所在的格子。 */
  private mouseGrid: GridCell = { x: 0, y: 0 };

  /** 起点高亮 Graphics（挂 layer5Effect，在世界坐标绘制）。 */
  private highlightGraphics: Graphics;
  /** 预览路径 Graphics 容器（挂 layer2Building）。 */
  private previewContainer: Container;
  /**
   * 端口内半格残段预览容器（2026-09-02）: 预览确认对接时，在端口格内画半格带身
   * 预览。zIndex=0.5（带身 0 之上、物品 0.5 同层、设备 1 之下）→ 被设备纹理遮挡，
   * "钻入设备"观感——previewContainer 本体 zIndex 20000 在设备之上，故单独挂容器。
   */
  private previewStubContainer: Container;
  /** 当前预览路径（live，未提交）。 */
  private previewPath: PathCell[] = [];
  /** 当前预览是否可放置。 */
  private previewValid = false;
  /** T2.16 终点吸附: 最近一次 refreshPreview 的吸附决策（落盘时重放到末段方向）。 */
  private pendingSnap: DockSnap | null = null;
  /** T2.16 对接信息: 预览末格相邻的输入端口格（候选/确认），渲染层端口高亮用。 */
  private dockInfo: DockInfo | null = null;
  /**
   * 延长预览期间被隐藏的原尾格（带身+pointer 由渲染层按此跳过）。
   * tail 起点 trySelectStart 置位；首次落盘（形态定型）/退出时清空。
   * 该格由预览渲染接管（drawPreview 首格叠加），避免"旧带身+预览"双层叠印。
   */
  private hiddenTailCell: GridCell | null = null;

  constructor(
    world: World,
    occupancy: OccupancyMap,
    camera: Camera,
    layers: SceneLayers,
  ) {
    this.world = world;
    this.occupancy = occupancy;
    this.camera = camera;
    this.layers = layers;

    this.highlightGraphics = new Graphics({ label: 'beltHighlights' });
    this.highlightGraphics.visible = false;
    this.layers.layer5Effect.addChild(this.highlightGraphics);

    this.previewContainer = new Container({ label: 'beltPreview' });
    this.previewContainer.visible = false;
    this.previewContainer.zIndex = 20000;
    this.layers.layer2Building.addChild(this.previewContainer);

    this.previewStubContainer = new Container({ label: 'beltPreviewStubs' });
    this.previewStubContainer.visible = false;
    this.previewStubContainer.zIndex = 0.5; // 设备(1)之下——残段"钻入设备"
    this.layers.layer2Building.addChild(this.previewStubContainer);
  }

  // ───────────────────────── 模式控制 ─────────────────────────

  /** 切换创建模式。再按 E 直接退出（按文档 T2.0 入口规则：右键/ESC/E 退出，不落盘）。 */
  toggleMode(): void {
    if (this.mode === 'idle') {
      this.enterMode();
    } else {
      this.exitMode();
    }
  }

  /** 进入创建模式。 */
  enterMode(): void {
    this.mode = 'hover';
    this.startPoint = null;
    this.anchors = [];
    this.fullPath = [];
    this.committedHandles.clear();
    this.committedChainId = null;
    this.committedBaseIndex = 0;
    this.hiddenTailCell = null;
    this.lastAnchorDirection = 0;
    this.previewPath = [];
    this.previewValid = false;
    this.pendingSnap = null;
    this.dockInfo = null;
    this.highlightGraphics.visible = true;
    this.previewContainer.visible = false;
  }

  /** 退出创建模式（不落盘预览）。 */
  exitMode(): void {
    this.mode = 'idle';
    this.startPoint = null;
    this.anchors = [];
    this.fullPath = [];
    this.committedHandles.clear();
    this.committedChainId = null;
    this.committedBaseIndex = 0;
    this.hiddenTailCell = null;
    this.lastAnchorDirection = 0;
    this.previewPath = [];
    this.previewValid = false;
    this.pendingSnap = null;
    this.dockInfo = null;
    this.highlightGraphics.visible = false;
    this.highlightGraphics.clear();
    this.clearPreviewSprites();
    this.previewContainer.visible = false;
    this.previewStubContainer.visible = false;
  }

  /** 当前是否处于创建模式。 */
  isActive(): boolean {
    return this.mode !== 'idle';
  }

  /** 当前具体状态（调试用）。 */
  getMode(): BeltMode {
    return this.mode;
  }

  // ───────────────────────── 输入 ─────────────────────────

  /** 更新鼠标屏幕坐标。 */
  setMouse(screenX: number, screenY: number, inside: boolean): void {
    this.mouseInside = inside;
    if (inside) {
      const world = this.camera.screenToWorld(screenX, screenY);
      this.mouseGrid = worldToGrid(world.x, world.y);
      // 预览态下鼠标移动立即刷新路径，避免只依赖 update() 帧更新导致落盘时路径滞后
      if (this.mode === 'preview') {
        this.refreshPreview();
      }
    }
  }

  /**
   * 鼠标按下。
   * @param button 0=左键，2=右键
   */
  onPointerDown(_screenX: number, _screenY: number, button: number): void {
    if (this.mode === 'idle') return;

    // 右键：直接退出（按文档 T2.0 入口规则；不落盘当前预览段——落盘由左键 addWaypoint 负责）
    if (button === 2) {
      this.exitMode();
      return;
    }
    if (button !== 0) return;

    if (this.mode === 'hover') {
      this.trySelectStart();
    } else if (this.mode === 'preview') {
      this.addWaypoint();
    }
  }

  /** 键盘按下（main.ts 已直接处理 Escape/KeyE，这里保留兼容）。 */
  onKeyDown(code: string): void {
    if (this.mode === 'idle') return;
    if (code === 'Escape') {
      this.exitMode();
    }
  }

  // ───────────────────────── 主循环 ─────────────────────────

  /** 每帧调用：刷新高亮与预览。 */
  update(_deltaMS: number): void {
    if (this.mode === 'idle') return;
    if (!this.mouseInside) {
      // 鼠标离开 canvas 时隐藏预览，但保持模式
      this.previewContainer.visible = false;
      this.previewStubContainer.visible = false;
      this.drawHighlights(null);
      return;
    }

    this.drawHighlights(this.findHoveredStart());
  }

  /** 销毁临时显示对象。 */
  destroy(): void {
    this.highlightGraphics.removeFromParent();
    this.highlightGraphics.destroy();
    this.clearPreviewSprites();
    this.previewContainer.removeFromParent();
    this.previewContainer.destroy();
    this.previewStubContainer.removeFromParent();
    this.previewStubContainer.destroy();
  }

  // ───────────────────────── 内部：起点 ─────────────────────────

  /** 查找所有合法起点（设备输出端口 + 已有断头传送带末端）。 */
  private findStarts(): StartPoint[] {
    const starts: StartPoint[] = [];

    // 设备输出端口
    for (const handle of this.world.query('Position', 'BuildingComp')) {
      const building = this.world.getComponent<BuildingComp>(handle, 'BuildingComp')!;
      const def = getBuildingDefinition(building.definitionId);
      if (!def) continue;
      const pos = this.world.getComponent<Position>(handle, 'Position')!;
      const gx = Math.round(pos.x / CELL_SIZE);
      const gy = Math.round(pos.y / CELL_SIZE);

      for (let i = 0; i < def.ports.length; i++) {
        const port = def.ports[i];
        if (port.type !== 'output') continue;
        const abs = rotatePort(port, def.footprint, building.direction);
        const outward = rotateDirection(
          portOutwardBase(port, def.footprint),
          building.direction,
        );
        starts.push({
          kind: 'port',
          cell: { x: gx + abs.dx, y: gy + abs.dy },
          direction: outward,
          entryDirection: outward,
          buildingHandle: handle,
          portIndex: i,
        });
      }
    }

    // 已有断头传送带末端
    for (const handle of this.world.query('Position', 'BeltSegmentComp')) {
      const seg = this.world.getComponent<BeltSegmentComp>(handle, 'BeltSegmentComp')!;
      if (!seg.isTail) continue;
      const pos = this.world.getComponent<Position>(handle, 'Position')!;
      const gx = Math.round(pos.x / CELL_SIZE);
      const gy = Math.round(pos.y / CELL_SIZE);
      starts.push({
        kind: 'tail',
        cell: { x: gx, y: gy },
        direction: seg.direction,
        entryDirection: seg.entryDir ?? seg.direction,
        segmentHandle: handle,
      });
    }

    return starts;
  }

  /** 查找鼠标当前覆盖的起点。 */
  private findHoveredStart(): StartPoint | null {
    for (const s of this.findStarts()) {
      if (s.cell.x === this.mouseGrid.x && s.cell.y === this.mouseGrid.y) {
        return s;
      }
    }
    return null;
  }

  /** 返回当前悬停的输出端口格（创建模式下，供 PortHighlightRenderer 做悬停淡蓝高亮）。 */
  getHoveredPortCell(): { x: number; y: number } | null {
    if (this.mode === 'idle' || !this.mouseInside) return null;
    const hovered = this.findHoveredStart();
    if (hovered && hovered.kind === 'port') return hovered.cell;
    return null;
  }

  /**
   * 返回当前悬停的**任意**端口格（含输入口——仓库口 Status 面板高亮用，T2.12）。
   * 与 getHoveredPortCell 的差别: 后者只认合法起点（输出端口/断头末端），本方法
   * 扫全部设备的全部端口格——存货口这类"非起点但有对接意义"的设备也能获得悬停反馈。
   */
  getHoveredAnyPortCell(): { x: number; y: number } | null {
    if (this.mode === 'idle' || !this.mouseInside) return null;
    for (const handle of this.world.query('Position', 'BuildingComp')) {
      const building = this.world.getComponent<BuildingComp>(handle, 'BuildingComp');
      const pos = this.world.getComponent<Position>(handle, 'Position');
      if (!building || !pos) continue;
      const def = getBuildingDefinition(building.definitionId);
      if (!def) continue;
      const gx = Math.round(pos.x / CELL_SIZE);
      const gy = Math.round(pos.y / CELL_SIZE);
      for (const port of def.ports) {
        const abs = rotatePort(port, def.footprint, building.direction);
        if (gx + abs.dx === this.mouseGrid.x && gy + abs.dy === this.mouseGrid.y) {
          return { x: gx + abs.dx, y: gy + abs.dy };
        }
      }
    }
    return null;
  }

  /**
   * T2.16 终点对接信息: 预览末格相邻的输入端口格（targets=候选"够得着"，
   * confirmed=末段方向指向的端口格"将连接"）。预览无效/无末格时 null。
   * 消费方: RenderSystem → PortHighlightRenderer（输入端口候选紫/确认绿）。
   */
  getDockInfo(): DockInfo | null {
    return this.dockInfo;
  }

  /**
   * 延长预览期间被隐藏的原尾格（带身+pointer 渲染层按此跳过，预览接管该格）。
   * 消费方: main.ts → RenderSystem → BeltVectorRenderer / BeltPointerRenderer。
   * 仅 tail 起点首段预览期间非 null；首次落盘（形态定型）或退出创建模式即恢复显示。
   */
  getHiddenTailCell(): GridCell | null {
    return this.hiddenTailCell;
  }

  /**
   * T2.16 起点反例: hover 态鼠标悬停的**输入端口格**（不是合法起点——起点只认
   * 输出端口/断头末端）。消费方: PortHighlightRenderer（红色警示 + 文字提示
   * "输入端口不能作为起点"，替代此前的静默无效）。preview 态恒 null——
   * 预览中悬停输入端口是"终点对接"手势（见 getDockInfo），不是起点反例。
   */
  getStartHintCell(): { x: number; y: number } | null {
    if (this.mode !== 'hover' || !this.mouseInside) return null;
    const ports = collectInputPortCells(this.world);
    return ports.get(portKey(this.mouseGrid)) ?? null;
  }

  /** hover 态：尝试选中一个起点。 */
  private trySelectStart(): void {
    const hovered = this.findHoveredStart();
    if (!hovered) return;
    this.startPoint = hovered;
    this.mode = 'preview';
    this.anchors = [{ ...hovered.cell }];
    this.fullPath = [];
    this.committedHandles.clear();
    this.committedChainId = null;
    this.committedBaseIndex = 0;
    // tail 起点：原尾格登记为「已落盘前缀」首格——延长首段允许 90° 侧转时，
    // 转角落在原尾格上（直段→转角 / 转角→直段），方向/转角计算、落盘更新
    // （commitCells 旧尾格分支）、阻挡判定（不可穿回）全部走既有链路。
    // 同时隐藏原尾格实体（带身+pointer），该格视觉由预览渲染接管。
    if (hovered.kind === 'tail' && hovered.segmentHandle) {
      this.fullPath = [{ ...hovered.cell }];
      this.committedHandles.set(keyOf(hovered.cell), hovered.segmentHandle);
      this.hiddenTailCell = { ...hovered.cell };
    }
    this.lastAnchorDirection = hovered.direction;
    this.pendingSnap = null;
    this.dockInfo = null;
    this.previewContainer.visible = true;
    // 立即刷新一次预览
    this.refreshPreview();
  }

  // ───────────────────────── 内部：预览寻路 ─────────────────────────

  /**
   * 构造阻挡判定函数：
   *   - 当前已确认 fullPath 格（防新预览段与自身交叉）；但 lastAnchor 本身允许（它是新段起点）。
   *   - 被设备占用的格；仅 port 起点时豁免链首格（端口格本身已占用但合法），
   *     tail 起点**不豁免**——startCell 是原 chain 的尾段（已存在的传送带），
   *     新路径绝不能穿回它（否则会在原传送带格上创建重叠段，T2.0 重叠 bug 根因）。
   * 越界由 canPlace 在 checkPathValid 兜底（BFS 不主动越界，因为设备占用通常贴边）。
   */
  private makeIsBlocked(): IsBlocked {
    const fullPath = this.fullPath;
    const lastAnchor = this.anchors[this.anchors.length - 1];
    const startCell = this.anchors[0];
    const occupancy = this.occupancy;
    // tail 延长时 startCell 是已存在传送带，必须阻挡；port 起点时 startCell 是端口格，可豁免
    const isPortStart = this.startPoint?.kind === 'port';
    const isStartCellAllowed = (cell: GridCell): boolean =>
      isPortStart && cell.x === startCell.x && cell.y === startCell.y;
    return (cell: GridCell): boolean => {
      // lastAnchor 是新预览段的起点，允许（它可能在 fullPath 末尾）
      if (cell.x === lastAnchor.x && cell.y === lastAnchor.y) return false;
      // 已确认路径上的格阻挡（防止自交）
      for (const c of fullPath) {
        if (c.x === cell.x && c.y === cell.y) {
          if (isStartCellAllowed(cell)) return false;
          return true;
        }
      }
      // 设备占用格阻挡（tail 起点不豁免，防穿回原 chain）
      if (occupancy.isOccupied(cell.x, cell.y)) {
        if (isStartCellAllowed(cell)) return false;
        return true;
      }
      return false;
    };
  }

  /** 刷新预览路径与预览 Sprite。 */
  private refreshPreview(): void {
    if (!this.startPoint || this.anchors.length === 0) {
      this.previewPath = [];
      this.previewValid = false;
      this.clearPreviewSprites();
      this.previewContainer.visible = false;
      return;
    }

    const lastAnchor = this.anchors[this.anchors.length - 1];
    const startingDirection = this.lastAnchorDirection;

    // ── 端口重定向（2026-09-02）──
    // mouse 在输入端口格上 → 寻路目标改为该端口的朝向侧供给格 + 吸附末段指向端口:
    // 从任意方向（含侧方横穿，如从设备右侧拖到端口上）都自动找最近路径经供给格接入，
    // 末段拐向端口（侧方进入=90°转角，下方进入=直段）——不再因侧向无法进入而恒红。
    // 吸附决策存 pendingSnap，末格方向覆盖在 cells 上重放（预览/落盘同源）。
    const ports = collectInputPortCells(this.world);
    const dock = dockRedirect(this.mouseGrid, ports);
    const pathTarget = dock?.target ?? this.mouseGrid;
    this.pendingSnap = dock?.snap ?? null;

    // verticalFirst 看 lastAnchor → pathTarget 位移(而非 anchors 历史),保证 L 形两腿与真实目标对齐
    const verticalFirst = Math.abs(pathTarget.y - lastAnchor.y) > Math.abs(pathTarget.x - lastAnchor.x);

    // 首段方向约束:
    // - port 起点 / 后续延长段: 强制首步 = 起点方向 / 上一落盘段出方向(动量延续,禁止逆流)
    // - tail 起点首段: 不强制首步——直接朝拖拽方向起步,允许在原尾格上 90° 侧转
    //   (原尾格直段→转角 / 转角→直段,见 commitCells);仅禁止逆着原尾段进入方向折返
    //   (180° U 形不是合法带型,与 BeltDockOps 吸附折返判定同一约束)
    const isTailFirstSegment = this.startPoint.kind === 'tail' && this.anchors.length === 1;
    const options: FindPathOptions = isTailFirstSegment
      ? { verticalFirst, allowedDirections: tailFirstStepDirs(this.startPoint.entryDirection) }
      : { verticalFirst, startingDirection };

    const isBlocked = this.makeIsBlocked();
    let raw = findPath(lastAnchor, pathTarget, isBlocked, options);

    if (!raw || raw.length < 1) {
      // BFS 找不到路(终点被完全包围或不可达):退化为动量 L 形"理想路径",整条染红提示
      // 用户能看到一条"如果能放置会走这条"的预览,而非消失成单格红块
      // (tail 首段同样不强制首步;逆折返的首步由 checkPathValid 兜底染红)
      raw = calculateMomentumPath(
        lastAnchor,
        pathTarget,
        isTailFirstSegment ? { verticalFirst } : { verticalFirst, startingDirection },
      );
      if (!raw || raw.length < 1) raw = [lastAnchor, pathTarget];
    }

    // 拼上已确认路径，用于跨段转角检测（confirmed + preview）。
    // 注意：raw[0] 是寻路起点格 —— 第一段时是端口/断头起点格（不应渲染成传送带），
    // 后续段时是 lastAnchor（已含在 fullPath 末尾），两种情况都要剔除首格。
    // tail 起点时 fullPath 前缀已含原尾格（trySelectStart 登记），combined[0] 即原尾格，
    // 其转角/直化信息随新段首步方向一并算出。
    const combined =
      this.fullPath.length > 0
        ? [...this.fullPath, ...raw.slice(1)]
        : raw.slice(1);
    const cells = computePathCells(combined, this.startPoint.entryDirection);
    applySnapToCells(cells, this.pendingSnap);
    this.previewPath = cells;
    // checkPathValid 不再依赖 isFirstSegment：起点格(startCell)和锚点格(lastAnchor)都跳过
    this.previewValid = this.checkPathValid(raw, lastAnchor);
    // T2.16 对接信息: 预览有效且有末格时提供（红色预览不亮端口，避免误导"能接上"）
    this.dockInfo = this.previewValid && cells.length > 0
      ? dockInfoOf(cells[cells.length - 1], cells[cells.length - 1].direction, ports)
      : null;
    this.drawPreview();
  }

  /**
   * 检查预览段（raw，相对本次锚点）是否全部可放置。
   * - raw[0] 是本次预览段起点（lastAnchor），跳过。
   * - tail 起点首段：首步朝原尾段上游折返（180° U 形）判非法。
   * - 起点格（anchors[0]，即原 chain 的尾段 / 设备端口格）出现在 raw[1:] 中即判非法：
   *   路径绕回起点会在原 chain / 建筑端口格上创建重叠段（T2.0 重叠 bug 根因）。
   *   BFS 即使把 startCell 当终点也会返回该路径（终点豁免占用），所以这里必须拒绝。
   */
  private checkPathValid(raw: GridCell[], lastAnchor: GridCell): boolean {
    const startCell = this.anchors[0];
    // tail 起点首段：首步逆着原尾段进入方向（朝上游 180° 折返）→ 非法。
    // findPath 的动量/BFS 分支已按 allowedDirections 拦截，但 BFS 失败后的
    // 动量 fallback 理想路径不经过该校验，这里统一兜底。
    if (this.startPoint?.kind === 'tail' && this.anchors.length === 1 && raw.length >= 2) {
      const firstStep = directionBetween(raw[0], raw[1]);
      if (firstStep !== null && firstStep === oppositeDir(this.startPoint.entryDirection)) {
        return false;
      }
    }
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      // raw[0] 永远是起点格（端口/锚点），不检查
      if (i === 0) continue;
      // 起点格出现在非首格位置 → 路径绕回起点会与原 chain / 端口格重叠，判非法
      if (c.x === startCell.x && c.y === startCell.y) return false;
      if (c.x === lastAnchor.x && c.y === lastAnchor.y) continue;
      if (!this.occupancy.canPlace(c.x, c.y, 1, 1)) return false;
    }
    return true;
  }

  // ───────────────────────── 内部：多锚点交互 ─────────────────────────

  /**
   * preview 态左键：把当前预览段**立即落盘**为真实传送带实体（已创建样式，黄色带身+pointer）。
   * 点击一次 = 创建一段；落盘后以该段末端为新的寻路起点继续预览。
   * 若当前预览无效则忽略（不创建坏段）。
   */
  private addWaypoint(): void {
    if (!this.startPoint || !this.previewValid) return;
    // 取预览路径中尚未落盘的部分（previewPath 是 combined：已落盘 fullPath + 新预览段）
    const confirmedLen = this.fullPath.length;
    const newCells = this.previewPath.slice(confirmedLen);
    if (newCells.length === 0) {
      // 无新段（鼠标停在锚点格/端口重定向后目标=锚点）。端口吸附指向锚点格时
      // （尾格已在供给格、方向不对），落盘"尾段转向"——把已落盘尾段更新为指向端口
      this.commitTailResnap();
      return;
    }
    // 立即落盘新段
    this.commitCells(newCells);
    // 记录锚点（实际路径末端格，而非 mouseGrid；L 形路径末端可能因 verticalFirst 与鼠标格不同）
    const lastNewCell = newCells[newCells.length - 1];
    this.anchors.push({ x: lastNewCell.x, y: lastNewCell.y });
    // 更新 lastAnchorDirection 为新 tail 的出方向，延长时 refreshPreview 用作 startingDirection
    this.lastAnchorDirection = lastNewCell.direction;
    // 立即基于新锚点刷新预览（从已落盘尾端继续延伸）
    this.refreshPreview();
  }

  /**
   * 零新段时的"尾段转向"落盘（端口重定向补全，2026-09-02）:
   * 尾段已在端口朝向侧供给格、但方向未指向端口（如横着路过停在供给格）时，
   * 点击端口格 → 把已落盘尾段更新为指向端口（直段↔转角互转），即刻对接。
   * 无吸附/吸附不指向锚点格/锚点无实体时为无操作（同旧"鼠标在锚点上忽略"）。
   */
  private commitTailResnap(): void {
    const snap = this.pendingSnap;
    const lastAnchor = this.anchors[this.anchors.length - 1];
    if (!snap || snap.cell.x !== lastAnchor.x || snap.cell.y !== lastAnchor.y) return;
    const handle = this.committedHandles.get(keyOf(lastAnchor));
    if (!handle) return;
    const seg = this.world.getComponent<BeltSegmentComp>(handle, 'BeltSegmentComp');
    if (!seg) return;
    const info = turnInfoFromDirections(seg.entryDir ?? seg.direction, snap.dir);
    this.updateSegment(handle, info, true); // 该格仍是链尾
    // 后续延长从新方向继续
    this.lastAnchorDirection = snap.dir;
    this.refreshPreview();
  }

  /**
   * 把 newCells 落盘为真实传送带实体。
   * - 首次落盘时确定 chainId（tail 起点继承原 chainId，port 起点新建）。
   * - 用「已落盘 fullPath + 新段」完整序列计算方向/转角信息，保证跨段转角正确。
   * - 已落盘的旧尾格可能因新段而变成转角（如直带末端转弯），需要重算并更新其组件。
   * - 新段末端标记 isTail（可继续延长）。
   */
  private commitCells(newCells: GridCell[]): void {
    if (!this.startPoint || newCells.length === 0) return;

    // 首次落盘时确定 chainId
    if (!this.committedChainId) {
      if (this.startPoint.kind === 'tail' && this.startPoint.segmentHandle) {
        const seg = this.world.getComponent<BeltSegmentComp>(this.startPoint.segmentHandle, 'BeltSegmentComp');
        this.committedChainId = seg?.chainId ?? `chain-${Date.now()}-${++chainCounter}`;
        // 延长后原 tail 不再是末端；新段 segmentIndex 接在原尾段之后连续递增
        // （SelectionSystem 链内排序、BeltPointerRenderer v11 领头相位都按
        // segmentIndex = 链内连续位置假设，从 0 重排会在延长链上错位）
        if (seg) {
          this.committedBaseIndex = seg.segmentIndex;
          this.world.addComponent(this.startPoint.segmentHandle, 'BeltSegmentComp', { ...seg, isTail: false });
        }
        // 原尾格形态已随本次落盘定型（直↔转互转在下方旧尾格分支生效），恢复显示
        this.hiddenTailCell = null;
      } else {
        this.committedChainId = `chain-${Date.now()}-${++chainCounter}`;
      }
    }

    // 链首格继承的进入方向（来自源端）。与旧项目 ConveyorBelt.incomingDirection 对应。
    const chainIncoming: Direction = this.startPoint.entryDirection;

    // 完整序列（已落盘 + 新段）计算每格方向 + 转角信息
    const full = [...this.fullPath, ...newCells];
    const cells = computePathCells(full, chainIncoming);
    // T2.16: 重放吸附决策到末段方向（computePathCells 默认尾向"沿用上一格方向"会覆盖掉
    // 预览时的吸附方向；lastNewCell.direction 只影响后续延长，落盘段组件以此为准）
    applySnapToCells(cells, this.pendingSnap);
    const infos = computeTurnInfos(cells, chainIncoming);

    // 更新已落盘的旧尾格（可能从直段变成转角段，方向/isCorner/entryDir/mirrorH 需要重算）。
    // tail 起点时 fullPath 前缀首格 = 原尾段，首段 90° 侧转的转角/直化在此生效。
    if (this.fullPath.length > 0) {
      const prevTailIdx = this.fullPath.length - 1;
      const prevTailCell = cells[prevTailIdx];
      const handle = this.committedHandles.get(keyOf(prevTailCell));
      if (handle) {
        this.updateSegment(handle, infos[prevTailIdx], false);
      }
    }

    // 创建新段实体（从 fullPath 末尾之后开始）
    for (let i = this.fullPath.length; i < cells.length; i++) {
      const isTail = i === cells.length - 1;
      const handle = this.createSegment(
        cells[i].x,
        cells[i].y,
        infos[i],
        this.committedChainId!,
        this.committedBaseIndex + i, // segmentIndex: 链内连续序号（tail 延长接续原尾段）
        isTail,
        i === 0 ? chainIncoming : undefined,
      );
      this.committedHandles.set(keyOf(cells[i]), handle);
    }

    // 更新已落盘序列
    this.fullPath.push(...newCells);
  }

  /** 更新已落盘实体的段组件（方向/转角/镜像/isTail）。 */
  private updateSegment(handle: EntityHandle, info: CellTurnInfo, isTail: boolean): void {
    const seg = this.world.getComponent<BeltSegmentComp>(handle, 'BeltSegmentComp');
    if (!seg) return;
    this.world.addComponent(handle, 'BeltSegmentComp', {
      ...seg,
      direction: info.outgoingDir,
      isCorner: info.isTurn,
      entryDir: info.isTurn ? info.incomingDir : undefined,
      mirrorH: info.isTurn ? info.isCCW : undefined,
      isTail,
    });
    // 带身已由 BeltVectorRenderer 矢量渲染（不再依赖 SpriteComp 纹理），
    // 保留 SpriteComp 仅作占位（其他系统如占用表可能读取）；textureKey 无需再切换。
    const spr = this.world.getComponent<import('../components/SpriteComp').SpriteComp>(handle, 'SpriteComp');
    if (spr) {
      const newKey = info.isTurn ? 'belt_corner' : 'transport_belt';
      if (spr.textureKey !== newKey) {
        this.world.addComponent(handle, 'SpriteComp', { ...spr, textureKey: newKey });
      }
    }
  }

  /** 创建一个传送带段实体。返回 handle 供后续更新用。 */
  private createSegment(
    gx: number,
    gy: number,
    info: CellTurnInfo,
    chainId: string,
    segmentIndex: number,
    isTail: boolean,
    incomingDirection: Direction | undefined,
  ): EntityHandle {
    const handle = this.world.createEntity();
    this.world.addComponent(handle, 'Position', {
      x: gx * CELL_SIZE,
      y: gy * CELL_SIZE,
    });
    this.world.addComponent(handle, 'SpriteComp', {
      group: 'devices',
      textureKey: info.isTurn ? 'belt_corner' : 'transport_belt',
      width: CELL_SIZE,
      height: CELL_SIZE,
      layer: 2,
    });
    this.world.addComponent(handle, 'BeltSegmentComp', {
      chainId,
      direction: info.outgoingDir,
      isCorner: info.isTurn,
      entryDir: info.isTurn ? info.incomingDir : undefined,
      mirrorH: info.isTurn ? info.isCCW : undefined,
      isTail,
      incomingDirection,
      segmentIndex,
      phaseOffset: Math.random(),
      items: [], // T2.1: 物品队列初始为空，由 BeltSystem 推进 progress
      blocked: false,
    });
    this.occupancy.occupy(gx, gy, 'transport_belt');
    return handle;
  }

  // ───────────────────────── 内部：高亮与预览绘制 ─────────────────────────

  /** 绘制起点高亮（已重构：port 起点 → PortHighlightRenderer 蓝面板；tail 起点 → BeltVectorRenderer 黄→蓝渐变）。 */
  private drawHighlights(_hovered: StartPoint | null): void {
    // 整格半透明占位已移除，这里仅清空旧 Graphics（保留容器供未来使用）。
    this.highlightGraphics.clear();
  }

  /**
   * 绘制预览路径（只画尚未落盘的部分；已落盘段由真实实体渲染）。
   * - previewPath 非空 → 整条按 previewValid 染色(蓝/红),含转角渲染
   * - previewPath 为空 + previewValid=false → 鼠标格单格红块(BFS 无路径)
   * - tail 首段预览期间原尾格被隐藏（hiddenTailCell），该格由预览接管渲染
   */
  private drawPreview(): void {
    this.clearPreviewSprites();
    const startIdx = this.fullPath.length;
    // tail 起点首段预览期间：原尾格实体被隐藏（getHiddenTailCell），该格由预览
    // 接管渲染（含 90° 侧转的直↔转形态变化）；首次落盘后（anchors>1）不再接管，
    // 原尾格以落盘定型的新形态恢复显示。
    const headPreviewIdx =
      this.startPoint?.kind === 'tail' && this.anchors.length === 1 && startIdx > 0 ? 0 : -1;

    if (this.previewPath.length <= startIdx && headPreviewIdx < 0) {
      // 预览路径为空: 仅在预览无效时,在鼠标当前格画单格红块提示"此处不可达"(BFS 失败)
      if (!this.previewValid && this.mode === 'preview' && this.mouseInside) {
        this.drawInvalidMarker();
      }
      return;
    }

    // 预览路径非空: 整条按 previewValid 染色(蓝/红),含转角正确渲染
    // 方案A：用矢量 Graphics 绘制（与落盘带身同构），缩小 zoom 无缝无接缝。
    const previewColor = this.previewValid ? COLOR_PREVIEW_VALID : COLOR_PREVIEW_INVALID;
    const startDir = this.startPoint!.entryDirection;
    const infos = computeTurnInfos(this.previewPath, startDir);

    // 原尾格的渲染形态: 有新段时用推导 info（含 90° 侧转的直↔转互转）；
    // 无新段（鼠标停在尾格上）时用已落盘实体的当前形态——单格序列的推导 info
    // 会退化成 entry 方向直段，转角尾格会画错形状。端口吸附指向尾格时（尾格已在
    // 供给格、鼠标点在端口上）以吸附方向为出方向——预览"这一格将拐向端口"。
    let headInfo = infos[0];
    if (headPreviewIdx === 0 && this.previewPath.length <= startIdx) {
      const handle = this.committedHandles.get(keyOf(this.previewPath[0]));
      const seg = handle
        ? this.world.getComponent<BeltSegmentComp>(handle, 'BeltSegmentComp')
        : undefined;
      if (seg) {
        const snap = this.pendingSnap;
        const snapped =
          snap !== null && snap.cell.x === this.previewPath[0].x && snap.cell.y === this.previewPath[0].y;
        headInfo = turnInfoFromDirections(
          seg.entryDir ?? seg.direction,
          snapped ? snap!.dir : seg.direction,
        );
      }
    }

    for (let i = 0; i < this.previewPath.length; i++) {
      if (i !== headPreviewIdx && i < startIdx) continue; // 已落盘格（原尾格除外）不渲染
      const cell = this.previewPath[i];
      const info = i === headPreviewIdx ? headInfo : infos[i];
      const g = new Graphics();
      g.position.set(cell.x * CELL_SIZE + CELL_SIZE / 2, cell.y * CELL_SIZE + CELL_SIZE / 2);
      g.alpha = PREVIEW_ALPHA;

      if (info.isTurn) {
        const t = beltCornerTransform(info.incomingDir, info.outgoingDir);
        g.rotation = t.rotation;
        g.scale.set(t.mirrorH ? -1 : 1, 1);
        drawCornerBelt(g, CELL_SIZE, { shellColor: previewColor, beltColor: previewColor });
      } else {
        g.rotation = beltTextureRotation(info.outgoingDir);
        drawStraightBelt(g, CELL_SIZE, { shellColor: previewColor, beltColor: previewColor });
      }

      this.previewContainer.addChild(g);
    }

    this.previewContainer.visible = true;

    // 端口内半格残段预览（2026-09-02）: 确认对接（绿）时，末段在端口格内的半格
    // 延伸先于落盘可见。挂 previewStubContainer（zIndex 0.5，设备之下）——被设备
    // 纹理遮挡的"钻入设备"观感与落盘后 BeltVectorRenderer 的残段一致。
    if (this.dockInfo !== null && this.dockInfo.confirmed.length > 0) {
      const last = this.previewPath[this.previewPath.length - 1];
      const dv = directionVector(last.direction);
      const stub = new Graphics();
      stub.position.set(
        (last.x + dv.x) * CELL_SIZE + CELL_SIZE / 2,
        (last.y + dv.y) * CELL_SIZE + CELL_SIZE / 2,
      );
      stub.alpha = PREVIEW_ALPHA;
      stub.rotation = beltTextureRotation(last.direction);
      // 水平方向镜像修正（T2.20，与 BeltVectorRenderer 同律）: ±π/2 旋转会把本地
      // "上/下半格"转到流动背侧（设备内侧=穿模），取反使残段恒落在靠段一侧
      const horizontal = last.direction === 0 || last.direction === 180;
      drawStraightBeltStub(stub, CELL_SIZE, { shellColor: previewColor, beltColor: previewColor }, horizontal);
      this.previewStubContainer.addChild(stub);
      this.previewStubContainer.visible = true;
    }

    // 输出口的半格残段预览（2026-09-02 补全）: port 起点首段（尚未落盘任何格）时，
    // 起点端口格内的**出口侧**半格——物品将从端口格中心冒出，带身从设备下方接出。
    // 首段落盘后由 BeltVectorRenderer 的已落盘残段接管（判定：接收段入口朝向 =
    // 端口朝外方向），预览不再重复画。
    const srcPort = this.startPoint;
    if (
      srcPort !== null &&
      srcPort.kind === 'port' &&
      this.fullPath.length === 0 &&
      this.previewPath.length > 0
    ) {
      const stub = new Graphics();
      stub.position.set(
        srcPort.cell.x * CELL_SIZE + CELL_SIZE / 2,
        srcPort.cell.y * CELL_SIZE + CELL_SIZE / 2,
      );
      stub.alpha = PREVIEW_ALPHA;
      stub.rotation = beltTextureRotation(srcPort.direction);
      // 水平方向镜像修正（T2.20，同上）: 竖直出口侧天然正确，水平取反
      const horizontal = srcPort.direction === 0 || srcPort.direction === 180;
      drawStraightBeltStub(stub, CELL_SIZE, { shellColor: previewColor, beltColor: previewColor }, horizontal ? false : true);
      this.previewStubContainer.addChild(stub);
      this.previewStubContainer.visible = true;
    }
  }

  /** 在鼠标当前格渲染单格红色警示块(BFS 无路径时提示"此处不可达")。 */
  private drawInvalidMarker(): void {
    const gx = this.mouseGrid.x;
    const gy = this.mouseGrid.y;
    const g = new Graphics();
    g.position.set(gx * CELL_SIZE + CELL_SIZE / 2, gy * CELL_SIZE + CELL_SIZE / 2);
    g.alpha = PREVIEW_ALPHA;
    drawStraightBelt(g, CELL_SIZE, { shellColor: COLOR_PREVIEW_INVALID, beltColor: COLOR_PREVIEW_INVALID });
    this.previewContainer.addChild(g);
    this.previewContainer.visible = true;
  }

  /** 清空预览 Sprite。注意不能边遍历边移除（for...of 遍历 live 数组时 removeFromParent 会
   *  改变数组长度，导致跳过元素、残留旧 Sprite），先快照再清。 */
  private clearPreviewSprites(): void {
    const children = this.previewContainer.children.slice();
    for (const child of children) {
      child.removeFromParent();
      child.destroy();
    }
    const stubs = this.previewStubContainer.children.slice();
    for (const child of stubs) {
      child.removeFromParent();
      child.destroy();
    }
    this.previewStubContainer.visible = false;
  }
}

// ───────────────────────── 坐标 / 方向工具 ─────────────────────────

/** 世界像素 → 格子坐标（向下取整）。 */
function worldToGrid(wx: number, wy: number): GridCell {
  return { x: Math.floor(wx / CELL_SIZE), y: Math.floor(wy / CELL_SIZE) };
}

/**
 * 由完整路径格子序列计算每格的 PathCell（含出方向）。
 * direction = 该格的出方向：非尾格看下游格位移；尾格沿用上一段方向。
 * @param startDir 链首格继承的进入方向（来自源端），仅用于首格 incoming 判断。
 */
function computePathCells(path: GridCell[], _startDir: Direction): PathCell[] {
  const cells: PathCell[] = [];
  for (let i = 0; i < path.length; i++) {
    let dir: Direction;
    if (i < path.length - 1) {
      // 非尾格：看出方向（指向下游）
      dir = offsetToDir(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y);
    } else if (i > 0) {
      // 尾格：沿用上一格方向（直线延伸）
      dir = offsetToDir(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    } else {
      // 单格链：用继承方向
      dir = _startDir;
    }
    cells.push({ x: path[i].x, y: path[i].y, direction: dir });
  }
  return cells;
}

/** 由位移(dx,dy)推断方向。 */
function offsetToDir(dx: number, dy: number): Direction {
  if (dx > 0) return 0;
  if (dx < 0) return 180;
  if (dy > 0) return 90;
  return 270;
}

/** 相反方向（180° 折返判定用，与 BeltDockOps.opposite 同一约定）。 */
function oppositeDir(dir: Direction): Direction {
  return ((dir + 180) % 360) as Direction;
}

/**
 * tail 起点首段允许的首步方向集合：同向 + 两个 90° 侧转，
 * 排除逆着原尾段进入方向的上游折返（180° U 形不是合法带型）。
 */
function tailFirstStepDirs(entryDirection: Direction): Direction[] {
  const reverse = oppositeDir(entryDirection);
  return ([0, 90, 180, 270] as Direction[]).filter((d) => d !== reverse);
}

/**
 * 由 PathCell 序列计算每格的 CellTurnInfo（用于预览/落盘渲染）。
 * - 首格 incoming = startDir（链首继承的进入方向）。
 * - 其余格 incoming = 上一格的出方向。
 * - 每格 outgoing = 自身的出方向。
 */
function computeTurnInfos(cells: PathCell[], startDir: Direction): CellTurnInfo[] {
  const infos: CellTurnInfo[] = [];
  for (let i = 0; i < cells.length; i++) {
    const incomingDir = i === 0 ? startDir : cells[i - 1].direction;
    const outgoingDir = cells[i].direction;
    infos.push(turnInfoFromDirections(incomingDir, outgoingDir));
  }
  return infos;
}
