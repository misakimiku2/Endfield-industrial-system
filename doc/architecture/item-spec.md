# A4 — 物品规范

> **关联决策**: DD-005 (Definition 不引用 Entity), DD-011 (状态在 Component)

> **Phase 归属**: 🟢 **Phase 2**（物品定义、Tag 系统、Recipe 配方——Phase 2 配方加载 T2.3 才真正用到）。Phase 1 不涉及物品系统。

---

## 1. ItemDefinition

```ts
interface ItemDefinition {
  id: string;              // 唯一标识: "originium_ore", "ferrium"
  name: string;            // 显示名称: "源矿", "蓝铁块"
  category: ItemCategory;  // 分类
  stackSize: number;       // 单格最大堆叠数 (1 ~ 999)
  tags: string[];          // 标签 (用于配方匹配和生产设备筛选)
  texture: string;         // 纹理图集 key
}

type ItemCategory = 'mineral_ore'     // 矿物 (源矿、紫晶矿、蓝铁矿、赤铜矿)
                  | 'natural_liquid'  // 天然液体 (清水、沉积酸)
                  | 'plant'           // 植物 (荞花、柑实、酮化灌木等)
                  | 'aic_products'    // 工业产物 (晶体外壳、蓝铁块、粉末、零件、瓶等)
                  | 'usable_items';   // 消耗品 (罐头、胶囊、针剂、软饮等)
```

### 1.1 首批物品

下面列出了从 CSV 数据源中提取的代表性物品。完整物品列表由游戏运行时加载的配表数据驱动（见 recipe 章节）。

