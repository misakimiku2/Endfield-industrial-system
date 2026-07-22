# 生产逻辑重新设计：删除"加工位"，改为完成时扣除

## 背景与核心变更

参照《明日方舟：终末地》游戏原版，生产**没有"加工位"这个设定**。新模型：

> **生产期间原料始终躺在输入缓冲区里，不被扣除；只有当生产时间走完那一刻，才发生原子操作：输入槽 -N、输出槽 +M。**

以精炼炉"晶体外壳"配方（源矿×1 → 晶体外壳×1，2s），缓冲区 3 个源矿为例：
- 旧模型：T=0 扣 1 源矿（3→2）"转入加工位"，T=2s 产出。生产期间显示 2。
- 新模型：T=0 只启动计时（缓冲区仍 3），T=2s 时 3→2 同时产出 1 晶体外壳。生产期间显示 3，到点才掉。

## 已确认的 6 项设计决策

| 决策 | 结论 |
|------|------|
| 计时器归属 | **删除加工位概念**，`currentRecipeId`/`progress`/`elapsed` 并入 `BuildingComponent` |
| 扣除时机 | **完成时扣除**（原子操作：输入 -N + 输出 +M 同时发生） |
| 输入缓冲区 | **N 个独立槽位**，每槽锁一种物品，槽位数 = 设备配方所需固体原料最大种类数（可自由组合，如 2进1出、1进2出） |
| 输出缓冲区 | **M 个独立槽位，一槽一物**（与输入对称） |
| 液体 | **走专用 liquid 端口，不占物品槽**；Phase 1 不实现液体 |
| 槽位容量 | 每槽 50（沿用现状） |

## 各设备最终槽位数（扫 recipe.csv 92 条配方得出）

| 设备 | 固体输入槽 | 固体输出槽 | 说明 |
|------|----------|----------|------|
| 精炼炉 | 1 | 1 | 赤铜块的清水(入)/污水(出)走液体端口(Phase 2) |
| 粉碎机/配件机/塑形机/采种机 | 1 | 1 | 纯单原料 |
| 种植机 | 1 | 1 | 清水走液体端口(Phase 2) |
| 装备原件机/灌装机/封装机/研磨机/反应池/天有洪炉 | 2 | 1 | 多数有双固体原料 |

## 牵连的 6 个文件 + 改动

### 1. `production-system-spec.md`（改动最大）
- **§1.1 首批设备参数表**：新增"输入槽数/输出槽数"两列（按上表），把原来的"输入缓冲区 1(上限50)"语义升级为"固体输入槽 ×N"。
- **§3 加工位系统 → 改为"生产计时系统"**：删除 `ProcessingSlot` 接口；改为说明计时字段已并入 `BuildingComponent`，附完整的新 `BuildingComponent` 代码块引用。重写生产规则：**开始时不扣原料只启动计时；完成时才扣输入+加输出**。
- **§3.2 加工完成条件**：保留 progress 逻辑，但"完成"的副作用改为原子扣除。
- **§5.4 生产触发**：把"扣除原料→启动任务"改为"检查原料充足→启动计时（不扣）"。
- **§6 状态机**：`BLOCKED` 语义变化说明（阻塞时原料仍在缓冲区未被扣，输出有空间后才完成扣除+产出）。更新状态转换条件表里"扣除"措辞。
- **§7 Tick 内执行顺序 / §7.1**：阶段 1 从"扣除原料→启动新任务"改为"完成则原子结算(扣输入+加输出)→若原料充足则启动新计时"。
- **§8 规则总结**："加工位独一无二"→"单设备单计时器"。

### 2. `building-spec.md`
- **§3 BuildingComponent 接口**：重写为多槽位模型：
  ```ts
  interface BufferSlot { itemId: string | null; count: number; }  // null=空槽未锁定
  interface BuildingComponent {
    definitionId: string;
    direction: 0|90|180|270;
    state: BuildingState;
    // 生产计时（原 ProcessingSlot 字段，无独立接口）
    currentRecipeId: string | null;   // null = 空闲
    progress: number;                  // 0~1
    elapsed: number;                   // ms
    // 缓冲区（每槽一种物品，长度由 BuildingDefinition 决定）
    bufferInput:  BufferSlot[];
    bufferOutput: BufferSlot[];
    inputPollIndex: number;
    outputPollIndex: number;
    // 删除 lockedInputType（锁定信息已内含在每个槽的 itemId≠null 中）
  }
  ```
  删除 `bufferInputCapacity`/`bufferOutputCapacity`/`lockedInputType` 三个字段（容量下沉到 BuildingDefinition 每槽 50，锁定改为槽内 itemId 是否为 null）。
