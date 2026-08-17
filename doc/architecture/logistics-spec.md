# A9 — 物流系统规范

> **关联决策**: DD-003 (数据驱动), DD-004 (20 TPS), DD-009 (三层坐标), DD-010 (System 执行顺序)

> **Phase 归属**: 🟢 **Phase 2**（传送带速度/物品移动/端口触发/堵塞传播/传送带创建系统——物流系统，Phase 2 的核心）。Phase 1 不实现传送带。

---

## 1. 传送带基础

### 1.1 定义

传送带是 1×1 的基础物流设备，单向传输物品。

```ts
interface BeltDefinition {
  id: string;                    // "belt", "fast_belt"（Phase 2+）
  name: string;                  // "传送带"
  speed: number;                 // 0.5 格/秒
  direction: Direction;          // 4 朝向
  cellSize: 1;                   // 占地 1×1
}
```

### 1.2 速度

- 传送带速度：**0.5 单元格/秒**
- 在 CELL_SIZE=64px、20 TPS 的设定下：
  - 每 Tick (50ms) 移动距离：32px/s × 0.05s = **1.6px**
  - 跨过一整格 (64px) 需要：**2 秒**
- 一个格子内可以同时有多个物品以流水线形式排列

---

## 2. 传送带上的物品

### 2.1 BeltItem

```ts
interface BeltItem {
  itemId: string;
  progress: number;  // 0.0 ~ 1.0，在该段传送带上的位置
}
```

每一段传送带独立追踪自己上面的物品队列。

### 2.2 物品移动

每个 Simulation Tick：

```ts
for (const item of beltComp.items) {
  item.progress += (beltSpeed / CELL_SIZE) * SIM_STEP;
  // beltSpeed = 32（0.5 格/秒）
  // SIM_STEP = 50ms
  // item.progress += (32 / 64) * 0.05 = 0.025 per tick
}
```

物品完成一整段传送带需要 40 个 Tick（2 秒）。

### 2.3 物品间距与多物品共存

> **修订（2026-08-17 用户澄清）**: 一格传送带只承载**一个**物品（"箭头"或"物品"二选一）。
> 最小间距由 0.25 格（1/4 格）改为 **1 格**：同段 `items[]` 实际至多 1 件；跨段跟随 =
> 队首推进不得越过下游段最近物品的 progress（世界间距恒 ≥ 1 格，整链 lockstep 流动）；
> 跨段进入条件由"入口间距足"改为"**下游段为空**"；堵塞形态 = 每格一件、全部停在格中心 0.5
> （§3.1-B 的 0.99 段尾停止随之统一为 0.5 格中心）。吞吐 1 件/格 × 0.5 格/秒 = 每 2 秒 1 件，
> 与配方节拍一致。以下原文保留作历史记录。

- **一条传送带（逻辑链）的每一格都可以是不同类型的物品**。例如一条 A-B-C-D-E-F 的传送带链，A 格放源矿、B 格放蓝铁块、C 格放紫晶纤维……完全允许。物品类型不需要统一。
- 每个 Cell（物理段）独立维护自己的 `items[]` 队列，每个物品各自追踪自己的 `progress`。
- 物品之间必须保持"最小间距"（防止视觉重叠）。最小间距用 progress 差值衡量：**同一段内**相邻两个物品的 `progress` 差不得小于 `MIN_ITEM_GAP`（Phase 2 取 `0.25`，即 1/4 格）。
- 后方物品不能越过前方物品：若后方物品前进后会小于 MIN_ITEM_GAP，则被前方物品"夹住"，progress 停在 `前物品.progress - MIN_ITEM_GAP`。
- 前方物品进入下游段/被吸入设备后消失 → 后方物品恢复前进。
- `lockedInputType`（设备输入槽锁定类型）不影响传送带本身：不同类型物品可以在传送带上自由排队，只有到达设备输入端口时才受设备输入槽锁定机制约束。

### 2.4 堵塞时的最小间距

> **修订（2026-08-17 一格一物品模型，随 §2.3）**: 堵塞排队 = 每格一件停在格中心，不再有
> 同段密集队列。跨段跟随由队首推进钳制保证（不得越过下游段最近物品的 progress）。

当首物品停在段尾（见 §3）时，后方物品依次被夹住，形成密集排队队列。队列中的物品 progress 互不相同，渲染时各自显示在自己的位置上。跨段排队时，上游段末尾的物品与下游段首位的物品之间也需满足最小间距（按两段的 progress 换算到世界坐标距离判断）。

---

## 3. 物品的停止点与堵塞

> **修订（2026-08-17 一格一物品模型，随 §2.3）**: 停止点统一为**格中心 0.5**——
> 本节原文的"段尾中心 0.99"已废弃（T2.6 起 STOP_MAX=0.5 是唯一停止点: 端口吸入触发、
> 断头堵塞、满带堆放同点）。堵塞形态 = 每格一件、全部停在格中心，跨段进入条件 = 下游段为空。
> 以下原文保留作历史记录。

### 3.1 两种停止点

物品在传送带上的停止位置分两种情况：

| 情况 | 物品停止位置 | 触发条件 |
|------|-------------|---------|
| **A. 端口停止（被设备吸入）** | 格子中心（`progress = 0.5`） | 传送带末端连接设备输入端口，设备缓冲区有空位 |
| **B. 段尾停止（堵塞）** | 段尾中心（`progress = 0.99`） | 下列任意一种：① 末端是断头传送带（未连接任何设备）；② 连接的设备缓冲区已满；③ 连接的设备无法生产（如断电、配方不匹配且缓冲区满） |

### 3.2 停止点坐标

- **格子中心**指传送带段所在 Cell 的几何中心（worldX + CELL_SIZE/2, worldY + CELL_SIZE/2）。
- **段尾中心**：直线传送带的段尾 = 出口方向那一侧的格子边缘中点。具体计算见 §5.3.2 `getItemWorldPos` 中 `progress = 0.99` 的位置（接近边缘但未跨出）。
- 物品 progress 上限钳制为 `0.99`，避免视觉上"穿出"格子边界。

```ts
// 移动物品后钳制
item.progress = Math.min(item.progress, 0.99);
```

### 3.3 端口吸入（情况 A）