```ts
const ITEM_DEFINITIONS: Record<string, ItemDefinition> = {
  // ========================================
  // 矿物 (mineral_ore)
  // ========================================
  originium_ore: {
    id: 'originium_ore', name: '源矿', category: 'mineral_ore',
    stackSize: 50, tags: ['ore'], texture: 'originium_ore',
  },
  amethyst_ore: {
    id: 'amethyst_ore', name: '紫晶矿', category: 'mineral_ore',
    stackSize: 50, tags: ['ore'], texture: 'amethyst_ore',
  },
  ferrium_ore: {
    id: 'ferrium_ore', name: '蓝铁矿', category: 'mineral_ore',
    stackSize: 50, tags: ['ore'], texture: 'ferrium_ore',
  },
  cuprium_ore: {
    id: 'cuprium_ore', name: '赤铜矿', category: 'mineral_ore',
    stackSize: 50, tags: ['ore'], texture: 'cuprium_ore',
  },

  // ========================================
  // 天然液体 (natural_liquid)
  // ========================================
  clean_water: {
    id: 'clean_water', name: '清水', category: 'natural_liquid',
    stackSize: 50, tags: ['liquid'], texture: 'clean_water',
  },
  precipitation_acid: {
    id: 'precipitation_acid', name: '沉积酸', category: 'natural_liquid',
    stackSize: 50, tags: ['liquid', 'acid'], texture: 'precipitation_acid',
  },

  // ========================================
  // 植物 (plant)
  // ========================================
  buckflower: {
    id: 'buckflower', name: '荞花', category: 'plant',
    stackSize: 50, tags: ['plant', 'flower'], texture: 'buckflower',
  },
  citrome: {
    id: 'citrome', name: '柑实', category: 'plant',
    stackSize: 50, tags: ['plant', 'fruit'], texture: 'citrome',
  },
  aketine: {
    id: 'aketine', name: '酮化灌木', category: 'plant',
    stackSize: 50, tags: ['plant', 'shrub'], texture: 'aketine',
  },
  sandleaf: {
    id: 'sandleaf', name: '砂叶', category: 'plant',
    stackSize: 50, tags: ['plant', 'leaf'], texture: 'sandleaf',
  },
  jincao: {
    id: 'jincao', name: '锦草', category: 'plant',
    stackSize: 50, tags: ['plant', 'grass'], texture: 'jincao',
  },
  yazhen: {
    id: 'yazhen', name: '芽针', category: 'plant',
    stackSize: 50, tags: ['plant', 'thorn'], texture: 'yazhen',
  },

  // ========================================
  // 工业产物 (aic_products) — 精选示例
  // ========================================
  // -- 基础冶炼产物 --
  origocrust: {
    id: 'origocrust', name: '晶体外壳', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'crystal'], texture: 'origocrust',
  },
  ferrium: {
    id: 'ferrium', name: '蓝铁块', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'metal'], texture: 'ferrium',
  },
  amethyst_fiber: {
    id: 'amethyst_fiber', name: '紫晶纤维', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'fiber'], texture: 'amethyst_fiber',
  },
  cuprium: {
    id: 'cuprium', name: '赤铜块', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'metal'], texture: 'cuprium',
  },
  carbon: {
    id: 'carbon', name: '碳块', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'carbon'], texture: 'carbon',
  },

  // -- 粉末类 --
  originium_powder: {
    id: 'originium_powder', name: '源石粉末', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'powder'], texture: 'originium_powder',
  },
  ferrium_powder: {
    id: 'ferrium_powder', name: '蓝铁粉末', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'powder'], texture: 'ferrium_powder',
  },
  amethyst_powder: {
    id: 'amethyst_powder', name: '紫晶粉末', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'powder'], texture: 'amethyst_powder',
  },
  origocrust_powder: {
    id: 'origocrust_powder', name: '晶体外壳粉末', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'powder'], texture: 'origocrust_powder',
  },
  carbon_powder: {
    id: 'carbon_powder', name: '碳粉末', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'powder'], texture: 'carbon_powder',
  },

  // -- 致密粉末 (研磨产物) --
  dense_ferrium_powder: {
    id: 'dense_ferrium_powder', name: '致密蓝铁粉末', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'powder', 'dense'], texture: 'dense_ferrium_powder',
  },
  dense_originium_powder: {
    id: 'dense_originium_powder', name: '致密源石粉末', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'powder', 'dense'], texture: 'dense_originium_powder',
  },
  dense_carbon_powder: {
    id: 'dense_carbon_powder', name: '致密碳粉末', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'powder', 'dense'], texture: 'dense_carbon_powder',
  },

  // -- 高级冶炼产物 --
  packed_origocrust: {
    id: 'packed_origocrust', name: '密制晶体', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'crystal', 'refined'], texture: 'packed_origocrust',
  },
  steel: {
    id: 'steel', name: '钢块', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'metal', 'refined'], texture: 'steel',
  },
  cryston_fiber: {
    id: 'cryston_fiber', name: '高晶纤维', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'fiber', 'refined'], texture: 'cryston_fiber',
  },
  stabilized_carbon: {
    id: 'stabilized_carbon', name: '稳定碳块', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'carbon', 'refined'], texture: 'stabilized_carbon',
  },

  // -- 零件类 --
  ferrium_part: {
    id: 'ferrium_part', name: '铁制零件', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'part'], texture: 'ferrium_part',
  },
  amethyst_part: {
    id: 'amethyst_part', name: '紫晶零件', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'part'], texture: 'amethyst_part',
  },
  steel_part: {
    id: 'steel_part', name: '钢制零件', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'part', 'refined'], texture: 'steel_part',
  },
  cryston_part: {
    id: 'cryston_part', name: '高晶零件', category: 'aic_products',
    stackSize: 100, tags: ['processed', 'part', 'refined'], texture: 'cryston_part',
  },

  // -- 瓶类 --
  ferrium_bottle: {
    id: 'ferrium_bottle', name: '蓝铁瓶', category: 'aic_products',
    stackSize: 50, tags: ['processed', 'bottle'], texture: 'ferrium_bottle',
  },
  amethyst_bottle: {
    id: 'amethyst_bottle', name: '紫晶质瓶', category: 'aic_products',
    stackSize: 50, tags: ['processed', 'bottle'], texture: 'amethyst_bottle',
  },
  steel_bottle: {
    id: 'steel_bottle', name: '钢质瓶', category: 'aic_products',
    stackSize: 50, tags: ['processed', 'bottle', 'refined'], texture: 'steel_bottle',
  },

  // -- 装备原件 --
  ferrium_component: {
    id: 'ferrium_component', name: '蓝铁装备原件', category: 'aic_products',
    stackSize: 20, tags: ['processed', 'component'], texture: 'ferrium_component',
  },
  amethyst_component: {
    id: 'amethyst_component', name: '紫晶装备原件', category: 'aic_products',
    stackSize: 20, tags: ['processed', 'component'], texture: 'amethyst_component',
  },
  cryston_component: {
    id: 'cryston_component', name: '高晶装备原件', category: 'aic_products',
    stackSize: 20, tags: ['processed', 'component', 'refined'], texture: 'cryston_component',
  },

  // -- 种子 (通过采种获得，用于种植) --
  buckflower_seed: {
    id: 'buckflower_seed', name: '荞花种子', category: 'aic_products',
    stackSize: 100, tags: ['seed'], texture: 'buckflower_seed',
  },
  citrome_seed: {
    id: 'citrome_seed', name: '柑实种子', category: 'aic_products',
    stackSize: 100, tags: ['seed'], texture: 'citrome_seed',
  },
  aketine_seed: {
    id: 'aketine_seed', name: '酮化树种', category: 'aic_products',
    stackSize: 100, tags: ['seed'], texture: 'aketine_seed',
  },

  // -- 溶液类 --
  jincao_solution: {
    id: 'jincao_solution', name: '锦草溶液', category: 'aic_products',
    stackSize: 50, tags: ['liquid', 'solution'], texture: 'jincao_solution',
  },
  yazhen_solution: {
    id: 'yazhen_solution', name: '芽针溶液', category: 'aic_products',
    stackSize: 50, tags: ['liquid', 'solution'], texture: 'yazhen_solution',
  },
  liquid_xiranite: {
    id: 'liquid_xiranite', name: '液化息壤', category: 'aic_products',
    stackSize: 50, tags: ['liquid', 'xiranite'], texture: 'liquid_xiranite',
  },

  // -- 电池/爆炸物 --
  industrial_explosive: {
    id: 'industrial_explosive', name: '工业爆炸物', category: 'aic_products',
    stackSize: 20, tags: ['processed', 'explosive'], texture: 'industrial_explosive',
  },
  lc_valley_battery: {
    id: 'lc_valley_battery', name: '低容谷底电池', category: 'aic_products',
    stackSize: 20, tags: ['processed', 'battery'], texture: 'lc_valley_battery',
  },

  // ========================================
  // 消耗品 (usable_items)
  // ========================================
  buckflower_powder: {
    id: 'buckflower_powder', name: '荞花粉末', category: 'usable_items',
    stackSize: 100, tags: ['consumable', 'heal'], texture: 'buckflower_powder',
  },
  citrome_powder: {
    id: 'citrome_powder', name: '柑实粉末', category: 'usable_items',
    stackSize: 100, tags: ['consumable', 'heal'], texture: 'citrome_powder',
  },
  jincao_powder: {
    id: 'jincao_powder', name: '锦草粉末', category: 'usable_items',
    stackSize: 100, tags: ['consumable', 'heal'], texture: 'jincao_powder',
  },
  yazhen_powder: {
    id: 'yazhen_powder', name: '芽针粉末', category: 'usable_items',
    stackSize: 100, tags: ['consumable', 'heal'], texture: 'yazhen_powder',
  },
  canned_citrome_c: {
    id: 'canned_citrome_c', name: '柑实罐头', category: 'usable_items',
    stackSize: 20, tags: ['consumable', 'food', 'heal'], texture: 'canned_citrome_c',
  },
  buck_capsule_c: {
    id: 'buck_capsule_c', name: '荞愈胶囊', category: 'usable_items',
    stackSize: 20, tags: ['consumable', 'medicine', 'heal'], texture: 'buck_capsule_c',
  },
};
```

