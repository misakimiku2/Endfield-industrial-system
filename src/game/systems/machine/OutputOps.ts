// 输出对接操作 — 设备输出端口 → 传送带注入 (T2.7 → T2.21 输出传送带轮询)
// 依据: implementation-phase-2.md T2.7、A9 logistics-spec.md §6.7(端口连接判定)、
//       A8 production-system-spec.md §7 步骤3(输出物流)/§4.2(输出轮询)、
//       一格一物品规则（用户 2026-08-17 澄清，修订 A9 §2.3 间距）
//
// 纯逻辑模块 (DD-011，IntakeOps 先例): 判定"哪条传送带在接哪个输出端口的货"
// 与"从输出槽放出一件物品到传送带"，由 MachineSystem 每 Tick 对每台设备调用
// （A8 §7 顺序: 内部状态 → 输入物流 → 输出物流）。
//
// 连接判定 (A9 §6.7): 传送带段的 Cell 与设备某 Output Port 的 Cell 相邻，
//   且传送带方向"背离"设备——段的入口侧（段格 − 入口朝向向量）恰为端口格。
//   直段入口朝向 = direction；转角段 = entryDir（物品从 entryDir 侧进入转角）。
//   接收段的入口侧是端口格（被设备占据、链不可能穿过设备），故接收段必为链首
//   segmentIndex 0 —— "传送带创建顺序" = "链创建顺序"（T2.21 轮询排序键）。
// 注入相位（2026-08-25 退役"物品=实体 pointer"约定，用户实测: 不同时间创建的
//   传送带物品/指针全局锁步不符实际玩法）: 旧版注入在全局 beltPhase 相位且仅
//   ≤STOP_MAX 窗口注入；改为**段首 progress=0** 注入——物品进度独立推进，断头
//   钳制 0→0.5 只进不退无后跳，相位窗口退役；指针动画按链独立相位（渲染层）。
//   （MachineSystem.emitBeltOutputs 里残留的 beltPhase 闸门已于 T2.21 一并移除，
//   由设备级输出节拍取代——见 syncOutputBeltQueue/pollOutputBelt 与 BuildingComp
//   .outputNextEmitTick。）
// 满带判定 (一格一物品): 只往**空段**注入——段上已有物品即满，物品留在输出槽，
//   每 Tick 重试（带腾位即恢复，对称 T2.6 疏通）。吞吐 1 件/格 × 0.5 格/秒 = 每 2 秒 1 件。
// 轮询 (T2.21，2026-09-05 用户重定语义): 轮询单元 = **接收传送带**（按创建顺序，
//   不再按端口定义序）；节流 = **设备级**每 40 Tick(=一格传送带时长) 至多成功 1 件
//   ——多带只分摊不提速（1 条带 1-1-1 / 2 条各 1-0-1 / 3 条各 1-0-0）。队列轮转/
//   同步/走访决策在 pollOutputBelt（本模块），节拍计时器由 MachineSystem 管理。

import type { World, EntityHandle } from '../../ECS.ts';
import type { BeltSegmentComp } from '../../components/BeltSegmentComp.ts';
import type { BuildingComp, Direction } from '../../components/BuildingComp.ts';
import type { BuildingDefinition } from '../../data/buildings.ts';
import { directionVector } from '../belt/BeltPathGeometry.ts';
import { rotatePort, rotateDirection, portOutwardBase } from '../PortGeometry.ts';
import { consumeFromSlot } from './BufferOps.ts';
import type { PortCell } from './IntakeOps.ts';

/**
 * 计算设备全部**输出**端口的世界格（按定义顺序，即"左→中→右"连接序）。
 * 输入端口在 IntakeOps.inputPortCells（liquid 端口由 Phase 2+ 处理）。
 * @param gx gy 建筑左上角格坐标（Position / CELL_SIZE）
 */
export function outputPortCells(
  gx: number,
  gy: number,
  def: BuildingDefinition,
  direction: Direction,
): PortCell[] {
  const cells: PortCell[] = [];
  for (const port of def.ports) {
    if (port.type !== 'output') continue;
    const o = rotatePort(port, def.footprint, direction);
    cells.push({
      port,
      x: gx + o.dx,
      y: gy + o.dy,
      outward: rotateDirection(portOutwardBase(port, def.footprint), direction),
    });
  }
  return cells;
}

