# Phase 文档索引

> **用途**：每个开发 Phase 开始前，把本文件对应章节的内容发给 AI，AI 就知道该加载哪些设计文档、各读哪些章节。避免每次会话都要翻找"这个 Phase 到底要用哪几份文档"。

> **配套**：每个架构文档顶部都标注了 `Phase 归属`（🔵Phase 1 / 🟢Phase 2 / 🟠Phase 3+ / ⚪全局 / 🟣Phase 4），打开文档第一眼就能看到。

---

## 颜色图例

| 图标 | 含义 |
|------|------|
| 🔵 | Phase 1：核心框架（✅ 已完成：ECS + 渲染 + 设备放置/选择/删除 + 性能基准） |
| 🟢 | Phase 2：工厂生产系统（传送带 + 机器生产） |
| 🟠 | Phase 3：世界扩展 + 塔防 / 电力（拆分为 3a/3b/3c，见下文） |
| 🟣 | Phase 4：性能优化（分帧） |
| ⚪ | 全局：不分 Phase，每个 Phase 都要遵守 |

> **⚠️ Phase 3 已拆分**：原 Phase 3（塔防 + 电力）装不下"无限世界 + 资源点 + 物流"，按 [A11 world-vision.md](architecture/world-vision.md) 拆为 **3a（Chunk+无限世界+小地图+迷雾）/ 3b（资源点+简化物流）/ 3c（塔防+电力）**。详见下文"🟠 Phase 3 前瞻"。

---

## 🔵 Phase 1（✅ 主体已完成，含 1 项待排期补充任务）

Phase 1（T1.1~T1.10）已全部完成：ECS + 渲染 + 设备放置/选择/删除 + 相机控制
（平移/缩放/边缘滚动/视图旋转）+ 性能基准（100 设备 FPS≥55 与内存监控）。
此章节供回顾实现细节使用，新开发直接从 🟢 Phase 2 开始。详见
[implementation-phase-1.md](implementation-phase-1.md)。

> **✅ T1.11 九宫格设备底座（2026-08-20 实施完成）**：Phase 1 性质的渲染/素材管线基建——
> 设备底座切 9 件（角/边/中）运行时按 footprint 平铺拼装，图集面积与设备尺寸解耦
> （6×6 设备全套层帧 ~45M 像素 vs 九宫格 9 件 ~0.6M 共用）。完整方案见
> [S2 nine-slice-device-base.md](nine-slice-device-base.md)（2026-08-18 T2.8 图集扩容
> 讨论中用户提出，经素材结构核验成立）。**建议 T2.12（Depot 素材启用）前执行**，
> 最晚不迟于第一台 ≥5×5 设备美术立项。

### 必读（全部内容）

| 优先级 | 文档 | 说明 |
|--------|------|------|
| ⭐⭐⭐ | [A7 core-decisions.md](architecture/core-decisions.md) | 14 条项目宪法。**编码前先通读**，所有代码必须遵守。 |
| ⭐⭐⭐ | [A11 world-vision.md](architecture/world-vision.md) | 世界/地图产品方向（无限世界 / 手工核心+程序外围 / Chunk 提前 / 资源点 C 派 / 简化物流 / 小地图迷雾）。**定方向的上位文档**，A2 世界模型受它约束。Phase 1 有一项接口预留改动源自此处（见下）。 |
| ⭐⭐⭐ | [A1 ecs-spec.md](architecture/ecs-spec.md) | ECS 全部（Entity/Component/System/World API）。T1.1 的核心依据。Phase 2 会往里加 System，但框架 Phase 1 全部建好。 |
| ⭐⭐⭐ | [A6 coordinate-spec.md](architecture/coordinate-spec.md) | 全部（Grid↔World↔Screen 转换、Camera）。T1.2 相机、T1.7 放置的核心依赖。 |
| ⭐⭐ | [A5 simulation-spec.md](architecture/simulation-spec.md) | **§1~§4 + §6 + §8**（双时钟架构、GameLoop、速度控制、暂停）。**§5（Tick 内 System 顺序）是 Phase 2 才用，Phase 1 跳过**。 |
| ⭐⭐ | [A2 world-model.md](architecture/world-model.md) | **§1~§2、§4~§5、§7~§8**（Grid/Cell、层级模型、视觉风格、占用表、世界边界）。**§3 Chunk 提前到 Phase 3a（A11 WV-003），Phase 1 跳过**。**§8 世界边界：64×64 是临时方案——`WORLD_*` 常量→地图实例属性改造已在 T1.6 完成（`src/game/world/MapInstance.ts`，A11 WV-003 §4.4）**。 |