> **修订（2026-08-17 用户确认 → 同日预约制实现 ✅）**: 吸入消失点为**设备输入端口格的中心**（视觉
> "走进设备"，以 `精炼炉设备说明.md` 为准）；堵塞时物品停在**供给格**（不进设备）。已实现为
> **预约制两阶段**：
>
> - **预约（0.5 供给格中心）**：progress 到 0.5 且槽可接受 → 输入槽 count+1（即占用）+ 物品标记
>   `entering=true` **保留在段上**（`IntakeOps.tryAbsorbHeadItem`，判定点 = `BeltSystem.STOP_MAX`）；
> - **放行（1.5 端口格中心）**：entering 物品被 BeltSystem 放行推进（`PORT_ENTER_DONE = STOP_MAX + 1.0`），
>   到达 1.5 从段 `items[]` 移除消失（`IntakeOps.releaseArrivedItems`；MachineSystem 每 Tick **先放行再预约**）；
> - **堵塞不变**：槽满/类型不符 → 物品停在供给格中心 0.5（STOP_MAX 语义不变，§3.1-A 停止点 = 预约判定点）。
>
> 实现细节见 implementation-phase-2.md T2.6「吸入点=端口格中心」。以下原文保留作历史记录。

当传送带末端连接设备输入端口时：

- 物品 progress 到达 **0.5**（格子中心）→ 触发输入检测
- 设备存在可接受该物品的输入槽（槽空可锁定新类型，或槽已锁定同类型且未满）→ **物品从传送带 `items[]` 中移除，该输入槽 count + 1**
- 设备所有输入槽都已满 **或** 无可接受的槽（物品类型不匹配）→ 物品继续前进到段尾，停在 `progress = 0.99`

### 3.4 堵塞与逆流传播（情况 B）

当首物品因 §3.1 情况 B 停在段尾后：

```
下游设备满 → 首物品停在 progress=0.99
        ↓
后方物品被 §2.3 的最小间距规则夹住，依次排队
        ↓
本段被"塞满"（无 progress 空位）→ 上游传送带的段尾传输也失败
        ↓
上游段尾物品停在 0.99 → 上游也开始排队
        ↓
堵塞逆流向源头传播
```

### 3.5 堵塞解除

下游设备输入槽消耗/腾出空间（count < 50）→ 设备恢复接收能力 → 段尾物品被吸入 → 本段腾出空间 → 上游恢复流动。

### 3.6 传入设备的副作用

物品传入设备时：

1. 物品从传送带的 `items[]` 中移除
2. 对应的输入槽 count + 1
3. 如果该输入槽此前为空 → 锁定该物品类型（设置该槽的 `itemId`）

---

## 4. 方向系统

### 4.1 4 朝向

```ts
type Direction = 0 | 90 | 180 | 270;
// 0° = 朝右(→), 90° = 朝下(↓), 180° = 朝左(←), 270° = 朝上(↑)
```

### 4.2 连接规则

传送带的连接由方向和邻接隐式决定：

```
传送带 A (方向→右) 的右侧相邻 Cell 有传送带 B (方向→右)
→ 物品从 A 流向 B

传送带 A (方向→右) 的右侧相邻 Cell 是设备的输入端口
→ 物品从 A 进入设备

设备的输出端口相邻 Cell 有传送带 B (方向→右)
→ 物品从设备进入 B
```

### 4.3 显式连接（Phase 2+）

未来引入：玩家可手动连接/断开传送带段之间的连接，即使它们相邻但仍可选择不连接。

---

## 5. 美术资源

### 5.1 纹理资产

所有传送带相关的 SVG 源文件存储在 `src/assets/svg/`：

| 文件名 | 类型 | 用途 |
|--------|------|------|
| `Transport_Belt_Move.svg` | 直线传送带（垂直方向） | 基础直线段，其他 3 方向通过旋转获得 |
| `Transport_Belt_rotate.svg` | 转角传送带（方向 ↑→） | L 形转弯段，其他 3 种转角通过旋转获得 |
| `pointer.svg` | 方向指示器 | 空载时在传送带上移动的箭头，显示传输方向 |

传送带纹理为 64×64 像素，灰色底色 + 黄色内带。

### 5.2 方向指示器（Pointer）

#### 5.2.1 概念

当传送带上没有物品时，方向指示器（`pointer.svg`）沿传送带移动，用于直观显示该段传送带的传输方向。

```
┌──────────┐
│          │     ████████████████████████████
│ 灰色带身  │     ██  ██  ██  ██  ██  ██  ██  ← 黄色传送带
│          │     ████████████████████████████
│   ▶      │     ↑ pointer 在该位置上移动
└──────────┘
```

#### 5.2.2 规则

- pointer 是**纯视觉效果**，不是实体、不是物品、不参与任何物流逻辑
- pointer 只在传送带 **items[] 为空**时显示
- 当第一个物品进入传送带时，pointer 立即隐藏
- 当最后一个物品移出传送带时，pointer 恢复显示
- pointer 的移动速度和逻辑与物品完全相同（0.5 格/秒，沿方向移动）
- pointer 居中于传送带表面（中心线上）
- 多个物品在传送带上时，pointer 不显示

> Pointer 状态相关字段（`items`, `pointerProgress`）属于 `LogisticsComp`，完整定义见 **§7.2**。这里仅列出 Pointer 行为依赖的字段：
>
> ```ts
> // LogisticsComp 中与 Pointer 相关的字段（完整定义见 §7.2）
> items: BeltItem[];        // 空数组时显示 pointer
> pointerProgress: number;  // pointer 当前位置 0.0~1.0
> type: 'straight' | 'corner';      // 传送带类型（直线/转角）
> cornerDir?: string;               // 转角方向，如 "up_right"（Phase 2+）
> ```

#### 5.2.3 Pointer 移动

```ts
// 在 BeltSystem 中
function updatePointer(logi: LogisticsComp, dt: number): void {
  logi.pointerProgress += (logi.speed / CELL_SIZE) * dt;
  if (logi.pointerProgress >= 1.0) {
    logi.pointerProgress = 0.0;  // 循环，不走出入段尾
  }
}
// 只在 items.length === 0 时渲染
```

### 5.3 传送带渲染

#### 5.3.1 分层

