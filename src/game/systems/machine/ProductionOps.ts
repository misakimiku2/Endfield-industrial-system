// 生产操作 — 纯函数 (DD-011 状态在 Component，逻辑按 BufferOps/BeltChainOps 先例独立 ops 模块)
// 依据: A8 §3 (生产计时系统)、§5.3/§5.4 (原料匹配/生产触发)、A4 §6.1 (Recipe 模型)
//
// 核心规则 (A8 §3.1):
//   - 启动计时**不扣原料**；原料始终停留在输入槽，直到计时完成那一刻的**原子结算**
//     （扣输入 + 加输出在同一 Tick 内同时完成）。
//   - 输出槽满 → 结算暂缓（blocked），原料继续留在输入槽未被扣除 (A8 §2.2)。
//
// 匹配/结算都用"计划"(plan) 描述——启动与结算时刻各规划一次：
//   生产期间输入槽只进不出（物流可补货、只有结算才扣），启动可行的计划在结算时必然仍可行，
//   因此 Component 只存 currentRecipeId (A8 §3.1)，不存计划本身。
//
// 液体规则 (A8 §2.2 注): 液体物品（清水/污水）走 liquid 端口、不占固体槽（液体系统 Phase 2+）。
//   → 匹配时固体输入槽中的液体物品不满足任何原料组（纯液体原料组 → 配方不可启动，如赤铜块需清水）；
//   → 结算时液体产物（如赤铜块的污水）跳过，不占固体输出槽。
//
// T2.6 端口吸入、T2.7 输出到传送带、T2.10 轮询在后续任务扩展。

import type { BuildingComp, BufferSlot } from '../../components/BuildingComp.ts';
import type { Recipe, RecipeAtom, RecipeOutput } from '../../data/recipes.ts';
import type { ItemRegistry } from '../../data/items.ts';
import { consumeFromSlot } from './BufferOps.ts';

/** 结算的输入扣减计划条目：从第 slotIndex 个输入槽扣 itemId×count。 */
export interface InputPlanEntry {
  slotIndex: number;
  itemId: string;
  count: number;
}

/** 结算的产物落地计划条目：向第 slotIndex 个输出槽加 itemId×count。 */
export interface OutputPlanEntry {
  slotIndex: number;
  itemId: string;
  count: number;
}

/** 物品是否为液体（tags 含 'liquid' 别名，A4 §1 类别派生）。液体不进/不占固体槽。 */
export function isLiquidItem(itemId: string, registry: ItemRegistry): boolean {
  return registry.byId.get(itemId)?.tags.includes('liquid') ?? false;
}

/** 单个原料原子是否可由槽中物品满足（item 比 itemId，tag 比 ItemDefinition.tags）。 */
function atomMatchesSlot(atom: RecipeAtom, slotItemId: string, registry: ItemRegistry): boolean {
  if (atom.kind === 'item') return atom.ref === slotItemId;
  return registry.byId.get(slotItemId)?.tags.includes(atom.ref) ?? false;
}

/**
 * 规划一条配方的输入扣减计划 (A8 §5.4 配方匹配)。
 * 逐原料组（和关系）分配：每组在 alternatives（或关系）中按顺序找第一个可满足的备选，
 * 备选落到"有足够剩余量的固体槽"上；同槽剩余量跨组递减，避免两组合计超扣同一槽。
 *
 * @returns 计划条目数组；任一组无法满足 → null（配方不匹配/不可结算）。
 *   现有数据每个配方的原料组指向不同物品，贪心分配足够；同物品跨多组的组合情况未出现。
 */
export function planRecipeInputs(
  recipe: Recipe,
  slots: BufferSlot[],
  registry: ItemRegistry,
): InputPlanEntry[] | null {
  const remaining = slots.map((s) => s.count);
  const plan: InputPlanEntry[] = [];
  for (const group of recipe.inputs) {
    let entry: InputPlanEntry | null = null;
    for (const alt of group.alternatives) {
      for (let i = 0; i < slots.length; i++) {
        const sid = slots[i].itemId;
        // 液体物品走 liquid 端口，不作为固体输入槽的匹配来源
        if (sid === null || remaining[i] < alt.count || isLiquidItem(sid, registry)) continue;
        if (atomMatchesSlot(alt, sid, registry)) {
          entry = { slotIndex: i, itemId: sid, count: alt.count };
          break;
        }
      }
      if (entry !== null) break;
    }
    if (entry === null) return null;
    remaining[entry.slotIndex] -= entry.count;
    plan.push(entry);
  }
  return plan;
}