### 部分阅读（只读指定章节）

| 文档 | Phase 1 读哪些章节 | Phase 1 跳过哪些 |
|------|------------------|----------------|
| [A3 building-spec.md](architecture/building-spec.md) | ✅ §1 BuildingDefinition、§2 Port 系统、§3.3 方向约定、§3.4 Footprint 占用、§5 建造流程、§2.4 中的 SVG 功能层规范（T1.7 已落地） | ❌ §3 BuildingComponent 的缓冲区字段、§3.1 缓冲区规则、§3.2 轮询规则、§4 状态机、§2.4 中 BuildingView 完整实现（Phase 2 生产逻辑） |
| [asset-drawing-standard.md](asset-drawing-standard.md) | 设备 SVG 绘制规范：`layer-*` 功能层、画布尺寸、命名约定。T1.3/T1.7 涉及素材时必须遵守。 | — |

> **说明**：A3 是跨 Phase 文档。Phase 1 做设备放置时只需要"建筑长什么样、占几格、Port 在哪、怎么放置"——这些在 §1/§2/§3.3/§3.4/§5。缓冲区、轮询、状态机是 Phase 2 生产才用，Phase 1 不实现。

### 不需要读（Phase 1 用不到）

- A4 item-spec.md（🟢 物品系统，Phase 2）
- A8 production-system-spec.md（🟢 生产系统，Phase 2）
- A9 logistics-spec.md（🟢 物流系统，Phase 2）
- A10 power-system-spec.md（🟠 电力，Phase 3+）

### Phase 1 交互范式速查（操作约定汇总）

Phase 1 的操作交互约定分散在各任务章节，此处集中速查。开发任一交互任务前对照此表，避免操作语义冲突。

| 操作 | 任务 | 触发方式 | 备注 |
|------|------|----------|------|
| 相机平移 | T1.2 | 中键拖拽 / WASD / 边缘滚动(T1.5) | WASD + 边缘滚动 **屏幕相对**（视图旋转后不变） |
| 相机缩放 | T1.2 | 滚轮（鼠标为锚） | 不受视图旋转影响 |
| 视图旋转 | T1.5 | Ctrl+R 顺时针 90°，4 态循环 | 改 Camera.viewRotation；旋转不进 ECS |
| 设备放置 | T1.7 | 工具栏选 → 左键确定 | 放置前 R 键旋转预览，**相对视图** |
| 设备选中 | T1.8 | 短按左键（pointerup 提交） | 为 Phase 2 长按移动预留结构 |
| 设备删除 | T1.9 | 选中 + Delete 键 | **不用右键** |
| 性能基准 | T1.10 | 控制台 `__game.spawnBenchmarkDevices(100)` / `fillBenchmarkDevices()` / `runFpsBenchmark()` | 重置式生成（先清空再生成）；HUD 显示 FPS/JS堆/纹理/Sprite |
| 取消放置 | T1.7 | 放置模式右键 / ESC | 右键专留此语义 |

**后续阶段相关**：
- **设备移动（T2.14，Phase 2）**：长按 >300ms 进入移动态 → R 旋转 → 左键重放 / 右键取消。改变已放置设备朝向的唯一入口。
- **多选组操作（Phase 3）**：X 框选 → 组移动/旋转/删除/复制粘贴 → 右键取消多选。

---

## 🟢 Phase 2 开发前要读的文档

Phase 2 目标：传送带能跑物品、机器能根据配方生产、物品从传送带进入机器、产物从机器输出到传送带。详见 [implementation-phase-2.md](implementation-phase-2.md)。

