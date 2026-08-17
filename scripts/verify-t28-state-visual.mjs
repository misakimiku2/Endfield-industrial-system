// T2.8 浏览器验收: 设备状态机与终末地风格状态视觉（paused + LOGO 切换 + 端口高亮）
// 依据: implementation-phase-2.md T2.8 验收标准
//
// 前置: vite dev server 在 localhost:5173，Chrome 带 --remote-debugging-port=9222。
// 运行: node scripts/verify-t28-state-visual.mjs
//
// 断言（逻辑态与画面高亮同源——PortHighlightRenderer 与 __game.portStatus 共用 PortStatusOps）:
//   1. 场景: 精炼炉(5,5) + 下行输入带×3 + 上行输出带×3 + 源矿 → working（外观与现状一致）
//   2. 端口连接: portStatus 输入中口(6,7)/输出中口(6,5) ●黄（画面端口格 #FFEF00）
//   3. setPaused(true): productionStatus 含 "(已暂停)"（与 LOGO 深灰图标对照）、进度冻结（2 秒采样不变）
//   4. setPaused(false): "(已暂停)" 消失、恢复推进
//   5. blocked: 注满输出 → state=blocked（LOGO 红 X）
//   6. 输入堵红: 注满输入 + 上带物品 → 停门口 → portStatus 输入 ●红
//   7. 输出堵红: 满带留槽 → portStatus 输出 ●红
//   8. 疏通: consumeOutput → 非 blocked；生产消耗输入 → 门口物品进门 → 输入回黄
//   9. 一键测试 __game.test('t28') 完整跑通 + 二次调用被忽略
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
/** productionStatus 解析: { state, paused, elapsedMs }。 */
const prodInfo = `(() => {
  const s = __game.productionStatus();
  const m = s.match(/: (\\w+)( \\(已暂停\\))? \\|/);
  const p = s.match(/\\((\\d+)\\/(\\d+)ms\\)/);
  return {
    state: m ? m[1] : 'none',
    paused: s.includes('(已暂停)'),
    elapsedMs: p ? parseInt(p[1]) : -1,
  };
})()`;
/** portStatus 指定行（'输入'/'输出'）中是否有 ●红/●黄。 */
const portHas = (kind, mark) => `(() => {
  const s = __game.portStatus();
  const line = s.split('\\n').find((l) => l.trim().startsWith('${kind}'));
  return line !== undefined && line.includes('${mark}');
})()`;
/** 等待表达式为真。 */
async function waitUntil(cdp, expr, timeoutMs, stepMs = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJs(cdp, expr).catch(() => false)) return true;
    await sleep(stepMs);
  }
  return await evalJs(cdp, expr).catch(() => false);
}

