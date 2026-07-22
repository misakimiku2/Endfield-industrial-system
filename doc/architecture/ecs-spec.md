# A1 — ECS 设计规范

> **关联决策**: DD-001 (Entity ID), DD-002 (纯数据 Component), DD-006 (系统隔离), DD-011 (状态在 Component)

> **Phase 归属**: 🔵 **Phase 1**（World/Entity/Component 基础框架） + 🟢 **Phase 2**（新增 BeltSystem/MachineSystem 等具体 System）。Phase 1 完成 Entity/Component/World API，Phase 2 往里加业务 System。

---

## 1. Entity

### 1.1 标识

Entity 使用 `{ index: number, generation: number }` 结构。外部通过 `EntityHandle` 引用实体。

```ts
type EntityHandle = number; // 内部编码: (generation << 20) | index

// index: 0 ~ 2^20-1 (约 100 万)
// generation: 0 ~ 2^12-1 (4096 代)
```

外部代码**永远不使用** `index` / `generation` 的裸值，只用 `EntityHandle` 和 World 提供的方法判断有效性。

### 1.2 生命周期

```
createEntity()  →  实体诞生，Handle 有效
   ↓
 [存活期间: 添加/移除 Component]
   ↓
destroyEntity(handle)  →  实体销毁
   ↓
 handle 从此永久无效 (generation 已递增)
```

### 1.3 规则

- **禁止**缓存 `index` 或裸 `number` 作为实体引用
- **允许**缓存 `EntityHandle`（它是值类型，代际自校验）
- **禁止**在使用前检查"这个 handle 还活着吗"之后、使用之前，实体被销毁（TOCTOU 问题由调用方负责：如果你持有一个 handle 并操作它的 Component，说明你确信它活着）

---

## 2. Component

### 2.1 定义

Component 是纯 TypeScript Interface，定义在 `src/game/components/` 下。

```ts
// ✅ 正确: 纯数据接口
export interface Position {
  x: number;
  y: number;
}

export interface LogisticsComp {
  direction: Direction;
  speed: number;
  items: BeltItem[];
}

// ❌ 错误: 包含方法
export interface BadComponent {
  x: number;
  getWorldPos(): { x: number; y: number }; // 禁止!
}
```

### 2.2 规则

| 规则 | 说明 |
|------|------|
| **纯数据** | 只有字段，没有方法、getter、setter |
| **可序列化** | 可以通过 `JSON.stringify` 完整序列化 |
| **不引用 Entity** | Component 的字段不能是 `EntityHandle`（参考 DD-005） |
| **Tag Component** | 可以是一个空 Interface，用作标记（如 `interface Selected {}`） |
| **移除即销毁** | 移除最后一个 Component 不等于销毁实体，需要显式 `destroyEntity` |

### 2.3 结构化 vs 扁平化

Component 嵌套对象是**允许的**，但层级不超过 2 层：

```ts
// ✅ 允许: 一层嵌套
interface LogisticsComp {
  items: { itemId: string; progress: number }[];
}

// ❌ 避免: 深层嵌套
interface BadBelt {
  items: { item: { def: { id: string } }; progress: number }[];
}
```

### 2.4 命名约定

- 文件名: 小写 + 连字符，如 `logistics-comp.ts`, `position.ts`
- Interface 名: PascalCase，如 `LogisticsComp`, `Position`
- Tag Component: 不加 `Comp` 后缀，如 `Selected`（不是 `SelectedComp`）

---

## 3. System

### 3.1 定义

System 是 Class，实现 `update(world: World, dt: number)` 方法。定义在 `src/game/systems/` 下。

```ts
export class BeltSystem {
  update(world: World, dt: number): void {
    const entities = world.query('LogisticsComp', 'Position');
    for (const e of entities) {
      const belt = world.getComponent<LogisticsComp>(e, 'LogisticsComp')!;
      const pos = world.getComponent<Position>(e, 'Position')!;
      // ... 逻辑
    }
  }
}
```

### 3.2 规则

| 规则 | 说明 |
|------|------|
| **不调用其他 System** | 通过读写 Component 通信 (DD-006) |
| **只读/只写** | 声明自己"读哪些 Component，写哪些 Component"——虽然 TypeScript 不强约束，但注释必须标明 |
| **无状态** | System 不应该持有"跨 Tick 的游戏状态"——状态放在 Component 里 (DD-011) |
| **允许内部状态** | System 可以有遍历进度、缓存等"不被序列化"的内部变量 |
| **dt 含义** | `dt` 是**从上次 Tick 到本次 Tick 的毫秒数**（通常 ≈ 50ms @ 20 TPS） |

### 3.3 执行顺序

每个 Simulation Tick 按固定顺序执行（DD-010）：

```
1. BeltSystem         — 物品沿传送带移动
2. MachineSystem      — 机器消耗输入、推进生产进度、产出口
3. TurretSystem       — 索敌、射击
4. EnemySystem        — 沿路径移动、受伤检测
5. CleanupSystem      — 移除死亡实体
```

---

## 4. World API

### 4.1 接口

```ts
class World {
  // 实体
  createEntity(): EntityHandle;
  destroyEntity(handle: EntityHandle): void;
  isAlive(handle: EntityHandle): boolean;
  entityCount(): number;

  // 组件
  addComponent<T>(handle: EntityHandle, key: string, data: T): void;
  getComponent<T>(handle: EntityHandle, key: string): T | undefined;
  hasComponent(handle: EntityHandle, key: string): boolean;
  removeComponent(handle: EntityHandle, key: string): void;

  // 查询
  query(...componentKeys: string[]): EntityHandle[];
}
```

### 4.2 查询性能

- Phase 1 使用最简单的"遍历过滤"实现（适合 < 200 实体）
- Phase 4 如性能需要可升级为订阅模式（维护每个 query 的结果缓存）
- **当前不提前优化**——先实现正确的功能，后用性能数据驱动优化

### 4.3 实体销毁后

`destroyEntity` 的语义：
- 移除该实体的**所有** Component
- 递增该 index 的 generation
- 该 handle 和所有持有它的引用此后**永久无效**
- **不负责**清理引用它的 PixiJS 对象——由 RenderSystem 通过检测 `isAlive` 或监听销毁事件来清理

---

## 5. 事件系统（预留）

当前 Phase 1 不实现事件总线。系统通过"检查 Component 变化"来响应事件。

例如：RenderSystem 每帧对比"上一帧的 query 结果"和"这一帧的 query 结果"，发现新增实体就创建 Sprite，发现消失的实体就销毁 Sprite。

未来如果需要解耦更复杂的事件（如"敌人到达终点 → 扣血 → UI 更新"），再引入事件 Dispatcher。**当前不在 YAGNI 范围内**。