> **进度（2026-08-25 修订）**: T2.0~T2.10、**T2.12** 已完成 ✅（新增: 产线观察层临时读数/物品区分确认；
> 仓库取货口/存货口——无限源/汇、非生产设备、Depot 整图+单层 LOGO+Status 悬停高亮、R 两档朝向；
> **端口轮询**——输入指针轮询/输出活跃队列轮转、堵塞跳过、恢复追加队尾）。
> 同期插入完成 Phase 1 补充任务 T1.11/T1.12（九宫格底座/端口变体）。
> 2026-08-24 玩家模式实测暴露三个缺口——玩家无原料来源 / 传送带终点无对接辅助 / 全部任务卡均为脚本验收无玩家维度
> → **新增 T2.16 终点对接辅助**（挂在 T2.12 之后、T2.13 之前）、**T2.13 验收加"玩家手动搭建"最终关卡**。
> 修订后顺序: 当前任务 **T2.16 终点对接辅助**（T2.10 轮询已完成）→ T2.13 打通验证（含玩家关卡）→ T2.14 设备移动 → T2.15 设备弹窗（弹窗落地时吸收移除 T2.9b 临时读数）。
> T2.11 转角带主体已在 T2.0~T2.8 期间提前实现，剩余 4 方向正式验收并入 T2.13 回归。详见 implementation-phase-2.md 文首「进度与执行顺序（2026-08-24 修订）」。

### 必读（全部内容）

| 文档 | 说明 |
|------|------|
| [A7 core-decisions.md](architecture/core-decisions.md) | 宪法，再次通读。 |
| [A4 item-spec.md](architecture/item-spec.md) | 物品定义、Tag 系统、Recipe 配方（多产物/副产物）。T2.3 配方加载的依据。 |
| [A8 production-system-spec.md](architecture/production-system-spec.md) | 生产系统全部（缓冲区槽位、生产计时、端口轮询、状态机）。生产逻辑核心。 |
| [A9 logistics-spec.md](architecture/logistics-spec.md) | 物流系统全部（传送带速度、物品移动、端口触发、堵塞传播、传送带创建系统）。物流核心。T2.0 重点看 §6（截断/合并/物流桥属后续），§7~§8 先浏览，T2.1/T2.2 再深入。 |
| [精炼炉设备说明.md](精炼炉设备说明.md) | 精炼炉的详细行为规范（基础设备模板，所有设备继承）。 |

### 部分阅读

| 文档 | Phase 2 读哪些 | Phase 1 已实现，Phase 2 在此基础上扩展 |
|------|---------------|--------------------------------------|
| [A1 ecs-spec.md](architecture/ecs-spec.md) | 重点看 §3 System（BeltSystem/MachineSystem 的实现规范） | World/Entity/Component 框架已建好 |
| [A5 simulation-spec.md](architecture/simulation-spec.md) | 重点看 **§5 Tick 内 System 顺序、§5.2 设备事件顺序** | GameLoop/速度控制已建好 |
| [A3 building-spec.md](architecture/building-spec.md) | 重点看 **§3 BuildingComponent（缓冲区槽位/计时）、§3.1 缓冲区规则、§3.2 轮询规则、§4 状态机、§2.4 BuildingView 分层架构**（素材层已备好，Phase 2 直接组合渲染） | Definition/Port/放置已建好；`layer-*` 分层与 `pack-assets.ts` 子帧输出已在 T1.7 完成 |
| [asset-drawing-standard.md](asset-drawing-standard.md) | 新增/修改设备 SVG 时必须遵守的绘制规范 | T1.7 已完成 `3x3_unit.svg` / `refining_unit.svg` 规范化与构建脚本拆层；新增 billboard `layer-logo` |

### Phase 2 明确排除（不在范围内）

- 液体系统（清水/污水走 liquid 端口）—— Phase 1/2 不实现，赤铜块等液体配方 Phase 2 也不启用
- 物流桥完整交叉逻辑、分流器/汇流器/物品准入口 —— Phase 3
- 电力系统 —— Phase 3+
- **多选与组操作（X 框选 + 组移动/旋转/删除 + 复制粘贴，传送带可入组）—— Phase 3**。依赖 T2.14 单设备移动机制作为原型，扩展为组级操作；传送带入组需重建 chainId（与 T2.0 链管理耦合）。

---

## 🟠 Phase 3 前瞻（已定型方向，文档待开写）

> **⚠️ Phase 3 已拆分为 3a/3b/3c**。原 Phase 3（塔防 + 电力）装不下"无限世界 + 资源点 + 远距离物流"，按 [A11 world-vision.md](architecture/world-vision.md) 拆分。三者可顺序做，也可视进度并行。Phase 3 实施计划文档（`implementation-phase-3.md`）尚未创建，开写时按下面三个子 Phase 组织。

