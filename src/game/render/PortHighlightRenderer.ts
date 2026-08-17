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
//   输入堵 = 供给带队首物品停门口（T2.6 满槽堵停）；输出堵 = 输出槽有货+接收带被占
//   （T2.7 满带留槽）；paused 时不算堵（暂停由 LOGO 指示）。

import { Sprite, Container } from 'pixi.js';
import type { World, EntityHandle } from '../ECS';
import type { Position } from '../components/Position';
import type { SpriteComp } from '../components/SpriteComp';
import type { BuildingComp } from '../components/BuildingComp';
import { getBuildingDefinition, type BuildingDefinition } from '../data/buildings';
import { buildBeltCellIndex } from '../systems/machine/IntakeOps';
import {
  inputPortStatuses,
  outputPortStatuses,
} from '../systems/machine/PortStatusOps';
import type { TextureLookup } from '../systems/RenderSystem';

/** 连接高亮颜色（用户指定 #FFEF00）。 */
const PORT_CONNECTED_TINT = 0xffef00;
/** 堵塞高亮颜色（用户指定 #B10000）。 */
const PORT_BLOCKED_TINT = 0xb10000;
/** 箭头常态色（与设备主帧箭头 stroke #828080 一致）。 */
const ARROW_TINT_NORMAL = 0x828080;
/** 堵塞时箭头变白（用户要求，方向由容器旋转保持）。 */
const ARROW_TINT_BLOCKED = 0xffffff;

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
}

/**
 * 端口连接高亮渲染器。端口面板染色（连接黄 / 堵塞红，不透明）。
 * 每帧 diff 设备集合（新增建容器、消失销毁），状态变化仅写 visible/tint（无重绘）。
 */
export class PortHighlightRenderer {
  private world: World;
  private getTexture: TextureLookup;
  private layer: Container;
  private entries = new Map<EntityHandle, PortEntry>();

  constructor(world: World, layer: Container, getTexture: TextureLookup) {
    this.world = world;
    this.getTexture = getTexture;
    this.layer = layer;
  }

  /** 每帧刷新（RenderSystem.update 调用）。 */
  update(): void {
    const buildings = this.world.query('BuildingComp', 'Position');
    const seen = new Set<EntityHandle>(buildings);

    // 清理已销毁设备
    for (const [handle, entry] of this.entries) {
      if (!seen.has(handle)) {
        entry.container.destroy({ children: true });
        this.entries.delete(handle);
      }
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

      // 端口状态 → visible/tint（未连接隐藏；堵塞红 / 连接黄；堵塞箭头白）
      const inSt = inputPortStatuses(this.world, beltAt, handle, comp, def);
      const outSt = outputPortStatuses(this.world, beltAt, handle, comp, def);
      this.applyStates(entry.inSprites, inSt);
      this.applyStates(entry.outSprites, outSt);
      this.applyArrows(entry.inArrows, inSt);
      this.applyArrows(entry.outArrows, outSt);
    }
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
    for (let i = 0; i < nIn; i++) {
      inSprites.push(mk(`${def.texture}/port-in-${i}`, 0)); // 面板（下层）
      inArrows.push(mk(`${def.texture}/arrow-in-${i}`, 10)); // 箭头（面板之上）
    }
    for (let i = 0; i < nOut; i++) {
      outSprites.push(mk(`${def.texture}/port-out-${i}`, 0));
      outArrows.push(mk(`${def.texture}/arrow-out-${i}`, 10));
    }
    return { container, inSprites, outSprites, inArrows, outArrows };
  }

  private applyStates(
    sprites: Array<Sprite | null>,
    states: { connected: boolean; blocked: boolean }[],
  ): void {
    for (let i = 0; i < sprites.length && i < states.length; i++) {
      const s = sprites[i];
      if (!s) continue;
      const st = states[i];
      s.visible = st.connected;
      if (st.connected) s.tint = st.blocked ? PORT_BLOCKED_TINT : PORT_CONNECTED_TINT;
    }
  }

  /** 箭头与面板同显隐（面板盖住设备主帧箭头 → 补画）；堵塞变白、常态原灰（方向随容器旋转）。 */
  private applyArrows(
    arrows: Array<Sprite | null>,
    states: { connected: boolean; blocked: boolean }[],
  ): void {
    for (let i = 0; i < arrows.length && i < states.length; i++) {
      const a = arrows[i];
      if (!a) continue;
      const st = states[i];
      a.visible = st.connected;
      if (st.connected) a.tint = st.blocked ? ARROW_TINT_BLOCKED : ARROW_TINT_NORMAL;
    }
  }

  /** 销毁全部（teardown 用）。 */
  destroy(): void {
    for (const entry of this.entries.values()) entry.container.destroy({ children: true });
    this.entries.clear();
  }
}
