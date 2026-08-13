// 物品顿诊断：高频采样物品 progress/delta/accumulator，算 renderProgress，定位跨段停滞
// 运行: APP_URL=http://localhost:5174 node scripts/diag-item-stutter.mjs
const CDP = 'http://localhost:9222';
const APP = process.env.APP_URL || 'http://localhost:5173';
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
// 读物品所在段 segIdx + progress + delta + accumulator
const READ = `(() => {
  const w = window.__game.world;
  const acc = window.__game.game.gameLoop.accumulator;
  const segs = w.query('BeltSegmentComp');
  let segIdx=-1, prog=null, delta=null;
  for (const h of segs) { const s = w.getComponent(h,'BeltSegmentComp');
    if (s && s.items && s.items.length) { segIdx=s.segmentIndex; prog=s.items[0].progress; delta=s.items[0].delta||0; break; } }
  return JSON.stringify({ segIdx, prog, delta, acc });
})()`;

const t = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' }).then((r) => r.json());
const cdp = new CDPClient(t.webSocketDebuggerUrl);
await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
let ready = false;
for (let i = 0; i < 60 && !ready; i++) { await delay(500);
  ready = await evalJs(cdp, `!!(window.__game && window.__game.spawnBeltWithItem)`).catch(()=>false); }
if (!ready) { console.log('FAIL: __game 未就绪'); process.exit(1); }
console.log('[diag] __game 就绪');

await evalJs(cdp, `window.__game.clearAllPlaced()`);
await evalJs(cdp, `window.__game.spawnBeltWithItem([[10,10],[11,10],[12,10],[13,10]], 0, 'cuprium_ore')`);
await delay(500);

// 高频采样，记录 segIdx 变化（跨段）前后的 renderProgress
console.log('采样（segIdx 变化=跨段，关注跨段前后 renderProgress 是否连续）：');
let prev = null;
let prevSeg = -1;
const transitions = [];
for (let i = 0; i < 200; i++) {
  await delay(15);
  const v = JSON.parse(await evalJs(cdp, READ));
  if (v.prog === null) continue;
  const alpha = v.acc / 50;
  const renderProg = v.prog + alpha * v.delta;
  const rec = { segIdx: v.segIdx, prog: v.prog, delta: v.delta, acc: v.acc, renderProg: Math.round(renderProg*1000)/1000 };
  if (v.segIdx !== prevSeg && prevSeg !== -1) {
    transitions.push({ from: prevSeg, to: v.segIdx, prevRender: prev ? prev.renderProg : null, curRender: rec.renderProg, prevProg: prev?.prog, curProg: rec.prog });
    console.log(`  ★ 跨段 seg${prevSeg}→seg${v.segIdx}: prev renderProg=${prev?.renderProg} cur renderProg=${rec.renderProg} (prev prog=${prev?.prog} cur prog=${rec.prog})`);
  }
  prev = rec;
  prevSeg = v.segIdx;
}
console.log(`\n共观测到 ${transitions.length} 次跨段。`);
console.log('分析：跨段时 prev renderProg（格A出口~1.0）→ cur renderProg（格B入口~0）；');
console.log('  若 cur renderProg 明显 >0（如 0.025）说明 processSegment 同 tick 推进了格B物品，renderProgress 跳过入口段 → 可能顿。');
process.exit(0);
