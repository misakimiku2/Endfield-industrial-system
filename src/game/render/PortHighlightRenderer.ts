// 端口连接高亮渲染器 — T2.8 设备状态机与终末地风格状态视觉（2026-08-18 用户反馈修订）
// 设计依据: implementation-phase-2.md T2.8 需求3、用户拍板——"把 3x3_unit.svg ports_top 组
//   里的东西弄成 #FFEF00（连接）/ #B10000（堵塞），不透明，不要整格半透明高亮"。
//
// 实现（SVG 单端口帧 + Sprite tint）:
//   - refining_unit.svg 新增 6 个隐藏层 layer-port-in/out-{0,1,2}（rect_top 端口面板几何的
//     白色复制品，display:none 不进主帧）→ pack-assets 生成 `refining_unit/port-in-*` 等
//     **单端口帧**（全画布 192×192、只有该端口的面板矩形可见）。
//   - 每台设备一个 Container（挂 layer3Item、position=设备中心、rotation=direction 弧度，
//     与设备 Sprite 同旋转数学），每端口一个 Sprite：纹理=对应单端口帧、anchor 0.5、
//     position 0（帧与主帧同画布 → 面板矩形自动落位）、scale=设备像素尺寸/纹理尺寸。
//     设备旋转 90/180/270° 后高亮位置恒与实际端口面板对齐。
//   - 染色: 纹理为纯白矩形，tint 相乘即纯色不透明——连接 #FFEF00 / 堵塞 #B10000。
//     未连接端口 Sprite visible=false。
//
// 堵塞判定（PortStatusOps，渲染与 __game.portStatus 同源）:
//   端口堵 = 连接该端口的传送带段 seg.blocked（BeltSystem 整链逆流传播）——与传送带
//   带身/箭头同源，整链堵塞时端口同步变红（不必等物品堆到门口/段首）。
//   渐变: 面板黄 #FFEF00 → 红 #B10000、箭头灰 → 白，时长 BLOCKED_BLEND_MS。
//   paused 时不算堵（暂停由 LOGO 指示）。

import { Sprite, Container, Text } from 'pixi.js';
import type { World, EntityHandle } from '../ECS';
import type { Position } from '../components/Position';
import type { SpriteComp } from '../components/SpriteComp';
import type { BuildingComp } from '../components/BuildingComp';
import { getBuildingDefinition, type BuildingDefinition } from '../data/buildings';
import { buildBeltCellIndex } from '../systems/machine/IntakeOps';
import {
  inputPortStatuses,
  outputPortStatuses,
  type PortStatus,
} from '../systems/machine/PortStatusOps';
import type { TextureLookup } from '../systems/RenderSystem';
import { lerpColor, BLOCKED_BLEND_MS } from './BeltVectorGeometry';
import { CELL_SIZE } from './constants';

/** 连接高亮颜色（用户指定 #FFEF00）。 */
const PORT_CONNECTED_TINT = 0xffef00;
/** 堵塞高亮颜色（用户指定 #B10000）。 */
const PORT_BLOCKED_TINT = 0xb10000;
/** 箭头常态色（与设备主帧箭头 stroke #828080 一致）。 */
const ARROW_TINT_NORMAL = 0x828080;
/** 堵塞时箭头变白（用户要求，方向由容器旋转保持）。 */
const ARROW_TINT_BLOCKED = 0xffffff;
/** 传送带创建模式下输出端口高亮色（用户指定 #80BEE9）。 */
export const PORT_CREATE_TINT = 0x80bee9;
/** 传送带创建模式下输出端口悬停色（更淡的蓝）。 */
export const PORT_CREATE_HOVER_TINT = 0xa8d4f5;
/** T2.16 创建模式输入端口候选色（紫——预览末格"够得着"的输入口，与输出口蓝区分）。 */
const PORT_DOCK_CANDIDATE_TINT = 0xc79bf2;
/** T2.16 "将连接"确认色（绿——末段方向指向该输入口，落盘即对接成立；
 *  落盘后常态即回到 T2.8 连接黄 #FFEF00）。 */
const PORT_DOCK_CONFIRMED_TINT = 0x37d067;
/** T2.16 起点反例警示色（红——hover 输入口"不能作为起点"，与预览不可放置红一致）。 */
const PORT_START_INVALID_TINT = 0xe45050;
/** T2.16 起点反例提示文案。 */
const START_HINT_TEXT = '输入端口不能作为起点';

