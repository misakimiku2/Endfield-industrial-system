// 九宫格底座拼装器 — T1.11c（方案 S2 §5.2，素材规范 S1 §9）
//
// 职责: 按 footprint 从 devices 图集取 nineslice/* 8~9 种切片帧，平铺拼装成
// 设备底座容器。图集面积与设备尺寸彻底解耦——任意 w×h（w,h ≥ 2）设备共用
// 一套切片件，新增尺寸零美术成本。
//
// 平铺规则（S1 §9.3）:
//   行 0:      tl, t×(w-2), tr
//   行 1..h-2: l,  c×(w-2), r
//   行 h-1:    bl, b×(w-2), br
//
// 坐标数学:
//   - 容器原点 = 设备中心（与设备 Sprite anchor 0.5 同约定，RenderSystem/PortHighlight
//     的 position/rotation 公式直接复用）。
//   - 每个切片 Sprite 覆盖 (64+2×NINESLICE_MARGIN_PX)² 世界像素、anchor 0.5、
//     中心对齐所在格中心——切片窗口含 4px 边距（柱子突出/边框切分重叠的越界内容，
//     见 S1 §9.5），相邻切片重叠 8px（内容不透明同色，无视觉影响）。
//   - 纹理 288 texels（72 源px × 4 超采样）↔ 72 世界像素，zoom=4 纹素 1:1。
//
// 性能: 同图集纹理自动合批；已放置设备走 getBakedNineSliceTexture 的 RenderTexture
// 烘焙（每设备 1 Sprite，见文件尾 v2 方案说明）；本函数仍服务预览染色与烘焙源。

import { Container, Sprite, Texture, type Renderer } from 'pixi.js';
import type { TextureLookup } from '../systems/RenderSystem';
import { CELL_SIZE } from './constants';

/**
 * 切片提取窗口边距（源像素，与 asset-manifest NINESLICE_MARGIN_SRC_PX 一致）。
 * 运行时按 1 源px = 1 世界像素换算：切片 Sprite 覆盖 64 + 2×4 = 72 世界像素。
 */
export const NINESLICE_MARGIN_PX = 4;

/** 单个切片覆盖的世界像素（格 64px + 两侧窗口边距）。 */
export const NINESLICE_SLICE_SPAN = CELL_SIZE + NINESLICE_MARGIN_PX * 2;

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

// ───────────────────────── RenderTexture 烘焙（S2 §5.2 v2 方案） ─────────────────────────

/**
 * 尺寸 → 烘焙整机底座纹理缓存。同尺寸设备共享一张（图集占用仍与设备数无关，
 * 烘焙纹理只随"不同尺寸数"增长；未来尺寸多了可加 LRU 淘汰，接口不变）。
 */
const bakedCache = new Map<string, Texture>();

/**
 * 把 w×h 的九宫格拼装一次性烘焙成单张 RenderTexture（T1.11c 实施时从逐切片
 * Sprite 升级而来，S2 §5.2 预留的 v2 方案）。
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
 * @returns 烘焙纹理（anchor 0.5 + scale 1 时内容恰好覆盖设备 footprint）
 */
export function getBakedNineSliceTexture(
  w: number,
  h: number,
  renderer: Renderer,
  getTexture: TextureLookup,
): Texture {
  const key = `${w}x${h}`;
  const cached = bakedCache.get(key);
  if (cached) return cached;
  const container = buildNineSliceBase(w, h, getTexture);
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
