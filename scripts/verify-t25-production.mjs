// T2.5 浏览器验收: 生产计时与生产循环（控制台监控路径）
// 依据: implementation-phase-2.md T2.5 验收标准
//
// 前置: vite dev server 在 localhost:5173，Chrome 带 --remote-debugging-port=9222。
// 运行: node scripts/verify-t25-production.mjs
//
// 断言:
//   生产计时（核心链路）:
//     1. placeAt 放精炼炉 + injectInput 源矿×3 → 自动启动计时（state=working）
//     2. 计时期间输入槽源矿数量保持 ×3 不变（只有结算那一刻才扣除）
//     3. 进度随时间推进（两次采样递增且 <100%）
//     4. ~2 秒后原子结算: 输入槽 源矿 -1（×2）、输出槽 晶体外壳 +1
//     5. 控制台消息: "计时完成！原子结算：输入槽 源矿 -1，输出槽 晶体外壳 +1"
//     6. 自动续启: "已启动下一次生产计时..."，state 保持 working
//   blocked 暂缓（A8 §2.2）:
//     7. 注满输出槽 + 原料充足 → 计时完成后 state=blocked、原料未扣除
//     8. consumeOutput(1) 疏通 → 下一 Tick 完成暂缓结算（"输出疏通"消息）并恢复 working
//   液体配方:
//     9. 只投赤铜矿（赤铜块需清水，液体端口未实现）→ 保持 idle 无计时
const CDP = 'http://localhost:9222';
const APP = process.env.APP_URL || 'http://localhost:5173';

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name} ${extra}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0; this.pending = new Map();
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
  }
  async send(method, params = {}) {
    await this.ready; const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
}
async function evalJs(cdp, e) {
  const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}
/** 采样生产状态: { state, progress, inputCount, outputCount } */
const sample = `(() => {
  const s = __game.productionStatus();
  const m = s.match(/: (\\w+) \\|/);
  const p = s.match(/进度: ([\\d.]+)%/);
  const inCount = s.match(/输入槽0: 源矿 × (\\d+)/);
  const outCount = s.match(/输出槽0: 晶体外壳 × (\\d+)/);
  return {
    state: m ? m[1] : 'idle',
    progress: p ? parseFloat(p[1]) : 0,
    inputCount: inCount ? parseInt(inCount[1]) : 0,
    outputCount: outCount ? parseInt(outCount[1]) : 0,
    raw: s.split('\\n')[0],
  };
})()`;

