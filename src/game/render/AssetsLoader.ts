// 资源加载器 — 封装 PixiJS Assets API
// 依据: DD-013 (分组图集 + bundle 按需卸载)、T1.3 验收(运行时 Assets.get 可取)
//
// 把构建脚本产出的三个 spritesheet (devices/items/ui) 注册为 PixiJS bundle，
// 启动时 loadAll 一次性加载。加载后用 getTexture(group, key) 取单帧纹理。
//
// PixiJS v8 spritesheet 加载: Assets.load(jsonUrl) 会自动解析同目录关联的 PNG，
//   生成 Spritesheet 对象，其 .textures['key.png'] 为各帧 Texture。
//   bundle 机制: addBundle 注册别名映射，loadBundle(alias) 按需加载/卸载。
//
// Phase 1: 一次性全量加载(图集小)。Phase 2+: 可按场景 loadBundle/unloadBundle。

import { Assets, Texture } from 'pixi.js';

/** 图集分组名(与构建脚本产物、bundle 名一致)。 */
export type AtlasGroup = 'devices' | 'items' | 'ui';

/** 图集 JSON 在 public/ 下的 URL 路径(Vite serve public/ 为根)。 */
const ATLAS_JSON_PATH: Record<AtlasGroup, string> = {
  devices: '/spritesheets/devices.json',
  items: '/spritesheets/items.json',
  ui: '/spritesheets/ui.json',
};

const ALL_GROUPS: AtlasGroup[] = ['devices', 'items', 'ui'];

/**
 * 图集纹理源（TextureSource）的采样配置。
 *
 * 修复"纹理缩小锯齿"(T1.6 遗留): PixiJS v8 默认 autoGenerateMipmaps=false、mipLevelCount=1、
 * mipmapFilter=undefined，纹理在 zoom<1 被缩小时会产生严重 aliasing（精炼炉 logo / 液体接口
 * 等高频细节尤其明显，越小越严重）。antialias:true 只对几何多边形边缘 MSAA 生效，对纹理采样
 * 缩小锯齿无效。这里给图集源开启 mipmap，GPU 上传时自动生成 mipmap 链，缩小时按 LOD 选合适
 * 层级采样，aliasing 消除。
 *
 * 注入点说明（最可靠）: spritesheetLoader 接收 options.data.textureOptions，透传给
 * loader.load({ data: textureOptions }) → ImageSource 构造时 `...asset.data` 展开这些
 * TextureSource 选项。故纹理在**首次上传前**就已配好 mipmap，GPU 上传时一次生成整条 mipmap
 * 链，无需事后 update() 强制重建（事后改 source 属性在已上传纹理上不可靠）。
 *
 * 取值:
 *   - autoGenerateMipmaps + mipLevelCount=4: 覆盖到 1/8 尺寸（4096→256），
 *     对应 zoom≈0.06，远低于 CAMERA_ZOOM_MIN=0.25；GPU 会按 floor(log2(maxDim))+1 上限截断。
 *   - scaleMode 'linear': 放大缩小都线性（scaleMode setter 会把 mag/min/mipmapFilter 一并置 linear）。
 *   - maxAnisotropy 4: 斜视角下进一步降噪。图集尺寸均为 POT(4096²/2048²)，WebGL2/WebGPU 无限制。
 *
 * ⚠️ 副作用: atlas 子帧共享大图，低层级 mipmap 会采样到相邻图块（渗色 bleeding）。
 *    由 asset-manifest 的 ATLAS_PADDING=8 抑制（padding 每降一级等效减半，配合子帧自身缩小，
 *    邻居渗透视觉可忽略）。若 items 图标极小 zoom 仍渗色，可改为按 group 分别配置。
 */
const ATLAS_TEXTURE_OPTIONS = {
  autoGenerateMipmaps: true,
  mipLevelCount: 4,
  scaleMode: 'linear' as const,
  maxAnisotropy: 4,
};

/** 加载状态，防止重复加载。 */
let loaded = false;

/**
 * 加载全部图集。启动时调用一次。
 * 用 Assets.load 加载每个 spritesheet JSON — PixiJS v8 会自动解析关联 PNG
 * 并生成 Spritesheet 对象缓存(以 JSON URL 为 key)。后续 getTexture 用同 URL 取出。
 *
 * textureOptions 经 spritesheetLoader 透传给底层 ImageSource，使图集源在上传前配好 mipmap
 * （见 ATLAS_TEXTURE_OPTIONS 注释），消除 zoom<1 缩小时的纹理采样锯齿。
 */
export async function loadAllAssets(): Promise<void> {
  if (loaded) return;

  // 并行加载三个 spritesheet JSON(各自自动加载关联 PNG)
  await Promise.all(
    ALL_GROUPS.map((g) =>
      Assets.load({ src: ATLAS_JSON_PATH[g], data: { textureOptions: ATLAS_TEXTURE_OPTIONS } }),
    ),
  );
  loaded = true;
  console.log('[AssetsLoader] 图集加载完成:', ALL_GROUPS.join(', '));
}

/**
 * 从指定图集取某 texture key 的单帧纹理。
 * @param group 图集分组 (devices/items/ui)
 * @param key   texture key (不含 .png 后缀，如 'transport_belt', 'cuprium_ore')
 * @returns PixiJS Texture；若找不到返回 undefined
 */
export function getTexture(group: AtlasGroup, key: string): Texture | undefined {
  // bundle 加载后，PixiJS 把 spritesheet JSON 的 URL 作为 key 缓存了 Spritesheet 对象。
  // 通过 Assets.get(jsonUrl) 拿到 Spritesheet，再取 .textures['key.png']。
  const sheet = Assets.get(ATLAS_JSON_PATH[group]);
  if (!sheet) {
    console.warn(`[AssetsLoader] 图集 ${group} 未加载或不存在`);
    return undefined;
  }
  // Spritesheet.textures 的 key 带 .png 后缀(构建脚本输出格式)
  return sheet.textures?.[`${key}.png`];
}

/** 是否已加载完成。 */
export function isAssetsLoaded(): boolean {
  return loaded;
}