const t = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' }).then((r) => r.json());
const cdp = new CDPClient(t.webSocketDebuggerUrl);
try {
  // 等待应用就绪（__game + T2.8 钩子）
  let ready = false;
  for (let i = 0; i < 60; i++) {
    ready = await evalJs(cdp, `!!(window.__game && window.__game.setPaused && window.__game.portStatus && window.__game.test)`).catch(() => false);
    if (ready) break;
    await sleep(500);
  }
  if (!ready) { console.log('FAIL: window.__game 钩子未就绪'); process.exit(1); }

  console.log('[场景: 精炼炉 + 输入/输出传送带 → working（外观与现状一致）]');
  await evalJs(cdp, `__game.clearAllPlaced()`);
  check('1a. 放置精炼炉(5,5)', await evalJs(cdp, `__game.placeAt('refining_unit', 5, 5)`) === true);
  const inBelt = await evalJs(cdp, `__game.spawnBelt([[6, 10], [6, 9], [6, 8]], 270)`);
  const outBelt = await evalJs(cdp, `__game.spawnBelt([[6, 4], [6, 3], [6, 2]], 270)`);
  check('1b. 下行输入带×3 + 上行输出带×3', inBelt === 3 && outBelt === 3, `输入 ${inBelt} 段 / 输出 ${outBelt} 段`);
  await evalJs(cdp, `__game.injectInput('originium_ore', 10)`);
  const working = await waitUntil(cdp, `(() => ${prodInfo}.state === 'working')()`, 10000);
  check('1c. 注源矿后进入 working（LOGO 保持原 LOGO 不变）', working, await evalJs(cdp, `__game.productionStatus()`));

  console.log('[端口连接高亮: 对应端口格变黄 #FFEF00]');
  check('2a. 输入中口 (6,7) ●黄（有供给带）', await evalJs(cdp, portHas('输入', '●黄(已连接)')));
  check('2b. 输出中口 (6,5) ●黄（有接收带）', await evalJs(cdp, portHas('输出', '●黄(已连接)')));
  check('2c. 未连接端口无红', !(await evalJs(cdp, portHas('输入', '●红'))));
  console.log('    ' + (await evalJs(cdp, `__game.portStatus()`)).split('\n').slice(1).join('\n    '));

  console.log('[手动暂停: LOGO 深灰图标 + 计时冻结 + 不吞吐]');
  const pausedMsg = await evalJs(cdp, `__game.setPaused(true)`);
  check('3a. setPaused(true) 后 productionStatus 含 "(已暂停)"（与 LOGO 深灰图标对照）', String(pausedMsg).includes('(已暂停)'));
  const frozenMs = await evalJs(cdp, `(${prodInfo}).elapsedMs`);
  await sleep(2000);
  const stillMs = await evalJs(cdp, `(${prodInfo}).elapsedMs`);
  check('3b. 暂停期间进度冻结（2 秒采样 elapsed 不变）', stillMs === frozenMs, `冻结于 ${frozenMs}ms`);
  await sleep(2000); // 观察深灰图标

  const resumedMsg = await evalJs(cdp, `__game.setPaused(false)`);
  check('4a. setPaused(false) 后 "(已暂停)" 消失', !String(resumedMsg).includes('(已暂停)'));
  const progressAgain = await waitUntil(cdp,
    `(() => { const p = ${prodInfo}; return p.elapsedMs > ${frozenMs} || p.state === 'idle'; })()`, 6000);
  check('4b. 恢复后从暂停处继续（elapsed 超过冻结值推进）', progressAgain,
    `elapsed ${await evalJs(cdp, `(${prodInfo}).elapsedMs`)}ms`);

  console.log('[blocked: 输出堆满 → LOGO 红 X]');
  await evalJs(cdp, `__game.injectOutput('origocrust', 50)`);
  const blocked = await waitUntil(cdp, `(() => ${prodInfo}.state === 'blocked')()`, 10000);
  check('5. 注满输出 → blocked（结算暂缓，LOGO 红 X）', blocked, await evalJs(cdp, `__game.productionStatus()`));

  console.log('[端口堵塞红: 输入物品停门口 / 输出满带留槽]');
  await evalJs(cdp, `__game.injectInput('originium_ore', 50)`);
  await evalJs(cdp, `__game.injectBeltItem('originium_ore')`);
  const inputRed = await waitUntil(cdp, portHas('输入', '●红'), 20000);
  check('6. 注满输入 + 上带物品停门口 → 输入端口 ●红', inputRed, await evalJs(cdp, `__game.beltStatus()`));
  const outputRed = await waitUntil(cdp, portHas('输出', '●红'), 20000);
  check('7. 满带物品留在输出槽 → 输出端口 ●红', outputRed);
  console.log('    ' + (await evalJs(cdp, `__game.portStatus()`)).split('\n').slice(1).join('\n    '));
  await sleep(3000); // 停稳观察双红 + 红 X

  console.log('[疏通: LOGO 复原 + 端口回黄]');
  await evalJs(cdp, `__game.consumeOutput(50)`);
  const unblocked = await waitUntil(cdp, `(() => ${prodInfo}.state !== 'blocked')()`, 8000);
  check('8a. consumeOutput 疏通 → 非 blocked（LOGO 复原）', unblocked);
  const inputClear = await waitUntil(cdp, `!(${portHas('输入', '●红')})`, 10000);
  check('8b. 生产恢复消耗输入 → 门口物品进门 → 输入端口回黄', inputClear,
    await evalJs(cdp, `__game.portStatus()`));

  console.log('[一键测试 t28]');
  const result = await evalJs(cdp, `__game.test('t28')`);
  check('9a. __game.test("t28") 完整跑通', String(result).includes('T2.8 一键测试完成'), String(result).slice(0, 80));
  const again = await evalJs(cdp, `__game.test('t28')`);
  check('9b. 二次调用被忽略（防自动重发 phase 状态机）', String(again).includes('已忽略'), String(again).slice(0, 60));

  await evalJs(cdp, `__game.clearAllPlaced()`);
} finally {
  await cdp.send('Target.closeTarget', { targetId: t.id }).catch(() => {});
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