每个传送带 Entity 渲染两个 Sprite：
1. **传送带本体**（Sprite）— 使用对应的 SVG 纹理，静态不移动
2. **Pointer / 物品**（Sprite）— 动态移动，二者互斥显示

#### 5.3.2 直线传送带位置

```ts
function getItemWorldPos(
  beltPos: { x: number; y: number },
  direction: Direction,
  progress: number
): { x: number; y: number } {
  const offset = progress * CELL_SIZE;
  switch (direction) {
    case 0:   return { x: beltPos.x + offset, y: beltPos.y + CELL_SIZE / 2 };
    case 90:  return { x: beltPos.x + CELL_SIZE / 2, y: beltPos.y + offset };
    case 180: return { x: beltPos.x + CELL_SIZE - offset, y: beltPos.y + CELL_SIZE / 2 };
    case 270: return { x: beltPos.x + CELL_SIZE / 2, y: beltPos.y + CELL_SIZE - offset };
  }
}
```

物品和 pointer 都绘制在传送带表面的中心线上（y 偏移半格）。

#### 5.3.3 传送带纹理旋转

- `Transport_Belt_Move.svg` 是**垂直方向**的直线传送带
- 其他方向通过旋转获得：
  - 0°（→）：旋转 90°
  - 90°（↓）：不旋转（垂直）= 原始纹理
  - 180°（←）：旋转 270°
  - 270°（↑）：旋转 180°

```ts
// 从方向获取纹理旋转角度
function getBeltTextureRotation(direction: Direction): number {
  // Transport_Belt_Move.svg 是垂直(↓)方向
  switch (direction) {
    case 0:   return 90;   // → = 旋转90°
    case 90:  return 0;    // ↓ = 不旋转
    case 180: return 270;  // ← = 旋转270°
    case 270: return 180;  // ↑ = 旋转180°
  }
}
```

### 5.4 转角传送带（Phase 2 实现）

#### 5.4.1 转角定义

`Transport_Belt_rotate.svg` 是方向 **↑→** 的转角传送带（从下往上进入，向右转出）。

```ts
interface CornerBeltDef {
  entryDir: Direction;   // 进入方向
  exitDir: Direction;    // 出口方向
  texture: string;       // 纹理 key
  rotation: number;      // 纹理旋转角度
}

const CORNER_DEFINITIONS: Record<string, CornerBeltDef> = {
  up_right:     { entryDir: 270, exitDir: 0,   texture: 'belt_corner', rotation: 0 },
  right_down:   { entryDir: 0,   exitDir: 90,  texture: 'belt_corner', rotation: 90 },
  down_left:    { entryDir: 90,  exitDir: 180, texture: 'belt_corner', rotation: 180 },
  left_up:      { entryDir: 180, exitDir: 270, texture: 'belt_corner', rotation: 270 },
};
```

#### 5.4.2 转角路径

转角上的物品/pointer 沿弧形路径移动，不是直线。

```ts
function getCornerItemWorldPos(
  beltPos: { x: number; y: number },
  cornerType: string,  // 'up_right' etc.
  progress: number     // 0.0~1.0
): { x: number; y: number } {
  // 沿 90° 扇形弧线插值
  const angle = (progress * Math.PI) / 2;  // 0~90°
  const radius = CELL_SIZE / 2;             // 弧线半径
  const centerX = beltPos.x + CELL_SIZE / 2;
  const centerY = beltPos.y + CELL_SIZE / 2;

  switch (cornerType) {
    case 'up_right':
      return {
        x: centerX + radius * Math.sin(angle),  // 从下到右
        y: centerY + radius * Math.cos(angle),
      };
    // 其他方向通过旋转对称得到
  }
}
```

#### 5.4.3 转角物品传入/传出

- 转角段尾（progress ≥ 1.0）的物品传入 entryDir 的反方向的相邻 Cell
- 转角段的物品从 entryDir 方向的相邻 Cell 传入（即物品只能在入口方向接收到物品）

```
示例 (↑→):
               输出 → 连接到右方相邻 Cell
               │
          ┌────▼────┐
入口从下方 ←│  ↑→转角  │
  连接到   │         │
  下方相邻  └─────────┘
  Cell
```

---

## 6. 传送带创建与编辑系统

> **关联规则**: DD-003 (数据驱动), DD-009 (三层坐标)
>
> **设计原则**: 传送带是玩家从设备输出端开始"画"出来的，而不是像设备那样从工具栏单点放置。传送带的创建有严格的方向约束和几何约束，目的是保证物品流动逻辑的正确性并避免美术穿模。
>
> **Phase 2 实现范围**: 本章节描述传送带创建与编辑的**完整规范**。其中 **T2.0 传送带创建系统** 先实现基础创建、延申、删除与高亮；截断、合并、物流桥交叉等高级编辑留到 T2.0 之后的任务。具体范围见 [implementation-phase-2.md](../implementation-phase-2.md) 的 T2.0 章节。

### 6.1 创建起点约束

**所有传送带必须从设备的输出端口（或仓库取货口）发起创建，或从已有断头传送带的末端延申**。玩家不能在空地上凭空放置独立传送带。

T2.0 的入口规则：玩家按 `E` 进入**全局传送带创建模式**，无需先选中设备。进入模式后，设备输出端口和断头传送带末端会高亮，点击高亮格作为路径起点。

```
按 E 进入创建模式 ──→ 输出端口/断头末端高亮 ──→ 点击起点格 ──→ 移动鼠标预览路径 ──→ 点击目标格落盘
```

允许的创建起点：

| 起点 | 说明 | T2.0 范围 |
|------|------|----------|
| 设备 Output Port 所在 Cell | 所有生产设备的输出端口、仓库取货口（Depot Unloader） | ✅ T2.0 |
| 已有传送带的末端 Cell（断头传送带） | 延申创建，见 §6.3 | ✅ T2.0 |
| 已有传送带的中间 Cell（非末端） | 截断创建，见 §6.4 | ⏳ T2.0 之后 |

### 6.2 传送带链（Chain）的概念

为了同时满足"延申视为一条传送带"和"ECS 单实体管理"，引入 **Chain（链）** 概念：

