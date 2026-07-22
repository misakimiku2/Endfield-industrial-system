# Phase 文档索引

> **用途**：每个开发 Phase 开始前，把本文件对应章节的内容发给 AI，AI 就知道该加载哪些设计文档、各读哪些章节。避免每次会话都要翻找"这个 Phase 到底要用哪几份文档"。

> **配套**：每个架构文档顶部都标注了 `Phase 归属`（🔵Phase 1 / 🟢Phase 2 / 🟠Phase 3+ / ⚪全局 / 🟣Phase 4），打开文档第一眼就能看到。

---

## 颜色图例

| 图标 | 含义 |
|------|------|
| 🔵 | Phase 1：核心框架（ECS + 渲染 + 设备放置） |
| 🟢 | Phase 2：工厂生产系统（传送带 + 机器生产） |
| 🟠 | Phase 3+：塔防 / 电力 / 高级功能 |
| 🟣 | Phase 4：性能优化（分帧） |
| ⚪ | 全局：不分 Phase，每个 Phase 都要遵守 |

---

## 🔵 Phase 1 开发前要读的文档

Phase 1 目标：建立 ECS + 渲染基础，实现设备放置、相机控制和速度调节。详见 [implementation-phase-1.md](implementation-phase-1.md)。

### 必读（全部内容）

| 优先级 | 文档 | 说明 |
|--------|------|------|
| ⭐⭐⭐ | [A7 core-decisions.md](architecture/core-decisions.md) | 14 条项目宪法。**编码前先通读**，所有代码必须遵守。 |
| ⭐⭐⭐ | [A1 ecs-spec.md](architecture/ecs-spec.md) | ECS 全部（Entity/Component/System/World API）。T1.1 的核心依据。Phase 2 会往里加 System，但框架 Phase 1 全部建好。 |
| ⭐⭐⭐ | [A6 coordinate-spec.md](architecture/coordinate-spec.md) | 全部（Grid↔World↔Screen 转换、Camera）。T1.2 相机、T1.7 放置的核心依赖。 |
| ⭐⭐ | [A5 simulation-spec.md](architecture/simulation-spec.md) | **§1~§4 + §6 + §8**（双时钟架构、GameLoop、速度控制、暂停）。**§5（Tick 内 System 顺序）是 Phase 2 才用，Phase 1 跳过**。 |
| ⭐⭐ | [A2 world-model.md](architecture/world-model.md) | **§1~§2、§4~§5、§7~§8**（Grid/Cell、层级模型、视觉风格、占用表、世界边界）。**§3 Chunk 是 Phase 4 才用，Phase 1 跳过**。 |

### 部分阅读（只读指定章节）

| 文档 | Phase 1 读哪些章节 | Phase 1 跳过哪些 |
|------|------------------|----------------|
| [A3 building-spec.md](architecture/building-spec.md) | ✅ §1 BuildingDefinition、§2 Port 系统、§3.3 方向约定、§3.4 Footprint 占用、§5 建造流程 | ❌ §3 BuildingComponent 的缓冲区字段、§3.1 缓冲区规则、§3.2 轮询规则、§4 状态机（这些都是 Phase 2 生产逻辑） |

> **说明**：A3 是跨 Phase 文档。Phase 1 做设备放置时只需要"建筑长什么样、占几格、Port 在哪、怎么放置"——这些在 §1/§2/§3.3/§3.4/§5。缓冲区、轮询、状态机是 Phase 2 生产才用，Phase 1 不实现。

### 不需要读（Phase 1 用不到）

- A4 item-spec.md（🟢 物品系统，Phase 2）
- A8 production-system-spec.md（🟢 生产系统，Phase 2）
- A9 logistics-spec.md（🟢 物流系统，Phase 2）
- A10 power-system-spec.md（🟠 电力，Phase 3+）

---

## 🟢 Phase 2 开发前要读的文档

Phase 2 目标：传送带能跑物品、机器能根据配方生产、物品从传送带进入机器、产物从机器输出到传送带。详见 [implementation-phase-2.md](implementation-phase-2.md)。