/**
 * 在设备的配方列表中找第一条可匹配的配方 (A8 §5.4 步骤 1~2)。
 * @returns { recipe, plan }；无匹配 → null。多配方可匹配时取列表序（CSV 顺序，确定性）。
 */
export function findMatchingRecipe(
  recipes: Recipe[],
  slots: BufferSlot[],
  registry: ItemRegistry,
): { recipe: Recipe; plan: InputPlanEntry[] } | null {
  for (const recipe of recipes) {
    const plan = planRecipeInputs(recipe, slots, registry);
    if (plan !== null) return { recipe, plan };
  }
  return null;
}

/**
 * 规划产物落地：每个固体产物找输出槽——已锁定同类的未满槽优先（合堆），
 * 其次空槽（锁定该产物类型，A8 §2.2 一槽一物）；液体产物跳过不占槽。
 * 同槽剩余容量跨产物递减（副产物各占一槽的主场景之外的同型合堆防御）。
 *
 * @returns 落地计划；任一固体产物无处安放 → null（输出满，结算暂缓 → blocked）。
 */
export function planOutputs(
  outputs: RecipeOutput[],
  slots: BufferSlot[],
  capacity: number,
  registry: ItemRegistry,
): OutputPlanEntry[] | null {
  const remaining = slots.map((s) => capacity - s.count);
  const plan: OutputPlanEntry[] = [];
  for (const out of outputs) {
    if (isLiquidItem(out.itemId, registry)) continue; // 液体产物走 liquid 端口 (A8 §2.2 注)
    let idx = -1;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].itemId === out.itemId && remaining[i] >= out.count) { idx = i; break; }
    }
    if (idx < 0) {
      for (let i = 0; i < slots.length; i++) {
        if (slots[i].itemId === null && remaining[i] >= out.count) { idx = i; break; }
      }
    }
    if (idx < 0) return null;
    remaining[idx] -= out.count;
    plan.push({ slotIndex: idx, itemId: out.itemId, count: out.count });
  }
  return plan;
}

/**
 * 原子结算 (A8 §3.1): 扣输入槽原料 + 向输出槽加入产物，同一调用内同时完成；
 * 计时清空（currentRecipeId=null, progress/elapsed 归零）。调用方需已用
 * planRecipeInputs/planOutputs 校验过两个计划，本函数不重复检查。
 */
export function settleProduction(
  comp: BuildingComp,
  inputPlan: InputPlanEntry[],
  outputPlan: OutputPlanEntry[],
): void {
  for (const e of inputPlan) {
    consumeFromSlot(comp.bufferInput[e.slotIndex], e.count); // 扣到 0 自动解锁 (A8 §2.1)
  }
  for (const e of outputPlan) {
    const slot = comp.bufferOutput[e.slotIndex];
    slot.itemId = e.itemId; // 空槽锁定产物类型；产物类型与配方绑定 (A8 §2.2)
    slot.count += e.count;
  }
  comp.currentRecipeId = null;
  comp.progress = 0;
  comp.elapsed = 0;
}

/**
 * 把计划条目聚合成显示文本："源矿 -1、清水 -1"（同物品多槽合并，控制台消息用）。
 * @param sign 扣减 '-' / 增加 '+'
 */
export function formatPlanDelta(
  plan: InputPlanEntry[] | OutputPlanEntry[],
  nameOf: (itemId: string) => string,
  sign: '-' | '+' = '-',
): string {
  const byItem = new Map<string, number>();
  for (const e of plan) byItem.set(e.itemId, (byItem.get(e.itemId) ?? 0) + e.count);
  return [...byItem.entries()].map(([id, n]) => `${nameOf(id)} ${sign}${n}`).join('、');
}