### Phase 3a — 世界扩展基建（Chunk + 无限世界 + 小地图 + 迷雾）

> 依据：A11 WV-001 / WV-003 / WV-006

| 产出 | 说明 |
|------|------|
| **Chunk 系统** | 16×16 Cell 分块，按相机视野动态加载/卸载。从原 Phase 4 提前（A11 WV-003）。Chunk 不依赖程序生成。 |
| **无限世界** | 世界向任意方向扩展，无固定边界。Phase 1 的 `MapInstance.widthCells/heightCells` 语义变为"初始已生成区域"。 |
| **占用表/地形表 Chunk 化** | 从全局 Map 改为按 Chunk 存储（A2 §3.2 已预留职责）。 |
| **小地图（Minimap）** | 世界缩放渲染到屏幕角落，只显示已探索区域。支持点击跳转。 |
| **战争迷雾（Fog of War）** | 每 Cell 有 `explored` 状态，玩家视野内标记已探索。小地图只显示已探索区。 |

**关键依赖**：Phase 1 的 `WORLD_*` 常量→地图实例属性改造（A11 WV-003 §4.4）必须已完成。

### Phase 3b — 远征玩法（资源点 + 矿点开采 + 管道）

> 依据：A11 WV-004 / WV-005、A12 EC-008 §11（固/液/气分类传输）、A12 EC-008 §18（矿点开采系统）

| 产出 | 说明 |
|------|------|
| **资源点（矿脉）系统** | C 派定位：出生点附近资源管够，外围稀有资源散落远处。具体分布规则/储量/采集机制开写前细化（A11 §10）。 |
| **矿点开采系统** | 基础采矿机（建矿脉上）+ **短距无线**传至储存站点 + **专用轨道 + 无人货运列车**运至基地储存站 → 自动入全局仓储。后期研发解锁高级采矿机（长距无线回仓，耗电多）。（详见 A11 WV-005 §6.2、A12 §18） |
| **普通管道（液体/气体）** | 液体版传送带，复杂拓扑（分流器/汇流器/准入口/管道桥，与 A9 §10 同构）。占地。 |
| **地下暗管（后期研发解锁）** | 极简 A-B 点对点传输，不占地，有距离上限（参考 300m）。区别于普通管道的独立设备。（详见 A12 §11.7、§17） |

**明确排除（留到 Phase 5+）**：完整火车系统（有人火车，轨道信号/调度/车站，A11 WV-005）。

### Phase 3c — 塔防 + 电力（原 Phase 3 内容）

> 依据：原 Phase 3 计划 + A11 WV-004 §5.2（塔防落在远征前哨防御）

| 产出 | 说明 |
|------|------|
| **塔防系统** | 敌人 + 炮塔 + 索敌 + 射击。玩法落点：远征前哨需要防御（A11 WV-004 §5.2），不是孤立系统。 |
| **电力系统** | 供电桩/中继器/负载/过载断电（A10）。 |

### Phase 3 其他累积功能（跨子 Phase 或独立排期）

以下功能从 Phase 1/2 排除项累积，归属 Phase 3 但具体放哪个子 Phase 待排期：

| 功能 | 来源 | 关键依赖 |
|------|------|----------|
| **多选与组操作**（X 框选 + 组移动/旋转/删除 + 复制粘贴，传送带可入组） | Phase 1 T1.x / Phase 2 T2.x 排除 | T2.14 单设备移动机制（原型）、T2.0 传送带链管理 |
| 物流桥完整交叉逻辑 | Phase 2 排除 | T2.0 传送带创建系统 |
| 分流器/汇流器/物品准人口过滤 | Phase 2 排除 | A9 物流系统 |
| 配方 UI（玩家手动选择配方） | Phase 2 排除 | A8 生产系统 |

> **多选与组操作的设计要点（用户已确认）**：
> - 按 X 进入框选多选模式，拖拽框选范围内的设备 + 传送带形成一个组
> - 对组整体执行移动、旋转、删除、复制粘贴
> - 右键取消已选的多选
> - **传送带入组是完整版**（组操作时重建 chainId 和连接关系），复杂度高于只处理设备
> - 组旋转需选枢轴 + 组内每个成员绕枢轴转 90°（位置+朝向）

---

## 下个会话怎么用这个索引

### 如果回顾 Phase 1（已完成）