> **说明**: 以上约 60 个物品定义覆盖了全部自然资源种类及主要工业产物类别，是当前阶段游戏运行的完整基础物品集。后续新增物品由配表系统驱动，无需修改代码枚举。

### 1.2 物品英文 ID 的现状（核对 recipe.csv 后）

经精确核对 `doc/csv/recipe.csv`：

- **91 个主产物物品**在 recipe.csv 第 2 列都有英文 ID（如 赫铜块/Hetonite、息壤/Xiranite、壤晶/Xircon、重息壤/Heavy Xiranite、锦草粉末/Jincao Powder、酮化灌木粉末/Aketine Powder 等）。
- 其中 **47 个已在本规范 §1.1 定义**（基础矿物、植物、工业产物、消耗品）。
- 另外 **44 个产物**（赫铜系列、息壤/壤晶系列、装备原件系列、高级消耗品等）**在 recipe.csv 有英文 ID，但尚未整理进本规范**。这些物品的英文 ID 是现成的，无需重新命名，只需补进未来的 `items.csv`（见 §1.3）。
- **副产物物品**：少数配方除了主产物还会产出副产物（详见 §6.1.2 副产物机制）。目前 recipe.csv 新增了"副产物"列，已定义的副产物：
  - **污水 / Sewage**：赤铜块配方的副产物（赤铜矿+清水 → 赤铜块 + 污水）。污水不能自然采集，只能通过生产转化形成。