const t = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' }).then((r) => r.json());
const cdp = new CDPClient(t.webSocketDebuggerUrl);
try {
  // 等待应用就绪（__game + T2.5 钩子）
  let ready = false;
  for (let i = 0; i < 60; i++) {
    ready = await evalJs(cdp, `!!(window.__game && window.__game.productionStatus && window.__game.productionLog)`).catch(() => false);
    if (ready) break;
    await sleep(500);
  }
  if (!ready) { console.log('FAIL: window.__game T2.5 钩子未就绪'); process.exit(1); }

  console.log('[生产计时核心链路]');
  await evalJs(cdp, `__game.clearAllPlaced()`);
  const placed = await evalJs(cdp, `__game.placeAt('refining_unit', 5, 5)`);
  check('1a. 放置精炼炉', placed === true);
  await evalJs(cdp, `__game.injectInput('originium_ore', 3)`);
  await sleep(150); // 等 1~3 个仿真 Tick 启动计时
  let s1 = await evalJs(cdp, sample);
  check('1b. 注入源矿×3 → 自动启动计时', s1.state === 'working', s1.raw);

  await sleep(600);
  const s2 = await evalJs(cdp, sample);
  check('2. 计时期间输入槽源矿保持 ×3（结算前不扣）', s2.inputCount === 3, `实际 ×${s2.inputCount}`);
  check('3. 进度随时间推进', s2.progress > s1.progress && s2.progress < 100,
    `${s1.progress}% → ${s2.progress}%`);

  // 等待结算（2 秒配方，从注入起 2.2s 足够；再留裕量）
  await sleep(1600);
  const s3 = await evalJs(cdp, sample);
  check('4a. 原子结算: 输入槽 源矿 -1', s3.inputCount === 2, `实际 ×${s3.inputCount}`);
  check('4b. 原子结算: 输出槽 晶体外壳 +1', s3.outputCount === 1, `实际 ×${s3.outputCount}`);
  check('4c. 结算后自动续启（仍 working）', s3.state === 'working', s3.raw);

  const logs = await evalJs(cdp, `__game.productionLog().map(e => e.message)`);
  check('5. 控制台消息: 计时完成原子结算',
    logs.some((m) => m.includes('计时完成！原子结算：输入槽 源矿 -1，输出槽 晶体外壳 +1')),
    (logs.find((m) => m.includes('计时完成')) || '无结算消息').slice(0, 60));
  check('6. 控制台消息: 已启动下一次生产计时',
    logs.some((m) => m.includes('已启动下一次生产计时')),
    (logs.find((m) => m.includes('已启动')) || '无启动消息').slice(0, 60));

  console.log('[blocked 暂缓与疏通]');
  await evalJs(cdp, `__game.clearAllPlaced()`);
  await evalJs(cdp, `__game.placeAt('refining_unit', 5, 5)`);
  await evalJs(cdp, `__game.injectOutput('origocrust', 50)`); // 输出注满
  const outFull = await evalJs(cdp, `__game.outputBuffer()`);
  check('7a. 注满输出槽', outFull === '输出槽0: 晶体外壳 × 50/50 (已锁定)', `"${outFull}"`);
  await evalJs(cdp, `__game.injectInput('originium_ore', 5)`);
  await sleep(2400); // 启动 + 2 秒计时完成
  const b1 = await evalJs(cdp, sample);
  check('7b. 计时完成但输出满 → blocked', b1.state === 'blocked', b1.raw);
  check('7c. 暂缓期间原料未扣除（仍 ×5）', b1.inputCount === 5, `实际 ×${b1.inputCount}`);
  const blockedLogs = await evalJs(cdp, `__game.productionLog().map(e => e.message)`);
  check('7d. blocked 事件消息', blockedLogs.some((m) => m.includes('blocked') && m.includes('原料未扣除')));

  await evalJs(cdp, `__game.consumeOutput(1)`); // 模拟 T2.7 传送带取走 1 件
  await sleep(200); // 下一仿真 Tick 完成暂缓结算 + 续启
  const b2 = await evalJs(cdp, sample);
  check('8a. 疏通后完成暂缓结算: 输入 -1', b2.inputCount === 4, `实际 ×${b2.inputCount}`);
  check('8b. 疏通后输出回满 50/50', b2.outputCount === 50, `实际 ×${b2.outputCount}`);
  check('8c. 恢复 working', b2.state === 'working', b2.raw);
  const resumeLogs = await evalJs(cdp, `__game.productionLog().map(e => e.message)`);
  check('8d. "输出疏通，计时完成" 消息', resumeLogs.some((m) => m.includes('输出疏通，计时完成！原子结算')));

  console.log('[液体配方不启动]');
  await evalJs(cdp, `__game.clearAllPlaced()`);
  await evalJs(cdp, `__game.placeAt('refining_unit', 5, 5)`);
  await evalJs(cdp, `__game.injectInput('cuprium_ore', 5)`);
  await sleep(400);
  const liq = await evalJs(cdp, sample);
  check('9. 只投赤铜矿（赤铜块需清水）→ 保持 idle', liq.state === 'idle', liq.raw);

  await evalJs(cdp, `__game.clearAllPlaced()`);
} finally {
  await cdp.send('Target.closeTarget', { targetId: t.id }).catch(() => {});
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
