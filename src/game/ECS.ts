// 轻量 ECS 核心 — Entity-Component-System
// 支撑 300-500 实体 60FPS

export type Entity = number;

export class World {
  private entities: Entity[] = [];
  private nextId: Entity = 0;
  private components: Map<string, Map<Entity, unknown>> = new Map();

  createEntity(): Entity {
    const id = this.nextId++;
    this.entities.push(id);
    return id;
  }

  removeEntity(entity: Entity): void {
    const idx = this.entities.indexOf(entity);
    if (idx !== -1) this.entities.splice(idx, 1);
    for (const store of this.components.values()) {
      store.delete(entity);
    }
  }

  addComponent<T>(entity: Entity, key: string, data: T): void {
    if (!this.components.has(key)) {
      this.components.set(key, new Map());
    }
    this.components.get(key)!.set(entity, data);
  }

  getComponent<T>(entity: Entity, key: string): T | undefined {
    return this.components.get(key)?.get(entity) as T | undefined;
  }

  hasComponent(entity: Entity, key: string): boolean {
    return this.components.get(key)?.has(entity) ?? false;
  }

  removeComponent(entity: Entity, key: string): void {
    this.components.get(key)?.delete(entity);
  }

  query(...keys: string[]): Entity[] {
    const sets = keys.map(k => new Set(this.components.get(k)?.keys() || []));
    return this.entities.filter(e => sets.every(s => s.has(e)));
  }

  get entityCount(): number {
    return this.entities.length;
  }
}
