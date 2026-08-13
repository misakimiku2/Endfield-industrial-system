// 仿真主循环 — A5 §2 双时钟架构
// 依据: simulation-spec.md §1/§2 (GameLoop)、DD-004 (20 TPS vs 60 FPS)、DD-014 (Frame Budget)
//
// 双时钟:
//   Simulation Clock 20 TPS (固定 dt=50ms) — BeltSystem/MachineSystem 等逻辑系统在此跑
//   Render Clock 60 FPS (~16.7ms)          — RenderSystem 读上一 Tick 快照渲染
//
// 固定步长 accumulator: 每渲染帧把 frameDeltaMS 累入 simAccumulator，每满 SIM_STEP_MS
//   跑一次 tick()（调用全部 system.update(world, 50)）。螺旋追赶保护: 累积超过
//   SIM_ACCUMULATOR_MAX_MS 时钳制，避免卡顿后一次性跑大量 tick 导致"追赶崩溃"。
//
// 渲染读快照 (A5 §1.1): RenderSystem 在两次 Tick 之间可能运行多次，读取的 Component
//   状态始终是"上一个完整 Tick 结束后的快照"，不存在半个 Tick 的中间状态。
//
// 速度/暂停 (A5 §4/§6): 预留 speedMultiplier(0×~8×) 与 paused 标志。T2.1 不加 UI，
//   默认 1× 不暂停；倍速通过让 accumulator 累积更快实现（单 Tick 内逻辑不变，dt 恒为 50ms）。

import type { World } from './ECS';
import { SIM_STEP_MS, SIM_ACCUMULATOR_MAX_MS } from './render/constants';

/**
 * 仿真系统接口 (A5 §2)。system.update 的 dt **始终为 50ms**，无需处理变长 dt。
 * Tick 内 System 执行顺序由 GameLoop 注册顺序决定（A5 §5/DD-010）:
 *   BeltSystem → MachineSystem → TurretSystem → EnemySystem → CleanupSystem
 */
export interface SimulationSystem {
  /** 单 Tick 推进。dt 恒为 SIM_STEP_MS(50ms)。 */
  update(world: World, dt: number): void;
}

/**
 * 仿真主循环。用法: 每渲染帧调用 update(frameDeltaMS)。
 */
export class GameLoop {
  private world: World;
  private systems: SimulationSystem[] = [];
  /** 累积的仿真时间（ms），每满 SIM_STEP_MS 跑一次 tick。 */
  private simAccumulator = 0;

  /** 暂停标志 (A5 §6)。true 时 tick 停止，渲染继续（相机可操作）。 */
  paused = false;
  /** 速度倍率 (A5 §4): 0=暂停效果, 1=默认, 2/4/8=加速。单 Tick 内 dt 恒定，仅改变累积速率。 */
  speedMultiplier = 1;

  constructor(world: World) {
    this.world = world;
  }

  /** 注册仿真系统（按注册顺序在每 Tick 内执行，A5 §5/DD-010）。 */
  addSystem(sys: SimulationSystem): void {
    this.systems.push(sys);
  }

  /**
   * 每渲染帧调用一次：累积时间 → 跑整数个 Tick。
   * @param frameDeltaMS 自上一渲染帧的毫秒数（来自 PixiJS ticker）。
   */
  update(frameDeltaMS: number): void {
    if (this.paused) return; // 暂停: 不跑 Tick（渲染由调用方继续）
    // 倍速: 让 accumulator 累积更快，单 Tick 内逻辑(dt=50ms)不变 (A5 §4)
    this.simAccumulator += frameDeltaMS * this.speedMultiplier;
    // 螺旋追赶保护 (A5 §2): 累积超上限则钳制，避免卡顿后追赶崩溃
    if (this.simAccumulator > SIM_ACCUMULATOR_MAX_MS) {
      this.simAccumulator = SIM_ACCUMULATOR_MAX_MS;
    }
    // 固定步长消费: 每满一个 SIM_STEP_MS 跑一次 tick
    while (this.simAccumulator >= SIM_STEP_MS) {
      this.simAccumulator -= SIM_STEP_MS;
      this.tick();
    }
  }

  /** 当前 accumulator 值（0~SIM_STEP_MS），供未来渲染插值用（A5 §1.1 快照→平滑）。 */
  get accumulator(): number {
    return this.simAccumulator;
  }

  /** 执行一个完整 Tick: 按顺序调用全部 system.update(world, dt)。 */
  private tick(): void {
    const dt = SIM_STEP_MS; // dt 恒定 50ms (DD-004)
    for (const sys of this.systems) {
      sys.update(this.world, dt);
    }
  }
}