- **物理层**：每个 Cell 上的传送带段是一个独立 ECS Entity（拥有自己的 `Position` + `LogisticsComp`）。这样物品移动、堵塞、视口剔除都按段处理，逻辑简单且性能好。
- **逻辑层**：属于同一次创建/延申操作的所有段共享一个 `chainId`。玩家选中任意一段 → 高亮整条链；删除时可选"删除单段"或"删除整链"。

**链的方向可变（L 形链）**：

一条逻辑链不要求所有段方向一致。延申时允许转弯，因此一条链可以是任意折线形状（→→→↑↑、→↓→ 等）。**每段独立存储自己的 `direction`**，物品流经转弯段时方向随之改变。

```
示例：原链 →→→，延申转弯后变成 →→→↑↑（L 形）

  [设备] → A → B → C
                  ↑
                  D
                  ↑
                  E（末端）

  这 5 段（A~E）共享同一个 chainId，是"一条传送带"。
  A/B/C 的 direction = 0（→），D/E 的 direction = 270（↑）。
```

```ts
interface LogisticsComp {
  // ... 原有字段 ...
  chainId: string;           // 所属链 ID（同一次创建/延申的所有段共享）
  segmentIndex: number;      // 在链中的顺序索引（从源头 0 开始递增）
  isChainHead: boolean;      // 是否为链的源头段（紧邻设备输出端口）
  isChainTail: boolean;      // 是否为链的末端段（断头，无下游连接）
}
```

> **T2.0 临时组件**: T2.0 为了聚焦创建逻辑，可先使用更细粒度的 `BeltSegmentComp`（记录 `chainId`/`direction`/`isCorner`/`isTail`）和 `BeltLinkComp`（记录 `prev`/`next`/`sourcePort`）。T2.1/T2.2 物品移动时再与 §7.2 的 `LogisticsComp` 统一。

**链的合并与分裂**：

- 延申创建 → 新段继承原链 `chainId`，`segmentIndex` 接续递增（T2.0 实现）
- 截断创建 → 原链在截断点分裂为两条独立链（下游链重新分配 `chainId`，见 §6.4）⏳ T2.0 之后
- 合并创建 → 把一条孤立链接入另一条链的末端，合并 `chainId`（见 §6.4.1）⏳ T2.0 之后

### 6.3 延申创建（Extend）

**操作**：处于传送带绘制模式时，点击一条断头传送带的末端 Cell。

**规则**：

1. 新段必须从断头末端**沿原方向**或**垂直方向**延申（见 §6.5 方向约束）。
2. 新段创建后：
   - 继承原链的 `chainId`
   - `segmentIndex = 原末端段.segmentIndex + 1`
   - 原末端段的 `isChainTail` 改为 `false`，新段 `isChainTail = true`
3. 延申后，**整条链在逻辑上视为一条传送带**（虽然物理上是多个 Entity）。
4. 新段的 `direction` 由玩家在绘制时指定（鼠标移动方向决定）。

### 6.4 截断创建（Split） ⏳ T2.0 之后

**操作**：处于传送带绘制模式时，点击一条已有传送带的**中间** Cell（非末端）。

**语义**：原传送带在截断点被**物理切断**为两条互不相干的链（上下游），同时在截断点垂直引出一条新的分支链。截断后，下游链与原传送带（含上游链和新分支链）**完全断开一切逻辑联系**，成为一条孤立的传送带。

**具体行为**：

1. 玩家点击链中第 N 段（`segmentIndex = N`）。
2. 原链分裂为：
   - **上游链**（原链的 segmentIndex 0~N）：保留原 `chainId`，第 N 段变为末端段（`isChainTail = true`）。
   - **下游链**（原链的 segmentIndex N+1~末尾）：分配**新的 `chainId`**，重新编号 segmentIndex 从 0 开始。此链从此**孤立**——它不再有源头设备供给物品，也不会接收来自上游/分支链的任何物品。
3. 在第 N 段所在 Cell **垂直方向**引出新链，新链继承上游链的 `chainId`（即新分支与上游同属一条逻辑链）。
4. **物品处理**：
   - 截断时已经走过截断点、位于下游链上的物品：**继续沿下游链前进**，到达下游链末端后停留（变成断头堵塞）。它们与上游链、新分支链再无任何交互。
   - 截断点处的物品及后方物品（在上游链上）：进入新创建的垂直分支链。

**示例（A-B-C-D-E-F 链）**：

```
截断前：物品源头是 A，当前 A-B-C-D-E 上都有物品（物品队列正好走到 E）

  [设备] → A → B → C → D → E → F（末端）

玩家在 C 处截断，向上（↑）创建新分支：

截断后：

  [设备] → A → B → C（上游链末端）← 上游链 + 新分支同属一条逻辑链
                      ↑
                     C1 → C2 → ...（新垂直分支链）

  D → E → F（孤立下游链，新 chainId）
   ↑
  D、E 上的物品继续向 F 方向前进，到 F 后停留（断头）
  这条链与上面的上游链 + 分支链完全无关，不会接收任何新物品
```

**关键性质**：

- 下游链（D-E-F）成为**孤立的断头传送带**。它上面已有的物品会自然流到末端后停留，但不会再生新物品。
- 玩家后续可通过 §6.4.1 的"合并创建"把这条孤立链重新接入别的传送带网络。

### 6.4.1 合并创建（Merge） ⏳ T2.0 之后

**操作**：处于传送带绘制模式时，正在延申的链末端**恰好接触到一条孤立传送带的起点段**（`isChainHead = true` 且该段所在 Cell 与当前延申末端相邻、方向对接）。

**语义**：把孤立链接入当前链，二者合并为**一条完整的传送带**（共享 `chainId`）。

**规则**：

1. 仅当被合并的链是**孤立的断头传送带**（其 `isChainHead` 段不连接任何设备）时才允许合并。如果被合并链的源头仍连着设备，则禁止合并（避免一个设备同时供给两条链造成歧义）。
2. 合并时：
   - 孤立链的所有段 `chainId` 改为当前链的 `chainId`
   - 孤立链各段的 `segmentIndex` 接续当前链递增
   - 当前链原末端段的 `isChainTail` 改为 `false`，孤立链的末端段成为新的 `isChainTail`
