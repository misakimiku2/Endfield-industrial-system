// 传送带选中态共享对象 — T2.0 链管理视觉
//
// 作用: SelectionSystem 每帧写入「当前选中的传送带段 handle 集合」，
//       三个带身渲染器（BeltVectorRenderer 白边、BeltPointerRenderer 隐藏 pointer、
//       BeltSelectionRenderer 屏幕常量斜杠）每帧读取，解耦选中逻辑与渲染。
//
// 设计: 极简可变集合，无渲染依赖（纯数据）。SelectionSystem.update() 每帧 set() 重置。

import type { EntityHandle } from '../../ECS';

/**
 * 传送带选中态。SelectionSystem 写，渲染器读。
 *
 * 单击选中单格 → 集合含 1 个 handle；
 * 双击选中整链 → 集合含该链所有段 handle。
 */
export class BeltSelection {
  private selected: Set<EntityHandle> = new Set();

  /** 重置当前选中段集合（整体替换）。 */
  set(handles: Iterable<EntityHandle>): void {
    this.selected = new Set(handles);
  }

  /** 该段是否处于选中态（渲染器每帧调用）。 */
  has(handle: EntityHandle): boolean {
    return this.selected.has(handle);
  }

  /** 当前选中段数量（HUD/调试用）。 */
  get size(): number {
    return this.selected.size;
  }

  /** 清空（SelectionSystem.clearSelection 时同步调用，立即生效）。 */
  clear(): void {
    this.selected.clear();
  }

  /** 切换某段的选中态（有则移除、无则加入）—— Ctrl 点选用。 */
  toggle(handle: EntityHandle): void {
    if (this.selected.has(handle)) this.selected.delete(handle);
    else this.selected.add(handle);
  }

  /** 当前所有选中段（Delete 批量删用）。 */
  getHandles(): EntityHandle[] {
    return Array.from(this.selected);
  }
}
