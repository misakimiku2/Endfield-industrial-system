// T2.7 浏览器验收: 设备 → 传送带输出对接（端口出货）
// 依据: implementation-phase-2.md T2.7 验收标准
//
// 前置: vite dev server 在 localhost:5173，Chrome 带 --remote-debugging-port=9222。
// 运行: node scripts/verify-t27-output-port.mjs
//
// 断言:
//   核心链路（产物出现在传送带起点并前进）:
//     1. placeAt 精炼炉(5,5) + 上行传送带×2（首段 (6,4) 入口朝向顶中输出端口 (6,5)）
//     2. injectOutput 晶体外壳×5 → 物品逐件出现在带首（输出槽递减 + [T2.7 物流] 输出消息）
//     3. 物品沿带前进 → 跨段 → 停在断头链尾 0.50（beltStatus 观察）
//   满带留槽:
//     4. 1 格断头带 + 5 件 → 带上 1 件@0.50 即满（一格一物品）→ 其余 4 件留在输出槽（停稳不变）
//   疏通恢复:
//     5. consumeBeltTailItem() 取走 1 件 → 输出槽物品继续上带（数量递减）
//   方向判定:
//     6. 同格传送带但方向平行经过（朝右）→ 永不接收，物品留在输出槽
//   一键测试:
//     7. __game.test('t27') 完整跑通（场景A 流动 + 场景B 满带/疏通）
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
/** 输出槽晶体外壳数量（outputBuffer 解析；无设备 → -1）。 */
const outputCount = `(() => {
  const s = __game.outputBuffer();
  if (s.includes('没有已放置的设备')) return -1;
  const m = s.match(/输出槽0: 晶体外壳 × (\\d+)/);
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
/** 链尾段物品数。 */
const tailItemCount = `(() => {
  const s = __game.beltStatus().split('\\n');
  const tail = s.find((l) => l.includes('[尾]'));
  if (!tail) return 0;
  return (tail.match(/@\\d/g) || []).length;
})()`;
/** 全链物品数。 */
const beltItemCount = `(() => {
  const s = __game.beltStatus();
  return (s.match(/@\\d/g) || []).length;
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
  // 等待应用就绪（__game + T2.7 测试入口）
  let ready = false;
  for (let i = 0; i < 60; i++) {
    ready = await evalJs(cdp, `!!(window.__game && window.__game.injectOutput && window.__game.test)`).catch(() => false);
    if (ready) break;
    await sleep(500);
  }
  if (!ready) { console.log('FAIL: window.__game 钩子未就绪'); process.exit(1); }

  console.log('[核心链路: 产物出现在传送带起点并前进]');
  await evalJs(cdp, `__game.clearAllPlaced()`);
  check('1a. 放置精炼炉(5,5)', await evalJs(cdp, `__game.placeAt('refining_unit', 5, 5)`) === true);
  const created = await evalJs(cdp, `__game.spawnBelt([[6, 4], [6, 3]], 270)`);
  check('1b. 上行传送带×2（首段 (6,4) 入口朝向顶中输出端口 (6,5)）', created === 2, `创建 ${created} 段`);
  await evalJs(cdp, `__game.injectOutput('origocrust', 5)`);

  // 相位窗口节流 ~2 秒/件，首件 ≤2 秒内上带
  const emitted = await waitUntil(cdp, `(() => ${outputCount} < 5)()`, 10000);
  check('2a. 输出槽物品出现在传送带起点（输出槽 5→4+）', emitted, await evalJs(cdp, `__game.beltStatus()`));
  const logs = await evalJs(cdp, `__game.productionLog().map(e => e.message)`);
  check('2b. 输出消息: "精炼炉: 输出 晶体外壳 ×1（输出槽 → 传送带）"',
    logs.some((m) => m.includes('输出 晶体外壳 ×1（输出槽 → 传送带）')),
    (logs.find((m) => m.includes('输出 晶体外壳')) || '无输出消息').slice(0, 60));

  // 物品沿带前进: 跨段到断头链尾停 0.50（首段注入 → 1.5 格行程 ≈ 3 秒）
  const atTail = await waitUntil(cdp, `(() => { const p = ${tailHeadProgress}; return p !== null && p >= 0.49; })()`, 15000);
  check('3a. 物品沿带前进跨段，停在断头链尾 0.50', atTail, await evalJs(cdp, `__game.beltStatus()`));
  // 连续出货至带满: 2 格带饱和于 2 件（一格一件@0.5），输出槽停在 ×3
  const saturated = await waitUntil(cdp, `(() => ${outputCount} === 3 && ${beltItemCount} === 2)()`, 15000);
  check('3b. 连续出货至带满（每格恰 1 件，输出槽停在 ×3）', saturated,
    `输出槽 ×${await evalJs(cdp, outputCount)}`, );
  check('3b2. 每段恰 1 件（一格一物品）', (await evalJs(cdp, `__game.beltStatus().split('\\n').every(l => (l.match(/@\\d/g) || []).length <= 1)`)) === true,
    await evalJs(cdp, `__game.beltStatus()`));

  console.log('[满带留槽: 1 格断头带 1 件即满 → 其余留在输出槽]');
  await evalJs(cdp, `__game.clearAllPlaced()`);
  await evalJs(cdp, `__game.placeAt('refining_unit', 5, 5)`);
  await evalJs(cdp, `__game.spawnBelt([[6, 4]], 270)`);
  await evalJs(cdp, `__game.injectOutput('origocrust', 5)`);
  const jammed = await waitUntil(cdp, `(() => ${outputCount} <= 4)()`, 20000);
  check('4a. 带上 1 件@格中心即满，输出槽停在 ×4（一格一物品）', jammed, `输出槽 ×${await evalJs(cdp, outputCount)}`);
  await sleep(2000); // 停稳观察
  check('4b. 停留期间输出槽保持 ×4 不变（满带 → 物品留在输出槽）',
    (await evalJs(cdp, outputCount)) === 4, await evalJs(cdp, `__game.beltStatus()`));
  check('4c. 带上恰 1 件@0.50（一格一物品）', (await evalJs(cdp, tailItemCount)) === 1,
    await evalJs(cdp, `__game.beltStatus()`));

  console.log('[疏通恢复]');
  await evalJs(cdp, `__game.consumeBeltTailItem()`); // 取走带上物品（模拟下游取货）
  const resumed = await waitUntil(cdp, `(() => ${outputCount} <= 3)()`, 10000);
  check('5. 疏通后输出槽物品继续上带（×4→×3）', resumed, `输出槽 ×${await evalJs(cdp, outputCount)}`);

  console.log('[方向判定: 平行经过的带不接收]');
  await evalJs(cdp, `__game.clearAllPlaced()`);
  await evalJs(cdp, `__game.placeAt('refining_unit', 5, 5)`);
  await evalJs(cdp, `__game.spawnBelt([[6, 4]], 0)`); // 同格但朝右——入口在 (5,4)，不朝向端口 (6,5)
  await evalJs(cdp, `__game.injectOutput('origocrust', 3)`);
  await sleep(5000); // 足够多个相位窗口，确认永不接收
  check('6a. 带上无物品（方向平行经过 → 永不接收）', (await evalJs(cdp, beltItemCount)) === 0,
    await evalJs(cdp, `__game.beltStatus()`));
  check('6b. 物品全部留在输出槽（×3）', (await evalJs(cdp, outputCount)) === 3);

  console.log('[一键测试 t27]');
  const result = await evalJs(cdp, `__game.test('t27')`);
  check('7. __game.test("t27") 完整跑通', String(result).includes('T2.7 一键测试完成'), String(result).slice(0, 80));
  const again = await evalJs(cdp, `__game.test('t27')`);
  check('7b. 二次调用被忽略（防自动重发 phase 状态机）', String(again).includes('已忽略'), String(again).slice(0, 60));

  await evalJs(cdp, `__game.clearAllPlaced()`);
} finally {
  await cdp.send('Target.closeTarget', { targetId: t.id }).catch(() => {});
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
