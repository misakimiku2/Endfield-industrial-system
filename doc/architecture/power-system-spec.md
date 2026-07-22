# A10 — 电力系统规范

> **关联决策**: DD-003 (数据驱动), DD-010 (System 执行顺序), DD-011 (状态在 Component)

> **Phase 归属**: 🟠 **Phase 3+**（完整电力网络——供电桩/中继器/负载/过载断电）。Phase 1~2 使用简化模型（所有设备假定供电，无能耗约束）。电力系统本质是"产线跑通后"的约束条件，因此放在生产/物流系统验证完成之后再实现。

---

## 1. 概述

电力系统是游戏内设备的能源供给体系。所有生产设备都有耗电峰值（单位：W），由电力设备（供电桩、中继器等）提供覆盖范围内的无线供电。

```
  ┌──────────┐     供电范围         ┌──────────┐
  │ 供电桩    │ ──── 12×12 ──────→ │ 精炼炉    │
  │ (2×2)    │                     │ (5W)      │
  └──────────┘                     └──────────┘
       │                              ┌──────────┐
       │ 中继 ─── 80m ──→ ┌─────┐    │ 粉碎机    │
       └─────────────────→│中继器│──→│ (5W)      │
                          └─────┘    └──────────┘
```

### 1.1 基本概念

| 概念 | 说明 |
|------|------|
| **电力设备** | 能产生或传输电力的设备（供电桩、中继器、电池） |
| **耗电设备** | 需要电力才能工作的设备（精炼炉、粉碎机、配件机等） |
| **供电范围** | 电力设备覆盖的方形区域（以设备 footprint 中心为原点） |
| **电力网络** | 由多个电力设备组成的供电/中继网络 |
| **总负载** | 供电范围内所有耗电设备的 powerConsumption 之和 |
| **峰值功率** | 供电桩的最大供电能力（默认 100W，Phase 3+ 可配置） |

---

## 2. 电力设备定义

### 2.1 PowerPylonDefinition

```ts
interface PowerPylonDefinition {
  id: string;                    // 唯一标识
  name: string;                  // 显示名称
  footprint: { w: number; h: number };  // 占地
  coverageRange: number;         // 供电范围（单元格数）
  maxPowerOutput: number;        // 最大供电功率 (W)
  isRelay: boolean;              // 是否为纯中继设备（不发电，仅传电）
  description: string;
}
```

### 2.2 首批电力设备

从 `doc/csv/终末地设备 - 电力.csv` 提取：

```ts
const POWER_DEFINITIONS: Record<string, PowerPylonDefinition> = {
  electric_pylon: {
    id: 'electric_pylon',
    name: '供电桩',
    footprint: { w: 2, h: 2 },
    coverageRange: 12,           // 12×12 单元格供电范围
    maxPowerOutput: 100,         // 默认供电能力
    isRelay: false,
    description: '通电后可给较大范围内的终末地设备无线供电。',
  },
  xiranite_pylon: {
    id: 'xiranite_pylon',
    name: '息壤供电桩',
    footprint: { w: 2, h: 2 },
    coverageRange: 12,
    maxPowerOutput: 200,
    isRelay: false,
    description: '集成核心区域的特殊供电设备，可进行范围供电与短距离电力传输。',
  },
  relay_tower: {
    id: 'relay_tower',
    name: '中继器',
    footprint: { w: 3, h: 3 },
    coverageRange: 7,
    maxPowerOutput: 0,           // 纯中继，不产生电力
    isRelay: true,
    description: '可在80m范围内完成电力配给的中继设备，只能进行电力传输。',
  },
  xiranite_relay: {
    id: 'xiranite_relay',
    name: '息壤中继器',
    footprint: { w: 3, h: 3 },
    coverageRange: 7,
    maxPowerOutput: 0,
    isRelay: true,
    description: '可在集成核心区域外自动连接协议核心与息壤电力设备。',
  },
  thermal_bank: {
    id: 'thermal_bank',
    name: '热能电池',
    footprint: { w: 2, h: 2 },
    coverageRange: 0,
    maxPowerOutput: 50,
    isRelay: false,
    description: '储能设备，可在供电不足时补充功率缺口。',
  },
};
```

---

## 3. 耗电设备

### 3.1 耗电字段

所有耗电设备的 `BuildingDefinition` 已有 `powerConsumption` 字段（单位 W）。

**各设备耗电汇总：**

