// 物流调试日志 — 2026-09-02 用户报告"三带未同时进料/疑似从第一件就开始轮询"定位用
// （先例: 指针问题期的 POINTER_DEBUG_CONSOLE——问题定位后本模块整体退役删除）
//
// 开关: main.ts 启动时默认开启 + 横幅；__game.logisticsDebug(false) 关闭 / (true) 重开（重开会
//       立即打印一次全场快照）；__game.logisticsLog(n=80) 覆盘最近 n 条。关闭时 log() 短路零开销。
//
// 记录内容（全部**跳变/事件**驱动，非每 Tick 刷屏）:
//   BeltSystem:   物品停止（位置+原因: 断头钳制/下游占用钳制/间距夹紧）、恢复前进、跨段
//   MachineSystem: 先到排名戳记、预约吸入（供给格+槽位变化）、走进设备消失(1.5)、
//                  门口等待开始/解除（槽满/类型不符）、满载冻结/腾位恢复、生产启动/结算/阻塞
//   main.ts:      开关时打印全场设备快照（端口连接、门口物品、排名、指针、槽位）
//
// 环形缓冲 400 条（与 MAX_RECENT_EVENTS 同理——覆盘用，超限丢最旧）。

/** 物流调试日志单例（BeltSystem/MachineSystem/main.ts 共用）。 */
class LogisticsDebug {
  /** 总开关（false 时 log 短路）。 */
  enabled = false;
  /** 覆盘缓冲（__game.logisticsLog 读）。 */
  readonly entries: string[] = [];
  private t0 = 0;
  private readonly maxLength = 400;

  /** 开/关（重开时清缓冲 + 横幅；调用方负责随后打印快照）。 */
  enable(on: boolean): void {
    this.enabled = on;
    if (on) {
      this.t0 = performance.now();
      this.entries.length = 0;
      this.log('═══ 物流调试日志开启（跳变/事件驱动；关闭: __game.logisticsDebug(false)；覆盘: __game.logisticsLog()）═══');
    }
  }

  /** 记一条（关闭时零开销短路）。 */
  log(msg: string): void {
    if (!this.enabled) return;
    const t = ((performance.now() - this.t0) / 1000).toFixed(2);
    const line = `[物流调试] +${t}s ${msg}`;
    this.entries.push(line);
    if (this.entries.length > this.maxLength) this.entries.shift();
    console.log(line);
  }

  /** 覆盘最近 n 条（默认 80），返回拼接文本。 */
  dump(n = 80): string {
    return this.entries.slice(-n).join('\n');
  }
}

export const logisticsDebug = new LogisticsDebug();
