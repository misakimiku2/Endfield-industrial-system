// T2.6 修复后目视验证: 物品与 pointer 相位对齐 + 门口停住物品的 pointer 淡入淡出
// 运行: node scripts/diag-t26-align.mjs   （截图 → gui-test-screenshots/t26-fix/）
//
// 用户实测反馈的两个问题（2026-08-14，已修复）:
//   1. 物品与指针间距每次不同 —— injectBeltItem 曾默认 progress=0（随机错相），
//      现默认 beltPhase（T2.1"物品=实体 pointer"对齐注入）。
//   2. 停在门口的物品前方指针闪动 —— pointer 单向淡出在相位回绕瞬间 alpha 0→1 硬跳，
//      现改为对称淡入淡出（接近淡出/穿过淡入）。
import { writeFileSync, mkdirSync } from 'node:fs';
const CDP = 'http://localhost:9222';
const APP = process.env.APP_URL || 'http://localhost:5173';
const OUT = './gui-test-screenshots/t26-fix';
mkdirSync(OUT, { recursive: true });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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
/** 页内 rAF 采样: 有物品段的 pointer 真实 alpha + beltPhase + 物品 progress。 */
const SAMPLE = `(async () => {
  const pr = window.__game.renderSystem.pointerRenderer;
  const w = window.__game.world;
  const out = [];
  const t0 = performance.now();
  await new Promise((resolve) => {
    const step = () => {
      let a = null, ip = null;
      for (const [, e] of pr.entries) {
        const s = w.getComponent(e.handle, 'BeltSegmentComp');
        if (s && s.items && s.items.length) { a = e.sprite.alpha; ip = s.items[0].progress; break; }
      }
      out.push({ a, ip, bp: w.__proto__ ? null : null });
      if (performance.now() - t0 < 3000) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
  return JSON.stringify(out);
})()`;

const t = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' }).then((r) => r.json());
const cdp = new CDPClient(t.webSocketDebuggerUrl);
await cdp.send('Page.enable');
try {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) { await delay(500);
    ready = await evalJs(cdp, `!!(window.__game && window.__game.injectBeltItem)`).catch(() => false); }
  if (!ready) { console.log('FAIL: __game 未就绪'); process.exit(1); }

  // 场景: 与 demoT26 相同（精炼炉 + 上行带×3 + 输出注满 blocked 保证确定性）
  await evalJs(cdp, `__game.clearAllPlaced()`);
  await evalJs(cdp, `__game.placeAt('refining_unit', 5, 5)`);
  await evalJs(cdp, `__game.injectOutput('origocrust', 50)`);
  await evalJs(cdp, `__game.spawnBelt([[6, 10], [6, 9], [6, 8]], 270)`);
  await evalJs(cdp, `__game.camera.setPosition(6*64+32, 9*64+32); __game.camera.setZoom?.(2.0)`);
  await evalJs(cdp, `__game.injectBeltItem('originium_ore')`); // 相位对齐注入（修复 1）
  await delay(1200);
  await shot(cdp, '01-item-aligned-moving');
  console.log('  ↑ 物品移动中: 物品与上下指针的间距应与指针彼此的间距完全一致（同一晶格）');

  // 等物品被吸入 → 注满输入 → 第二件停门口（修复 2 的观察点）
  for (let i = 0; i < 100; i++) {
    const c = await evalJs(cdp, `__game.inputBuffer().match(/× (\\d+)/)?.[1] ?? '0'`);
    if (parseInt(c) >= 1) break;
    await delay(100);
  }
  await evalJs(cdp, `__game.injectInput('originium_ore', 49)`);
  await evalJs(cdp, `__game.injectBeltItem('originium_ore')`);
  for (let i = 0; i < 100; i++) {
    const s = await evalJs(cdp, `__game.beltStatus()`);
    if (/@0\.50/.test(s)) break;
    await delay(100);
  }
  await shot(cdp, '02-item-parked-at-door');
  console.log('  ↑ 物品停在精炼炉门口 0.50: 门口格指针接近物品时渐隐、穿过后渐显（无闪动）');

  // 抓一张门口指针半透明中间态 + 采样验证连续性
  for (let i = 0; i < 60; i++) {
    const a = await evalJs(cdp, `(() => {
      const pr = window.__game.renderSystem.pointerRenderer; const w = window.__game.world;
      for (const [, e] of pr.entries) { const s = w.getComponent(e.handle, 'BeltSegmentComp');
        if (s && s.items && s.items.length) return e.sprite.alpha; }
      return 1;
    })()`);
    if (a > 0.05 && a < 0.95) { await shot(cdp, '03-pointer-fading-at-door'); break; }
    await delay(60);
  }
  const frames = JSON.parse(await evalJs(cdp, SAMPLE)).filter((f) => f.a !== null);
  const alphas = frames.map((f) => f.a);
  let maxJump = 0;
  for (let i = 1; i < alphas.length; i++) maxJump = Math.max(maxJump, Math.abs(alphas[i] - alphas[i - 1]));
  const minA = Math.min(...alphas);
  console.log(`  逐帧采样 ${alphas.length} 帧: minAlpha=${minA.toFixed(3)} maxJump=${maxJump.toFixed(3)}` +
    `（旧版闪动 maxJump=1.0，阈值 0.45）`);
  console.log(maxJump <= 0.45 ? '  ✓ 无闪动（alpha 连续）' : '  ✗ 检测到硬跳变！');

  await evalJs(cdp, `__game.clearAllPlaced()`);
} finally {
  await cdp.send('Target.closeTarget', { targetId: t.id }).catch(() => {});
}
console.log(`\n截图: ${OUT}/01..03*.png`);