| 设备 | 耗电 (W) | 设备 | 耗电 (W) |
|------|----------|------|----------|
| 精炼炉 | 5 | 提纯机 | 50 |
| 粉碎机 | 5 | 扩容反应池 | 100 |
| 配件机 | 20 | 天有洪炉 | 50 |
| 塑形机 | 10 | 反应池 | 50 |
| 采种机 | 10 | 拆解机 | 20 |
| 种植机 | 20 | 研磨机 | 50 |
| 协议储存箱 | 5 | 封装机 | 20 |
| 储液罐 | 0 | 灌装机 | 20 |
| 仓库存货口 | 0 | 装备原件机 | 10 |
| 仓库取货口 | 0 | | |

传输带物流设备（传送带、分流器等）默认 **不耗电**。

### 3.2 功耗模式

设备在 idle 状态下仍消耗 `powerConsumption × 0.1` 的待机功耗。在 working 状态下满功耗运行。

```ts
function getDevicePowerDemand(component: BuildingComponent): number {
  const def = BUILDING_DEFINITIONS[component.definitionId];
  if (!def) return 0;
  switch (component.state) {
    case 'idle':    return def.powerConsumption * 0.1;
    case 'working':  return def.powerConsumption;
    case 'blocked':  return def.powerConsumption * 0.5;  // 阻塞时降功耗
    case 'no_power': return 0;
  }
}
```

---

## 4. 电力网络

### 4.1 网络构成

电力网络由以下元素构成：

```
协议核心 (Phase 3+)
     │
     ├── 供电桩 ── 覆盖一定范围的无线供电
     │                 │
     │                 └── 覆盖范围内的所有耗电设备
     │
     └── 中继器 ── 将电力传输到更远范围
                      │
                      └── 中继器覆盖范围内的耗电设备
```

### 4.2 覆盖范围

电力设备（供电桩）以自身为中心，覆盖一个方形区域。

```ts
// 供电桩在 (gx, gy) 位置，覆盖 x±range, y±range 的方形区域
function getCoverageArea(gx: number, gy: number, range: number): GridRect {
  return {
    minX: gx - range, maxX: gx + range + footprint.w,
    minY: gy - range, maxY: gy + range + footprint.h,
  };
}
```

中继器可以延展供电距离：

```
供电桩 ──(距离≤80格)──→ 中继器 ──(距离≤80格)──→ 耗电设备
                                  └──(中继器自身覆盖 7×7)
```

### 4.3 连接规则

- 每个电力设备维护一个 `connectedTo: EntityHandle | null`
- 供电桩自动连接范围内的耗电设备
- 中继器需要连接到供电桩或其他中继器
- 中继器只能传输电力，不产生电力
- 耗电设备可以同时被多个供电桩覆盖 → 负载均衡

---

## 5. 功率管理

### 5.1 功率计算

```ts
interface PowerGrid {
  source: EntityHandle;         // 供电设备
  totalCapacity: number;        // 总供电能力
  currentLoad: number;          // 当前总负载
  connectedDevices: EntityHandle[];  // 覆盖范围内的耗电设备
}

// 每个供电 Tick 计算当前负载
function updatePowerGrid(grid: PowerGrid, world: World): void {
  grid.currentLoad = 0;
  for (const device of grid.connectedDevices) {
    if (!world.isAlive(device)) continue;
    const building = world.getComponent<BuildingComponent>(device, 'BuildingComponent');
    if (building) {
      grid.currentLoad += getDevicePowerDemand(building);
    }
  }
}
```

### 5.2 供电判定

```ts
function isDevicePowered(
  device: EntityHandle,
  grids: PowerGrid[],
  world: World
): boolean {
  // 设备只要被任意一个供电充足（load ≤ capacity）的网格覆盖即可
  for (const grid of grids) {
    if (grid.connectedDevices.includes(device)) {
      if (grid.currentLoad < grid.totalCapacity) {
        return true;  // 供电充足
      }
    }
  }
  return false;  // 无可用供电
}
```

### 5.3 过载

当供电范围内总负载超过总供电能力时发生过载：

| 负载比例 | 效果 |
|----------|------|
| ≤ 100% | 所有设备正常工作 |
| 100% ~ 120% | 所有设备降功耗运行（效率 80%） |
| > 120% | 部分设备进入 no_power 状态（按优先级断电） |

