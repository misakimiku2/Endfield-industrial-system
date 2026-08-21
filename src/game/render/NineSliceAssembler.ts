// 九宫格底座拼装器 — T1.11c（方案 S2 §5.2，素材规范 S1 §9）
//           端口叠加 — T1.12（方案 S3 §5，端口掩码派生 + 四边逐位叠加）
//
// 职责: 按 footprint 从 devices 图集取 nineslice/* 切片帧平铺底座，再按
// BuildingDefinition.ports 派生的四边端口掩码叠加 port-*（固体）/lport-*（液体）
// /deco-*（无液体侧边的装饰条）帧。图集面积与设备尺寸、端口组合彻底解耦——
// 任意 w×h（w,h ≥ 2）× 任意"哪些格有什么类型的口"共用一套元件，零美术成本。
//
// 平铺规则（S1 §9.3）:
//   行 0:      tl, t×(w-2), tr
//   行 1..h-2: l,  c×(w-2), r
//   行 h-1:    bl, b×(w-2), br
//
// 端口叠加规则（S3 §2/§5.1，掩码 = PortMask，默认朝向定义、随容器整体旋转）:
//   top.solid/bottom.solid 逐列 → port-tl/t/tr、port-bl/b/br（列方位同切片规则；
//     port-* 含端口底板，无口格镂空——底板跟端口走，2026-08-21 用户素材修订）
//   任一侧有固体口的内部边界 → emblazon-t*/b* 小方块（跟端口走：端口两侧各
//     一颗、角格口只内侧一颗，两侧无口不显示；边界奇偶 A/B 交替）
//   top.liquid/bottom.liquid 逐列 → lport-tl/t/tr、lport-bl/b/br（等 A3 端口
//     模型拆分后才有 def 能置位，管线/拼装已就绪）
//   left.liquid/right.liquid 逐行 → lport-l / lport-r
//   deco: 某侧边液体位图全 0 → 该侧中间行（1..h-2）逐行铺 deco-l/deco-r
//     （无液体口侧边的装饰条，2026-08-21 用户素材；帽端越界随 8px 窗口保留，
//     相邻行不透明同色重叠合并为连续饰条）
//
// 坐标数学:
//   - 容器原点 = 设备中心（与设备 Sprite anchor 0.5 同约定，RenderSystem/PortHighlight
//     的 position/rotation 公式直接复用）。
//   - 每个切片/端口 Sprite 覆盖 (64+2×4)² = 72² 世界像素、anchor 0.5、中心对齐
//     所在格中心——窗口含 4px 边距（柱子突出/端口越界的越界内容随窗口保留），
//     相邻切片重叠 8px（内容不透明同色，无视觉影响）。deco Sprite 覆盖
//     (64+2×8)² = 80² 世界像素（deco 帽端越界 1.8765 单位 > 4px 标准边距，
//     提取窗口放大到 8px，与 asset-manifest NINESLICE_DECO_MARGIN_SRC_PX 一致）。
//   - 纹理 288 texels（72 源px × 4 超采样）↔ 72 世界像素，zoom=4 纹素 1:1；
//     deco 帧 320² ↔ 80 世界像素。
//
// 性能: 同图集纹理自动合批；已放置设备走 getBakedNineSliceTexture 的 RenderTexture
// 烘焙（底座+全部端口一次烘焙，每设备 1 Sprite，缓存键含掩码）；本模块的逐帧
// 容器仍服务预览染色与烘焙源。

import { Container, Sprite, Texture, type Renderer } from 'pixi.js';
import type { TextureLookup } from '../systems/RenderSystem';
import { CELL_SIZE } from './constants';
import { portMaskKey, type PortMask } from './PortMask';

/**
 * 切片提取窗口边距（源像素，与 asset-manifest NINESLICE_MARGIN_SRC_PX 一致）。
 * 运行时按 1 源px = 1 世界像素换算：切片/端口 Sprite 覆盖 64 + 2×4 = 72 世界像素。
 */
export const NINESLICE_MARGIN_PX = 4;

/** 单个切片/端口帧覆盖的世界像素（格 64px + 两侧窗口边距）。 */
export const NINESLICE_SLICE_SPAN = CELL_SIZE + NINESLICE_MARGIN_PX * 2;

/**
 * deco-*（侧边装饰条）组的提取窗口边距（源像素，与 asset-manifest
 * NINESLICE_DECO_MARGIN_SRC_PX 一致）：装饰条帽端越界 1.8765 单位（≈7.1px）
 * > 标准边距 4px，窗口放大到 8px 保帽端完整。
 */
export const NINESLICE_DECO_MARGIN_PX = 8;

/** 单个 deco 帧覆盖的世界像素（格 64px + 两侧 8px 窗口边距）。 */
export const NINESLICE_DECO_SPAN = CELL_SIZE + NINESLICE_DECO_MARGIN_PX * 2;

/**
 * (行, 列) 位置应使用的切片方位名（S1 §9.3 平铺规则）。
 * 行首/行尾用 l/r，中间列用 c；顶行 t 系、底行 b 系、中间行 m 系。
 */
