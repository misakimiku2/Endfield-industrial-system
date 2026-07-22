# A5 — 仿真规范

> **关联决策**: DD-004 (20 TPS vs 60 FPS), DD-010 (System 执行顺序), DD-014 (Frame Budget)

> **Phase 归属**: 🔵 **Phase 1**（§1~§4 双时钟架构、GameLoop、速度控制——Phase 1 即实现 0×~8×） + 🟢 **Phase 2**（§5 Tick 内 System 顺序、设备事件时序——生产/物流跑起来才用到）。

---

## 1. 双时钟架构

```
┌─────────────────────────────────────┐
│          Simulation Clock           │
│            20 TPS (50ms)            │
│                                     │
│  BeltSystem → MachineSystem →       │
│  TurretSystem → EnemySystem →      │
│  CleanupSystem                      │
└─────────────────────────────────────┘
              ↓ 状态变化
┌─────────────────────────────────────┐
│          Render Clock               │
│            60 FPS (~16.7ms)         │
│                                     │
│  RenderSystem.update()  ← 读取      │
│  最新的 Component 状态               │
└─────────────────────────────────────┘
```

### 1.1 关键点

- Simulation 更新**所有** System 后才通知 Render
- Render 在两次 Simulation Tick 之间可能运行多次（60 FPS vs 20 TPS = 3:1）
- Render 读取的 Component 状态是**上一个完整 Tick 结束后的快照**——不存在"半个 Tick"的中间状态

---

## 2. GameLoop 实现

```ts
class GameLoop {
  private simAccumulator = 0;
  private readonly SIM_STEP = 50; // ms per tick @ 20 TPS
  private world: World;
  private systems: System[];

  constructor(world: World, systems: System[]) {
    this.world = world;
    this.systems = systems;
  }

  // 每渲染帧调用一次
  update(frameDeltaMS: number): void {
    // === 仿真阶段 ===
    this.simAccumulator += frameDeltaMS;

    // 防止螺旋式追赶：如果累积超过 5 个 Tick (250ms)，跳过
    if (this.simAccumulator > 250) {
      this.simAccumulator = 250;
    }

    while (this.simAccumulator >= this.SIM_STEP) {
      this.simAccumulator -= this.SIM_STEP;
      this.tick(); // 执行一个逻辑 Tick
    }

    // === 渲染阶段 ===
    // RenderSystem 在请求下一帧时由 PixiJS 自动调用
    // 或由独立的 renderSystem.update() 处理
  }

  private tick(): void {
    for (const system of this.systems) {
      system.update(this.world, this.SIM_STEP); // dt = 50ms
    }
  }
}
```

### 2.1 PixiJS 集成

```ts
// 方案 1: 使用 PixiJS Ticker
app.ticker.add((ticker) => {
  gameLoop.update(ticker.deltaMS);
});

// 方案 2: 手动 requestAnimationFrame (Phase 1 推荐——更可控)
function animate() {
  gameLoop.update(/* 计算真实 deltaMS */);
  app.render();
  requestAnimationFrame(animate);
}
```

---

## 3. 固定 dt 的意义

每个 `system.update(world, dt)` 中的 `dt` **始终为 50ms**。System 不需要处理变长 dt：

```ts
class BeltSystem {
  update(world: World, dt: number): void {
    // dt 始终 ≈ 50
    // 物品每 Tick 移动: speed * dt (像素/Tick)
    // 不需要做 deltaTime 归一化
  }
}
```

这保证了：
- 逻辑可复现（同一存档同一 Tick 总是同一结果）
- 未来可支持 replay（只记录输入，重放仿真）
- 多人同步的基础（所有客户端跑同一 Tick）

---

## 4. 速度控制

```ts
class GameLoop {
  speedMultiplier = 1; // 1×, 2×, 4×, 8×

  // 每模拟帧执行 tickCount 次
  private tickCountPerRender(): number {
    return this.speedMultiplier; // 1× = 1 tick, 8× = 8 ticks per frame load
  }

  // 实际: 保持 SIM_STEP = 50ms，改变 simAccumulator 的上限
  // 2× 时每 3 个渲染帧执行 6 个 tick (= 20ms real time per tick)
  // 8× 时每帧最多执行 8 个 tick，受螺旋追赶保护上限约束
}
```

### 4.1 速度挡位

| 档位 | 说明 |
|------|------|
| **0×** | 暂停。Tick 停止，渲染继续（相机可操作） |
| **1×** | 默认速度，每 Tick 50ms 真实时间 |
| **2×** | 每 Tick 25ms 真实时间 |
| **4×** | 每 Tick 12.5ms 真实时间 |
| **8×** | 最快速度，每 Tick 6.25ms 真实时间 |

所有挡位在 Phase 1 即可使用。倍速实现方式为累积更多的 simAccumulator，单 Tick 内的逻辑不受影响（DD-004 保证固定 dt=50ms）。

螺旋追赶保护上限（250ms）在不同速度下保持一致，防止长时间高倍速导致"追赶崩溃"。

---

## 5. Tick 内 System 执行顺序（重申 DD-010）

```
0. PowerSystem        — 供电计算 + 设备供电状态判定（Phase 3+ 实现；Phase 1~2 此位为空，所有设备假定供电）
1. BeltSystem         — 先移动所有传送带上的物品
2. MachineSystem      — 检查输入，推进进度，产出口
3. TurretSystem       — 索敌 + 射击（创建子弹 Entity）
4. EnemySystem        — 沿路径移动 + 受到伤害
5. CleanupSystem      — 删除 HP ≤ 0 的 Entity
```

