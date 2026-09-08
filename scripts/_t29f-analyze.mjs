// T2.29-f 采样数据分析（复用 log/t29f-samples.json，不重跑浏览器）:
//   (b) 修订判定: 越界可见样本若处于某停止物品中心 ±0.35 格内 = 正在被该物品
//       覆盖吞噬（物品 zIndex 0.5 > 指针 0.4，箭头滑入物品身下渐隐）→ 合法;
//       仅"前沿之后、且不邻近任何停止物品"的可见箭头记为真入侵。
//   brightEnd 诊断: 窗口中段全亮消失的 sprite —— 最后位置 d、当时物品布局、
//       是否伴随注入事件（数量增加）→ 判定是否带首注入清除（既有 T2.29 语义）。
//   (d) 锁定证据: 每个渐隐事件的位置 vs 历史前沿（lockGap ≤ 0.125 = 锁定出场口）。

import { readFileSync } from 'node:fs';
const data = JSON.parse(readFileSync('log/t29f-samples.json', 'utf-8'));
const { samples, itemSnaps } = data;
const SAMPLE_MS = 40000;
const CELL = 64;
const dOfY = (y) => 9.5 - (y - 32) / 64;

// terminus 时间线
const termTimeline = itemSnaps.map(([t, items, blocked]) => {
  let term = 9;
  const stoppedD = [];
  for (const [idx, p, delta] of items) {
    if (delta === 0) { stoppedD.push(idx + p); if (idx + p < term) term = idx + p; }
  }
  return { t, term, stoppedD, nItems: items.length, blocked };
});
const termAt = (t) => {
  let best = termTimeline[0];
  for (const s of termTimeline) { if (s.t <= t) best = s; else break; }
  return best;
};

// ── (b) 修订 ──
let realIntrusion = 0;
let coveredFades = 0;
const intrusionLog = [];
let checkedVisible = 0;
for (const [t, rows] of samples) {
  const st = termAt(t);
  const frontY = (9.5 - st.term) * 64 + 32;
  for (const [sid, y, a, v] of rows) {
    if (!v || a <= 0.05) continue;
    if (y < 40 || y > 10 * 64) continue; // 带外等待区
    checkedVisible++;
    if (y >= frontY - 0.45 * CELL) continue; // 前沿渐隐容差内
    const dArrow = dOfY(y);
    let nearStopped = Infinity;
    for (const sd of st.stoppedD) nearStopped = Math.min(nearStopped, Math.abs(sd - dArrow));
    if (nearStopped <= 0.35) { coveredFades++; continue; } // 停止物品身下的锁定渐隐
    realIntrusion++;
    if (intrusionLog.length < 8) intrusionLog.push({ t: +(t / 1000).toFixed(2), sid, d: +dArrow.toFixed(3), a, term: st.term, nearestStopped: +nearStopped.toFixed(3) });
  }
}
console.log(`(b) 修订: 检查 ${checkedVisible} 可见样本; 前沿后但停止物品身下（合法吞噬渐隐）= ${coveredFades}; 真入侵 = ${realIntrusion}`);
if (realIntrusion > 0) console.log('  入侵明细:', JSON.stringify(intrusionLog));

// ── brightEnd 诊断 ──
const series = new Map();
for (const [t, rows] of samples) {
  for (const [sid, y, a, v] of rows) {
    let s = series.get(sid);
    if (!s) { s = []; series.set(sid, s); }
    s.push({ t, y, a, v });
  }
}
console.log('\nbrightEnd 诊断（窗口中段全亮消失的 sprite）:');
for (const [sid, s] of series) {
  const last = s[s.length - 1];
  if (last.v !== 1 || last.t > SAMPLE_MS - 400) continue;
  // 最后一段可见 run 的起点与最长全亮段
  let runStart = s.length - 1;
  while (runStart > 0 && s[runStart - 1].v === 1) runStart--;
  const run = s.slice(runStart);
  const st = termAt(last.t);
  // 注入事件: 该时刻前后 ±300ms 物品数增加
  let inject = false;
  for (let i = 1; i < termTimeline.length; i++) {
    if (termTimeline[i].nItems > termTimeline[i - 1].nItems && Math.abs(termTimeline[i].t - last.t) <= 300) { inject = true; break; }
  }
  const d = dOfY(last.y);
  let nearItem = Infinity;
  for (const [idx, p] of st.nItems ? itemSnaps.find(([tt]) => tt === st.t)[1] : []) nearItem = Math.min(nearItem, Math.abs(idx + p - d));
  console.log(`  sid=${sid} 消失@t=${(last.t / 1000).toFixed(2)}s d=${d.toFixed(3)} α=${last.a} run时长=${((last.t - run[0].t) / 1000).toFixed(2)}s term=${st.term} 最近物品距离=${nearItem.toFixed(3)} 伴随注入=${inject}`);
}

// ── (d) 锁定证据 ──
console.log('\n(d) 渐隐位置 vs 历史前沿（lockGap = 到锁定时刻前沿的最小距离, ≤0.125=精确锁定出场口）:');
const fades = [];
for (const [sid, s] of series) {
  let cur = [];
  const segs = [];
  for (const pt of s) {
    if (pt.v === 1) cur.push(pt);
    else if (cur.length > 0) { segs.push(cur); cur = []; }
  }
  for (const seg of segs) {
    const last = seg[seg.length - 1];
    if (last.t > SAMPLE_MS - 400) continue;
    const st = termAt(last.t);
    let lockGap = Infinity;
    for (const t2 of termTimeline) {
      if (t2.t > last.t) break;
      lockGap = Math.min(lockGap, Math.abs(t2.term - dOfY(last.y)));
    }
    fades.push({ t: last.t, d: +dOfY(last.y).toFixed(3), termNow: st.term, lockGap: +lockGap.toFixed(3) });
  }
}
fades.sort((a, b) => a.t - b.t);
for (const f of fades) console.log(`  t=${(f.t / 1000).toFixed(1)}s d=${f.d} term_now=${f.termNow} lockGap=${f.lockGap}`);