/**
 * 找接收端口出货的传送带段 (A9 §6.7 "设备输出 → 传送带")。
 * 对 4 个方向 k 检查端口格 + dv(k) 处是否有段，且该段的**入口朝向**为 k——
 * 段格 − dv(入口朝向) = 端口格，即传送带从端口方向进料、流向背离设备。
 * 直段入口朝向 = direction；转角段 = entryDir（A9 §6.2 转角从入方向一侧进料）。
 * @returns 接收段 handle；无则 null。
 */
export function findReceiverBelt(
  world: World,
  beltAt: Map<string, EntityHandle>,
  portCell: { x: number; y: number },
): EntityHandle | null {
  const dirs: readonly Direction[] = [0, 90, 180, 270];
  for (const k of dirs) {
    const dv = directionVector(k);
    const h = beltAt.get(`${portCell.x + dv.x},${portCell.y + dv.y}`);
    if (h === undefined) continue;
    const seg = world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp');
    if (seg && (seg.entryDir ?? seg.direction) === k) return h;
  }
  return null;
}

/**
 * 解析传送带段的创建序键 (T2.21)。chainId 格式 "chain-${Date.now()}-${序号}"
 * （BeltCreationSystem 链创建时一次性赋值、之后永不改写；main.ts 演示脚本用
 * 随机后缀，同样可解析）。同链内按 segmentIndex 决胜（接收段必为链首 0，
 * 见文件头注释——segmentIndex 仅作确定性防御，跨链不可比时兜底）。
 * @returns [时间戳, 链内序号, 段序] 元组，升序比较即"传送带创建顺序"。
 */
export function beltCreationKey(seg: BeltSegmentComp): [number, number, number] {
  const parts = seg.chainId.split('-');
  const ts = Number(parts[1]);
  const serial = Number(parts[2]);
  return [
    Number.isFinite(ts) ? ts : 0,
    Number.isFinite(serial) ? serial : 0,
    seg.segmentIndex,
  ];
}

/** beltCreationKey 的元组升序比较（collectReceiverBelts 排序与调试显示共用）。 */
export function compareBeltCreation(
  a: BeltSegmentComp,
  b: BeltSegmentComp,
): number {
  const ka = beltCreationKey(a);
  const kb = beltCreationKey(b);
  return ka[0] !== kb[0] ? ka[0] - kb[0]
    : ka[1] !== kb[1] ? ka[1] - kb[1]
    : ka[2] - kb[2];
}

/** 设备的一个候选接收带（T2.21 轮询单元）。 */
export interface ReceiverBelt {
  /** 接收段实体 handle（输出轮询队列的元素）。 */
  handle: EntityHandle;
  /** 首个发现该带的输出端口下标（outputPortCells 过滤序；事件/调试文案用）。 */
  portIndex: number;
  /** 接收段组件（调用方免去二次 getComponent）。 */
  seg: BeltSegmentComp;
}

/**
 * 收集设备全部输出端口的候选接收带 (T2.21，替代"每端口固定方向序取第一条"——
 * 同端口旁多条接收带不再饿死，全部进入设备级轮询)。对每个端口格 4 邻格收集
 * 所有"入口朝向背离设备"的段（直段 direction / 转角 entryDir），按 handle 去重
 * （跨端口/跨方向重复计入一次，先到端口记 portIndex），返回按创建序升序。
 */
export function collectReceiverBelts(
  world: World,
  beltAt: Map<string, EntityHandle>,
  cells: ReadonlyArray<{ x: number; y: number }>,
): ReceiverBelt[] {
  const dirs: readonly Direction[] = [0, 90, 180, 270];
  const byHandle = new Map<EntityHandle, ReceiverBelt>();
  for (let portIndex = 0; portIndex < cells.length; portIndex++) {
    const cell = cells[portIndex]!;
    for (const k of dirs) {
      const dv = directionVector(k);
      const h = beltAt.get(`${cell.x + dv.x},${cell.y + dv.y}`);
      if (h === undefined || byHandle.has(h)) continue;
      const seg = world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp');
      if (seg && (seg.entryDir ?? seg.direction) === k) {
        byHandle.set(h, { handle: h, portIndex, seg });
      }
    }
  }
  return Array.from(byHandle.values()).sort((a, b) => compareBeltCreation(a.seg, b.seg));
}