### 必读（全部内容）

| 文档 | 说明 |
|------|------|
| [A7 core-decisions.md](architecture/core-decisions.md) | 宪法，再次通读。 |
| [A4 item-spec.md](architecture/item-spec.md) | 物品定义、Tag 系统、Recipe 配方（多产物/副产物）。T2.3 配方加载的依据。 |
| [A8 production-system-spec.md](architecture/production-system-spec.md) | 生产系统全部（缓冲区槽位、生产计时、端口轮询、状态机）。生产逻辑核心。 |
| [A9 logistics-spec.md](architecture/logistics-spec.md) | 物流系统全部（传送带速度、物品移动、端口触发、堵塞传播、传送带创建系统）。物流核心。 |
| [精炼炉设备说明.md](精炼炉设备说明.md) | 精炼炉的详细行为规范（基础设备模板，所有设备继承）。 |

### 部分阅读

| 文档 | Phase 2 读哪些 | Phase 1 已实现，Phase 2 在此基础上扩展 |
|------|---------------|--------------------------------------|
| [A1 ecs-spec.md](architecture/ecs-spec.md) | 重点看 §3 System（BeltSystem/MachineSystem 的实现规范） | World/Entity/Component 框架已建好 |
| [A5 simulation-spec.md](architecture/simulation-spec.md) | 重点看 **§5 Tick 内 System 顺序、§5.2 设备事件顺序** | GameLoop/速度控制已建好 |
| [A3 building-spec.md](architecture/building-spec.md) | 重点看 **§3 BuildingComponent（缓冲区槽位/计时）、§3.1 缓冲区规则、§3.2 轮询规则、§4 状态机** | Definition/Port/放置已建好 |

### Phase 2 明确排除（不在范围内）

- 液体系统（清水/污水走 liquid 端口）—— Phase 1/2 不实现，赤铜块等液体配方 Phase 2 也不启用
- 物流桥完整交叉逻辑、分流器/汇流器/物品准入口 —— Phase 3
- 电力系统 —— Phase 3+

---

## 下个会话怎么用这个索引

### 如果开始 Phase 1

把下面这段话发给 AI：

> 我要开始 Phase 1 开发。请先读 `doc/phase-docs-index.md` 的"🔵 Phase 1 开发前要读的文档"章节，然后加载里面列出的必读文档（A7/A1/A6/A5/A2 全部 + A3 的指定章节）。读完后我们从 T1.1 ECS 核心完善开始。

### 如果开始 Phase 2

把下面这段话发给 AI：

> 我要开始 Phase 2 开发。请先读 `doc/phase-docs-index.md` 的"🟢 Phase 2 开发前要读的文档"章节，然后加载里面列出的必读文档（A7/A4/A8/A9/精炼炉说明 + A1/A5/A3 的指定章节）。读完后我们从 T2.0 传送带创建系统开始。

---

## 文档总览（完整归属表）

| 文档 | 编号 | Phase 归属 | 一句话 |
|------|------|-----------|--------|
| ecs-spec.md | A1 | 🔵 P1 + 🟢 P2 | ECS 框架（P1）+ 业务 System（P2） |
| world-model.md | A2 | 🔵 P1 + 🟣 P4 | 网格/占用表（P1）+ Chunk 分帧（P4） |
| building-spec.md | A3 | 🔵 P1 + 🟢 P2 | 建筑定义/放置（P1）+ 缓冲区/生产（P2） |
| item-spec.md | A4 | 🟢 P2 | 物品/Tag/配方 |
| simulation-spec.md | A5 | 🔵 P1 + 🟢 P2 | GameLoop/相机/速度（P1）+ Tick 时序（P2） |
| coordinate-spec.md | A6 | 🔵 P1 | 坐标转换/Camera |
| core-decisions.md | A7 | ⚪ 全局 | 14 条宪法 |
| production-system-spec.md | A8 | 🟢 P2 | 生产系统 |
| logistics-spec.md | A9 | 🟢 P2 | 物流/传送带 |
| power-system-spec.md | A10 | 🟠 P3+ | 电力系统 |
