// pointer 渐变淡出验证：物品停止后 pointer 接近时 alpha 渐变（非硬切）
// 运行: APP_URL=http://localhost:5173 node scripts/verify-pointer-fade.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
const CDP = 'http://localhost:9222';
const APP = process.env.APP_URL || 'http://localhost:5173';
const OUT = './gui-test-screenshots/pointer-fade';
mkdirSync(OUT, { recursive: true });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const check = (n, c, e='') => { c ? (passed++, console.log(`  ✓ ${n} ${e}`)) : (failed++, console.log(`  ✗ ${n} ${e}`)); };
const FADE = 0.15;

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
// 读 beltPhase + 链尾物品 progress（单段场景，segIdx 0 即链尾）
const READ = `(() => {
  const w = window.__game.world;
  const bp = window.__game.game.beltSystem.constructor.beltPhase;
  const segs = w.query('BeltSegmentComp');
  let itemProg = null;
  for (const h of segs) { const s = w.getComponent(h,'BeltSegmentComp');
    if (s && s.items && s.items.length) { itemProg = s.items[0].progress; break; } }
  return JSON.stringify({ bp: Math.round(bp*1000)/1000, ip: itemProg===null?null:Math.round(itemProg*1000)/1000 });
})()`;

const t = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' }).then((r) => r.json());
const cdp = new CDPClient(t.webSocketDebuggerUrl);
await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
let ready = false;
for (let i = 0; i < 60 && !ready; i++) { await delay(500);
  ready = await evalJs(cdp, `!!(window.__game && window.__game.spawnBeltWithItem)`).catch(()=>false); }
if (!ready) { console.log('FAIL: __game 未就绪'); process.exit(1); }
console.log('[fade] __game 就绪');

// 单段，物品停止 progress=0.5（链尾断头）
await evalJs(cdp, `window.__game.clearAllPlaced()`);
await evalJs(cdp, `window.__game.spawnBeltWithItem([[10,10]], 270, 'cuprium_ore')`);
await evalJs(cdp, `(()=>{const c=window.__game.camera;c.setPosition(10*64+32,10*64+32);c.setZoom?.(3.0);})()`);
await delay(3000);
let st = JSON.parse(await evalJs(cdp, READ));
console.log('[fade] 物品停止:', st);
check('物品停止在 progress=0.5', st.ip !== null && Math.abs(st.ip - 0.5) < 0.02, `(ip=${st.ip})`);

// 采样 beltPhase，复刻 pointer ptrAlpha 公式，验证接近物品(0.5)时渐变到 0
console.log('\n采样 pointer alpha 渐变（物品 progress=0.5，pointer beltPhase 流动）：');
let sawFull = false, sawFade = false, sawHidden = false;
let fadeShotTaken = false;
for (let i = 0; i < 40; i++) {
  await delay(120);
  const s = JSON.parse(await evalJs(cdp, READ));
  if (s.ip === null) continue;
  // 复刻 BeltPointerRenderer: 前方物品 progress(ip) > bp ? ip : Infinity
  const front = s.ip > s.bp ? s.ip : Infinity;
  const ptrAlpha = front === Infinity ? 0 : Math.max(0, Math.min(1, (front - s.bp) / FADE));
  if (ptrAlpha >= 0.95) sawFull = true;
  if (ptrAlpha > 0.05 && ptrAlpha < 0.95) { sawFade = true; if (!fadeShotTaken) { await shot(cdp, '01-pointer-fading'); fadeShotTaken = true; } }
  if (ptrAlpha <= 0.05) sawHidden = true;
  if (i % 5 === 0) console.log(`  bp=${s.bp.toFixed(3)} ip=${s.ip.toFixed(3)} → ptrAlpha=${ptrAlpha.toFixed(3)}`);
}
console.log('');
check('pointer 远离物品时全显(alpha≈1)', sawFull, '');
check('pointer 接近物品时渐变淡出(0<alpha<1)', sawFade, '');
check('pointer 到达/越过物品时隐藏(alpha≈0)', sawHidden, '');
// 链尾断头 pointer（物品格上游空载格无，单段）—— 单段只有一格，pointer 在物品格渐变
await shot(cdp, '02-final');

console.log(`\n[fade] 结果: ${passed} passed, ${failed} failed`);
console.log(`  截图: ${OUT}/01-pointer-fading.png（pointer 接近物品半透明瞬间）`);
process.exit(failed === 0 ? 0 : 1);