/** 单台设备的端口高亮渲染态。 */
interface PortEntry {
  /** 设备锚容器: position=设备中心、rotation=设备朝向弧度，端口 Sprite 挂其下随旋转。 */
  container: Container;
  /** 输入端口面板 Sprite（按端口定义序；纹理缺失的位置为 null——不渲染该口）。 */
  inSprites: Array<Sprite | null>;
  outSprites: Array<Sprite | null>;
  /** 输入端口箭头 Sprite（白色源帧 × tint；面板之上，堵塞变白）。 */
  inArrows: Array<Sprite | null>;
  outArrows: Array<Sprite | null>;
  /** 输出端口主体面板 Sprite（ports 组，比 ports_top 大；创建模式悬停时显示）。 */
  outMidSprites: Array<Sprite | null>;
  /** 每端口堵塞渐变进度 0~1（面板黄→红 / 箭头灰→白），随 deltaMS 向目标趋近。 */
  inBlends: number[];
  outBlends: number[];
}

/**
 * 端口连接高亮渲染器。端口面板染色（连接黄 / 堵塞红，不透明）+ 堵塞渐变。
 * 每帧 diff 设备集合（新增建容器、消失销毁），状态变化仅写 visible/tint（无重绘）。
 */
export class PortHighlightRenderer {
  private world: World;
  private getTexture: TextureLookup;
  private layer: Container;
  private entries = new Map<EntityHandle, PortEntry>();
  /** 查询是否处于传送带创建模式（按 E）。创建模式下输出端口染蓝 #80BEE9。 */
  private isCreateMode: () => boolean;
  /** 查询当前悬停的输出端口格（创建模式下用于悬停淡蓝高亮）。 */
  private getHoveredPortCell: () => { x: number; y: number } | null;
  /** T2.16: 预览末段的输入端口对接信息（候选紫/确认绿；无预览/无效预览为 null）。 */
  private getDockInfo?: () => { targets: { x: number; y: number }[]; confirmed: { x: number; y: number }[] } | null;
  /** T2.16: hover 态悬停的输入端口格（起点反例——红警示 + 文字提示）。 */
  private getStartHintCell?: () => { x: number; y: number } | null;
  /** T2.16: 起点反例文字提示（懒创建，挂 layer3Item 顶层）。 */
  private hintText: Text | null = null;

  constructor(
    world: World,
    layer: Container,
    getTexture: TextureLookup,
    isCreateMode?: () => boolean,
    getHoveredPortCell?: () => { x: number; y: number } | null,
    getDockInfo?: () => { targets: { x: number; y: number }[]; confirmed: { x: number; y: number }[] } | null,
    getStartHintCell?: () => { x: number; y: number } | null,
  ) {
    this.world = world;
    this.getTexture = getTexture;
    this.layer = layer;
    this.isCreateMode = isCreateMode ?? (() => false);
    this.getHoveredPortCell = getHoveredPortCell ?? (() => null);
    this.getDockInfo = getDockInfo;
    this.getStartHintCell = getStartHintCell;
  }