断电优先级（数字越小越优先保留）：
1. 电力设备自身（供电桩/中继器）
2. 防御类设备（炮塔）
3. 生产类设备（熔炉、组装机等）
4. 物流类设备（传送带不耗电，但暗管等）

### 5.4 负载均衡

当设备被多个供电桩同时覆盖时，按以下规则分配：
- 优先使用剩余容量最大的供电桩
- 当一个供电桩过载时，尝试将部分设备切换到同区域内其他供电桩
- 如果所有覆盖的供电桩都过载，按优先级断电

---

## 6. ECS 组件

### 6.1 PowerConsumerComponent

```ts
// 耗电设备的电力组件
interface PowerConsumerComponent {
  currentDemand: number;    // 当前需求量 (W)
  isPowered: boolean;       // 当前是否通电
  priority: number;         // 断电优先级 (1=最高)
  connectedPylon: EntityHandle | null;  // 连接的供电设备
}
```

### 6.2 PowerSourceComponent

```ts
// 供电设备的电力组件
interface PowerSourceComponent {
  maxOutput: number;     // 最大供电能力 (W)
  currentLoad: number;   // 当前负载 (W)
  coverageCells: GridPos[];  // 覆盖的所有 Cell
  connectedDevices: EntityHandle[];  // 当前连接的耗电设备
  connections: EntityHandle[];       // 连接的中继器/上级供电
}
```

### 6.3 PowerRelayComponent

```ts
// 中继设备的电力组件
interface PowerRelayComponent {
  connectedSource: EntityHandle | null;    // 上级供电
  connectedDevices: EntityHandle[];        // 覆盖的耗电设备
  coverageCells: GridPos[];                // 覆盖的所有 Cell
}
```

---

## 7. PowerSystem

### 7.1Tick 内执行位置

PowerSystem 应在所有生产系统之前执行，确保设备在进入 working 前已确认供电状态。

```
PowerSystem  ← 新增，在第 0 位
  ↓
BeltSystem
  ↓
MachineSystem
  ↓
TurretSystem
  ↓
EnemySystem
  ↓
CleanupSystem
```

### 7.2 实现

```ts
class PowerSystem {
  update(world: World, dt: number): void {
    // 1. 更新所有供电设备的覆盖范围
    // 2. 更新供电网络的连接拓扑
    // 3. 计算每个网络的负载
    // 4. 判定每个耗电设备的供电状态
    // 5. 断电设备 → state = no_power
    // 6. 恢复设备 → state = idle/working
  }
}
```

---

## 8. Phase 1~2 简化模型

Phase 1~2 暂不实现完整的电力网络。使用简化方案：

```ts
// Phase 1~2: 所有设备假定供电
// PowerSystem 不存在（Tick 内第 0 位为空，直接从 BeltSystem 开始）
// BuildingComponent.state 不会进入 no_power
```

```ts
// 在 BuildingComponent 中
powerConsumption: number;  // 仍携带该字段（数据保留，供 Phase 3+ 使用）
// 但在 Phase 1~2 中不处理
```

**为什么 Phase 1~2 不实现电力系统：**
- 电力网络的核心价值是"多条产线并行时的能源约束"，本质是一个**限制条件**
- Phase 1 只有设备放置，Phase 2 才把单条产线跑通——在没有验证"产线本身能正确运转"之前引入电力约束，会让调试变复杂（无法区分是产线逻辑 bug 还是断电导致的不工作）
- **正确顺序**：先让产线在"无限供电"假设下跑通（Phase 2），再把电力作为约束叠加进去（Phase 3+）
- 完整电力系统还需要供电桩放置、覆盖范围可视化（供电范围指示器）等 UI 支持，工作量较大

---

## 9. 规则总结

| 规则 | 说明 |
|------|------|
| **电力设备数据驱动** | PowerPylonDefinition 与 BuildingDefinition 平行 |
| **无线供电** | 供电桩/中继器以自身为中心的方形范围供电，不是布线 |
| **Phase 1~2 简化** | 所有设备假定供电，powerConsumption 字段保留但不处理 |
| **过载断电** | 负载超过供电能力时按优先级断电 |
| **中继不发电** | 中继器只传输电力，不产生电力 |
| **待机功耗** | idle 状态有 10% 的待机功耗 |
| **Phase 3+ 启动** | 电力系统在 Phase 3 与塔防/地形系统同期实现（产线已跑通后再叠加能源约束） |
