// 传送带创建系统 — T2.0 阶段1：基础创建与预览（重构版）
// 依据: implementation-phase-2.md T2.0、A9 §6 (传送带创建与编辑系统)
// 移植参考: 旧 Flutter 项目 transport_belt.dart（多锚点交互）+ belt_direction_utils.dart（双层寻路）
//
// 职责:
//   - 维护"传送带创建模式"状态机（idle ↔ hover ↔ preview）
//   - 按 E 进入/退出；右键 / ESC / 再按 E 退出（右键/ESC 在 preview 态先落盘再退出）
//   - hover 态高亮设备输出端口与已有断头传送带末端
//   - 点击起点 → 移动鼠标显示蓝色预览路径（动量L形 + BFS绕障）
//   - 多锚点：preview 态左键把当前鼠标格作为中继锚点继续延伸折线
//   - 右键 / ESC 落盘整条链为真实传送带段
//
// 创建模式下普通设备选中逻辑由 main.ts 暂停转发，避免冲突。

import { Container, Graphics } from 'pixi.js';
import type { World, EntityHandle } from '../ECS';
import type { Camera } from '../render/Camera';
import type { SceneLayers } from '../render/SceneRenderer';
import type { OccupancyMap } from '../world/OccupancyMap';
import type { Port } from '../data/buildings';
import { getBuildingDefinition } from '../data/buildings';
import type { BuildingComp, Direction } from '../components/BuildingComp';
import type { Position } from '../components/Position';
import type { BeltSegmentComp } from '../components/BeltSegmentComp';
import { CELL_SIZE } from '../render/constants';
import { drawStraightBelt, drawCornerBelt } from '../render/BeltVectorGeometry';
import {
  beltCornerTransform,
  beltTextureRotation,
  turnInfoFromDirections,
  type CellTurnInfo,
} from './belt/BeltPathGeometry';
import {
  findPath,
  calculateMomentumPath,
  keyOf,
  type GridCell,
  type IsBlocked,
  type FindPathOptions,
} from './belt/BeltPathfinding';

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