- **§1 BuildingDefinition**：新增 `inputSlotCount`/`outputSlotCount`/`bufferCapacity`(默认50) 字段；给各设备填正确槽数。
- **§3.1 缓冲区规则**：重写为"每槽独立锁定一种物品，槽空则解锁"。
- **§3.2 轮询规则**：把 `lockedInputType` 改为"对应槽位的 itemId"。
- **§5 建造流程**：BuildingComponent 初始化代码块更新（去掉旧字段，加 currentRecipeId/elapsed，bufferInput/Output 初始化为空槽数组）。
- 精炼炉 `ports` 里已有的 liquid 端口保留（Phase 2+），补一句说明液体产物走液体端口不占物品槽。

### 3. `精炼炉设备说明.md`（这是基础设备模板，改动量大）
- 重写"描述"段：把"加工位""立即扣除原料"等全部改掉。改为：精炼炉有 1 固体输入槽+1 固体输出槽；生产期间原料在输入槽；2s 计时完成后一次性扣源矿+产晶体外壳。
- 重写"加工位规则"整节 → 改为"生产计时规则"。
- 补充"液体端口"说明：清水(入)/污水(出)走液体端口，Phase 1 不实现，Phase 1 精炼炉只支持固体配方（晶体外壳/蓝铁块/紫晶纤维/碳块等 8 个）。
- 保留输入/输出轮询、缓冲区锁定规则的描述，但措辞改为"槽位"。

### 4. `simulation-spec.md`
- **§5.2 设备内部事件顺序**：阶段 1 第 2 步"产物移入输出缓冲区"→改为"原子结算：扣输入+加输出"；第 3 步"扣除原料→启动新加工任务"→"原料充足则启动新计时"。
- **§5.1 说明文字**：调整"阶段 1: 设备内部状态更新（加工位进度...）"→"（计时进度...）"。

### 5. `item-spec.md`
- **§6.1.2 副产物机制**：更新最后一段关于 BuildingComponent 的描述（缓冲区现在是多槽位 BufferSlot[]，副产物占独立的输出槽；赤铜块的污水走液体端口，Phase 2）。
- **§6.2 配方示例表**：赤铜块那行的副产物标注补充"（污水，走液体端口，Phase 2）"。

### 6. `《...项目开发总文档.md` + `implementation-phase-2.md`
- 总文档 §5.1 表格 A8 描述："缓冲区/加工位/端口轮询/状态机"→去掉"加工位"。
- 总文档 §5.3 的 `BuildingComponent` 代码块、§5.4 的 MachineSystem 注释：同步新字段、去"加工位"措辞。
- Phase 2 文档：
  - 核心链路图："加工位(2秒生产→...)"→"计时器(2秒→...)"
  - 依赖图：T2.5 "加工位循环"→"生产计时循环"
  - **T2.4 输入缓冲区**：验收标准里"lockedType"改为"槽位锁定"，描述改为多槽位
  - **T2.5 任务标题**："加工位与生产循环"→"生产计时与生产循环"；验收标准更新（原料在生产期间仍在缓冲区，完成时才扣）
  - 主文档 §9.4 依赖图里的"T2.5 加工位"同步改名

## 不改动的部分
- `recipe.csv` 数据本身（配方、原料、副产物列）完全不动——这次只改生产逻辑的"机制描述"，数据驱动层不受影响。
- `ecs-spec.md`、`world-model.md`、`coordinate-spec.md`、`power-system-spec.md`、`logistics-spec.md` 物品移动部分基本不动（logistics 只需把 §3.3/§3.6 里 `lockedInputType` 改为"对应槽位 itemId"措辞）。
- core-decisions.md 不动（DD-003/011 反而支持这次重构）。

## 一个需要你知晓的连带影响（不改代码，只标注）
`赤铜块`配方（赤铜矿+清水→赤铜块+污水）因清水/污水是液体，**Phase 1 精炼炉无法生产**。Phase 1 精炼炉只跑 8 个纯固体配方。赤铜块标记为"Phase 2 液体系统完成后启用"。我会在 item-spec 和精炼炉说明里明确标注这点。

## 执行顺序
1. building-spec.md（数据结构源头，先定 BuildingDefinition + BuildingComponent 新接口）
2. production-system-spec.md（核心生产逻辑）
3. 精炼炉设备说明.md（模板设备说明）
4. simulation-spec.md（Tick 时序）
5. item-spec.md（副产物与槽位关系）
6. logistics-spec.md（小改：lockedInputType 措辞 → 槽位 itemId）
7. 总文档 + implementation-phase-2.md（同步措辞、任务名）
8. 全文验证：grep 确认"加工位/ProcessingSlot/lockedInputType"残留为 0（历史说明性文字除外）

全部是文档修改，不碰任何代码。改完后 Phase 1/2 的设计文档将统一为新生产模型。