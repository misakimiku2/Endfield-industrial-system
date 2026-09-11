// 图集 sprite 访问 — 设备弹窗家族（DeviceDialog / ItemDescriptionDialog / 配方一览）共用
// 依据: T2.15 的图集引用方案 + T2.22 抽公共模块（物品说明弹窗也要画物品图标，
//       不能把 ensureAtlas 复制一份：两张图集 JSON 各加载一次会双倍网络与解析开销）。
//
// 图标来源: **不新增任何美术资产**——ui/devices/items 三张图集的帧经 CSS sprite
//   （background-position 负偏移）直接引用；需要染色的（旧项目 SvgPicture colorFilter
//   srcIn）走 CSS mask + background-color。
//
// 图集 URL 约定与 AssetsLoader 一致: Vite 以根路径 serve public/。

/** 图集 JSON/PNG 的 URL。 */
export const ATLAS_JSON_URL = {
  devices: '/spritesheets/devices.json',
  items: '/spritesheets/items.json',
  ui: '/spritesheets/ui.json',
} as const;
export const ATLAS_PNG_URL = {
  devices: '/spritesheets/devices.png',
  items: '/spritesheets/items.png',
  ui: '/spritesheets/ui.png',
} as const;
export type AtlasGroup = keyof typeof ATLAS_JSON_URL;

export interface AtlasFrame { x: number; y: number; w: number; h: number }
export interface AtlasData {
  size: { w: number; h: number };
  frames: Map<string, AtlasFrame>;
}

export class AtlasSprites {
  private atlasPromise: Promise<unknown> | null = null;
  private atlases: Partial<Record<AtlasGroup, AtlasData>> = {};
  private readyCbs: Array<() => void> = [];

  /** 图集 JSON 懒加载缓存（构造即预取，点开设备时通常已就绪）。 */
  ensureAtlas(): Promise<unknown> {
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
            console.warn(`[AtlasSprites] 图集 ${g} JSON 加载失败，弹窗图标降级为空`);
            return [g, undefined] as const;
          }
        }),
      ).then((entries) => {
        this.atlases = Object.fromEntries(entries) as Partial<Record<AtlasGroup, AtlasData>>;
        for (const cb of this.readyCbs.splice(0)) cb();
        return this.atlases;
      });
    }
    return this.atlasPromise;
  }

  /** 图集就绪回调（已就绪时立即触发一次）。用于"图集迟到"场景补刷图标。 */
  onReady(cb: () => void): void {
    if (this.atlasPromise !== null) cb();
    else this.readyCbs.push(cb);
  }

  frame(group: AtlasGroup, key: string): AtlasFrame | null {
    return this.atlases[group]?.frames.get(key) ?? null;
  }

  /**
   * 图集帧 → CSS sprite 样式（contain 缩放到 dw×dh 目标盒）。
   * 元素实际盒 = 帧缩放后尺寸（父容器 flex 居中），图集未就绪返回 false。
   * mode='mask' 用于需要染色的白色图标: mask 定位帧 + CSS background-color 上色。
   */
  spriteStyle(
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
  itemIconStyle(el: HTMLElement, itemId: string, dw: number, dh: number): boolean {
    return this.spriteStyle(el, 'items', itemId, dw, dh);
  }

  /** 创建带 sprite 标记的图标元素（data-w/h = 目标盒，applySprites 据此算缩放）。 */
  makeSprite(spec: string, w: number, h: number, mode: 'image' | 'mask' = 'image'): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'efd-icon-sprite';
    el.dataset.sprite = spec;
    el.dataset.w = String(w);
    el.dataset.h = String(h);
    if (mode === 'mask') el.dataset.mode = 'mask';
    return el;
  }

  /** 把标记了 data-sprite / data-item-icon 的节点补上图集背景（每轮重设，幂等）。 */
  applySprites(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>('[data-sprite]').forEach((el) => {
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
    root.querySelectorAll<HTMLElement>('[data-item-icon]').forEach((el) => {
      const size = Number(el.dataset.itemSize ?? '56');
      this.itemIconStyle(el, el.dataset.itemIcon ?? '', size, size);
    });
  }

  // ── items 图集位图（飞行图标预重采样用；见 DeviceDialog.applyFlightIcon）──
  private itemsImagePromise: Promise<HTMLImageElement | null> | null = null;

  ensureItemsImage(): Promise<HTMLImageElement | null> {
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
}