/** 起点高亮颜色。 */
const COLOR_START = 0x76bbea;
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
 *   - onPointerDown(button): 左键确认/选择起点/添加中继锚点，右键落盘+退出
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
  /** 已落盘的真实传送带格子序列（不含起点格；点击一次落盘一段）。 */
  private fullPath: GridCell[] = [];
  /** 已落盘实体的 handle，按格子 key 索引（用于更新尾格方向/isTail）。 */
  private committedHandles = new Map<string, EntityHandle>();
  /** 已落盘段的 chainId（首次落盘时确定）。 */
  private committedChainId: string | null = null;
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
  /** 当前预览路径（live，未提交）。 */
  private previewPath: PathCell[] = [];
  /** 当前预览是否可放置。 */
  private previewValid = false;

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
    this.lastAnchorDirection = 0;
    this.previewPath = [];
    this.previewValid = false;
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
    this.lastAnchorDirection = 0;
    this.previewPath = [];
    this.previewValid = false;
    this.highlightGraphics.visible = false;
    this.highlightGraphics.clear();
    this.clearPreviewSprites();
    this.previewContainer.visible = false;
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
    this.lastAnchorDirection = hovered.direction;
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
    // 强制首步方向：首次 = 起点方向；延长 = 上次落盘尾段的出方向（禁止逆流延长，文档 T2.0 方向约束）
    const startingDirection = this.lastAnchorDirection;
    // verticalFirst 看 lastAnchor → mouseGrid 位移(而非 anchors 历史),保证 firstStep 后水平/竖直腿与目标对齐
    const verticalFirst = Math.abs(this.mouseGrid.y - lastAnchor.y) > Math.abs(this.mouseGrid.x - lastAnchor.x);

    const options: FindPathOptions = {
      verticalFirst,
      startingDirection,
    };

    const isBlocked = this.makeIsBlocked();
    let raw = findPath(lastAnchor, this.mouseGrid, isBlocked, options);

    if (!raw || raw.length < 1) {
      // BFS 找不到路(终点被完全包围或不可达):退化为动量 L 形"理想路径",整条染红提示
      // 用户能看到一条"如果能放置会走这条"的预览,而非消失成单格红块
      raw = calculateMomentumPath(lastAnchor, this.mouseGrid, {
        verticalFirst,
        startingDirection,
      });
      if (!raw || raw.length < 1) raw = [lastAnchor, this.mouseGrid];
    }

    // 拼上已确认路径，用于跨段转角检测（confirmed + preview）。
    // 注意：raw[0] 是寻路起点格 —— 第一段时是端口/断头起点格（不应渲染成传送带），
    // 后续段时是 lastAnchor（已含在 fullPath 末尾），两种情况都要剔除首格。
    const combined =
      this.fullPath.length > 0
        ? [...this.fullPath, ...raw.slice(1)]
        : raw.slice(1);
    const cells = computePathCells(combined, this.startPoint.direction);
    this.previewPath = cells;
    // checkPathValid 不再依赖 isFirstSegment：起点格(startCell)和锚点格(lastAnchor)都跳过
    this.previewValid = this.checkPathValid(raw, lastAnchor);
    this.drawPreview();
  }

  /**
   * 检查预览段（raw，相对本次锚点）是否全部可放置。
   * - raw[0] 是本次预览段起点（lastAnchor），跳过。
   * - 起点格（anchors[0]，即原 chain 的尾段 / 设备端口格）出现在 raw[1:] 中即判非法：
   *   路径绕回起点会在原 chain / 建筑端口格上创建重叠段（T2.0 重叠 bug 根因）。
   *   BFS 即使把 startCell 当终点也会返回该路径（终点豁免占用），所以这里必须拒绝。
   */
  private checkPathValid(raw: GridCell[], lastAnchor: GridCell): boolean {
    const startCell = this.anchors[0];
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
      // 鼠标就在 lastAnchor 上：无新段，忽略
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
        // 延长后原 tail 不再是末端
        if (seg) {
          this.world.addComponent(this.startPoint.segmentHandle, 'BeltSegmentComp', { ...seg, isTail: false });
        }
      } else {
        this.committedChainId = `chain-${Date.now()}-${++chainCounter}`;
      }
    }

    // 链首格继承的进入方向（来自源端）。与旧项目 ConveyorBelt.incomingDirection 对应。
    const chainIncoming: Direction = this.startPoint.direction;

    // 完整序列（已落盘 + 新段）计算每格方向 + 转角信息
    const full = [...this.fullPath, ...newCells];
    const cells = computePathCells(full, chainIncoming);
    const infos = computeTurnInfos(cells, chainIncoming);

    // 更新已落盘的旧尾格（可能从直段变成转角段，方向/isCorner/entryDir/mirrorH 需要重算）
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
        i, // segmentIndex: 链内序号（0=链首）
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
    });
    this.occupancy.occupy(gx, gy, 'transport_belt');
    return handle;
  }

  // ───────────────────────── 内部：高亮与预览绘制 ─────────────────────────

  /** 绘制起点高亮。 */
  private drawHighlights(hovered: StartPoint | null): void {
    const g = this.highlightGraphics;
    g.clear();

    // 预览路径上的起点高亮会盖住蓝色预览，产生灰白叠层，故跳过
    const skipCells = new Set<string>();
    for (const c of this.previewPath) {
      skipCells.add(`${c.x},${c.y}`);
    }
    // preview 态也跳过已确认 fullPath 上的格
    for (const c of this.fullPath) {
      skipCells.add(`${c.x},${c.y}`);
    }

    // 仅 hover 态显示所有起点高亮；preview 态只显示当前起点
    const showAll = this.mode === 'hover';
    const starts = showAll ? this.findStarts() : (this.startPoint ? [this.startPoint] : []);

    for (const s of starts) {
      if (skipCells.has(`${s.cell.x},${s.cell.y}`)) continue;
      const isHovered = hovered !== null && s.cell.x === hovered.cell.x && s.cell.y === hovered.cell.y;
      const alpha = isHovered ? 0.45 : 0.22;
      const x = s.cell.x * CELL_SIZE;
      const y = s.cell.y * CELL_SIZE;
      g.rect(x, y, CELL_SIZE, CELL_SIZE)
        .fill({ color: COLOR_START, alpha })
        .stroke({ width: 2, color: COLOR_START, alpha: alpha + 0.15 });
    }
  }

  /**
   * 绘制预览路径（只画尚未落盘的部分；已落盘段由真实实体渲染）。
   * - previewPath 非空 → 整条按 previewValid 染色(蓝/红),含转角渲染
   * - previewPath 为空 + previewValid=false → 鼠标格单格红块(BFS 无路径)
   */
  private drawPreview(): void {
    this.clearPreviewSprites();
    const startIdx = this.fullPath.length;

    if (this.previewPath.length <= startIdx) {
      // 预览路径为空: 仅在预览无效时,在鼠标当前格画单格红块提示"此处不可达"(BFS 失败)
      if (!this.previewValid && this.mode === 'preview' && this.mouseInside) {
        this.drawInvalidMarker();
      }
      return;
    }

    // 预览路径非空: 整条按 previewValid 染色(蓝/红),含转角正确渲染
    // 方案A：用矢量 Graphics 绘制（与落盘带身同构），缩小 zoom 无缝无接缝。
    const previewColor = this.previewValid ? COLOR_PREVIEW_VALID : COLOR_PREVIEW_INVALID;
    const startDir = this.startPoint!.direction;
    const infos = computeTurnInfos(this.previewPath, startDir);

    for (let i = startIdx; i < this.previewPath.length; i++) {
      const cell = this.previewPath[i];
      const info = infos[i];
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
  }
}

