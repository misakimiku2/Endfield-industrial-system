// T2.2 验证: 跨段传输 + 堵塞逆流 + 疏通
// 依据: implementation-phase-2.md T2.2 验收标准、A9 §2/§3
//
// 前置: vite dev server（APP_URL，默认 5173），Chrome 带 --remote-debugging-port=9222。
// 运行: APP_URL=http://localhost:5174 node scripts/verify-t22-cross-segment.mjs
//
// 断言:
//   1. 多格链(4段)上1个物品：segmentIndex 从 0 递增到 3（跨段），链尾 progress→0.99 停
//   2. 堵塞：注入多物品填链尾，链尾满后上游物品 progress 不再前进（被夹住）
//   3. 疏通：consumeBeltTailItem 移除链尾物品后，上游物品恢复前进
import { writeFileSync, mkdirSync } from 'node:fs';

const CDP = 'http://localhost:9222';
const APP = process.env.APP_URL || 'http://localhost:5173';
const OUT = './gui-test-screenshots/t22';
mkdirSync(OUT, { recursive: true });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name} ${extra}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

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
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  console.log('  shot:', name);
}

// 读取物品分布：每段的 segmentIndex + items 的 progress（链内按 segmentIndex 排序）
const READ_ITEMS = `(() => {
  const w = window.__game.world;
  const segs = w.query('BeltSegmentComp');
  const out = [];
  for (const h of segs) {
    const s = w.getComponent(h, 'BeltSegmentComp');
    if (!s) continue;
    out.push({ segIdx: s.segmentIndex, isTail: s.isTail, dir: s.direction,
               items: (s.items||[]).map(i => ({ id: i.itemId, p: Math.round(i.progress*1000)/1000 })) });
  }
  out.sort((a,b)=>a.segIdx-b.segIdx);
  return JSON.stringify(out);
})()`;

// 找物品所在段（第一个有物品的段）的 segmentIndex + 队首 progress
const TRACK_FIRST = `(() => {
  const w = window.__game.world;
  const segs = w.query('BeltSegmentComp');
  const list = [];
  for (const h of segs) { const s = w.getComponent(h,'BeltSegmentComp');
    if (s && s.items && s.items.length) list.push({ segIdx: s.segmentIndex, head: Math.max(...s.items.map(i=>i.progress)) }); }
  list.sort((a,b)=>a.segIdx-b.segIdx);
  return JSON.stringify(list.length ? list[0] : null);
})()`;

const t = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' }).then((r) => r.json());
const cdp = new CDPClient(t.webSocketDebuggerUrl);
await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
let ready = false;
for (let i = 0; i < 60 && !ready; i++) { await delay(500);
  ready = await evalJs(cdp, `!!(window.__game && window.__game.spawnBeltWithItem && window.__game.consumeBeltTailItem)`).catch(() => false); }
if (!ready) { console.log('FAIL: __game 未就绪'); process.exit(1); }
console.log('[T2.2] __game 就绪');

// === 测试 1: 跨段流动（4格水平链 + 1物品）===
console.log('\n=== 测试1: 跨段流动 ===');
await evalJs(cdp, `window.__game.clearAllPlaced()`);
await delay(200);
await evalJs(cdp, `window.__game.spawnBeltWithItem([[10,10],[11,10],[12,10],[13,10]], 0, 'cuprium_ore')`);
await delay(200);
await evalJs(cdp, `(() => { const c=window.__game.camera; c.setPosition(11.5*64, 10*64+32); })()`);
await delay(300);