3. 方向必须对接：当前链末端的输出方向必须指向孤立链起点段的输入方向（即两段方向一致或构成合法的转弯连接）。

**示例（接续 §6.4 的 D-E-F 孤立链）**：

```
截断后产生孤立链 D→E→F。玩家从别处延申一条新链 X→Y，Y 的末端恰好接到 D：

合并前：
  [设备A] → ... → X → Y          （chainId = "chain_new"）
  D → E → F                       （chainId = "chain_orphan"，孤立）

  Y 末端方向 → 指向 D，D 方向也是 →，方向对接 ✓

合并后：
  [设备A] → ... → X → Y → D → E → F   （全部 chainId = "chain_new"，一条完整传送带）
```

**为什么需要合并创建**：截断产生的孤立下游链并非废数据——玩家可能只是临时拆分产线做调整，随后通过合并把它重新接入网络。合并让传送带的编辑具备"可逆性"，避免截断=永久删除下游。

### 6.5 方向约束

传送带是单向的，创建时方向受限：

| 创建类型 | 允许的方向 | 禁止的方向 | T2.0 范围 |
|---------|-----------|-----------|----------|
| **延申创建** | 沿原方向继续；或垂直于原方向（90° 转弯） | 反向（逆流方向） | ✅ T2.0 |
| **截断创建** | 仅垂直于原链方向 | 原方向（顺流/逆流均禁止，因为原链已占用） | ⏳ T2.0 之后 |

**示例**（原链方向 →）：

- 延申：可向 →（继续直行）、↑、↓ 创建
- 延申：**不可**向 ← 创建（逆流）
- 截断：只能向 ↑ 或 ↓ 创建（垂直分叉）
- 截断：**不可**向 ← 或 → 创建

### 6.6 防穿模约束（设备避让）

传送带不能横穿设备的占用 Cell。当从设备输出端创建传送带时，必须绕开设备本体。

**规则**：

1. 创建前检查新段所在 Cell 是否与任何设备的 footprint 重叠。
2. 若重叠 → 创建失败，预览变红，提示玩家"传送带不能穿过设备"。
3. **例外——物流桥（Belt Bridge）**：物流桥是一个 1×1 设备，其设计目的就是**让两条传送带在同一 Cell 交叉运输互不干扰**。因此传送带可以穿过物流桥所在的 Cell（物流桥是合法的交叉点）。详见 §8.1.1。⏳ T2.0 暂不允许，留到后续任务。
4. 除物流桥外，其他所有设备（生产设备、分流器、汇流器、供电桩等）都禁止穿模。玩家必须通过转弯绕开。

**示例**（精炼炉 3×3，输出端在 (0,1)、(1,1)、(2,1)）：

```
玩家从输出端 (2,1) 想往右（→）创建：

  ❌ 错误（穿模）: (2,1) → (3,1) → (4,1) ...
     （如果 (3,1) 是另一个生产设备/分流器/汇流器的占用 Cell，则禁止）

  ✅ 正确（绕开）: 从 (2,1) 先 ↑ 到 (2,0)，再 → 到 (3,0) → (4,0) ...
     路径: (2,1) → (2,0) → (3,0) → (4,0)

  ✅ 正确（穿物流桥）: 若 (3,1) 是物流桥，则可以 (2,1) → (3,1) → (4,1) 穿过
     （物流桥允许两条传送带交叉）
```

**实现**：每次创建新段前，调用 `OccupancyMap.getOccupant(targetCell)` 检查占用者。若占用者是物流桥（`definitionId === 'belt_bridge'`）则放行；否则创建失败。

### 6.7 端口连接判定

传送带与设备的连接是**隐式**的（基于相邻关系 + 方向），不需要显式连线：

| 连接类型 | 判定条件 |
|---------|---------|
| **设备输出 → 传送带** | 传送带段的 Cell 与设备某 Output Port 的 Cell 相邻，且传送带方向"背离"设备 |
| **传送带 → 设备输入** | 传送带段的末端 Cell 与设备某 Input Port 的 Cell 相邻，且传送带方向"指向"设备 |

**示例**：

```
设备输出端在 (2,1)，传送带 A 在 (3,1) 方向→:
  → A 的输入侧（左侧 Cell (2,1)）是设备输出端口 → 物品从设备流入 A

传送带 B 末端在 (5,1) 方向→，设备输入端在 (6,1):
  → B 的输出侧（右侧 Cell (6,1)）是设备输入端口 → 物品从 B 流入设备
```

### 6.8 创建模式交互流程

```
1. 玩家按 `E` 进入全局"传送带创建模式"
2. 鼠标 hover 到设备输出端口 Cell 或断头传送带末端时，该格高亮
3. 玩家点击高亮格作为路径起点
4. 移动鼠标时显示从起点到鼠标所在格的预览路径（L 形或直线）
   - 预览路径吸附网格
   - 第一段固定沿起点方向（端口方向/断头方向）出去
   - 预览段若违反 §6.5 方向约束或 §6.6 防穿模约束 → 显示红色（不可创建）
5. 点击目标空格 → 预览路径落盘为真实传送带段
6. 继续移动鼠标可继续延长；按 `E` / 右键 / ESC → 退出创建模式
```

### 6.9 删除规则

T2.0 实现：

- **`Delete` 删除整链**：移除该 `chainId` 的所有段。物品全部消失（T2.0 无物品，仅移除 Entity）。
- **`Shift+Delete` 删除单段**：仅移除指定段的 Entity。若该段位于链中间，下游链变为新的断头链（暂不重新分配 `chainId`，T2.0 简化处理）。

T2.0 之后：

- 删除单段导致链分裂的完整逻辑（同 §6.4 截断但不创建新分支）。
- 删除后上游链末端变为断头传送带（已有物品继续流到末端后停留）。⏳ 依赖 T2.1 物品系统

### 6.10 链查询 API

```ts
class World {
  // 获取一条链的所有段 Entity（按 segmentIndex 排序）
  getChainSegments(chainId: string): EntityHandle[];

  // 获取某段的上下游相邻段
  getUpstreamSegment(entity: EntityHandle): EntityHandle | null;
  getDownstreamSegment(entity: EntityHandle): EntityHandle | null;
}
```

---

## 7. 物流设备通用模型

