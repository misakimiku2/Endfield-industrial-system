// T2.3+T2.4 浏览器验收: 配方加载 + 输入缓冲区（控制台验收路径）
// 依据: implementation-phase-2.md T2.3/T2.4 验收标准
//
// 前置: vite dev server 在 localhost:5173，Chrome 带 --remote-debugging-port=9222。
// 运行: node scripts/verify-t23-t24.mjs
//
// 断言:
//   T2.3（控制台查询配方列表）:
//     1. __game.listRecipes('refining_unit') 输出 "精炼炉配方：晶体外壳(源矿×1, 2秒)、蓝铁块(蓝铁矿×1, 2秒)..."
//     2. 精炼炉配方数 = 10（与 A4 §6.2 一致）
//     3. 非法设备 id → 空列表不抛错
//   T2.4（模拟物品传入，检查输入槽）:
//     4. placeAt 放精炼炉 → inputBuffer() = "输入槽0: 空"（放置即初始化输入槽）
//     5. injectInput('originium_ore', 3) → "输入槽0: 源矿 × 3/50 (已锁定)"
//     6. injectInput('ferrium_ore') 被拒（类型锁定）→ 槽仍为 源矿 × 3/50
//     7. 注满 50 后再注入 → 槽保持 50/50（容量上限）
//     8. consumeInput(3) 扣空 → 解锁 → "输入槽0: 空"
const CDP = 'http://localhost:9222';
const APP = process.env.APP_URL || 'http://localhost:5173';

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name} ${extra}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

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

const t = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' }).then((r) => r.json());
const cdp = new CDPClient(t.webSocketDebuggerUrl);
try {
  // 等待应用就绪（__game + 配方钩子）
  let ready = false;
  for (let i = 0; i < 60; i++) {
    ready = await evalJs(cdp, `!!(window.__game && window.__game.listRecipes && window.__game.injectInput)`).catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) { console.log('FAIL: window.__game T2.3/T2.4 钩子未就绪'); process.exit(1); }

  console.log('[T2.3 配方查询]');
  const furnaceRecipes = await evalJs(cdp, `__game.listRecipes('refining_unit')`);
  // 文档验收示例的缩写是"晶体外壳(源矿×1, 2秒)"，实际配方含或分支，全量展示为
  // "晶体外壳(源矿×1/晶体外壳粉末×1, 2秒)"；单原料配方（蓝铁块）与示例逐字一致。
  check('1. 精炼炉配方列表格式', typeof furnaceRecipes === 'string'
    && furnaceRecipes.startsWith('精炼炉配方：')
    && furnaceRecipes.includes('晶体外壳(源矿×1/晶体外壳粉末×1, 2秒)')
    && furnaceRecipes.includes('蓝铁块(蓝铁矿×1, 2秒)'), furnaceRecipes.slice(0, 80) + '...');
  const recipeCount = await evalJs(cdp, `__game.recipeIndex.get('refining_unit').length`);
  check('2. 精炼炉配方数 = 10', recipeCount === 10, `实际 ${recipeCount}`);
  const badEquip = await evalJs(cdp, `__game.listRecipes('nonexistent_unit')`);
  check('3. 非法设备 id 不抛错', typeof badEquip === 'string' && badEquip.includes('nonexistent_unit'));

  console.log('[T2.4 输入缓冲区]');
  await evalJs(cdp, `__game.clearAllPlaced()`);
  const placed = await evalJs(cdp, `__game.placeAt('refining_unit', 5, 5)`);
  check('4a. 放置精炼炉', placed === true);
  const emptyBuf = await evalJs(cdp, `__game.inputBuffer()`);
  check('4b. 放置即初始化空输入槽', emptyBuf === '输入槽0: 空', `"${emptyBuf}"`);

  const injected = await evalJs(cdp, `__game.injectInput('originium_ore', 3)`);
  check('5. 注入源矿×3 → 锁定', injected === '输入槽0: 源矿 × 3/50 (已锁定)', `"${injected}"`);

  const rejected = await evalJs(cdp, `__game.injectInput('ferrium_ore')`);
  check('6. 蓝铁矿被拒（类型锁定）', rejected === '输入槽0: 源矿 × 3/50 (已锁定)', `"${rejected}"`);

  await evalJs(cdp, `__game.injectInput('originium_ore', 47)`);
  const fullBuf = await evalJs(cdp, `__game.injectInput('originium_ore')`);
  check('7. 注满 50 后拒绝再进', fullBuf === '输入槽0: 源矿 × 50/50 (已锁定)', `"${fullBuf}"`);

  const consumed = await evalJs(cdp, `__game.consumeInput(3, 'originium_ore') && __game.consumeInput(47, 'originium_ore') && __game.inputBuffer()`);
  check('8. 扣空解锁 → 空槽', consumed === '输入槽0: 空', `"${consumed}"`);

  await evalJs(cdp, `__game.clearAllPlaced()`);
} finally {
  await cdp.send('Target.closeTarget', { targetId: t.id }).catch(() => {});
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