let track = JSON.parse(await evalJs(cdp, TRACK_FIRST));
console.log('[T2.2] 初始:', track);
check('物品在首段(segIdx=0)', track !== null && track.segIdx === 0, `(segIdx=${track?.segIdx})`);
const maxSeg = 3; // 4格链 segmentIndex 0~3
let reachedTail = false;
// 轮询 ~10秒，跟踪 segmentIndex 递增
const segIdxSeen = new Set([track?.segIdx ?? -1]);
for (let i = 0; i < 20; i++) {
  await delay(500);
  track = JSON.parse(await evalJs(cdp, TRACK_FIRST));
  if (track) {
    segIdxSeen.add(track.segIdx);
    if (track.segIdx === maxSeg && track.head >= 0.98) { reachedTail = true; }
  }
}
console.log('[T2.2] 流动过程 segmentIndex 覆盖:', [...segIdxSeen].sort((a,b)=>a-b));
check('物品跨段(segmentIndex 递增覆盖多段)', segIdxSeen.size >= 2, `(覆盖 ${segIdxSeen.size} 段)`);
check('物品到达链尾段(segIdx=3)', segIdxSeen.has(maxSeg), '');
check('物品在链尾段尾停下(head≥0.98)', reachedTail, `(head=${track?.head?.toFixed(3)})`);
await shot(cdp, '01-cross-segment-flow');

// === 测试 2: 堵塞（2格链 + 多物品，链尾满后上游停在段尾）===
console.log('\n=== 测试2: 堵塞逆流 ===');
await evalJs(cdp, `window.__game.clearAllPlaced()`);
await delay(200);
// 2格链：segIdx 0→1，segIdx 1 是断头链尾。注入6物品到首段
await evalJs(cdp, `window.__game.spawnBelt([[10,10],[11,10]], 0)`);
await delay(200);
await evalJs(cdp, `(() => {
  const w=window.__game.world; const segs=w.query('BeltSegmentComp');
  for (const h of segs) { const s=w.getComponent(h,'BeltSegmentComp');
    if (s && s.segmentIndex===0) { for(let k=0;k<6;k++) s.items.push({itemId:'cuprium_ore',progress:0}); } }
})()`);
await delay(200);
await evalJs(cdp, `(() => { const c=window.__game.camera; c.setPosition(10.5*64, 10*64+32); })()`);
// 等7秒：物品流到链尾填满(segIdx1~4物品)，后续堵在segIdx0段尾
await delay(7000);
let jam = JSON.parse(await evalJs(cdp, READ_ITEMS));
console.log('[T2.2] 堵塞后分布(7s):', JSON.stringify(jam));
const tailJam = jam.find(s => s.isTail);
const headJam = jam.find(s => s.segIdx === 0);
check('堵塞: 链尾段(segIdx=1)物品堆积(≥3)', tailJam && tailJam.items.length >= 3, `(链尾物品数=${tailJam?.items.length})`);
// 堵塞标志：segIdx=0 有物品停在段尾(≥0.95)无法跨段（因链尾入口满）
const headStuckP = headJam ? Math.max(0, ...headJam.items.map(i=>i.p)) : 0;
check('堵塞: 上游(segIdx=0)物品停在段尾等待(≥0.95)', headStuckP >= 0.95, `(segIdx0 max p=${headStuckP.toFixed(3)})`);
await shot(cdp, '02-jam-backup');

// === 测试 3: 疏通（consumeBeltTailItem 模拟设备消费，上游恢复跨段）===
console.log('\n=== 测试3: 疏通 ===');
const cnt0Before = headJam ? headJam.items.length : 0;
const removed = await evalJs(cdp, `window.__game.consumeBeltTailItem()`);
console.log('[T2.2] consumeBeltTailItem 移除链尾物品:', removed);
// 等2.5秒：链尾腾位后 min progress 上升 → hasSpace 恢复 → segIdx0 物品跨段
await delay(2500);
let cleared = JSON.parse(await evalJs(cdp, READ_ITEMS));
const headCleared = cleared.find(s => s.segIdx === 0);
const cnt0After = headCleared ? headCleared.items.length : 0;
console.log('[T2.2] 疏通后 segIdx=0 物品数: %d→%d', cnt0Before, cnt0After);
check('疏通: 消费链尾后上游物品跨段恢复(segIdx=0物品减少)', cnt0After < cnt0Before, `(${cnt0Before}→${cnt0After})`);
await shot(cdp, '03-clear-jam');

console.log(`\n[T2.2] 结果: ${passed} passed, ${failed} failed`);
console.log(`  截图: ${OUT}/01..03*.png`);
process.exit(failed === 0 ? 0 : 1);
