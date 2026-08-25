// 机器系统 — T2.5 生产计时与生产循环 + T2.6 传送带→设备输入对接 + T2.7 设备→传送带输出对接
//           + T2.10 端口轮询（输入指针轮询 / 输出队列轮转）
// 依据: implementation-phase-2.md T2.5/T2.6/T2.7/T2.10、A8 §3 (生产计时系统)、§6 (状态机)、
//       §7 (Tick 内执行顺序)、§4.1 (输入轮询)、§4.2 (输出轮询)、A9 §2.3(最小间距)/§6.7
//       (端口连接判定)、A3 §3.2 (轮询规则)、精炼炉设备说明.md（轮询次序示例）、A5 §5/DD-010
//
// 每 Simulation Tick 对每台带 BuildingComp 的设备执行 A8 §7:
//   1. 更新设备内部状态 (T2.5):
//   1a. 计时推进: elapsed += dt(50ms), progress = elapsed / Recipe.time
//   1b. progress >= 1.0 → 原子结算（扣输入 + 加输出，同一 Tick 内同时完成）；
//       输出槽满 → blocked 暂缓（原料不扣，留在输入槽），之后每 Tick 重试，
//       输出腾出空间即完成暂缓的结算（A8 §2.2/§6.2）
//   1c. 无计时 → 匹配配方启动新计时（**不扣原料**）；结算成功后同 Tick 立即续启下一次
//   2. 输入物流 (T2.6 预约制 + T2.10 轮询): 先对全部输入口放行走到端口格中心(1.5)的
//       预约物品（视觉行程与轮询解耦），再从 inputPollIndex 指针端口起循环走访一圈
//       预约停在供给格中心(0.5)的队首——成功/跳过指针都前进，全部输入槽满则冻结不重置
//       （A8 §4.1；每端口每走访至多预约 1 件）。吸入不依赖配方——仓库类设备（T2.12）
//       同走物流路径（仓库口自身走 def.depot 分支，无限源/汇无公平性诉求，保持定义序）。
//   3. 输出物流 (T2.7 注入纪律 + T2.10 轮询): 相位窗口（beltPhase ≤ STOP_MAX）为全局
//       闸门，窗口外整步跳过且不动 outputPollQueue；窗口内按活跃队列轮转出货——成功
//       移队尾、失败移出（堵塞集=全部端口−队列），堵塞端口每 Tick 探测真实出货，
//       恢复追加队尾（A8 §4.2"顺序 1-2-3-1-2-3…；堵塞跳过；恢复追加到末尾"）。
//       每端口每 Tick 至多 1 件 (A8 §4.2)；注入相位 = beltPhase（物品=实体 pointer）。
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
import { STOP_MAX, BeltSystem } from './BeltSystem.ts';
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
import {
  emitSourceToBelt,
  tryAbsorbHeadItemSink,
} from './machine/DepotOps.ts';