  /**
   * 每帧刷新（RenderSystem.update 调用）。
   * @param deltaMS 自上一帧毫秒数（驱动堵塞渐变，帧率无关）。
   */
  update(deltaMS = 0): void {
    // 堵塞渐变步长（线性插值，固定时长；deltaMS=0 时瞬间到位，兼容旧调用）
    const blendStep = deltaMS > 0 ? deltaMS / BLOCKED_BLEND_MS : 1;
    const buildings = this.world.query('BuildingComp', 'Position');
    const seen = new Set<EntityHandle>(buildings);

    // 清理已销毁设备
    for (const [handle, entry] of this.entries) {
      if (!seen.has(handle)) {
        entry.container.destroy({ children: true });
        this.entries.delete(handle);
      }
    }

    // T2.16 创建模式查询先于设备遍历/早退——退出创建模式时提示文字必须被隐藏，
    // 不能因"场上无设备"的早退跳过
    const createMode = this.isCreateMode();
    const hoveredCell = createMode ? this.getHoveredPortCell() : null;
    const dock = createMode ? (this.getDockInfo?.() ?? null) : null;
    const startHint = createMode ? (this.getStartHintCell?.() ?? null) : null;

    // T2.16 起点反例文字提示: 悬停输入端口时在端口上方显示（单例，随格子移动）
    if (startHint !== null) {
      const t = this.ensureHintText();
      t.position.set(
        (startHint.x + 0.5) * CELL_SIZE,
        startHint.y * CELL_SIZE - CELL_SIZE * 0.1,
      );
      t.visible = true;
    } else if (this.hintText !== null) {
      this.hintText.visible = false;
    }

    if (buildings.length === 0) return;
    const beltAt = buildBeltCellIndex(this.world);
    for (const handle of buildings) {
      const comp = this.world.getComponent<BuildingComp>(handle, 'BuildingComp');
      const pos = this.world.getComponent<Position>(handle, 'Position');
      const spr = this.world.getComponent<SpriteComp>(handle, 'SpriteComp');
      if (!comp || !pos || !spr) continue;
      const def = getBuildingDefinition(comp.definitionId);
      if (!def) continue;

      let entry = this.entries.get(handle);
      if (!entry) {
        entry = this.createEntry(def, spr);
        this.entries.set(handle, entry);
      }
      // 每帧同步锚（设备静态，开销可忽略；也兼容未来搬迁）
      entry.container.position.set(pos.x + spr.width / 2, pos.y + spr.height / 2);
      entry.container.rotation = (comp.direction * Math.PI) / 180;

      // 端口状态 → visible/tint（未连接隐藏；堵塞红 / 连接黄；堵塞箭头白；黄→红渐变）。
      // 创建模式下输出端口覆盖为蓝色 #80BEE9（作为可连接起点提示，未连接也显示），
      // 悬停的端口用更淡的蓝 #A8D4F5 提示可点击。
      // T2.16 输入端口（创建模式）: 起点反例红 > "将连接"绿 > 候选紫 > 常态（连接黄/隐藏）。
      const inSt = inputPortStatuses(this.world, beltAt, handle, comp, def);
      const outSt = outputPortStatuses(this.world, beltAt, handle, comp, def);
      this.applyPorts(entry.inSprites, entry.inArrows, entry.inBlends, inSt, blendStep, false, createMode, hoveredCell, null, dock, startHint);
      this.applyPorts(entry.outSprites, entry.outArrows, entry.outBlends, outSt, blendStep, true, createMode, hoveredCell, entry.outMidSprites, dock, startHint);
    }
  }

  /** 懒创建起点反例提示文字（layer3Item 顶层，盖在端口高亮之上）。 */
  private ensureHintText(): Text {
    if (this.hintText !== null) return this.hintText;
    const t = new Text({
      text: START_HINT_TEXT,
      style: {
        fontFamily: 'system-ui, sans-serif',
        fontSize: 14,
        fontWeight: 'bold',
        fill: 0xffffff,
        stroke: { color: 0x8a2020, width: 4 },
        align: 'center',
      },
    });
    t.anchor.set(0.5, 1);
    t.zIndex = 16000;
    t.visible = false;
    this.layer.addChild(t);
    this.hintText = t;
    return t;
  }

  /** 为一台设备创建端口 Sprite 集（每口面板+箭头各一帧，帧缺失的位置置 null）。 */
  private createEntry(def: BuildingDefinition, spr: SpriteComp): PortEntry {
    const container = new Container({ label: `portHighlight-${def.texture}` });
    container.zIndex = 14000; // 盖在设备(layer2Building)之上，低于悬停高亮(15000)
    this.layer.addChild(container);

    // 帧与主帧同画布（如 192×192），Sprite 尺寸=设备渲染尺寸 → 面板/箭头按比例落位
    const mk = (key: string, zIndex: number): Sprite | null => {
      const tex = this.getTexture('devices', key);
      if (!tex || tex.width === 0) return null;
      const s = new Sprite(tex);
      s.anchor.set(0.5);
      s.scale.set(spr.width / tex.width, spr.height / tex.height);
      s.visible = false;
      s.zIndex = zIndex;
      container.addChild(s);
      return s;
    };
    const nIn = def.ports.filter((p) => p.type === 'input').length;
    const nOut = def.ports.filter((p) => p.type === 'output').length;
    const inSprites: Array<Sprite | null> = [];
    const outSprites: Array<Sprite | null> = [];
    const inArrows: Array<Sprite | null> = [];
    const outArrows: Array<Sprite | null> = [];
    const outMidSprites: Array<Sprite | null> = [];
    const inBlends: number[] = [];
    const outBlends: number[] = [];
    for (let i = 0; i < nIn; i++) {
      inSprites.push(mk(`${def.texture}/port-in-${i}`, 0)); // 面板（下层）
      inArrows.push(mk(`${def.texture}/arrow-in-${i}`, 10)); // 箭头（面板之上）
      inBlends.push(0);
    }
    for (let i = 0; i < nOut; i++) {
      outSprites.push(mk(`${def.texture}/port-out-${i}`, 0));
      outArrows.push(mk(`${def.texture}/arrow-out-${i}`, 10));
      outMidSprites.push(mk(`${def.texture}/port-mid-out-${i}`, -1)); // 主体面板（悬停，在 top 下方，同素材 ports 在 ports_top 下方）
      outBlends.push(0);
    }
    return { container, inSprites, outSprites, inArrows, outArrows, outMidSprites, inBlends, outBlends };
  }

