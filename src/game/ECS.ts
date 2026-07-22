// 轻量 ECS 核心 — Entity-Component-System
// 支撑 300-500 实体 60FPS（Phase 1 目标 100 实体）
//
// 设计依据:
//   A1 ecs-spec.md  — World/Entity/Component/System API
//   A7 DD-001       — Entity ID generation-based，外部只用 EntityHandle
//   A7 DD-002       — Component 纯数据
//
// Handle 编码 (A1 §1.1): (generation << 20) | index
//   index       : 0 ~ 2^20-1 (~104 万)  —— 低位 20 bit
//   generation  : 0 ~ 2^12-1  (4096 代)  —— 高位 12 bit
// 外部代码永远只用 EntityHandle，不接触裸 index/generation。

/** 实体引用。内部编码 (generation<<20)|index，对调用方不透明。 */
export type EntityHandle = number;

const INDEX_BITS = 20;
const INDEX_MASK = (1 << INDEX_BITS) - 1; // 0xFFFFF
const GENERATION_MASK = 0xfff; // 12 bit

const encodeHandle = (generation: number, index: number): EntityHandle =>
  ((generation & GENERATION_MASK) << INDEX_BITS) | (index & INDEX_MASK);

const decodeIndex = (handle: EntityHandle): number => handle & INDEX_MASK;
const decodeGeneration = (handle: EntityHandle): number =>
  (handle >>> INDEX_BITS) & GENERATION_MASK;

/**
 * World 持有全部 Entity 与 Component 数据，是 System 的唯一读写对象 (A1 §4)。
 *
 * Entity 槽位可复用（freelist 回收 index），但每销毁一次 generation 递增，
 * 使旧 handle 永久失效 (DD-001)。组件存储按 index 键入，销毁时清空该 index
 * 的全部组件，因此槽位复用时组件自然从零开始。
 */
export class World {
  /** 并行数组: generations[index] = 该槽位的当前代数（已回绕到 12 bit）。 */
  private readonly generations: number[] = [];
  /** 并行数组: aliveFlags[index] = 该槽位当前是否存活。 */
  private readonly aliveFlags: boolean[] = [];
  /** 回收的 index 队列；createEntity 优先从这里取。 */
  private readonly freeIndices: number[] = [];
  /** 存活实体计数（= aliveFlags 中 true 的数量）。 */
  private liveCount = 0;

  /** componentKey -> (index -> data)。按 index 键入以便销毁时整槽清空。 */
  private readonly components = new Map<string, Map<number, unknown>>();

  // ───────────────────────── 实体生命周期 ─────────────────────────

  createEntity(): EntityHandle {
    let index: number;
    if (this.freeIndices.length > 0) {
      index = this.freeIndices.pop()!;
    } else {
      index = this.generations.length;
      this.generations.push(0);
      this.aliveFlags.push(false);
    }
    const generation = this.generations[index];
    this.aliveFlags[index] = true;
    this.liveCount++;
    return encodeHandle(generation, index);
  }

  /**
   * 销毁实体 (A1 §4.3):
   *   - 移除该实体的所有 Component
   *   - generation 递增（12 bit 回绕）→ handle 永久失效
   *   - 不负责清理引用它的 PixiJS 对象（由 RenderSystem 处理）
   */
  destroyEntity(handle: EntityHandle): void {
    if (!this.isAlive(handle)) return; // 已销毁/无效，幂等无操作

    const index = decodeIndex(handle);
    // 1. 清空该 index 的全部组件
    for (const store of this.components.values()) {
      store.delete(index);
    }
    // 2. generation 递增（回绕），旧 handle 从此失效
    this.generations[index] = (this.generations[index] + 1) & GENERATION_MASK;
    this.aliveFlags[index] = false;
    this.liveCount--;
    this.freeIndices.push(index);
  }

  /** handle 是否仍指向存活实体 (DD-001 代数校验)。 */
  isAlive(handle: EntityHandle): boolean {
    const index = decodeIndex(handle);
    if (index >= this.aliveFlags.length) return false;
    if (!this.aliveFlags[index]) return false;
    // 代数不匹配 → 旧 handle 指向已被复用的槽位
    return this.generations[index] === decodeGeneration(handle);
  }

  entityCount(): number {
    return this.liveCount;
  }

  // ───────────────────────── Component ─────────────────────────

  addComponent<T>(handle: EntityHandle, key: string, data: T): void {
    if (!this.isAlive(handle)) {
      throw new Error(`addComponent: 实体已销毁或 handle 无效 (key=${key})`);
    }
    const index = decodeIndex(handle);
    let store = this.components.get(key);
    if (!store) {
      store = new Map();
      this.components.set(key, store);
    }
    store.set(index, data as unknown);
  }

  getComponent<T>(handle: EntityHandle, key: string): T | undefined {
    if (!this.isAlive(handle)) return undefined;
    return this.components.get(key)?.get(decodeIndex(handle)) as T | undefined;
  }

  hasComponent(handle: EntityHandle, key: string): boolean {
    if (!this.isAlive(handle)) return false;
    return this.components.get(key)?.has(decodeIndex(handle)) ?? false;
  }

  removeComponent(handle: EntityHandle, key: string): void {
    if (!this.isAlive(handle)) return;
    this.components.get(key)?.delete(decodeIndex(handle));
  }

  /**
   * 查询同时拥有全部指定 Component 的存活实体 (A1 §4.2)。
   * Phase 1 用最简单的遍历过滤（< 200 实体足够），选最小 store 作为迭代基底。
   */
  query(...keys: string[]): EntityHandle[] {
    if (keys.length === 0) return [];

    // 取出各 store，任一缺失或为空 → 无结果
    const stores: Map<number, unknown>[] = [];
    let smallest: Map<number, unknown> | null = null;
    for (const key of keys) {
      const store = this.components.get(key);
      if (!store || store.size === 0) return [];
      stores.push(store);
      if (!smallest || store.size < smallest.size) smallest = store;
    }

    const result: EntityHandle[] = [];
    const base = smallest!;
    base.forEach((_data, index) => {
      // base 中的 index 必然 alive（销毁时已清空组件），但防御性检查 alive flag
      if (!this.aliveFlags[index]) return;
      // 校验其它 store 是否都含该 index
      let hasAll = true;
      for (let i = 0; i < stores.length; i++) {
        if (stores[i] === base) continue;
        if (!stores[i].has(index)) {
          hasAll = false;
          break;
        }
      }
      if (hasAll) {
        result.push(encodeHandle(this.generations[index], index));
      }
    });
    return result;
  }
}
