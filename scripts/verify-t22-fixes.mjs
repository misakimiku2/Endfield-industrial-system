// T2.2 修复验证: 停止位置不凸出 + 转角动画 + delta 帧间插值
// 运行: APP_URL=http://localhost:5174 node scripts/verify-t22-fixes.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
const CDP = 'http://localhost:9222';
const APP = process.env.APP_URL || 'http://localhost:5173';
const OUT = './gui-test-screenshots/t22-fix';
mkdirSync(OUT, { recursive: true });
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
async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64')); console.log('  shot:', name);
}
const READ = `(() => {
  const w = window.__game.world; const segs = w.query('BeltSegmentComp'); const out = [];
  for (const h of segs) { const s = w.getComponent(h,'BeltSegmentComp');
    if (s && s.items && s.items.length) out.push({ segIdx:s.segmentIndex, isCorner:s.isCorner, dir:s.direction,
      items: s.items.map(i=>({id:i.itemId,p:Math.round(i.progress*1000)/1000,d:Math.round((i.delta||0)*1000)/1000})) }); }
  out.sort((a,b)=>a.segIdx-b.segIdx); return JSON.stringify(out);
})()`;

const t = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' }).then((r) => r.json());
const cdp = new CDPClient(t.webSocketDebuggerUrl);
await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
let ready = false;
for (let i = 0; i < 60 && !ready; i++) { await delay(500);
  ready = await evalJs(cdp, `!!(window.__game && window.__game.spawnBeltWithItem)`).catch(()=>false); }
if (!ready) { console.log('FAIL: __game 未就绪'); process.exit(1); }
console.log('[修复] __game 就绪');

// === 测试1: 停止位置不凸出（progress=0.75 而非 0.99）===
console.log('\n=== 测试1: 停止位置不凸出 ===');
await evalJs(cdp, `window.__game.clearAllPlaced()`);
await evalJs(cdp, `window.__game.spawnBeltWithItem([[10,10]], 270, 'cuprium_ore')`);
await evalJs(cdp, `(()=>{const c=window.__game.camera;c.setPosition(10*64+32,10*64+32);c.setZoom?.(2.5);})()`);
await delay(3000); // 物品到段尾停
let st = JSON.parse(await evalJs(cdp, READ));
const stopItem = st[0]?.items[0];
console.log('[修复] 停止物品:', stopItem);
check('停止 progress=0.75(完全在格内不凸出)', stopItem && Math.abs(stopItem.p - 0.75) < 0.02, `(p=${stopItem?.p})`);
check('停止 delta=0(静止不插值)', stopItem && stopItem.d === 0, `(delta=${stopItem?.d})`);
await shot(cdp, '01-stop-not-overflow');

// === 测试2: 转角动画（物品经过转角段）===
console.log('\n=== 测试2: 转角动画 ===');
await evalJs(cdp, `window.__game.clearAllPlaced()`);
// L形链: [10,12]→[10,10](向上)→[12,10](向右转角)。startDir=270 匹配首段方向(向上)
await evalJs(cdp, `window.__game.spawnBeltWithItem([[10,12],[10,11],[10,10],[11,10]], 270, 'cuprium_ore')`);
await evalJs(cdp, `(()=>{const c=window.__game.camera;c.setPosition(10.5*64,11*64);c.setZoom?.(1.8);})()`);
let cornerReached = false;
for (let i = 0; i < 24; i++) {
  await delay(400);
  const s2 = JSON.parse(await evalJs(cdp, READ));
  if (s2.find(s => s.isCorner)) { cornerReached = true; await shot(cdp, '02-corner-arc'); break; }
}
check('物品流经转角段(isCorner)', cornerReached);
// 转角段物品 progress 应在 0~1（沿弧移动），验证转角渲染路径生效
if (cornerReached) {
  await delay(600);
  const s3 = JSON.parse(await evalJs(cdp, READ));
  const cs = s3.find(s => s.isCorner);
  check('转角段物品 progress 在弧上(0<p<1)', cs && cs.items[0] && cs.items[0].p > 0 && cs.items[0].p < 1, `(p=${cs?.items[0]?.p})`);
}

// === 测试3: delta 帧间插值（流动 delta≈0.025）===
console.log('\n=== 测试3: delta 帧间插值 ===');
await evalJs(cdp, `window.__game.clearAllPlaced()`);
await evalJs(cdp, `window.__game.spawnBeltWithItem([[10,10],[11,10],[12,10],[13,10]], 0, 'cuprium_ore')`);
await delay(600); // 物品正在流动（未到段尾）
const s4 = JSON.parse(await evalJs(cdp, READ));
const flowItem = s4[0]?.items[0];
console.log('[修复] 流动物品:', flowItem);
check('流动物品 delta≈0.025(插值启用，消除抽搐)', flowItem && Math.abs(flowItem.d - 0.025) < 0.001, `(delta=${flowItem?.d})`);

console.log(`\n[修复] 结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