- **仍缺英文 ID 的只有 1 个物品**：赫铜溶液（反应池原料：赫铜溶液+蓝铁粉末→赫铜块）。待命名后补进 items.csv。

> **已修复的命名不一致**：recipe.csv 原本"锦草"（产物列）和"棉草"（原料列）混用，已统一为"**锦草**"（与 item-spec §1.1 的"锦草 jincao"一致）。涉及 锦草粉末/锦草溶液/锦草软饮 等，英文 ID（Jincao Powder/Solution/Drink）不变。

> **处理原则**：
> - Phase 2 的配方加载器（T2.3）在遇到未定义物品时，应**记录警告并跳过该配方**（而非崩溃），保证基础产线能跑通。
> - 44 个已有英文 ID 的产物，T2.3 可直接从 recipe.csv 读取并自动注册为 ItemDefinition（基础属性用默认值，后续在 items.csv 细化）。

### 1.3 物品配表规划（待建立）

当前物品定义硬编码在本文档中，不便维护。计划在 Phase 2 前建立统一的 `doc/csv/items.csv` 作为物品唯一数据源：

```
物品名称, 英文ID, 类别, 堆叠上限, 标签
源矿, Originium Ore, mineral_ore, 50, "ore"
晶体外壳, Origocrust, aic_products, 100, "processed,crystal"
赫铜块, Hetonite, aic_products, 100, "processed,metal"
...
```

**好处**：
- 新增物品只需在 items.csv 加一行，无需改代码
- recipe.csv 的"原料需求"列可直接写中文物品名，加载器用 items.csv 自动翻译成英文 itemId
- 中英文映射集中管理，避免多处命名不一致（如之前的"塑性机/塑形机""装备原型机/装备原件机"问题）

---

## 2. ItemStack

表示"某种物品 × 数量"的运行时不变量：

```ts
interface ItemStack {
  itemId: string;
  count: number;
}

function createStack(itemId: string, count: number): ItemStack {
  return { itemId, count };
}

// 拆分堆叠
function splitStack(stack: ItemStack, amount: number): [ItemStack, ItemStack] {
  // 返回 [取出部分, 剩余部分]
}
```

### 2.1 堆叠限制

```ts
function canStack(itemId: string, currentCount: number, addCount: number): boolean {
  return currentCount + addCount <= ITEM_DEFINITIONS[itemId].stackSize;
}
```

---

## 3. 物品在传送带上的表示

传送带上的物品比物品栏中的更简单——它只有一个 `itemId` 和一个 `progress`（在传送带段上的位置 0~1）：

```ts
interface BeltItem {
  itemId: string;
  progress: number;  // 0 = 刚进入此段, 1 = 到达此段末端
}
```

每段传送带独立追踪自己上面的物品。物品从一个 Belt 段移动到下一个时，原地删除 + 目标段新增。

---

## 4. 物品与 Entity

ItemStack 和 ItemDefinition **不**是 ECS Component。它们是纯数据结构，存储在：

- **物品栏**: 玩家的 `InventoryComponent` (ECS)
- **机器内部**: `BuildingComponent.bufferInput[]` / `BuildingComponent.bufferOutput[]` (ECS)
- **传送带上**: `LogisticsComp.items[]` (ECS)
- **地面掉落**: 独立的 ECS Entity（有 `Position` + `DroppedItemComponent`）

```ts
// ECS Component: 玩家物品栏
interface InventoryComponent {
  slots: (ItemStack | null)[];  // 固定大小数组
  maxSlots: number;
}

// ECS Component: 地面掉落物
interface DroppedItemComponent {
  stack: ItemStack;
  despawnTimer: number;  // 消失倒计时 (ms), 0 = 永久
}
```

---

## 5. Tag 系统