所有物流设备（传送带、物流桥、分流器、汇流器、物品准入口）共享同一套数据驱动模型，仅通过参数表区分。

### 7.1 LogisticsDeviceDefinition

```ts
// 物流设备类型定义 — 数据驱动，新增设备只需添加一条记录
interface LogisticsDeviceDefinition {
  id: string;                  // 唯一标识，如 "transport_belt"
  name: string;                // 显示名称
  category: 'belt' | 'pipe';  // 固体物流 / 液体气体物流
  speed: number;               // 传输速率 (格/秒)
  capacity: number;            // 缓冲区容量 (0 = 无缓冲)
  maxInputs: number;           // 最大输入端口数 (1~3)
  maxOutputs: number;          // 最大输出端口数 (1~3)
  hasFilter: boolean;          // 是否支持物品过滤
  texture: string;             // 纹理图集 key
}
```

### 7.2 LogisticsComp（ECS Component 完整定义）

所有物流设备使用同一个 ECS Component。下面是合并了 §6.2 链（Chain）字段后的**完整定义**，作为实现的唯一参考：

```ts
interface LogisticsComp {
  deviceId: string;                 // 对应 LogisticsDeviceDefinition.id
  direction: 0 | 90 | 180 | 270;   // 设备朝向
  speed: number;                     // 实际传输速率
  items: BeltItem[];                // 当前段上的物品（多物品队列，见 §2.3）
  pointerProgress: number;           // 方向指示器进度 0.0~1.0
  type: 'straight' | 'corner';      // 传送带类型（直线/转角），影响 pointer 和物品路径计算
  cornerDir?: string;               // 转角方向，如 "up_right"（仅 type='corner' 时使用，见 §5.4）

  // === 链（Chain）字段 — 仅传送带类使用，见 §6.2 ===
  chainId: string;                  // 所属链 ID（同一次创建/延申的所有段共享）
  segmentIndex: number;             // 在链中的顺序索引（从源头 0 开始递增）
  isChainHead: boolean;             // 是否为链的源头段（紧邻设备输出端口）
  isChainTail: boolean;             // 是否为链的末端段（断头，无下游连接）

  // === 多端口（由设备类型 + 连接情况决定） ===
  inputDirections: Direction[];     // 输入方向列表（绝对方向）
  outputDirections: Direction[];    // 输出方向列表（绝对方向）

  // === 轮询（多入/多出时使用） ===
  inputPollIndex: number;           // 输入轮询指针
  outputPollIndex: number;          // 输出轮询指针

  // === 过滤（仅物品准入口使用） ===
  filterItemIds?: string[];         // 允许通过的物品 ID 白名单
  maxItemCount?: number;            // 最大通过数量
}
```

> **说明**：§5.2.2 和 §6.2 中曾分别给出过 `LogisticsComp` 的局部定义。**以本节 §7.2 为准**，它合并了两处的字段。

### 7.3 端口连接规则

物流设备的端口由**方向**和**相邻 Cell** 隐式决定：

- 设备自身有 4 个方向：前、后、左、右（相对设备朝向）
- `inputDirections` 和 `outputDirections` 是**绝对方向**（世界坐标角度）
- 连接时检查：设备输出方向的相邻 Cell 是否包含有效输入端口

```ts
// 根据设备信息和当前朝向，计算实际端口方向
function computePortDirections(def: LogisticsDeviceDefinition, direction: Direction): {
  inputs: Direction[];
  outputs: Direction[];
} {
  // Phase 1 传送带简化：输入=反方向，输出=正方向
  const back = (direction + 180) % 360;
  const forward = direction;
  const left = (direction + 270) % 360;
  const right = (direction + 90) % 360;

  return {
    inputs:   [back],         // 默认从背后输入
    outputs:  [forward],      // 默认从前方输出
  };
}

// 分流器/汇流器在 Phase 3 中扩展此函数以返回多个端口方向
```

---

## 8. 物流设备实例化

### 8.1 定义数据（正式数据源：`doc/csv/终末地设备 - 物流设备.csv`）

```ts
const LOGISTICS_DEVICE_DEFINITIONS: Record<string, LogisticsDeviceDefinition> = {
  transport_belt: {
    id: 'transport_belt',
    name: '传送带',
    category: 'belt',
    speed: 0.5,
    capacity: 0,
    maxInputs: 1,
    maxOutputs: 1,
    hasFilter: false,
    texture: 'transport_belt',
  },
  belt_bridge: {
    id: 'belt_bridge',
    name: '物流桥',
    category: 'belt',
    speed: 0.5,
    capacity: 0,
    maxInputs: 1,
    maxOutputs: 1,
    hasFilter: false,
    texture: 'belt_bridge',
  },
  splitter: {
    id: 'splitter',
    name: '分流器',
    category: 'belt',
    speed: 0.5,
    capacity: 0,
    maxInputs: 1,
    maxOutputs: 3,     // 最多 3 条分支
    hasFilter: false,
    texture: 'splitter',
  },
  converger: {
    id: 'converger',
    name: '汇流器',
    category: 'belt',
    speed: 0.5,
    capacity: 0,
    maxInputs: 3,       // 最多 3 条分支
    maxOutputs: 1,
    hasFilter: false,
    texture: 'converger',
  },
  item_control_port: {
    id: 'item_control_port',
    name: '物品准入口',
    category: 'belt',
    speed: 0.5,
    capacity: 0,
    maxInputs: 1,
    maxOutputs: 1,
    hasFilter: true,    // 支持过滤
    texture: 'item_control_port',
  },
};
```

### 8.1.1 物流桥（Belt Bridge）的特殊语义

物流桥是唯一允许**两条传送带在同一 Cell 交叉**的设备。它的核心功能是"让一条垂直传送带与一条水平传送带交叉运输互不干扰"。

```
       ↑
       │
  ─────╳───── →   物流桥位于交叉点 ╳
       │           水平链和垂直链互不影响
       ↑
```

**关键性质**：

- 物流桥是 1×1 设备，占用一个 Cell。
- **防穿模例外**：传送带创建时可以穿过物流桥所在的 Cell（见 §6.6 规则 3）。这是物流桥存在的全部意义。
- 两条交叉的传送带在物流桥处**逻辑上各自独立**：水平链的物品不会跑到垂直链上，反之亦然。物流桥同时承担两条链的一个段。
- 实现上，物流桥所在 Cell 可能同时是两条不同 `chainId` 链的某一段。渲染时绘制物流桥纹理；物品移动时按各自链的 direction 独立计算。

