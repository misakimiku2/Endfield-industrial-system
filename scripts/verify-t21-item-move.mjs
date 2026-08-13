// T2.1 验证: 单段传送带物品移动（progress 推进 + 段尾停止 + pointer 显隐）
// 依据: implementation-phase-2.md T2.1 验收标准、A9 §2.2/§3.2
//
// 前置: vite dev server 在 localhost:5173，Chrome 带 --remote-debugging-port=9222。
// 运行: node scripts/verify-t21-item-move.mjs
//
// 断言:
//   1. spawnBeltWithItem 后物品 progress≈0（段首）
//   2. ~1 秒后 progress≈0.5（20 tick × 0.025，匀速推进）
//   3. ~2 秒后 progress 稳定在 [0.98,0.99]（段尾停止，A9 §3.2 钳制 0.99）
//   4. 再等 0.5 秒 progress 不变（确实停下，非滑过）
//   5. 截图: 有物品段无 pointer、空载段有 pointer（目视）
import { writeFileSync, mkdirSync } from 'node:fs';

const CDP = 'http://localhost:9222';
const APP = process.env.APP_URL || 'http://localhost:5173';
const OUT = './gui-test-screenshots/t21';
mkdirSync(OUT, { recursive: true });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  console.log('  shot:', name);
}

// 读取首个含物品段的物品状态
const READ_ITEM = `(() => {
  const w = window.__game.world;
  const segs = w.query('BeltSegmentComp');
  for (const h of segs) {
    const seg = w.getComponent(h, 'BeltSegmentComp');
    if (seg && seg.items && seg.items.length > 0) {
      return JSON.stringify({ progress: seg.items[0].progress, itemId: seg.items[0].itemId, count: seg.items.length, dir: seg.direction, isCorner: seg.isCorner, segIdx: seg.segmentIndex });
    }
  }
  return JSON.stringify(null);
})()`;

const t = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' }).then((r) => r.json());
const cdp = new CDPClient(t.webSocketDebuggerUrl);
await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await delay(500);
  ready = await evalJs(cdp, `!!(window.__game && window.__game.spawnBeltWithItem)`).catch(() => false);
}
if (!ready) { console.log('FAIL: window.__game 未就绪（确认 dev server + 9222 端口）'); process.exit(1); }
console.log('[T2.1] window.__game 就绪');

// 清场 + 创建单段方向↑的传送带并注入源矿物品
await evalJs(cdp, `window.__game.clearAllPlaced()`);
await delay(200);
await evalJs(cdp, `window.__game.spawnBeltWithItem([[10,10]], 270, 'cuprium_ore')`);
await delay(200);
// 相机定位到该格中心 (10,10) → 世界 (640,640)，+32 居中
await evalJs(cdp, `(() => { const c=window.__game.camera; c.setPosition(10*64+32, 10*64+32); c.setZoom?.(2.0); })()`);
await delay(400);

let st = JSON.parse(await evalJs(cdp, READ_ITEM));
console.log('[T2.1] 初始状态:', st);
check('物品已注入段首', st !== null && st.itemId === 'cuprium_ore', `(progress=${st?.progress})`);
const p0 = st?.progress ?? 0;
// 注入后到首次读取有 evalJs 往返+截图延迟，物品可能已推进若干 tick，故放宽到 <0.5
check('物品在段首附近(progress<0.5)', p0 < 0.5, `(progress=${p0.toFixed(3)})`);
await shot(cdp, '01-item-at-head');

// 等 ~1 秒: 验证匀速推进（20 tick × 0.025 ≈ +0.5，用差值断言避免依赖 p0 起点）
await delay(1000);
st = JSON.parse(await evalJs(cdp, READ_ITEM));
const p1 = st?.progress ?? 0;
console.log('[T2.1] ~1s:', st);
check('物品移动中(progress 单调递增)', p1 > p0, `(${p0.toFixed(3)} → ${p1.toFixed(3)})`);
const dv = p1 - p0;
check('匀速推进(~0.5/秒, 40tick/格)', dv >= 0.3 && dv <= 0.75, `(Δprogress=${dv.toFixed(3)})`);
check('尚未到段尾(p1<0.99)', p1 < 0.99, `(progress=${p1.toFixed(3)})`);
await shot(cdp, '02-item-moving');

// 等 ~1.2 秒(累计~2.2s): 应到段尾并稳定在 0.99
await delay(1200);
st = JSON.parse(await evalJs(cdp, READ_ITEM));
const p2 = st?.progress ?? 0;
console.log('[T2.1] ~2.2s:', st);
check('~2s 后到段尾 [0.98,0.99]', p2 >= 0.98 && p2 <= 0.99, `(progress=${p2.toFixed(3)})`);

// 再等 0.5 秒: 应稳定不变（证明停下，非滑过）
await delay(500);
st = JSON.parse(await evalJs(cdp, READ_ITEM));
const p3 = st?.progress ?? 0;
console.log('[T2.1] ~2.7s(停止后):', st);
check('段尾稳定不超 0.99', p3 >= 0.98 && p3 <= 0.99, `(progress=${p3.toFixed(3)})`);
check('确实停下(Δprogress≈0)', Math.abs(p3 - p2) < 0.01, `(Δ=${(p3 - p2).toFixed(3)})`);
await shot(cdp, '03-item-stopped-at-tail');

// 额外: 创建一段无物品传送带，验证空载 pointer 可见（目视对比）
await evalJs(cdp, `window.__game.spawnBelt([[14,10]], 270)`);
await delay(300);
// 相机拉远到能同时看到两段
await evalJs(cdp, `(() => { const c=window.__game.camera; c.setPosition(12*64+32, 10*64+32); c.setZoom?.(1.0); })()`);
await delay(400);
await shot(cdp, '04-compare-empty-vs-item');
console.log('[T2.1] 截图 04 对比: 左侧(10,10)有物品=无pointer, 右侧(14,10)空载=pointer流动');

// 缩放测试: 放大后物品位置仍居中
await evalJs(cdp, `(() => { const c=window.__game.camera; c.setPosition(10*64+32, 10*64+32); c.setZoom?.(3.5); })()`);
await delay(400);
await shot(cdp, '05-zoom-in-item-centered');

console.log(`\n[T2.1] 结果: ${passed} passed, ${failed} failed`);
console.log(`  截图: ${OUT}/01..05*.png`);
console.log(failed === 0 ? 'DONE OK' : 'DONE WITH FAILURES');
process.exit(failed === 0 ? 0 : 1);