Tag 贯穿配方匹配、设备筛选、机器权限三条逻辑路径，是物品系统中最核心的查询维度。

### 5.1 按 Tag 匹配物品

```ts
// 如配方输入可写为: { tag: 'ore' } 而不是 { itemId: 'originium_ore' }
// 匹配时: 所有 tags 包含 'ore' 的物品都满足
function matchesTag(itemId: string, tag: string): boolean {
  return ITEM_DEFINITIONS[itemId].tags.includes(tag);
}
```

### 5.2 实际 Tag 分类体系

| Tag | 含义 | 示例物品 |
|-----|------|---------|
| `ore` | 矿石 | 源矿、紫晶矿、蓝铁矿、赤铜矿 |
| `liquid` | 液体 | 清水、沉积酸、锦草溶液、芽针溶液 |
| `acid` | 酸性 | 沉积酸 |
| `plant` | 植物 | 荞花、柑实、酮化灌木、砂叶、锦草、芽针 |
| `flower` / `fruit` / `shrub` / `leaf` / `grass` / `thorn` | 植物子类型 | 荞花 / 柑实 / 酮化灌木 / 砂叶 / 锦草 / 芽针 |
| `processed` | 工业加工品 | 晶体外壳、蓝铁块、粉末、零件、瓶等 |
| `crystal` | 晶体类 | 晶体外壳、密制晶体 |
| `metal` | 金属类 | 蓝铁块、赤铜块、钢块 |
| `fiber` | 纤维类 | 紫晶纤维、高晶纤维 |
| `carbon` | 碳类 | 碳块、稳定碳块 |
| `powder` | 粉末类 | 源石粉末、蓝铁粉末、碳粉末等 |
| `dense` | 致密粉末 | 致密蓝铁粉末、致密源石粉末等 |
| `refined` | 高级精炼品 | 密制晶体、钢块、高晶纤维等 |
| `part` | 零件 | 铁制零件、紫晶零件、钢制零件等 |
| `bottle` | 瓶类容器 | 蓝铁瓶、紫晶质瓶、钢质瓶等 |
| `component` | 装备原件 | 蓝铁装备原件、紫晶装备原件等 |
| `seed` | 种子 | 荞花种子、柑实种子、酮化树种等 |
| `solution` | 溶液 | 锦草溶液、芽针溶液 |
| `xiranite` | 息壤相关 | 液化息壤 |
| `battery` | 电池 | 低容谷底电池 |
| `explosive` | 爆炸物 | 工业爆炸物 |
| `consumable` | 消耗品 | 荞花粉末、柑实罐头、荞愈胶囊 |
| `heal` | 可回复生命 | 各类消耗品 |

### 5.3 Tag 与设备的关联

部分生产设备通过 Tag 判断可处理的输入物品，例如：

- **粉碎机**: 接受 `processed` 或 `plant` 类物品，产出 `powder` 类
- **精炼炉**: 接受 `ore` 或 `powder` 类物品，产出 `processed` 类
- **种植机**: 接受 `seed` 类物品，产出作物
- **采种机**: 接受 `plant` 类物品，产出 `seed` 类

---

## 6. 配方系统 (Recipe)

配方数据存储在 `doc/csv/recipe.csv` 中，游戏启动时加载为 Recipe 数据表。当前 CSV 包含约 93 条配方记录，涵盖 14 种生产设备。

### 6.1 Recipe 数据接口

```ts
interface Recipe {
  id: string;              // 唯一标识。注意：同一 outputs[0].itemId 可对应多条 Recipe（不同设备/不同原料产出同一种物品），
                           // 所以 id 不能仅用主产物，建议格式: "recipe_{equipmentId}_{主产物ItemId}_{序号}"
                           // 例: "recipe_refining_unit_origocrust_0"、"recipe_grinding_unit_dense_origocrust_powder_0"
  outputs: RecipeOutput[]; // 产物列表（支持多产物，见 §6.1.2）。outputs[0] 是主产物
  equipmentId: string;     // 生产设备 ID
  inputs: RecipeInput[];   // 原料需求（支持"或"和"和"，见 §6.1.1）
  time: number;            // 生产时间 (ms)
  level: number;           // 物品等级 (1~4)
}

// 产物项：主产物或副产物
interface RecipeOutput {
  itemId: string;          // 产物物品 ID
  count: number;           // 产出数量
}

// 单个原料需求：可以是"具体物品"，也可以是"类别匹配"，还可以是"多选一"
interface RecipeInput {
  alternatives: RecipeAtom[];  // 一组可选项。数组长度=1 表示确定需求；长度>1 表示"任选其一"（或关系）
}

interface RecipeAtom {
  kind: 'item' | 'tag';        // 'item' = 具体物品，'tag' = 类别匹配（对应 ItemDefinition.tags）
  ref: string;                 // kind='item' 时是 itemId；kind='tag' 时是 tag 名（如 'plant'）
  count: number;               // 需要的数量
}
```