### 5.1 为什么这个顺序

- PowerSystem 在最前（Phase 3+）→ 设备进入 working 前已确认供电状态。Phase 1~2 简化：PowerSystem 不存在，所有设备假定供电（详见 A10 §8）
- BeltSystem 先运行 → 物品到达机器 → MachineSystem 可以检测到新到达的输入
- TurretSystem 先于 EnemySystem → 本 Tick 射击在本 Tick 造成伤害（即时反馈）
- CleanupSystem 最后 → 保证被销毁的实体不会在其他 System 中被访问

### 5.2 设备内部事件顺序（每个 Tick 内）

虽然仿真使用固定 20 TPS，但每个 Tick 内设备的处理需要遵循精炼炉说明中的"事件顺序"：

```
每个 Tick (50ms) 内，BeltSystem 和 MachineSystem 的处理按以下三级顺序：
```

**阶段 1 — 设备内部状态更新（MachineSystem 前半）**
1. 若有生产计时：progress += 50ms（elapsed += 50ms）
2. 如果计时完成（progress >= 1.0）→ 检查输出槽：
   - 有空间 → **原子结算**：扣输入槽原料 + 向输出槽加入产物（同一 Tick 内同时完成）→ 清空计时
   - 无空间 → 进入 blocked 状态（不结算，原料继续停留在输入槽）
3. 若计时已清空，检查输入槽是否满足配方 → 满足则启动新计时（**不扣原料**）

**阶段 2 — 输入物流处理（BeltSystem）**
1. 所有传送带段上的物品前进
2. 物品 progress 到达 0.5 → 检测连接端口
3. 设备输入槽有空位 → 物品传入
4. 设备输入槽满 → 物品停在段尾

**阶段 3 — 输出物流处理（MachineSystem 后半）**
1. 输出槽有物品 → 按轮询顺序尝试输出到连接传送带
2. 传送带接收 → 物品从输出槽移除
3. 传送带堵塞 → 跳过该端口

**为什么是这个顺序**（解释）：
- 设备先完成自身状态变化（计时完成、原子结算），再处理输入输出
- 传送带先移动物品，设备后接收——保证"本 Tick 到达的物品在本 Tick 进入设备"
- 设备先处理输出，再处理输入（在 Tick 维度上分三段，但不是严格的 1→2→3，因为 MachineSystem 被拆成了前后两半）

实际实现方式：
```
tick() {
  // 阶段 1: 所有设备的内部状态更新
  for (const machine of machines) {
    machine.updateInternal(dt);  // 计时推进, 计时完成→原子结算, 配方匹配→启动计时
  }

  // 阶段 2: 所有传送带的物品移动
  beltSystem.update(world, dt);  // 物品前进 + 段尾传输

  // 阶段 3: 所有设备的输出处理
  for (const machine of machines) {
    machine.processOutput();  // 输出槽 → 传送带
  }
}
```

---

## 6. 暂停

```ts
gameLoop.paused = true; // Tick 停止，但渲染继续（相机可操作）
```

暂停时：
- `gameLoop.update()` 仍然被调用（保持渲染）
- `tick()` 不被调用
- RenderSystem 照常运行（相机平移/缩放仍然工作）

---

> **关于"事件驱动"的说明**
>
> 精炼炉说明中提到"不存在固定的检测周期，设备发生事件时立即执行"。
>
> 在实现层面，这并不与固定 20 TPS 矛盾：
> - 仿真 Tick 仍然是固定的 50ms（DD-004）
> - "事件"是指在一个 Tick 内，设备按照固定的事件处理顺序执行
> - 所谓的"立即"是指在同一个 Tick 内完成响应，不需要跨 Tick 等待
> - 例如：计时完成 → 同一 Tick 内立即结算（扣输入 + 加输出）并尝试匹配新配方，不需要等下一个 Tick
>
> 未来的连续生产过程可以考虑"子 Tick 步进"优化，但 Phase 1 保持每个 Tick 全量处理。

---

## 7. 分帧处理

当前 Phase 1 每个 System 在单 Tick 内完整处理其所有 Entity。Phase 4 如遇到性能问题可升级为分帧：

```ts
// Phase 4 分帧示例（Phase 1 不实现）
class BeltSystem {
  private batchIndex = 0;
  private readonly BATCH_SIZE = 20;

  update(world: World, dt: number): void {
    const entities = world.query('LogisticsComp', 'Position');
    const start = this.batchIndex * this.BATCH_SIZE;
    const end = Math.min(start + this.BATCH_SIZE, entities.length);

    for (let i = start; i < end; i++) {
      this.processOne(world, entities[i], dt);
    }

    this.batchIndex = (end >= entities.length) ? 0 : this.batchIndex + 1;
  }
}
```

**分帧与 DD-004 的交互**：如果 500 条传送带在单 Tick 内无法处理完（超过 50ms），分帧意味着跨越多个 Tick 处理。这破坏了"一个 Tick 内传送带物品都移动一次"的语义。需要额外设计——**留到 Phase 4 再讨论**。

---

## 8. 规则

| 规则 | 说明 |
|------|------|
| **dt 恒定** | System.update 的 dt 始终为 50ms |
| **顺序不变** | Tick 内 System 执行顺序永不改变 |
| **Render 读快照** | 渲染读取的是上一个完整 Tick 结束后的状态 |
| **暂停不停渲染** | 即使 paused，RenderSystem 和相机系统继续运行 |
| **Phase 1 不分帧** | 100 个实体时能在 50ms 内全部处理完 |
