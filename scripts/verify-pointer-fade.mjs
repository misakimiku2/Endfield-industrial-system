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

// 页内 rAF 采样渲染器**真实 sprite alpha**（每帧一条，无 CDP 往返节奏失真；
// 读 RenderSystem.pointerRenderer.entries 中"有物品段"的黄色 pointer alpha）。
// 复刻公式的旧断言只能验证数学，公式回归（如退回旧版单向淡出）测不出来——
// 旧版在相位回绕瞬间 alpha 0→1 硬跳（用户实测"物品前方的指针闪动"），帧采样必捕获。
const SAMPLE_ALPHA = `(async () => {
  const pr = window.__game.renderSystem.pointerRenderer;
  const w = window.__game.world;
  const samples = [];
  const t0 = performance.now();
  await new Promise((resolve) => {
    const step = () => {
      let a = null;
      for (const [, entry] of pr.entries) {
        const seg = w.getComponent(entry.handle, 'BeltSegmentComp');
        if (seg && seg.items && seg.items.length > 0) { a = entry.sprite.alpha; break; }
      }
      samples.push(a);
      if (performance.now() - t0 < 4200) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
  return JSON.stringify(samples);
})()`;
console.log('\n页内逐帧采样真实 pointer alpha（物品 progress=0.5，pointer 流动，~4.2 秒 / 2 个周期）：');
const rawSamples = JSON.parse(await evalJs(cdp, SAMPLE_ALPHA));
const samples = rawSamples.filter((a) => a !== null);
let sawFull = false, sawFade = false, minAlpha = 1, maxJump = 0;
for (let i = 0; i < samples.length; i++) {
  const a = samples[i];
  if (a < minAlpha) minAlpha = a;
  if (a >= 0.95) sawFull = true;
  if (a > 0.05 && a < 0.95) sawFade = true;
  if (i > 0) maxJump = Math.max(maxJump, Math.abs(a - samples[i - 1]));
}
console.log(`  采样 ${samples.length} 帧: minAlpha=${minAlpha.toFixed(3)} maxJump=${maxJump.toFixed(3)}`);
check(`采样覆盖充分(≥100 帧)`, samples.length >= 100, `(${samples.length} 帧)`);
check('pointer 远离物品时全显(alpha≈1)', sawFull, '');
check('pointer 接近物品时渐变淡出(0<alpha<1)', sawFade, '');
check('pointer 经过物品正下方时接近隐藏(谷值 alpha≤0.25)', minAlpha <= 0.25, `(minAlpha=${minAlpha.toFixed(3)})`);
// 连续性: 逐帧采样相位步长 ≈0.025/3 → alpha 变化 ≤~0.06/帧（偶掉帧 ≤0.4）；旧版回绕硬跳 = 1.0
check('无硬跳变(逐帧 |Δalpha| ≤ 0.45，无闪动)', maxJump <= 0.45, `(maxJump=${maxJump.toFixed(3)})`);
// 抓一张淡出中间态截图（真实 alpha 进入 0.05~0.95 窗口时拍）
for (let i = 0; i < 40; i++) {
  const a = await evalJs(cdp, `(() => {
    const pr = window.__game.renderSystem.pointerRenderer; const w = window.__game.world;
    for (const [, e] of pr.entries) { const s = w.getComponent(e.handle, 'BeltSegmentComp');
      if (s && s.items && s.items.length) return e.sprite.alpha; }
    return 1;
  })()`);
  if (a > 0.05 && a < 0.95) { await shot(cdp, '01-pointer-fading'); break; }
  await delay(80);
};
// 链尾断头 pointer（物品格上游空载格无，单段）—— 单段只有一格，pointer 在物品格渐变
await shot(cdp, '02-final');

console.log(`\n[fade] 结果: ${passed} passed, ${failed} failed`);
console.log(`  截图: ${OUT}/01-pointer-fading.png（pointer 接近物品半透明瞬间）`);
process.exit(failed === 0 ? 0 : 1);
