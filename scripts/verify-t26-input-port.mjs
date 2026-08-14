// T2.6 浏览器验收: 传送带 → 设备输入对接（端口吸入）
// 依据: implementation-phase-2.md T2.6 验收标准
//
// 前置: vite dev server 在 localhost:5173，Chrome 带 --remote-debugging-port=9222。
// 运行: node scripts/verify-t26-input-port.mjs
//
// 断言:
//   核心链路（物品进入输入槽）:
//     1. placeAt 精炼炉(5,5) + 上行传送带×2（链尾 (6,8) 指向底中输入端口 (6,7)）
//     2. injectBeltItem 源矿 → 沿带前进 → 到门口消失（beltStatus 链尾无物品）
//     3. 精炼炉输入槽 count+1（"输入槽0: 源矿 × 1/50 (已锁定)"）+ [T2.6 物流] 吸入消息
//   满槽堵停:
//     4. 注满输入槽 50/50 → 再放一件 → 物品停在精炼炉门口（progress=0.50 不再前进）
//     5. 停留期间输入槽保持 50/50
//   疏通恢复:
//     6. consumeInput(1) 腾位 → 门口物品被吸入 → 输入槽回满 50/50、带上清空
//   方向判定:
//     7. 同一格传送带但方向背离端口（朝右）→ 物品停在门口、永不吸入
//
// 场景确定性: 与 __game.test('t26') 相同，先 injectOutput 注满输出槽使设备 blocked
// （结算暂缓不消耗输入槽），验收只观察输入对接本身。
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
/** 输入槽源矿数量（inputBuffer 解析）。 */
const inputCount = `(() => {
  const m = __game.inputBuffer().match(/输入槽0: 源矿 × (\\d+)/);
  return m ? parseInt(m[1]) : 0;
})()`;
/** 链尾段队首物品 progress（无物品 → null）。 */
const tailHeadProgress = `(() => {
  const s = __game.beltStatus().split('\\n');
  const tail = s.find((l) => l.includes('[尾]'));
  if (!tail) return null;
  const m = tail.match(/@(\\d+\\.\\d+)/g);
  if (!m || m.length === 0) return null;
  return Math.max(...m.map((x) => parseFloat(x.slice(1))));
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
  // 等待应用就绪（__game + T2.6 钩子）
  let ready = false;
  for (let i = 0; i < 60; i++) {
    ready = await evalJs(cdp, `!!(window.__game && window.__game.injectBeltItem && window.__game.beltStatus)`).catch(() => false);
    if (ready) break;
    await sleep(500);
  }
  if (!ready) { console.log('FAIL: window.__game T2.6 钩子未就绪'); process.exit(1); }

  console.log('[核心链路: 物品到门口消失并进入输入槽]');
  await evalJs(cdp, `__game.clearAllPlaced()`);
  check('1a. 放置精炼炉(5,5)', await evalJs(cdp, `__game.placeAt('refining_unit', 5, 5)`) === true);
  await evalJs(cdp, `__game.injectOutput('origocrust', 50)`); // blocked，输入槽不被生产消耗
  const created = await evalJs(cdp, `__game.spawnBelt([[6, 9], [6, 8]], 270)`);
  check('1b. 上行传送带×2（链尾 (6,8) 指向底中输入端口 (6,7)）', created === 2, `创建 ${created} 段`);
  check('1c. 链首注入源矿', await evalJs(cdp, `__game.injectBeltItem('originium_ore')`) === true);

  // 1.5 格行程（(6,9) p0 → (6,8) p0.5）≈ 3 秒，等吸入完成（输入槽 ≥1 即物品已消失进槽）
  const gone = await waitUntil(cdp, `(() => ${inputCount} >= 1)()`, 10000);
  check('2a. 物品到精炼炉门口消失（被吸入输入槽）', gone, await evalJs(cdp, `__game.beltStatus()`));
  const inCount1 = await evalJs(cdp, inputCount);
  check('2b. 链上无残留物品', !(await evalJs(cdp, `__game.beltStatus()`)).match(/@\d/));
  check('3a. 输入槽 count+1（源矿 × 1/50）', inCount1 === 1, `实际 ×${inCount1}`);
  const logs = await evalJs(cdp, `__game.productionLog().map(e => e.message)`);
  check('3b. 吸入消息: "精炼炉: 吸入 源矿 ×1（传送带 → 输入槽）"',
    logs.some((m) => m.includes('吸入 源矿 ×1（传送带 → 输入槽）')),
    (logs.find((m) => m.includes('吸入')) || '无吸入消息').slice(0, 60));

  console.log('[满槽堵停]');
  await evalJs(cdp, `__game.injectInput('originium_ore', 49)`); // 补到 50/50
  await evalJs(cdp, `__game.injectBeltItem('originium_ore')`);
  const parked = await waitUntil(cdp, `(() => { const p = ${tailHeadProgress}; return p !== null && p >= 0.49; })()`, 10000);
  check('4a. 物品走到精炼炉门口停住（progress ≥ 0.49）', parked, await evalJs(cdp, `__game.beltStatus()`));
  await sleep(800); // 停稳观察
  const p1 = await evalJs(cdp, tailHeadProgress);
  await sleep(600);
  const p2 = await evalJs(cdp, tailHeadProgress);
  check('4b. 停住后 progress 不再前进（0.50 静止）', p1 !== null && p2 !== null && Math.abs(p1 - p2) < 0.001 && p2 <= 0.51,
    `${p1} → ${p2}`);
  check('5. 停留期间输入槽保持 50/50', (await evalJs(cdp, inputCount)) === 50);

  console.log('[疏通恢复]');
  await evalJs(cdp, `__game.consumeInput(1)`); // 腾出 1 空位（模拟生产消耗）
  const resumed = await waitUntil(cdp, `(() => { const p = ${tailHeadProgress}; return p === null && ${inputCount} >= 50; })()`, 4000);
  check('6a. 疏通后门口物品被吸入（带上清空）', resumed, await evalJs(cdp, `__game.beltStatus()`));
  check('6b. 输入槽回满 50/50', (await evalJs(cdp, inputCount)) === 50);

  console.log('[方向判定: 背离端口的带不吸入]');
  await evalJs(cdp, `__game.clearAllPlaced()`);
  await evalJs(cdp, `__game.placeAt('refining_unit', 5, 5)`);
  await evalJs(cdp, `__game.injectOutput('origocrust', 50)`); // 输入槽不参与生产，且保持空
  await evalJs(cdp, `__game.spawnBelt([[6, 8]], 0)`); // 同格但朝右——出口是 (7,8)，不指向端口 (6,7)
  await evalJs(cdp, `__game.injectBeltItem('originium_ore')`);
  await waitUntil(cdp, `(() => { const p = ${tailHeadProgress}; return p !== null && p >= 0.49; })()`, 8000);
  await sleep(1000); // 在门口停留一段时间，确认不被吸入
  const p3 = await evalJs(cdp, tailHeadProgress);
  check('7a. 物品停在门口（0.50）', p3 !== null && Math.abs(p3 - 0.5) < 0.01, `progress=${p3}`);
  check('7b. 输入槽保持空（方向背离永不吸入）', (await evalJs(cdp, inputCount)) === 0);

  await evalJs(cdp, `__game.clearAllPlaced()`);
} finally {
  await cdp.send('Target.closeTarget', { targetId: t.id }).catch(() => {});
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
