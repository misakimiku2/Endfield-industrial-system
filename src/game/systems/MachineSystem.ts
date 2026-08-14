// 机器系统 — T2.5 生产计时与生产循环
// 依据: implementation-phase-2.md T2.5、A8 §3 (生产计时系统)、§6 (状态机)、§7 (Tick 内执行顺序)、A5 §5/DD-010
//
// 每 Simulation Tick 对每台带 BuildingComp 的设备执行 A8 §7 的"1. 更新设备内部状态"：
//   1a. 计时推进: elapsed += dt(50ms), progress = elapsed / Recipe.time
//   1b. progress >= 1.0 → 原子结算（扣输入 + 加输出，同一 Tick 内同时完成）；
//       输出槽满 → blocked 暂缓（原料不扣，留在输入槽），之后每 Tick 重试，
//       输出腾出空间即完成暂缓的结算（A8 §2.2/§6.2）
//   1c. 无计时 → 匹配配方启动新计时（**不扣原料**）；结算成功后同 Tick 立即续启下一次
// §7 的"2. 输入物流 / 3. 输出物流"（端口吸入/吐出）由 T2.6/T2.7 实现。
//
// 状态机 (A8 §6): idle ↔ working ↔ blocked，转换全部由本系统驱动：
//   idle→working 启动计时；working→idle 结算后无后续配方；working→blocked 计时完成但输出满；
//   blocked→working/idle 输出疏通、完成暂缓结算后按是否续配分流。
//
// 执行顺序 (A5 §5/DD-010): BeltSystem → MachineSystem（物品先到端口，设备再结算）。

import type { World, EntityHandle } from '../ECS.ts';
import type { SimulationSystem } from '../GameLoop.ts';
import type { BuildingComp } from '../components/BuildingComp.ts';
import type { Recipe } from '../data/recipes.ts';
import { formatRecipeSummary } from '../data/recipes.ts';
import type { ItemRegistry } from '../data/items.ts';
import { getBuildingDefinition } from '../data/buildings.ts';
import {
  findMatchingRecipe,
  planRecipeInputs,
  planOutputs,
  settleProduction,
  formatPlanDelta,
} from './machine/ProductionOps.ts';

/** 生产事件（控制台输出/调试钩子用，仅状态转换时产生，非每 Tick）。 */
export interface ProductionEvent {
  type: 'start' | 'settle' | 'blocked' | 'cancel';
  handle: EntityHandle;
  recipeId: string;
  /** 控制台可读消息（T2.5 验收格式） */
  message: string;
}

/** recentEvents 环形缓冲上限。 */
const MAX_RECENT_EVENTS = 100;

/**
 * 生产系统。处理所有带 BuildingComp 设备的生产计时、原子结算与状态机。
 */
export class MachineSystem implements SimulationSystem {
  /** equipmentId → 该设备可用配方列表（T2.3 配方索引）。 */
  private readonly recipes: Map<string, Recipe[]>;
  /** recipeId → Recipe（O(1) 取当前配方）。 */
  private readonly recipeById = new Map<string, Recipe>();
  private readonly registry: ItemRegistry;

  /** 事件监听器（main.ts 转发 console）。 */
  onEvent: ((e: ProductionEvent) => void) | null = null;
  /** 最近事件缓冲（调试钩子 __game.productionLog 读，超出上限丢最旧）。 */
  readonly recentEvents: ProductionEvent[] = [];

  constructor(recipes: Map<string, Recipe[]>, registry: ItemRegistry) {
    this.recipes = recipes;
    this.registry = registry;
    for (const list of recipes.values()) {
      for (const r of list) this.recipeById.set(r.id, r);
    }
  }

  private readonly nameOf = (itemId: string): string =>
    this.registry.byId.get(itemId)?.name ?? itemId;

  private emit(e: ProductionEvent): void {
    this.recentEvents.push(e);
    if (this.recentEvents.length > MAX_RECENT_EVENTS) this.recentEvents.shift();
    this.onEvent?.(e);
  }