> **Phase 归属**：物流桥的完整交叉逻辑属于 **Phase 3**。T2.0 阶段不实现物流桥设备，也不允许传送带穿过物流桥所在 Cell。

### 8.1.2 分流器 / 汇流器（1×1 设备）

分流器、汇流器、物品准入口都是 **1×1 设备**（见 CSV 数据源），占用一个 Cell：

| 设备 | 占地 | 端口 | 功能 |
|------|------|------|------|
| 分流器（Splitter） | 1×1 | 1 入 / 最多 3 出 | 把 1 条传送带的物品均匀分配到多条分支 |
| 汇流器（Converger） | 1×1 | 最多 3 入 / 1 出 | 把多条分支传送带的物品汇流到 1 条 |
| 物品准入口（Item Control Port） | 1×1 | 1 入 / 1 出 | 设置允许通过的物品白名单和最大数量 |

**防穿模**：这三种设备都是普通设备（非物流桥），传送带创建时**不能穿过**它们（见 §6.6）。它们与传送带的连接通过端口方向隐式判定（见 §6.7）。

> **Phase 归属**：分流器/汇流器/物品准入口的逻辑属于 **Phase 3**（见 implementation-phase-2.md 排除清单）。

### 8.2 ECS 实体

```ts
// 创建传送带段时的实体构成（由传送带创建系统调用，见 §6）
function createBeltSegment(
  world: World,
  gridPos: GridPos,
  direction: Direction,
  chainId: string,
  segmentIndex: number,
  isChainHead: boolean,
  isChainTail: boolean
): EntityHandle {
  const def = LOGISTICS_DEVICE_DEFINITIONS['transport_belt'];
  const handle = world.createEntity();

  world.addComponent(handle, 'Position', gridToWorld(gridPos.x, gridPos.y));
  world.addComponent(handle, 'SpriteComp', {
    texture: def.texture,
    width: CELL_SIZE,
    height: CELL_SIZE,
    layer: 2,  // BuildingLayer
  });
  world.addComponent(handle, 'LogisticsComp', {
    deviceId: 'transport_belt',
    direction,
    speed: def.speed,
    items: [],
    pointerProgress: 0,
    type: 'straight',
    // 链（Chain）字段
    chainId,
    segmentIndex,
    isChainHead,
    isChainTail,
    // 单入单出端口方向
    inputDirections: [reverseDirection(direction)],
    outputDirections: [direction],
    inputPollIndex: 0,
    outputPollIndex: 0,
  });

  return handle;
}
```

> **注意**：此函数只创建单个段 Entity。链的 `chainId` 由传送带创建系统（§6）统一分配与维护——延申创建时传入父链的 chainId，截断创建时为分裂出的下游链重新分配。

### 8.3 物品在分流器/汇流器上的行为（Phase 3 实现）

**分流器规则**：
- 物品从唯一的输入端口进入
- 输出端口按顺序轮询，物品均匀分配到各输出分支
- 当一个输出分支堵塞时，跳过后继续分配给下一个
- 所有分支都堵塞时，逆流传播堵塞

**汇流器规则**：
- 多个输入端口按轮询顺序交替流入
- 同一 Tick 内，每个输入端口至多传入 1 件物品
- 输出端口唯一，输出端堵塞时停止所有输入的接收

---

## 9. BeltSystem

BeltSystem 处理所有 `LogisticsComp` 实体的物品移动逻辑。Phase 1 仅处理传送带（直带），Phase 2 扩展为处理全部物流设备类型。

```ts
class BeltSystem {
  update(world: World, dt: number): void {
    const entities = world.query('LogisticsComp', 'Position');
    for (const entity of entities) {
      const logi = world.getComponent<LogisticsComp>(entity, 'LogisticsComp')!;
      const pos = world.getComponent<Position>(entity, 'Position')!;
      const def = LOGISTICS_DEVICE_DEFINITIONS[logi.deviceId];

      // 1. 前进物品（适用于所有物流设备）
      for (const item of logi.items) {
        item.progress += (logi.speed / CELL_SIZE) * dt;
      }

      // 2. 根据设备类型处理段尾传输
      switch (def.id) {
        case 'transport_belt':
        case 'belt_bridge':
          // 单入单出：传入前方相邻 Cell 的物流设备
          this.transferSingleOutput(logi, pos, entity, world);
          break;
        // Phase 2 扩展:
        // case 'splitter':  this.transferSplitter(...);  break;
        // case 'converger': this.transferConverger(...); break;
        // case 'item_control_port': this.transferWithFilter(...); break;
      }

      // 3. 移除已传输的物品
      logi.items = logi.items.filter(item => item.progress < 1.0);

      // 4. 更新 Pointer
      this.updatePointer(logi);
    }
  }

  private transferSingleOutput(
    logi: LogisticsComp, pos: Position,
    entity: EntityHandle, world: World
  ): void {
    for (const item of logi.items) {
      if (item.progress >= 1.0) {
        const nextCell = getNeighborCell(pos, logi.outputDirections[0]);
        this.tryTransferItem(item, nextCell, world);
      }
    }
  }
}
```

后续 System（MachineSystem）再处理从传送带传入设备的内容（DD-010 保证 BeltSystem 先运行）。

---

## 10. 管道系统（Phase 3b，详见 A12 §17）

> **时机**：普通管道实现在 **Phase 3b**（与全局仓储/核心建筑同期）。地下暗管作为后期研发解锁，排在 Phase 3b 后期或 Phase 5。
> 管道设计的上位约束见 **A12 EC-008**（固/液/气分类传输）和 **A12 §17**（管道系统专题）。

管道系统与固体物流系统共享**相同的拓扑模型**（直通/桥/分流/汇流/过滤），但参数不同。

### 10.1 差异对比

| 属性 | 固体物流 | 管道物流 |
|------|---------|---------|
| 传输速率 | 0.5 格/秒 | 2.0 格/秒 |
| 缓冲区容量 | 0 | 4 |
| 传输内容 | 固体物品 | 液体/气体 |
| SVG 资产前缀 | `Transport_Belt_*` | `Pipe_*` |
| 目标 Phase | Phase 1~2 | Phase 3b |