function sliceNameAt(row: number, col: number, w: number, h: number): string {
  const v = row === 0 ? 't' : row === h - 1 ? 'b' : 'm';
  const u = col === 0 ? 'l' : col === w - 1 ? 'r' : 'm';
  if (v === 'm' && u === 'm') return 'c';
  return v === 'm' ? u : u === 'm' ? v : v + u;
}

/**
 * 拼装 w×h 设备的九宫格底座容器。
 *
 * @param w,h         footprint 宽高（格数，均 ≥ 2；1×n/n×1 设备走 whole 路径不进本函数）
 * @param getTexture  图集纹理查找（RenderSystem 注入的同一函数）
 * @param tint        可选整体染色（放置预览蓝/橙红用；已放置设备不染）
 * @returns 容器（原点 = 设备中心）；切片帧缺失的位置跳过（如全透明未打包的 c 块）
 */
export function buildNineSliceBase(
  w: number,
  h: number,
  getTexture: TextureLookup,
  tint?: number,
): Container {
  const container = new Container({ label: `nineslice-${w}x${h}` });
  const halfW = (w * CELL_SIZE) / 2;
  const halfH = (h * CELL_SIZE) / 2;
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const tex: Texture | undefined = getTexture('devices', `nineslice/${sliceNameAt(row, col, w, h)}`);
      if (!tex || tex.width === 0) continue; // c 块空心未打包等
      const s = new Sprite(tex);
      s.anchor.set(0.5);
      // 切片窗口含边距：纹理覆盖 NINESLICE_SLICE_SPAN 世界像素（texture.width=288
      // 源尺寸 × 超采样后，width setter 按源尺寸比例缩放）
      s.width = NINESLICE_SLICE_SPAN;
      s.height = NINESLICE_SLICE_SPAN;
      s.position.set(col * CELL_SIZE + CELL_SIZE / 2 - halfW, row * CELL_SIZE + CELL_SIZE / 2 - halfH);
      if (tint !== undefined) s.tint = tint;
      container.addChild(s);
    }
  }
  return container;
}

/**
 * 对拼装容器（或任意容器子树）内的全部 Sprite 设置 tint。
 * 放置预览按 canPlace 切换蓝/橙红时用（S2 §5.3: nineslice 预览染色 =
 * 容器内逐 Sprite tint，无整帧 mask filter）。
 */
export function tintContainer(root: Container, tint: number): void {
  for (const child of root.children) {
    if (child instanceof Sprite) child.tint = tint;
    else if (child instanceof Container) tintContainer(child, tint);
  }
}

// ───────────────────────── 端口叠加层（T1.12，S3 §5.1） ─────────────────────────

/**
 * 顶/底行第 col 列应使用的端口方位名（与 sliceNameAt 的行方位规则一致：
 * 首列 tl/bl、末列 tr/br、中间列 t/b）。
 */
function portColumnName(col: number, w: number, top: boolean): string {
  const v = top ? 't' : 'b';
  if (col === 0) return v + 'l';
  if (col === w - 1) return v + 'r';
  return v;
}

/** 放一个覆盖 span² 世界像素、中心对齐 (row, col) 格中心的端口 Sprite。 */
function placePortSprite(
  container: Container,
  tex: Texture,
  row: number, col: number,
  w: number, h: number,
  span: number,
  tint?: number,
): void {
  const s = new Sprite(tex);
  s.anchor.set(0.5);
  s.width = span;
  s.height = span;
  s.position.set(col * CELL_SIZE + CELL_SIZE / 2 - (w * CELL_SIZE) / 2,
                 row * CELL_SIZE + CELL_SIZE / 2 - (h * CELL_SIZE) / 2);
  if (tint !== undefined) s.tint = tint;
  container.addChild(s);
}

/**
 * 端口叠加层：按四边掩码在底座之上逐位放 port- / lport- / deco- 系 Sprite
 * （z 序：固体口 → 液体口 → deco；液体与固体同格时液体盖上层）。
 *
 * @param w,h         footprint 宽高（格数）
 * @param mask        portMaskFromDef 派生的四边端口位图（默认朝向）
 * @param getTexture  图集纹理查找（RenderSystem 注入的同一函数）
 * @param tint        可选整体染色（放置预览蓝/橙红用）
 * @returns 容器（原点 = 设备中心）；掩码全零时为空容器（无液体侧边仍有 deco）
 */
