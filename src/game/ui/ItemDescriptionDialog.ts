// 物品说明二级弹窗 (T2.22) — 点击物品栏格子 / 输入·输出格 / 配方卡迷你格时弹出。
// 依据: 旧 Flutter 项目 lib/widgets/item_description_dialog.dart（尺寸/颜色逐项抄录，
//       token 对照表见 DeviceDialog.css 头注）。
//
// 技术形态: DOM overlay，与设备弹窗同款（根节点 fixed 挂 body，是 canvas 的兄弟节点）。
//   z-index 高于设备弹窗（1100 > 1000），遮罩点击/关闭按钮/ESC 关闭。
//
// 数据来源: 物品描述/次要描述直接来自 CSV 列（items.ts T2.22 扩展），不在代码里另造
//   文案；CSV 未填时显示旧项目同款空态「暂无描述信息」。

import './DeviceDialog.css';
import type { AtlasSprites } from './AtlasSprites';
import type { ItemRegistry } from '../data/items';

export interface ItemDescriptionDialogDeps {
  /** 图集访问（与设备弹窗共用同一个实例，避免重复加载图集 JSON）。 */
  sprites: AtlasSprites;
  /** itemId → 中文名。 */
  itemName(id: string): string;
  /** 物品注册表（取 level/description/secondaryDescription）。 */
  items: ItemRegistry;
}

export class ItemDescriptionDialog {
  readonly root: HTMLDivElement;
  private readonly deps: ItemDescriptionDialogDeps;
  private readonly panel: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly imgEl: HTMLDivElement;
  private readonly bodyEl: HTMLDivElement;
  private visible = false;

  constructor(deps: ItemDescriptionDialogDeps) {
    this.deps = deps;

    this.root = document.createElement('div');
    this.root.className = 'efd-itemdesc-root';
    this.root.hidden = true;

    const barrier = document.createElement('div');
    barrier.className = 'efd-itemdesc-barrier';
    barrier.addEventListener('click', () => this.close());

    this.panel = document.createElement('div');
    this.panel.className = 'efd-itemdesc';

    const watermark = document.createElement('img');
    watermark.className = 'efd-itemdesc-watermark';
    watermark.src = '/window/endfield-industries.svg';
    watermark.alt = '';
    watermark.draggable = false;
    this.panel.appendChild(watermark);

    // 头部: 物品名（旧项目 22px w600 白，单行省略）+ 关闭按钮 26×26
    const head = document.createElement('div');
    head.className = 'efd-itemdesc-head';
    this.titleEl = document.createElement('div');
    this.titleEl.className = 'efd-itemdesc-title';
    const close = document.createElement('button');
    close.className = 'efd-infobar-close'; // 与设备弹窗同款关闭按钮（复用样式）
    close.title = '关闭';
    close.appendChild(deps.sprites.makeSprite('ui/close_button', 26, 26));
    close.addEventListener('click', () => this.close());
    head.appendChild(this.titleEl);
    head.appendChild(close);

    const sep = document.createElement('div');
    sep.className = 'efd-itemdesc-sep';

    // 物品大图 160×160（旧项目: 原始图片无网格背景，cacheWidth 480）
    this.imgEl = document.createElement('div');
    this.imgEl.className = 'efd-itemdesc-img';

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'efd-itemdesc-body';

    this.panel.appendChild(head);
    this.panel.appendChild(sep);
    this.panel.appendChild(this.imgEl);
    this.panel.appendChild(this.bodyEl);

    this.panel.addEventListener('click', (e) => e.stopPropagation());

    this.root.appendChild(barrier);
    this.root.appendChild(this.panel);
    document.body.appendChild(this.root);
  }

  isOpen(): boolean {
    return this.visible;
  }

  /** 打开指定物品的说明（图集未就绪时由 onReady 补刷图标）。 */
  open(itemId: string): void {
    const def = this.deps.items.byId.get(itemId);
    if (def === undefined) return;

    this.titleEl.textContent = def.name;

    // 描述/次要描述（旧项目: 次要描述为 '-' 视同无）。
    // 滚动策略（2026-09-12 用户拍板）: 弹窗高度自适应、上限 430px；标题/图片/主描述
    // 固定不动，**只有次要描述超过 3 行时才在次要描述区域内滚动**——整弹窗滚动会让
    // 背景花纹/图片/标题一起动，视觉极不协调（用户实测反馈）。
    const hasDesc = def.description.trim().length > 0;
    const hasSecondary = def.secondaryDescription.trim().length > 0
      && def.secondaryDescription.trim() !== '-';
    this.bodyEl.innerHTML = '';
    if (hasDesc) {
      const p = document.createElement('div');
      p.className = 'efd-itemdesc-desc';
      p.textContent = def.description;
      this.bodyEl.appendChild(p);
    }
    if (hasSecondary) {
      const p = document.createElement('div');
      p.className = 'efd-itemdesc-secondary';
      p.textContent = def.secondaryDescription;
      this.bodyEl.appendChild(p);
    }
    if (!hasDesc && !hasSecondary) {
      const p = document.createElement('div');
      p.className = 'efd-itemdesc-desc empty';
      p.textContent = '暂无描述信息';
      this.bodyEl.appendChild(p);
    }

    this.visible = true;
    this.root.hidden = false;
    this.applyIcon(itemId);
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
  }

  private applyIcon(itemId: string): void {
    const paint = (): void => {
      if (!this.visible) return;
      this.deps.sprites.itemIconStyle(this.imgEl, itemId, 160, 160);
      this.deps.sprites.applySprites(this.panel);
    };
    paint();
    this.deps.sprites.onReady(paint);
  }
}