// ───────────────────────── 坐标 / 方向工具 ─────────────────────────

/** 世界像素 → 格子坐标（向下取整）。 */
function worldToGrid(wx: number, wy: number): GridCell {
  return { x: Math.floor(wx / CELL_SIZE), y: Math.floor(wy / CELL_SIZE) };
}

/** 把端口相对位置按建筑朝向旋转，得到在世界坐标系中的相对位置。 */
function rotatePort(
  port: Port,
  footprint: { w: number; h: number },
  direction: Direction,
): { dx: number; dy: number } {
  const cx = (footprint.w - 1) / 2;
  const cy = (footprint.h - 1) / 2;
  const x = port.position.dx - cx;
  const y = port.position.dy - cy;
  let rx = x;
  let ry = y;
  switch (direction) {
    case 0:
      break;
    case 90:
      rx = -y;
      ry = x;
      break;
    case 180:
      rx = -x;
      ry = -y;
      break;
    case 270:
      rx = y;
      ry = -x;
      break;
  }
  return {
    dx: Math.round(rx + cx),
    dy: Math.round(ry + cy),
  };
}

/** 端口在默认方向下的朝外方向。 */
function portOutwardBase(
  port: Port,
  footprint: { w: number; h: number },
): Direction {
  const { dx, dy } = port.position;
  if (dy === 0) return 270; // 顶边端口朝上
  if (dy === footprint.h - 1) return 90; // 底边端口朝下
  if (dx === 0) return 180; // 左边端口朝左
  if (dx === footprint.w - 1) return 0; // 右边端口朝右
  // 非边缘端口按上处理（防御性，当前数据不会出现）
  return 270;
}

/** 把一个基础方向按建筑朝向旋转。 */
function rotateDirection(base: Direction, direction: Direction): Direction {
  return ((base + direction) % 360) as Direction;
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