  update(world: World, dt: number): void {
    for (const handle of world.query('BuildingComp')) {
      const comp = world.getComponent<BuildingComp>(handle, 'BuildingComp');
      if (!comp) continue;
      const def = getBuildingDefinition(comp.definitionId);
      const recipeList = def ? this.recipes.get(comp.definitionId) : undefined;
      if (!def || !recipeList || recipeList.length === 0) continue;

      let settledThisTick = false;

      if (comp.currentRecipeId !== null) {
        const recipe = this.recipeById.get(comp.currentRecipeId);
        if (!recipe) {
          // 防御: currentRecipeId 不在索引（配方数据变更等）→ 清计时回 idle
          comp.currentRecipeId = null;
          comp.progress = 0;
          comp.elapsed = 0;
          comp.state = 'idle';
        } else {
          // 1a. 计时推进（blocked 暂缓中的计时已停在 1.0，不重复推进）
          if (comp.progress < 1.0) {
            comp.elapsed += dt;
            const p = comp.elapsed / recipe.time;
            comp.progress = p >= 1.0 ? 1.0 : p;
          }
          // 1b. 计时完成 → 原子结算（输出满时 blocked，每 Tick 重试至疏通）
          if (comp.progress >= 1.0) {
            const inputPlan = planRecipeInputs(recipe, comp.bufferInput, this.registry);
            if (inputPlan === null) {
              // 原料在生产期间被外部取走（仅调试钩子可致；正常物流只进不出）→ 取消计时
              this.emit({
                type: 'cancel', handle, recipeId: recipe.id,
                message: `⚠ ${def.name}: 原料在生产期间被取走，取消计时（${formatRecipeSummary(recipe, this.nameOf)}）`,
              });
              comp.currentRecipeId = null;
              comp.progress = 0;
              comp.elapsed = 0;
            } else {
              const outputPlan = planOutputs(
                recipe.outputs, comp.bufferOutput, def.bufferCapacity, this.registry,
              );
              if (outputPlan === null) {
                if (comp.state !== 'blocked') {
                  comp.state = 'blocked';
                  this.emit({
                    type: 'blocked', handle, recipeId: recipe.id,
                    message: `${def.name}: 输出槽已满 → blocked，结算暂缓（原料未扣除）: ${this.nameOf(recipe.outputs[0].itemId)}`,
                  });
                }
              } else {
                const wasBlocked = comp.state === 'blocked';
                settleProduction(comp, inputPlan, outputPlan);
                settledThisTick = true;
                this.emit({
                  type: 'settle', handle, recipeId: recipe.id,
                  message: `${def.name}: ${wasBlocked ? '输出疏通，' : ''}计时完成！原子结算：输入槽 ${formatPlanDelta(inputPlan, this.nameOf)}，输出槽 ${formatPlanDelta(outputPlan, this.nameOf, '+')}`,
                });
              }
            }
          }
        }
      }

      // 1c. 无计时 → 尝试启动下一次生产（结算成功后同 Tick 立即续启，A8 §3.1）
      if (comp.currentRecipeId === null) {
        let started = false;
        // 早退: 全空槽不可能匹配任何配方（跳过配方遍历——性能基准 100 台空炉零开销）
        if (comp.bufferInput.some((s) => s.count > 0)) {
          const m = findMatchingRecipe(recipeList, comp.bufferInput, this.registry);
          if (m) {
            comp.currentRecipeId = m.recipe.id; // 启动计时（不扣原料，A8 §3.1）
            comp.progress = 0;
            comp.elapsed = 0;
            comp.state = 'working';
            started = true;
            this.emit({
              type: 'start', handle, recipeId: m.recipe.id,
              message: `${def.name}: 已启动${settledThisTick ? '下一次' : ''}生产计时 → ${formatRecipeSummary(m.recipe, this.nameOf)}`,
            });
          }
        }
        if (!started && comp.state !== 'idle') comp.state = 'idle';
      }
    }
  }
}
