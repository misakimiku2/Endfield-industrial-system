// 对象池 — 复用子弹/敌人/粒子，避免 GC 抖动

export class ObjectPool<T> {
  private pool: T[] = [];
  private factory: () => T;
  private resetFn: (obj: T) => void;

  constructor(
    factory: () => T,
    resetFn: (obj: T) => void,
    initialSize = 100,
  ) {
    this.factory = factory;
    this.resetFn = resetFn;
    for (let i = 0; i < initialSize; i++) {
      this.pool.push(factory());
    }
  }

  acquire(): T {
    return this.pool.pop() || this.factory();
  }

  release(obj: T): void {
    this.resetFn(obj);
    this.pool.push(obj);
  }

  get size(): number {
    return this.pool.length;
  }

  clear(): void {
    this.pool.length = 0;
  }
}
