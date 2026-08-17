// 机器系统 — T2.5 生产计时与生产循环 + T2.6 传送带→设备输入对接 + T2.7 设备→传送带输出对接
// 依据: implementation-phase-2.md T2.5/T2.6/T2.7、A8 §3 (生产计时系统)、§6 (状态机)、§7 (Tick 内执行顺序)、
//       §4.1 (输入轮询)、§4.2 (输出轮询)、A9 §2.3(最小间距)/§6.7 (端口连接判定)、A5 §5/DD-010
//
// 每 Simulation Tick 对每台带 BuildingComp 的设备执行 A8 §7:
//   1. 更新设备内部状态 (T2.5):
//   1a. 计时推进: elapsed += dt(50ms), progress = elapsed / Recipe.time
//   1b. progress >= 1.0 → 原子结算（扣输入 + 加输出，同一 Tick 内同时完成）；
//       输出槽满 → blocked 暂缓（原料不扣，留在输入槽），之后每 Tick 重试，
//       输出腾出空间即完成暂缓的结算（A8 §2.2/§6.2）
//   1c. 无计时 → 匹配配方启动新计时（**不扣原料**）；结算成功后同 Tick 立即续启下一次
//   2. 输入物流 (T2.6): 每个输入端口找指向它的供给传送带（A9 §6.7），
//       预约制两阶段——队首物品停在供给格中心(0.5)时预约（槽 count+1 + entering，
//       tryAcceptItem 判定"空槽或锁定同类型未满"，满则物品留在传送带上），
//       预约物品由 BeltSystem 放行推进到端口格中心(1.5)，本系统在 ≥1.5 时移除
//       （视觉消失走进设备半格深处，A9 §3.3 修订/精炼炉设备说明）。
//       吸入不依赖配方——仓库类设备（T2.12）同走此路径。每端口每 Tick 至多预约
//       1 件 (A8 §4.1)；多端口轮询指针 inputPollIndex 属 T2.10，本版按端口定义序
//       遍历（单输入槽设备等价）。
//   3. 输出物流 (T2.7): 每个输出端口找入口朝向它的接收传送带（A9 §6.7 "背离设备"），
//       从输出槽放 1 件到段首（beltPhase 相位注入，物品=实体 pointer；入口间距不足
//       → 满带，物品留在输出槽，下 Tick 重试，OutputOps 详注）。每端口每 Tick 至多
//       1 件 (A8 §4.2)；多端口轮询指针 outputPollIndex 属 T2.10，本版按端口定义序遍历。
//
// 状态机 (A8 §6): idle ↔ working ↔ blocked，转换全部由本系统驱动：
//   idle→working 启动计时；working→idle 结算后无后续配方；working→blocked 计时完成但输出满；
//   blocked→working/idle 输出疏通、完成暂缓结算后按是否续配分流。
//
// 执行顺序 (A5 §5/DD-010): BeltSystem → MachineSystem。BeltSystem 先推进/钳制物品
//   （未预约钳 0.5 门口、entering 放行到 1.5），本系统随后同 Tick 预约/放行——
//   保证"本 Tick 到达门口的物品在本 Tick 被预约、到达端口格中心的物品在本 Tick 消失"。
//   输出注入同理在 BeltSystem 之后：注入的物品下一 Tick 起由 BeltSystem 推进。

import type { World, EntityHandle } from '../ECS.ts';
import type { SimulationSystem } from '../GameLoop.ts';
import type { Position } from '../components/Position.ts';
import type { BeltSegmentComp } from '../components/BeltSegmentComp.ts';
import type { BuildingComp } from '../components/BuildingComp.ts';
import type { Recipe } from '../data/recipes.ts';
import { formatRecipeSummary } from '../data/recipes.ts';
import type { ItemRegistry } from '../data/items.ts';
import { getBuildingDefinition, type BuildingDefinition } from '../data/buildings.ts';
import { CELL_SIZE } from '../render/constants.ts';
import {
  findMatchingRecipe,
  planRecipeInputs,
  planOutputs,
  settleProduction,
  formatPlanDelta,
} from './machine/ProductionOps.ts';
import {
  buildBeltCellIndex,
  inputPortCells,
  findFeederBelt,
  tryAbsorbHeadItem,
  releaseArrivedItems,
} from './machine/IntakeOps.ts';
import {
  outputPortCells,
  findReceiverBelt,
  tryEmitToBelt,
} from './machine/OutputOps.ts';

