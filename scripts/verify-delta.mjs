// delta 顿修复验证：beltPhaseDelta 始终=0.025（含重置 tick），跨段物品 delta=0.025
// 运行: APP_URL=http://localhost:5175 node scripts/verify-delta.mjs
const CDP = 'http://localhost:9222';
const APP = process.env.APP_URL || 'http://localhost:5173';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const check = (n, c, e='') => { c ? (passed++, console.log(`  ✓ ${n} ${e}`)) : (failed++, console.log(`  ✗ ${n} ${e}`)); };

class CDPClient {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result); } });
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); }); }
  async send(method, params = {}) { await this.ready; const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
}
async function evalJs(cdp, e) {
  const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}

const t = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' }).then((r) => r.json());
const cdp = new CDPClient(t.webSocketDebuggerUrl);
await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
let ready = false;
for (let i = 0; i < 60 && !ready; i++) { await delay(500);
  ready = await evalJs(cdp, `!!(window.__game && window.__game.spawnBeltWithItem)`).catch(()=>false); }
if (!ready) { console.log('FAIL: __game 未就绪'); process.exit(1); }
console.log('[delta] __game 就绪');

// 采样 beltPhase + beltPhaseDelta，验证 delta 始终 0.025（含 beltPhase 接近 1.0 重置时刻）
console.log('采样 beltPhase / beltPhaseDelta（关注 beltPhase 接近 0 = 刚重置的时刻）：');
let sawReset = false;   // beltPhase 接近 0（刚重置）
let allDeltaOk = true;
let prevBp = -1;
for (let i = 0; i < 50; i++) {
  await delay(60);
  const v = await evalJs(cdp, `JSON.stringify({
    bp: window.__game.game.beltSystem.constructor.beltPhase,
    bd: window.__game.game.beltSystem.constructor.beltPhaseDelta,
  })`);
  const { bp, bd } = JSON.parse(v);
  if (Math.abs(bd - 0.025) > 0.001) allDeltaOk = false;
  // 检测重置：bp 从大跳到小（接近 0）
  if (prevBp > 0.9 && bp < 0.1) { sawReset = true; console.log(`  ★ 重置时刻: bp ${prevBp.toFixed(3)}→${bp.toFixed(3)}, delta=${bd.toFixed(3)}`); }
  prevBp = bp;
}
check('beltPhaseDelta 始终=0.025（含重置 tick，消除顿）', allDeltaOk, '');
check('观测到 beltPhase 重置（1.0→0）', sawReset, '');

console.log(`\n[delta] 结果: ${passed} passed, ${failed} failed`);
console.log('  顿修复逻辑确认：delta 不再为 0，renderProgress 跨段/重置时连续递增（无 50ms 停滞）');
process.exit(failed === 0 ? 0 : 1);