> **CSV 列映射**：recipe.csv 的"物品名称"+"合成数量"两列对应 `outputs[0]`（主产物）；"副产物"列对应 `outputs[1:]`（副产物）。没有副产物时该列为空，`outputs` 只有一个元素。

#### 6.1.1 原料需求的"或/和"语义（对应 CSV 的 `/` 和 `+`）

recipe.csv 的"原料需求"列用两种分隔符：

| CSV 分隔符 | 语义 | 例子 | Recipe 表示 |
|-----------|------|------|------------|
| `+` | **和**（全部都要） | `赤铜矿*1+清水*1` | `inputs = [{alternatives:[赤铜矿]} , {alternatives:[清水]}]`（两组都要满足） |
| `/` | **或**（任选其一） | `源矿*1/晶体外壳粉末*1` | `inputs = [{alternatives:[源矿, 晶体外壳粉末]}]`（一组内任选一个） |

**解析规则**：加载配方时，先按 `+` 拆分成多个 `RecipeInput`（和关系），每个 `RecipeInput` 内部再按 `/` 拆分成 `alternatives`（或关系）。

**特殊情况——类别匹配**：原料形如 `（任意Plant类别的物品）*1`，解析为 `{ kind:'tag', ref:'plant', count:1 }`，匹配时检查物品的 tags 是否包含 `plant`。

> **设计理由**：扁平的 `inputs: {itemId, count}[]` 无法表达"或"关系（会把 `/` 误当"和"处理，导致配方要求同时提供两种原料）。改用 `alternatives` 嵌套后，"和"与"或"都能精确表达，且支持未来更复杂的多选规则。

#### 6.1.2 多产物与副产物机制

少数配方在产出主产物的同时，还会产出**副产物**（byproduct）。副产物是生产过程的附带产物，不能自然采集，只能通过特定配方转化形成。

**当前已定义的副产物**：

| 配方 | 设备 | 原料 | 主产物 | 副产物 |
|------|------|------|--------|--------|
| 赤铜块 | 精炼炉 | 赤铜矿*1 + 清水*1 | 赤铜块*1 | **污水*1**（Sewage） |

**副产物的处理规则**：

- 生产计时完成时（原子结算），主产物和副产物**同时**放入输出槽（每种产物各占一个独立的输出槽）。
- 固体副产物占用固体输出槽的容量；**液体副产物走专用 liquid 端口，不占固体输出槽**（液体系统 Phase 2+）。
- 副产物通过设备的输出端口送往传送带，与主产物的输出逻辑一致。
- 若固体输出槽无法容纳全部固体产物（主+副），设备进入 `blocked` 状态，结算不执行（原料继续停留在输入槽）。

**对 BuildingComponent 的影响**：输出缓冲区 `bufferOutput: BufferSlot[]` 是多槽位数组，每种产物各占一个独立的槽（一槽一物）。以赤铜块配方为例：固体产物（赤铜块）占 1 个固体输出槽，液体副产物（污水）走 liquid 端口不占固体槽。输入槽的锁定机制只作用于输入侧，不受副产物影响。详见 A3 §3.1、A8 §2.2。

> **赤铜块配方的 Phase 说明**：赤铜块（`赤铜矿*1 + 清水*1 → 赤铜块*1 + 污水*1`）涉及液体（清水入、污水出），**Phase 1 不实现液体系统，因此 Phase 1 精炼炉无法生产赤铜块**。该配方在 Phase 2 液体系统完成后才启用。Phase 1 精炼炉只支持纯固体配方（晶体外壳、蓝铁块等 9 个）。

### 6.2 配方表示示例 (精炼炉)