Phase 1 已全部完成，无需再走"开始"流程。如需回顾实现或排查 Phase 1 功能，可发：

> 我要回顾 Phase 1 的实现。请读 `doc/phase-docs-index.md` 的"🔵 Phase 1（✅ 已完成，供回顾）"
> 章节与 `doc/implementation-phase-1.md` 各任务的「实现备注」。

### 如果继续 Phase 2（进行中）

把下面这段话发给 AI：

> 我要继续 Phase 2 开发。请先读 `doc/phase-docs-index.md` 的"🟢 Phase 2 开发前要读的文档"章节（含进度注），
> 然后 读 `doc/implementation-phase-2.md` 中 **T2.8 章节与 T2.6/T2.7 的实现笔记**（含一格一物品模型修订、
> 设备弹窗参考旧 Flutter 项目的决定）。读完后我们从 T2.8 开始。

### 如果开始 Phase 2（从 T2.0 重来的场景，一般用不到）

把下面这段话发给 AI：

> 我要开始 Phase 2 开发。请先读 `doc/phase-docs-index.md` 的"🟢 Phase 2 开发前要读的文档"章节，然后加载里面列出的必读文档（A7/A4/A8/A9/精炼炉说明 + A1/A5/A3 的指定章节）。读完后我们从 T2.0 传送带创建系统开始。

---

## 文档总览（完整归属表）

| 文档 | 编号 | Phase 归属 | 一句话 |
|------|------|-----------|--------|
| ecs-spec.md | A1 | 🔵 P1 + 🟢 P2 | ECS 框架（P1）+ 业务 System（P2） |
| world-model.md | A2 | 🔵 P1 + 🟠 P3a + 🟣 P4 | 网格/占用表（P1）+ Chunk 加载/卸载（P3a，A11 提前）+ Chunk 分帧（P4） |
| building-spec.md | A3 | 🔵 P1 + 🟢 P2 | 建筑定义/放置（P1）+ 缓冲区/生产（P2） |
| item-spec.md | A4 | 🟢 P2 | 物品/Tag/配方 |
| simulation-spec.md | A5 | 🔵 P1 + 🟢 P2 | GameLoop/相机/速度（P1）+ Tick 时序（P2） |
| coordinate-spec.md | A6 | 🔵 P1 | 坐标转换/Camera |
| core-decisions.md | A7 | ⚪ 全局 | 14 条宪法 |
| production-system-spec.md | A8 | 🟢 P2 | 生产系统 |
| logistics-spec.md | A9 | 🟢 P2 + 🟠 P3b | 物流/传送带（P2）+ 远距离物流（P3b，A11 WV-005） |
| power-system-spec.md | A10 | 🟠 P3c | 电力系统 |
| **world-vision.md** | **A11** | **⚪ 全局上位** | **世界/地图产品方向（无限世界/资源/物流/小地图）。A2 受其约束。** |
| **economy-vision.md** | **A12** | **⚪ 全局上位（⚠️ 待定型）** | **经济/玩法愿景（人口+探索+市场+创造模式）。⚠️ 大方向备忘，核心选择（探索方式/人口定位/市场角色）待后续会话定型。创造模式（EC-002）已定型。** |
| asset-drawing-standard.md | S1 | ⚪ 全局（🔵 P1 T1.3/T1.7 起用） | 设备 SVG 绘制标准：`layer-*` 功能层、画布尺寸、命名约定 |
| **nine-slice-device-base.md** | **S2** | **🔵 P1 补充（T1.11，✅ 已实施）** | **九宫格设备底座方案：底座切 9 件平铺拼装，图集面积与设备尺寸解耦（2026-08-20 实施：图集回落 4096、像素级还原、含实施记录 §11）** |
| **nineslice-port-variant.md** | **S3** | **🟢 P1 补充（T1.12，✅ 2026-08-21 已实施）** | **九宫格端口变体方案：端口拆独立 port-*(固体,含底板)+emblazon-*(端口间方块)+lport-*(液体,四边)+deco-l/r(无液口侧边装饰) 切片组，def.ports 派生四边类型掩码逐位叠加，部分/无端口/液体侧口设备零美术成本（2026-08-21 实施：精炼炉液口迁出 equipment 0 差异、离线 20/20 + 浏览器探针 21/21；顶/底液体口 def 置位待 A3 端口模型方向×介质拆分）** |

