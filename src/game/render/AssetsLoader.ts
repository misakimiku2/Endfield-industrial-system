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

/** 加载状态，防止重复加载。 */
let loaded = false;

/**
 * 加载全部图集。启动时调用一次。
 * 用 Assets.load 加载每个 spritesheet JSON — PixiJS v8 会自动解析关联 PNG
 * 并生成 Spritesheet 对象缓存(以 JSON URL 为 key)。后续 getTexture 用同 URL 取出。
 */
export async function loadAllAssets(): Promise<void> {
  if (loaded) return;

  // 并行加载三个 spritesheet JSON(各自自动加载关联 PNG)
  await Promise.all(ALL_GROUPS.map((g) => Assets.load(ATLAS_JSON_PATH[g])));
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