  /**
   * 逐端口同步显隐 + 颜色（面板/箭头）。
   * 创建模式下输出端口（isOutput && createMode）覆盖为蓝色 #80BEE9 且始终显示，
   * 悬停端口用更淡的蓝 #A8D4F5、箭头白色（面板之上清晰可见）；
   * T2.16 创建模式下输入端口按对接信息覆盖: 起点反例红 / "将连接"绿 / 候选紫
   * （箭头白色），优先级高于常态；否则按连接黄/堵塞红渐变，未连接隐藏。
   */
  private applyPorts(
    sprites: Array<Sprite | null>,
    arrows: Array<Sprite | null>,
    blends: number[],
    states: PortStatus[],
    blendStep: number,
    isOutput: boolean,
    createMode: boolean,
    hoveredCell: { x: number; y: number } | null,
    midSprites: Array<Sprite | null> | null,
    dock: { targets: { x: number; y: number }[]; confirmed: { x: number; y: number }[] } | null,
    startHint: { x: number; y: number } | null,
  ): void {
    for (let i = 0; i < sprites.length && i < states.length; i++) {
      const st = states[i];
      const showCreate = createMode && isOutput;
      const isHovered = showCreate && hoveredCell !== null && st.x === hoveredCell.x && st.y === hoveredCell.y;
      // T2.16 输入端口对接态（仅创建模式 + 输入端口）
      const dockable = createMode && !isOutput && dock !== null;
      const isConfirmed = dockable && dock!.confirmed.some((c) => c.x === st.x && c.y === st.y);
      const isCandidate = !isConfirmed && dockable && dock!.targets.some((c) => c.x === st.x && c.y === st.y);
      const isStartHint = createMode && !isOutput && startHint !== null && st.x === startHint.x && st.y === startHint.y;
      const showDock = isConfirmed || isCandidate || isStartHint;
      // 堵塞渐变进度向目标（connected 且 blocked → 1，否则 0）线性趋近（创建态/对接态不渐变）
      const target = !showCreate && !showDock && st.connected && st.blocked ? 1 : 0;
      const b = blends[i];
      blends[i] = b < target ? Math.min(target, b + blendStep)
        : b > target ? Math.max(target, b - blendStep) : b;
      const blend = blends[i];
      // top 面板（ports_top 小矩形）：始终显示（创建态蓝 / 对接态红绿紫 / 连接黄 / 堵塞红）
      const s = sprites[i];
      if (s) {
        s.visible = showCreate || showDock || st.connected;
        if (isStartHint) {
          s.tint = PORT_START_INVALID_TINT;
        } else if (isConfirmed) {
          s.tint = PORT_DOCK_CONFIRMED_TINT;
        } else if (isCandidate) {
          s.tint = PORT_DOCK_CANDIDATE_TINT;
        } else if (showCreate) {
          s.tint = PORT_CREATE_TINT;
        } else if (st.connected) {
          s.tint = lerpColor(PORT_CONNECTED_TINT, PORT_BLOCKED_TINT, blend);
        }
      }
      // mid 面板（ports 主体面板，更大）：仅悬停时显示，在 top 下方（zIndex -1），淡蓝
      const m = midSprites ? midSprites[i] : null;
      if (m) {
        m.visible = isHovered;
        if (isHovered) m.tint = PORT_CREATE_HOVER_TINT;
      }
      const a = arrows[i];
      if (a) {
        a.visible = showCreate || showDock || st.connected;
        if (showCreate || showDock) {
          a.tint = ARROW_TINT_BLOCKED; // 白色箭头（彩色面板之上可见）
        } else if (st.connected) {
          a.tint = lerpColor(ARROW_TINT_NORMAL, ARROW_TINT_BLOCKED, blend);
        }
      }
    }
  }

  /** 销毁全部（teardown 用）。 */
  destroy(): void {
    for (const entry of this.entries.values()) entry.container.destroy({ children: true });
    this.entries.clear();
    if (this.hintText !== null) {
      this.hintText.destroy();
      this.hintText = null;
    }
  }
}
