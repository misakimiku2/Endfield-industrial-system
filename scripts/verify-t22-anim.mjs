// T2.2 动画修复验证: 停止居中(0.5) + pointer/物品同步(beltPhase) + 转角旋转(视觉)
// 运行: APP_URL=http://localhost:5174 node scripts/verify-t22-anim.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
const CDP = 'http://localhost:9222';
const APP = process.env.APP_URL || 'http://localhost:5173';
const OUT = './gui-test-screenshots/t22-anim';
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
// 读取首个含物品段的物品 progress + 当前 beltPhase（验证同步）
const READ = `(() => {
  const w = window.__game.world;
  const bp = window.__game.game.beltSystem.constructor.beltPhase;
  const segs = w.query('BeltSegmentComp');
  let itemProg = null, segIdx = -1, isCorner = false;
  for (const h of segs) { const s = w.getComponent(h,'BeltSegmentComp');
    if (s && s.items && s.items.length) { itemProg = s.items[0].progress; segIdx = s.segmentIndex; isCorner = s.isCorner; break; } }
  return JSON.stringify({ beltPhase: Math.round(bp*1000)/1000, itemProg: itemProg===null?null:Math.round(itemProg*1000)/1000, segIdx, isCorner });
})()`;

const t = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' }).then((r) => r.json());
const cdp = new CDPClient(t.webSocketDebuggerUrl);
await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
let ready = false;
for (let i = 0; i < 60 && !ready; i++) { await delay(500);
  ready = await evalJs(cdp, `!!(window.__game && window.__game.spawnBeltWithItem)`).catch(()=>false); }
if (!ready) { console.log('FAIL: __game 未就绪'); process.exit(1); }
console.log('[动画] __game 就绪');

// === 测试1: 停止居中（progress=0.5）===
console.log('\n=== 测试1: 停止居中 ===');
await evalJs(cdp, `window.__game.clearAllPlaced()`);
await evalJs(cdp, `window.__game.spawnBeltWithItem([[10,10]], 270, 'cuprium_ore')`);
await evalJs(cdp, `(()=>{const c=window.__game.camera;c.setPosition(10*64+32,10*64+32);c.setZoom?.(2.5);})()`);
await delay(3000);
let st = JSON.parse(await evalJs(cdp, READ));
console.log('[动画] 停止:', st);
check('停止 progress=0.5(格中心居中)', st.itemProg !== null && Math.abs(st.itemProg - 0.5) < 0.02, `(p=${st.itemProg})`);
await shot(cdp, '01-stop-centered');

// === 测试2: pointer/物品同步（progress ≈ beltPhase）===
console.log('\n=== 测试2: pointer/物品同步 ===');
await evalJs(cdp, `window.__game.clearAllPlaced()`);
await evalJs(cdp, `window.__game.spawnBeltWithItem([[10,10],[11,10],[12,10],[13,10]], 0, 'cuprium_ore')`);
await evalJs(cdp, `(()=>{const c=window.__game.camera;c.setPosition(11.5*64,10*64+32);c.setZoom?.(1.5);})()`);
await delay(800);
// 多次采样，验证 itemProgress 始终 ≈ beltPhase（同步，无漂移）
let syncOk = true, maxDiff = 0;
for (let i = 0; i < 6; i++) {
  await delay(350);
  const s = JSON.parse(await evalJs(cdp, READ));
  if (s.itemProg === null) continue;
  const diff = Math.abs(s.itemProg - s.beltPhase);
  if (diff > maxDiff) maxDiff = diff;
  if (diff > 0.06) syncOk = false; // 容差：注入对齐后差应 < 0.06（一 tick 余量）
}
console.log('[动画] 同步最大偏差:', maxDiff.toFixed(3));
check('pointer/物品同步(progress≈beltPhase, 偏差<0.06)', syncOk, `(maxDiff=${maxDiff.toFixed(3)})`);
await shot(cdp, '02-sync-pointer-item');

// === 测试3: 转角旋转（视觉，截图确认物品沿弧旋转）===
console.log('\n=== 测试3: 转角旋转 ===');
await evalJs(cdp, `window.__game.clearAllPlaced()`);
await evalJs(cdp, `window.__game.spawnBeltWithItem([[10,12],[10,11],[10,10],[11,10]], 270, 'cuprium_ore')`);
await evalJs(cdp, `(()=>{const c=window.__game.camera;c.setPosition(10.5*64,11*64);c.setZoom?.(1.8);})()`);
// 等物品到转角段，截图
let onCorner = false;
for (let i = 0; i < 24; i++) {
  await delay(400);
  const s = JSON.parse(await evalJs(cdp, READ));
  if (s.isCorner && s.itemProg !== null) { onCorner = true; await shot(cdp, '03-corner-rotate'); break; }
}
check('物品流经转角段(可旋转)', onCorner);

console.log(`\n[动画] 结果: ${passed} passed, ${failed} failed`);
console.log(`  截图: ${OUT}/01..03*.png（目视确认: 01居中 02同步间距 03转角旋转）`);
process.exit(failed === 0 ? 0 : 1);