/**
 * 输出轮询队列同步（纯函数，T2.21）。
 *  1. 失效清理: 队列中已非本 Tick 候选的 handle 移除（带被删除/改道）。
 *  2. 新带接入: 不在队列中的候选按**创建序**追加队尾——动态接入自动加入轮询
 *     （A 独跑中接入 B，下一件仍先出 A 再轮 B；同 Tick 批量接入按创建序排队）。
 *     已在队列中的带保持既有轮询序（轮转/恢复位置记忆不被重建打乱）。
 * @param queue 当前轮询序（入参不修改，返回新数组）
 * @param candidates 本 Tick 候选带（collectReceiverBelts 输出，创建序升序）
 */
export function syncOutputBeltQueue(
  queue: readonly number[],
  candidates: ReadonlyArray<{ handle: number }>,
): number[] {
  const candSet = new Set(candidates.map((c) => c.handle));
  const q = queue.filter((h) => candSet.has(h));
  const inQueue = new Set(q);
  for (const c of candidates) {
    if (!inQueue.has(c.handle)) {
      q.push(c.handle);
      inQueue.add(c.handle);
    }
  }
  return q;
}

/**
 * 输出轮询单 Tick 决策（纯函数，T2.21；设备级节拍计时器由 MachineSystem 管理）。
 * 先 syncOutputBeltQueue 同步队列，再从队头走访**最多一轮**：队头带可写 → 选定
 * 并移到队尾（成功轮转）；不可写（满带一格一物品）→ 移出队列本 Tick 不回队，
 * 下一 Tick 同步时按创建序重新追加队尾 ≈ A8 §4.2"堵塞移出、恢复追加队尾"。
 * 走访在首条可写带处停止——设备级节拍下每 Tick 至多出 1 件，其余带留给下一节拍
 * （这正是 N 条带各得 1/N 频率、总速率恒为 1 件/40 Tick 的机制核心）。
 * @param canAccept 带是否可写（段空 = 一格一物品；由调用方查 BeltSegmentComp）
 * @returns 新队列 + 选定带 handle（null = 本 Tick 不出货、不重置节拍）。
 */
export function pollOutputBelt(
  queue: readonly number[],
  candidates: ReadonlyArray<{ handle: number }>,
  canAccept: (handle: number) => boolean,
): { queue: number[]; chosen: number | null } {
  const q = syncOutputBeltQueue(queue, candidates);
  let chosen: number | null = null;
  for (let remaining = q.length; remaining > 0 && chosen === null; remaining--) {
    const h = q.shift()!;
    if (canAccept(h)) {
      chosen = h;
      q.push(h);
    }
  }
  return { queue: q, chosen };
}

/**
 * 尝试从输出槽放出一件物品到传送带段首。
 * 取第一个非空输出槽（一槽一物，A8 §2.2），注入段 items[] **段首 progress=0**
 * （紧邻设备的入口边界，视觉"从机器里出来"），扣减输出槽 count（到 0 解锁）。
 *
 * 注入相位沿革（2026-08-25 退役"物品=实体 pointer"约定）: 旧版注入在全局
 * beltPhase 相位且仅 ≤STOP_MAX 窗口注入——物品与指针动画全局锁步，不同时间
 * 创建的传送带看起来同步流动（用户实测指出不符实际玩法）。改为段首注入后
 * 物品进度独立推进（断头钳制 0→0.5 只进不退，无视觉后跳，相位窗口不再需要），
 * 指针动画改为按链独立相位（BeltPointerRenderer）。
 * @returns 放出的 itemId；null = 输出槽空 / 段上已有物品（一格一物品 → 满带，
 *          物品留在输出槽，下 Tick 重试）。
 */
export function tryEmitToBelt(
  seg: BeltSegmentComp,
  comp: BuildingComp,
): string | null {
  // 1. 第一个非空输出槽（全部为空 → 无货可出）
  let slot = null as (typeof comp.bufferOutput)[number] | null;
  for (const s of comp.bufferOutput) {
    if (s.itemId !== null && s.count > 0) { slot = s; break; }
  }
  if (slot === null || slot.itemId === null) return null;
  const itemId = slot.itemId; // consumeFromSlot 扣到 0 会置 null，先取

  // 2. 一格一物品: 只往空段注入（段上已有物品 → 满带，物品留在输出槽）
  const items = seg.items ?? (seg.items = []);
  if (items.length > 0) return null;

  // 3. 注入段首 progress=0（delta=0: 出现即静止，下一 Tick 起 BeltSystem 推进并插值）
  items.push({ itemId, progress: 0, delta: 0 });
  consumeFromSlot(slot, 1);
  return itemId;
}