/** 生产/物流事件（控制台输出/调试钩子用，仅状态转换或物品吞吐时产生，非每 Tick）。 */
export interface ProductionEvent {
  /** T2.5: start/settle/blocked/cancel；T2.6: input（传送带物品吸入输入槽）；
   *  T2.7: output（输出槽物品放出到传送带）。 */
  type: 'start' | 'settle' | 'blocked' | 'cancel' | 'input' | 'output';
  handle: EntityHandle;
  /** 关联配方 id；input 事件无配方（不适用）。 */
  recipeId?: string;
  /** 控制台可读消息（T2.5/T2.6 验收格式） */
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
    // 传送带格索引（T2.6 输入物流用，全 Tick 共享一份；无传送带时为空 Map，各端口查找未命中）
    const beltAt = buildBeltCellIndex(world);
    for (const handle of world.query('BuildingComp')) {
      const comp = world.getComponent<BuildingComp>(handle, 'BuildingComp');
      if (!comp) continue;
      const def = getBuildingDefinition(comp.definitionId);
      if (!def) continue;
      const recipeList = this.recipes.get(comp.definitionId);

      if (comp.paused) {
        // ── T2.8 玩家手动暂停: 生产/物流视同离线 ──
        // 不推进计时（已走进度保留在 comp.elapsed/progress，恢复后从暂停处继续）、
        // 不预约吸入（门口物品被 BeltSystem 钳制停在 0.5）、不输出产物（槽内保留）。
        // 已预约(entering)物品仍放行——槽位早在预约时刻 +1，只剩视觉行程，
        // 不放行会让物品永远卡在设备半格深处（BeltSystem 持续把它推进到 1.5）。
        this.releaseEnteringItems(world, handle, comp, def, beltAt);
        continue;
      }

      // ── 1. 设备内部状态 (A8 §7 步骤1, T2.5) ──
      // 输入物流不依赖配方（仓库类设备 T2.12 也吸入），此处只挡内部生产部分
      if (recipeList && recipeList.length > 0) {
        this.updateInternal(handle, comp, def, recipeList, dt);
      }

      // ── 2. 输入物流 (A8 §7 步骤2, T2.6): 传送带 → 输入端口吸入 ──
      this.absorbBeltInputs(world, handle, comp, def, beltAt);

      // ── 3. 输出物流 (A8 §7 步骤3, T2.7): 输出端口 → 传送带注入 ──
      this.emitBeltOutputs(world, handle, comp, def, beltAt);
    }
  }

  /**
   * A8 §7 步骤1: 更新设备内部状态（T2.5，逻辑不变）。
   * 1a. 计时推进 → 1b. 计时完成原子结算（输出满 → blocked 暂缓）→ 1c. 无计时匹配配方启动。
   */
  private updateInternal(
    handle: EntityHandle,
    comp: BuildingComp,
    def: BuildingDefinition,
    recipeList: Recipe[],
    dt: number,
  ): void {
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

  /**
   * T2.8 暂停期间唯一的物流动作: 放行已预约(entering)物品。
   * 只做 releaseArrivedItems（走到端口格中心 1.5 的预约物品移除），不预约新物品
   * （tryAbsorbHeadItem 跳过）。与 absorbBeltInputs 的差别仅此一项——复用同一套
   * 端口遍历/供给带查找逻辑。
   */
  private releaseEnteringItems(
    world: World,
    handle: EntityHandle,
    comp: BuildingComp,
    def: BuildingDefinition,
    beltAt: Map<string, EntityHandle>,
  ): void {
    const pos = world.getComponent<Position>(handle, 'Position');
    if (!pos) return;
    const gx = Math.round(pos.x / CELL_SIZE);
    const gy = Math.round(pos.y / CELL_SIZE);
    for (const cell of inputPortCells(gx, gy, def, comp.direction)) {
      const feeder = findFeederBelt(world, beltAt, cell);
      if (feeder === null) continue;
      const seg = world.getComponent<BeltSegmentComp>(feeder, 'BeltSegmentComp');
      if (!seg) continue;
      releaseArrivedItems(seg); // 只放行，不预约
    }
  }

  /**
   * A8 §7 步骤2 (T2.6): 输入物流。对每个输入端口（定义序=连接序）找指向它的供给
   * 传送带段（A9 §6.7），先放行已走到端口格中心(1.5)的预约物品（releaseArrivedItems，
   * 阶段2），再预约停在供给格中心(0.5)的队首物品（tryAbsorbHeadItem，阶段1: 槽
   * count+1 + entering=true）；槽满/类型不符则物品留在传送带上（每 Tick 重试，槽
   * 腾出即预约，A9 §3.5）。每端口每 Tick 至多预约 1 件（放行不占节流——槽位在
   * 预约时刻已占用，放行只是完成视觉行程）。
   */
  private absorbBeltInputs(
    world: World,
    handle: EntityHandle,
    comp: BuildingComp,
    def: BuildingDefinition,
    beltAt: Map<string, EntityHandle>,
  ): void {
    const pos = world.getComponent<Position>(handle, 'Position');
    if (!pos) return;
    const gx = Math.round(pos.x / CELL_SIZE);
    const gy = Math.round(pos.y / CELL_SIZE);
    for (const cell of inputPortCells(gx, gy, def, comp.direction)) {
      const feeder = findFeederBelt(world, beltAt, cell);
      if (feeder === null) continue;
      const seg = world.getComponent<BeltSegmentComp>(feeder, 'BeltSegmentComp');
      if (!seg) continue;
      releaseArrivedItems(seg); // 阶段2: 走到端口格中心的预约物品移除（视觉消失）
      const absorbed = tryAbsorbHeadItem(seg, comp, def.bufferCapacity); // 阶段1: 门口物品预约
      if (absorbed !== null) {
        this.emit({
          type: 'input', handle,
          message: `${def.name}: 吸入 ${this.nameOf(absorbed)} ×1（传送带 → 输入槽）`,
        });
      }
    }
  }

  /**
   * A8 §7 步骤3 (T2.7): 输出物流。对每个输出端口（定义序=连接序）找入口朝向它的
   * 接收传送带段（A9 §6.7），从输出槽放 1 件到段首；满带（入口间距不足）则物品
   * 留在输出槽（每 Tick 重试，带腾位即恢复）。每端口每 Tick 至多 1 件 (A8 §4.2)。
   */
  private emitBeltOutputs(
    world: World,
    handle: EntityHandle,
    comp: BuildingComp,
    def: BuildingDefinition,
    beltAt: Map<string, EntityHandle>,
  ): void {
    // 早退: 全空输出槽无货可出（跳过端口遍历——性能基准 100 台空炉零开销）
    if (!comp.bufferOutput.some((s) => s.count > 0)) return;
    const pos = world.getComponent<Position>(handle, 'Position');
    if (!pos) return;
    const gx = Math.round(pos.x / CELL_SIZE);
    const gy = Math.round(pos.y / CELL_SIZE);
    for (const cell of outputPortCells(gx, gy, def, comp.direction)) {
      const receiver = findReceiverBelt(world, beltAt, cell);
      if (receiver === null) continue;
      const seg = world.getComponent<BeltSegmentComp>(receiver, 'BeltSegmentComp');
      if (!seg) continue;
      const emitted = tryEmitToBelt(seg, comp);
      if (emitted !== null) {
        this.emit({
          type: 'output', handle,
          message: `${def.name}: 输出 ${this.nameOf(emitted)} ×1（输出槽 → 传送带）`,
        });
      }
    }
  }
}