### 10.2 定义数据

```ts
const LOGISTICS_DEVICE_DEFINITIONS = {
  // ... 固体物流设备 ...
  pipe: {
    id: 'pipe',
    name: '管道',
    category: 'pipe',
    speed: 2.0,
    capacity: 4,       // 有缓冲区
    maxInputs: 1,
    maxOutputs: 1,
    hasFilter: false,
    texture: 'pipe',
  },
  pipe_bridge:     { ... category: 'pipe', speed: 2.0, capacity: 4, maxInputs: 1, maxOutputs: 1, texture: 'pipe_bridge' },
  pipe_splitter:   { ... category: 'pipe', speed: 2.0, capacity: 4, maxInputs: 1, maxOutputs: 3, texture: 'pipe_splitter' },
  pipe_converger:  { ... category: 'pipe', speed: 2.0, capacity: 4, maxInputs: 3, maxOutputs: 1, texture: 'pipe_converger' },
  pipe_control_port: { ... category: 'pipe', speed: 2.0, capacity: 4, maxInputs: 1, maxOutputs: 1, hasFilter: true, texture: 'pipe_control_port' },
};
```

### 10.3 实现策略

管道系统使用与固体物流**相同的 ECS Component**（`LogisticsComp`），同一套 System（BeltSystem 扩展），仅通过 `category: 'pipe'` 区分行为。Phase 3b 实现时：

1. 增加管道 SVG 纹理资产
2. 添加 `capacity: 4` 对应的缓冲区逻辑（物品数量累计到 4 才输出）
3. 渲染时管道使用液体颜色，不是物品 Sprite

这种设计使管道系统不需额外 System，只需新增数据定义和渲染逻辑。

### 10.4 地下暗管（Phase 3b 后期 / Phase 5 研发解锁）

地下暗管是与普通管道**完全不同的设备**，不是管道的升级版。设计详见 A12 §11.7。

| 维度 | 普通管道（本 §10 描述） | 地下暗管（A12 §11.7） |
|------|------------------------|------------------------|
| **定位** | 液体版传送带，复杂拓扑 | 极简 A-B 点对点传输 |
| **占地** | 占用地形 | 不占地形 |
| **距离** | 无上限（一节节铺） | 有最大距离上限（参考 300m） |
| **Phase** | Phase 3b | Phase 3b 后期 / Phase 5（研发解锁） |

---

## 11. 未来扩展（Phase 2+）

现有 SVG 资产已为物流设备扩展做好预备：

| 特性 | SVG 资产 | 说明 |
|------|----------|------|
| **转角传送带** | `Transport_Belt_rotate.svg` | L 形转弯段，详 §5.4，Phase 2 实现 |
| **分流器** | `Splitter.svg` | 1 入多出，最多 3 条分支 |
| **汇流器** | `Converger.svg` | 多入 1 出，最多 3 条分支 |
| **物流桥** | `Belt_Bridge.svg` | 两条传送带交叉互不干扰 |
| **物品准入口** | `Item_Control_Port.svg` | 过滤设备，可设置白名单 |
| **管道系统** | 待添加 | 液体/气体传输，2.0 格/秒 |

**Phase 2 优先实现**：转角传送带（逻辑已在 §5.4 完成）。

**Phase 3 实现**：分流器（按端口轮询分配）、汇流器（按端口轮询合并）、物流桥、物品准入口。

Phase 2 扩展时，只需：
1. 在 `LOGISTICS_DEVICE_DEFINITIONS` 中添加新设备的定义数据
2. 在 BeltSystem 的 switch 中添加对应的传输逻辑分支
3. 添加对应的 SVG 纹理

---

## 12. 规则

| 规则 | 说明 |
|------|------|
| 所有物流设备共享 LogisticsComp | 传送带/物流桥/分流器/汇流器使用同一 ECS Component（完整定义见 §7.2） |
| 数据驱动 | 新增物流设备只需添加一条定义记录，不写新类 |
| 1×1 占地 | 所有固体物流设备占地 1×1 |
| 速度 0.5 格/秒 | 跨 1 格需要 2 秒（40 Ticks） |
| 同段多物品 | **一格一物品（2026-08-17 修订）**：一段（=一格）至多 1 件物品，整链一节一件（见 §2.3） |
| 两种停止点 | **统一格中心 0.5（2026-08-17 修订）**：端口吸入预约判定、断头堵塞、满带堆放同点；预约物品随后放行至端口格中心 1.5 消失（见 §3.3） |
| 堵塞逆流传播 | 下游占用 → 队首停在下游物品后方（≤0.5）→ 每格一件逆流向上游排开 |
| Pointer 空载时显示 | 无物品时 pointer 循环移动，有物品时隐藏 |
| Pointer 与物品同逻辑 | 移动速度、路径与物品完全一致 |
| 分流器均匀分配 | 输出端口轮询，堵塞跳过 |
| 汇流器轮询输入 | 多个输入端口按顺序交替接收 |
| 直线带 4 方向 | Transport_Belt_Move.svg（垂直）旋转得 4 方向 |
| **传送带必须从设备输出端创建** | 不能在空地凭空放置（见 §6.1） |
| **延申视为逻辑一条** | 物理 Entity 独立 + chainId 共享，选中/删除可整链操作（见 §6.2） |
| **截断物理切断** | 截断点分裂为上下游两链 + 垂直引出新链（见 §6.4） |
| **方向不可逆流** | 延申禁止反向；截断禁止顺/逆流，仅可垂直（见 §6.5） |
| **禁止穿模** | 传送带不能横穿设备占用 Cell，必须绕开（见 §6.6） |
| T2.0 实现直带 + L 形转角 | 截断/合并/物流桥/分流器/汇流器/物品准入口留到 Phase 3 |
| 普通管道 Phase 3b | 共享拓扑模型，参数不同（2.0 格/秒、容量 4）。地下暗管 Phase 3b 后期或 Phase 5（A12 §11.7） |
| BeltSystem 先执行 | 保证 MachineSystem 能看到已到达的物品（DD-010） |