| 产出物品 | 英文 ID | 等级 | 原料 | 时间 | 副产物 |
|---------|---------|------|------|------|--------|
| 晶体外壳 | origocrust | 2 | 源矿*1 或 晶体外壳粉末*1 | 2s | — |
| 蓝铁块 | ferrium | 2 | 蓝铁矿*1 | 2s | — |
| 紫晶纤维 | amethyst_fiber | 2 | 紫晶矿*1 | 2s | — |
| 赤铜块 | cuprium | 2 | 赤铜矿*1 + 清水*1 | 2s | **污水*1**（液体，Phase 2 启用） |
| 碳块 | carbon | 2 | (任意 Plant 类别物品)*1 | 2s | — |
| 密制晶体 | packed_origocrust | 3 | 致密晶体粉末*1 | 2s | — |
| 钢块 | steel | 3 | 致密蓝铁粉末*1 | 2s | — |
| 高晶纤维 | cryston_fiber | 3 | 高晶粉末*1 | 2s | — |
| 稳定碳块 | stabilized_carbon | 3 | 致密碳粉末*1 | 2s | — |
| 致密晶体粉末 | dense_origocrust_powder | 3 | 致密源石粉末*1 | 2s | — |

### 6.3 生产设备总览

| 设备 | 英文 ID | 耗电 (W) | 占地 | 主要功能 |
|------|---------|---------|------|---------|
| 精炼炉 | Refining Unit | 5 | 3x3 | 高温冶炼矿石/粉末为金属块或晶体 |
| 粉碎机 | Shredding Unit | 5 | 3x3 | 粉碎材料为粉末 |
| 研磨机 | Grinding Unit | 50 | 6x4 | 将粉末进一步研磨为致密粉末 |
| 配件机 | Fitting Unit | 20 | 3x3 | 加工零件 |
| 塑形机 | Moulding Unit | 10 | 3x3 | 冲压容器 |
| 种植机 | Planting Unit | 20 | 5x5 | 培育植物 |
| 采种机 | Seed-Picking Unit | 10 | 5x5 | 采集种子 |
| 灌装机 | Filling Unit | 20 | 6x4 | 将原料灌装到容器 |
| 封装机 | Packaging Unit | 20 | 6x4 | 封装能量元件 |
| 装备原件机 | Gearing Unit | 10 | 6x4 | 加工装备原件 |
| 反应池 | Reactor Crucible | 50 | 5x5 | 固液体化学反应 |
| 扩容反应池 | Expanded Crucible | 100 | 6x5 | 大型化学反应 |
| 提纯机 | Purification Unit | 50 | 5x5 | 溶液提纯 |
| 拆解机 | Separating Unit | 20 | 6x4 | 物理分拆 |
| 天有洪炉 | Forge of the Sky | 50 | 5x5 | 息壤相关合成 |

### 6.4 配方加载流程

```
[Game Start]
    |
    v
Load recipe.csv ──→ Parse rows ──→ Build Recipe[] table
    |
    v
For each Recipe.outputItemId:
  Look up ITEM_DEFINITIONS[outputItemId]
  If missing → log warning, skip recipe
    |
    v
Build index: Map<equipmentId, Recipe[]>
  → BuildingComponent 按设备 ID 查询可用配方
```

---

## 7. 规则

| 规则 | 说明 |
|------|------|
| **Definition 是静态数据** | `ItemDefinition` 在运行时只读，由配表驱动 |
| **ItemStack 是值对象** | 可以自由复制、传递，不持有引用 |
| **物品栏是 ECS Component** | 属于玩家实体的 `InventoryComponent` |
| **传送带物品不是独立 Entity** | 它们是 `LogisticsComp.items[]` 数组的元素 |
| **掉落的物品是独立 Entity** | 有 Position + DroppedItemComponent |
| **堆叠最大值为 Definition.stackSize** | 超过则拆分/拒绝 |
| **Tag 不作为 Component** | Tag 仅是 ItemDefinition 的属性，不参与 ECS 查询 |
| **配方数据 CSV 驱动** | Recipe 不在代码中硬编码，启动时从 `recipe.csv` 加载 |
| **设备通过 equipmentId 匹配配方** | BuildingComponent 根据自身设备 ID 从 Recipe 索引中查询可用配方 |
| **配方支持多原料输入** | 单配方可有多个 input slot，支持并联或串联原料链 |