export function buildNineSlicePorts(
  w: number,
  h: number,
  mask: PortMask,
  getTexture: TextureLookup,
  tint?: number,
): Container {
  const container = new Container({ label: `nineslice-ports-${w}x${h}` });
  const add = (key: string, row: number, col: number, span = NINESLICE_SLICE_SPAN) => {
    const tex = getTexture('devices', `nineslice/${key}`);
    if (!tex || tex.width === 0) return; // 帧缺失（图集未含该组）自然跳过
    placePortSprite(container, tex, row, col, w, h, span, tint);
  };

  // 固体口：顶/底行逐列（port-* 含底板，无口格镂空）
  for (let col = 0; col < w; col++) {
    if (mask.top.solid & (1 << col)) add(`port-${portColumnName(col, w, true)}`, 0, col);
    if (mask.bottom.solid & (1 << col)) add(`port-${portColumnName(col, w, false)}`, h - 1, col);
  }
  // emblazon 小方块：跟端口走——任一侧有固体口的内部边界都显示（2026-08-21 三轮
  // 修订，S3 §3.5：端口两侧各一颗，角格口只内侧一颗；两侧都无口不显示）。
  // A/B 形按边界序号奇偶交替（偶 A 奇 B，与原素材 3×3 的 A、B 排列一致，
  // 且形式只取决于边界位置、与端口分布无关），贴边界右侧格。
  for (let col = 0; col < w - 1; col++) {
    if (((mask.top.solid & (1 << col)) | (mask.top.solid & (1 << (col + 1)))) !== 0) {
      add(`emblazon-t${col % 2 ? 'b' : 'a'}`, 0, col + 1);
    }
    if (((mask.bottom.solid & (1 << col)) | (mask.bottom.solid & (1 << (col + 1)))) !== 0) {
      add(`emblazon-b${col % 2 ? 'b' : 'a'}`, h - 1, col + 1);
    }
  }
  // 液体口（顶/底行逐列 + 左右列逐行）
  for (let col = 0; col < w; col++) {
    if (mask.top.liquid & (1 << col)) add(`lport-${portColumnName(col, w, true)}`, 0, col);
    if (mask.bottom.liquid & (1 << col)) add(`lport-${portColumnName(col, w, false)}`, h - 1, col);
  }
  for (let row = 0; row < h; row++) {
    if (mask.left.liquid & (1 << row)) add('lport-l', row, 0);
    if (mask.right.liquid & (1 << row)) add('lport-r', row, w - 1);
  }
  // 侧边装饰条：某侧边无任何液体口 → 该侧中间行逐行铺 deco（S3 §3.4）
  for (let row = 1; row < h - 1; row++) {
    if (mask.left.liquid === 0) add('deco-l', row, 0, NINESLICE_DECO_SPAN);
    if (mask.right.liquid === 0) add('deco-r', row, w - 1, NINESLICE_DECO_SPAN);
  }
  return container;
}

// ───────────────────────── RenderTexture 烘焙（S2 §5.2 v2 方案；T1.12 掩码入键） ─────────────────────────

/**
 * 尺寸+掩码 → 烘焙整机底座纹理（底座 + 全部端口一次烘焙）缓存。
 * 同尺寸同掩码的设备共享一张（缓存规模 ≈ 设备款数——每款 ports 唯一；
 * 未来款数多了可加 LRU 淘汰，接口不变）。
 */
const bakedCache = new Map<string, Texture>();

/**
 * 把 w×h 的九宫格底座 + 端口叠加一次性烘焙成单张 RenderTexture（T1.11c 实施时
 * 从逐切片 Sprite 升级而来，S2 §5.2 预留的 v2 方案；T1.12 起缓存键含掩码）。
 *
 * 为什么烘焙（逐切片 Sprite 的两个实测问题）:
 *   1. 低 zoom mipmap 半透明叠加: 切片间 ε 重叠带（边框切分防缝）在 zoom<1 时
 *      处于 mipmap 半透明区，重叠处双重绘制 → 细轨上出现周期性暗斑。
 *      烘焙后 ε 重叠在 RT 内合为不透明实体，与原整帧渲染的 mip 行为逐像素一致。
 *   2. Sprite 数量: 100 台 6×6 = 3600 切片 Sprite → 烘焙后每设备 1 个 Sprite。
 *
 * 分辨率 4 对齐 DEVICE_RASTER_SCALE（zoom=4 纹素 1:1）；mipmap 在源上传前开启，
 * 缩小采样与图集帧一致。纹理含窗口边距（bounds = 设备 px + 两侧 4px，透明无碍）。
 *
 * @param mask 端口掩码（portMaskFromDef 派生；进缓存键，不同掩码不共享）
 * @returns 烘焙纹理（anchor 0.5 + scale 1 时内容恰好覆盖设备 footprint）
 */
export function getBakedNineSliceTexture(
  w: number,
  h: number,
  mask: PortMask,
  renderer: Renderer,
  getTexture: TextureLookup,
): Texture {
  const key = `${w}x${h}|${portMaskKey(mask)}`;
  const cached = bakedCache.get(key);
  if (cached) return cached;
  const container = buildNineSliceBase(w, h, getTexture);
  container.addChild(buildNineSlicePorts(w, h, mask, getTexture));
  // autoGenerateMipmaps 必须经 textureSourceOptions 在创建时传入——generateTexture
  // 渲染完会立即调 source.updateMipmaps()，事后改属性赶不上这次（实测低 zoom 闪烁）
  const tex = renderer.generateTexture({
    target: container,
    resolution: 4,
    textureSourceOptions: { autoGenerateMipmaps: true },
  });
  container.destroy({ children: true });
  bakedCache.set(key, tex);
  return tex;
}