/** 生产/物流事件（控制台输出/调试钩子用，仅状态转换或物品吞吐时产生，非每 Tick）。 */
export interface ProductionEvent {
  /** T2.5: start/settle/blocked/cancel；T2.6: input（传送带物品吸入输入槽）；
   *  T2.7: output（输出槽物品放出到传送带）；T2.12: depot-output/depot-input
   *  （仓库口吞吐——无限源/汇持续产生，只进 recentEvents 不转发控制台，防刷屏）。 */
  type: 'start' | 'settle' | 'blocked' | 'cancel' | 'input' | 'output'
    | 'depot-output' | 'depot-input';
  handle: EntityHandle;
  /** 关联配方 id；input 事件无配方（不适用）。 */
  recipeId?: string;
  /**
   * T2.10 轮询端口下标。type='input' → 输入端口过滤序（定义序左→中→右）中的下标；
   * type='output' → 输出端口过滤序中的下标；其余类型不带。
   * 供脚本断言轮询顺序（消息文案里同序号以"输入口N/输出口N"呈现）。
   */
  portIndex?: number;
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
        // 仓库口同理: 存货口 paused 只放行已预约物品、不预约新物品；取货口无输入口
        // 此处天然 no-op（T2.12）。
        this.releaseEnteringItems(world, handle, comp, def, beltAt);
        continue;
      }

      // ── T2.12 仓库口分支: 非生产设备，无内部状态/缓冲区，直接走 DepotOps ──
      // 取货口=每输出口放 1 件源物品（无限源）；存货口=预约制无条件吸入（无限汇）。
      if (def.depot !== undefined) {
        this.updateDepot(world, handle, comp, def, beltAt);
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
   * T2.12 仓库口物流（def.depot 分支）。非生产设备——无配方/缓冲区/状态机迁移
   * （state 恒 idle、currentRecipeId 恒 null，读数不显示任何数据）:
   *   - unload 取货口: 每输出口找接收带（A9 §6.7 背离设备），放 1 件源物品
   *     （emitSourceToBelt，与 T2.7 同律: 空段 + 相位窗口 + 每口每 Tick 1 件）。
   *   - load 存货口: 每输入口先放行走到端口格中心(1.5)的预约物品（复用
   *     releaseArrivedItems），再无条件预约队首（tryAbsorbHeadItemSink，无限汇
   *     永不堵塞——无槽位/类型/容量判定）。
   */
  private updateDepot(
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
    if (def.depot === 'unload') {
      for (const cell of outputPortCells(gx, gy, def, comp.direction)) {
        const receiver = findReceiverBelt(world, beltAt, cell);
        if (receiver === null) continue;
        const seg = world.getComponent<BeltSegmentComp>(receiver, 'BeltSegmentComp');
        if (!seg) continue;
        const emitted = emitSourceToBelt(seg);
        if (emitted !== null) {
          this.emit({
            type: 'depot-output', handle,
            message: `${def.name}: 输出 ${this.nameOf(emitted)} ×1（无限源 → 传送带）`,
          });
        }
      }
      return;
    }
    for (const cell of inputPortCells(gx, gy, def, comp.direction)) {
      const feeder = findFeederBelt(world, beltAt, cell);
      if (feeder === null) continue;
      const seg = world.getComponent<BeltSegmentComp>(feeder, 'BeltSegmentComp');
      if (!seg) continue;
      releaseArrivedItems(seg); // 阶段2: 走到端口格中心的预约物品移除（视觉消失）
      const absorbed = tryAbsorbHeadItemSink(seg); // 阶段1: 门口物品无条件预约
      if (absorbed !== null) {
        this.emit({
          type: 'depot-input', handle,
          message: `${def.name}: 接收 ${this.nameOf(absorbed)} ×1（传送带 → 无限汇）`,
        });
      }
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
   * A8 §7 步骤2 (T2.6 预约制 + T2.10 输入轮询)。
   * 两段式，放行与预约解耦:
   *   ① 放行扫描（全部输入口、定义序）: releaseArrivedItems 移除走到端口格中心(1.5)
   *      的预约物品——entering 物品的视觉行程不依赖轮询指针（指针跳过的端口也要放行，
   *      否则物品滞留在设备半格深处占住供给格）。
   *   ② 预约轮询（A8 §4.1）: 从 inputPollIndex 指向的端口起循环走访一圈，对每口
   *      tryAbsorbHeadItem 预约停在供给格中心(0.5)的队首。成功或跳过（无供给带/
   *      类型不符/未到门口）指针都 +1（mod n）；走访前/补货后检测"全部输入槽满"
   *      → 冻结: 指针保持不动不重置（A8 §4.1"轮询指针不重置"，精炼炉设备说明
   *      "A 补完之后…再降到 49 时 B 开始补货"的轮转次序）。
   * 满载早退放在放行之后——满载只冻结**新预约**，已预约物品照常进门。
   * 端口序 = inputPortCells 过滤序 = 定义序"左→中→右"；设备旋转只改端口世界位置，
   * 不改定义序，轮询次序与朝向无关。
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
    const cells = inputPortCells(gx, gy, def, comp.direction);
    const n = cells.length;
    if (n === 0) return;
    const capacity = def.bufferCapacity;

    // ① 放行扫描: 全部输入口的 entering 物品走到 1.5 即移除（与指针无关）
    for (const cell of cells) {
      const feeder = findFeederBelt(world, beltAt, cell);
      if (feeder === null) continue;
      const seg = world.getComponent<BeltSegmentComp>(feeder, 'BeltSegmentComp');
      if (!seg) continue;
      releaseArrivedItems(seg);
    }

    // ② 预约轮询。全部输入槽满 → 冻结（指针保持当前位置，A8 §4.1）
    const allFull = (): boolean => comp.bufferInput.every((s) => s.count >= capacity);
    if (allFull()) return;
    // 指针防御性归位（存档迁移/手改越界时回 0 而非崩溃）
    let idx = ((comp.inputPollIndex % n) + n) % n;
    for (let visited = 0; visited < n; visited++) {
      comp.inputPollIndex = (idx + 1) % n; // 先进指针: 成功/跳过同律（A8 §4.1 失败也移动到下一个）
      const feeder = findFeederBelt(world, beltAt, cells[idx]);
      if (feeder !== null) {
        const seg = world.getComponent<BeltSegmentComp>(feeder, 'BeltSegmentComp');
        if (seg) {
          const absorbed = tryAbsorbHeadItem(seg, comp, capacity);
          if (absorbed !== null) {
            this.emit({
              type: 'input', handle, portIndex: idx,
              message: `${def.name}: 吸入 ${this.nameOf(absorbed)} ×1（传送带 → 输入口${idx + 1}）`,
            });
            if (allFull()) break; // 补满即冻结在下一端口（下次 vacancy 从它开始）
          }
        }
      }
      idx = (idx + 1) % n;
    }
  }

  /**
   * A8 §7 步骤3 (T2.7 注入纪律 + T2.10 输出轮询)。
   * 输出轮询队列 comp.outputPollQueue（活跃端口按轮询序；堵塞集=全部端口−队列，派生不落盘）:
   *   - 全局闸门: 全空输出槽早退（队列零维护——无货可分时"失败"不是端口堵塞）；
   *     相位窗口外（beltPhase > STOP_MAX）整步跳过且**不动队列**——窗口关闭是全局节奏
   *     而非端口故障，若按端口失败处理会把队列每秒两次清空重建、丢失轮询序记忆
   *     （T2.7: 空带吞吐 1 件/2 秒的相位窗口纪律不变）。
   *   - 活跃轮转（A8 §4.2）: 按队列序逐口尝试出货——成功移到队尾（1→2→3→1…轮转）；
   *     失败（无接收带 / 接收带被占——一格一物品满带）移出队列进入堵塞集。
   *     分发中途货物耗尽即停，剩余端口保留在队列中（槽空≠端口堵塞）。
   *   - 恢复探测（A8 §4.2"恢复追加队尾"）: 堵塞端口每 Tick 按下标序尝试真实出货，
   *     成功即追加到当前轮询队尾（不插回原位）；仍堵则保持引用等待。
   */
  private emitBeltOutputs(
    world: World,
    handle: EntityHandle,
    comp: BuildingComp,
    def: BuildingDefinition,
    beltAt: Map<string, EntityHandle>,
  ): void {
    // 早退: 全空输出槽无货可出（跳过端口遍历与队列维护——性能基准 100 台空炉零开销）
    if (!comp.bufferOutput.some((s) => s.count > 0)) return;
    const pos = world.getComponent<Position>(handle, 'Position');
    if (!pos) return;
    const gx = Math.round(pos.x / CELL_SIZE);
    const gy = Math.round(pos.y / CELL_SIZE);
    const cells = outputPortCells(gx, gy, def, comp.direction);
    const n = cells.length;
    if (n === 0) return;
    // 相位窗口全局闸门（必须在任何队列变动之前）
    if (BeltSystem.beltPhase > STOP_MAX) return;

    const hasGoods = (): boolean => comp.bufferOutput.some((s) => s.count > 0);
    // 队列卫生: 过滤越界/重复项（存档迁移/手改防御），保持既有轮询次序
    const seen = new Set<number>();
    const active = comp.outputPollQueue.filter((i) => {
      if (i < 0 || i >= n || seen.has(i)) return false;
      seen.add(i);
      return true;
    });

    /** 尝试从输出槽放 1 件到端口 idx 的接收带。成功返回 itemId；端口不可写返回 null。 */
    const tryEmitAt = (idx: number): string | null => {
      const receiver = findReceiverBelt(world, beltAt, cells[idx]);
      if (receiver === null) return null;
      const seg = world.getComponent<BeltSegmentComp>(receiver, 'BeltSegmentComp');
      if (!seg || seg.items.length > 0) return null; // 无段 / 满带（一格一物品）
      return tryEmitToBelt(seg, comp); // 空段+有货+窗口内必成功
    };
    const emitOut = (idx: number, itemId: string): void => {
      this.emit({
        type: 'output', handle, portIndex: idx,
        message: `${def.name}: 输出 ${this.nameOf(itemId)} ×1（输出口${idx + 1} → 传送带）`,
      });
    };

    // ── 活跃队列轮转（恰好走访初始队列一轮）──
    // 成功 → 移队尾；失败 → 移出。两种情形都让"下一个未处理端口"落进 qi 位
    // （qi 不递增），以 visited 计数保证只走访初始元素一遍——轮转到队尾的
    // 端口本轮不再回头（它刚出过货/刚被判堵，重访会误伤队列状态）。
    let qi = 0;
    for (let visited = 0, total = active.length;
      visited < total && qi < active.length && hasGoods();
      visited++) {
      const idx = active[qi];
      const itemId = tryEmitAt(idx);
      if (itemId !== null) {
        active.splice(qi, 1);
        active.push(idx);
        emitOut(idx, itemId);
      } else {
        active.splice(qi, 1); // 失败 → 移出队列（堵塞集成员）
      }
    }

    // ── 堵塞恢复探测: 堵塞端口按下标序尝试真实出货，成功 → 追加队尾 ──
    for (let idx = 0; idx < n && hasGoods(); idx++) {
      if (active.includes(idx)) continue; // 活跃端口本轮已处理
      const itemId = tryEmitAt(idx);
      if (itemId === null) continue; // 仍堵（无接收带/满带），保持引用等待
      active.push(idx); // 恢复 → 追加到当前轮询顺序末尾（A8 §4.2，不插回原位）
      emitOut(idx, itemId);
    }
    comp.outputPollQueue = active;
  }
}
