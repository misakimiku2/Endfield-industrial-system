// 验证: 断头链两次延长场景下, 指针列空洞的**持续时长**（lockstep 下永久洞 = bug;
// ≤ ~60 Tick 的瞬态追平期可接受）。修复目标: 无持久洞, 稳态无洞。
import { ChainPointerQueue } from '../src/game/render/BeltPointerQueue.ts';
const STEP = 0.025;
function run({ cf, t1, t2, totalTicks = 600 }) {
  const q = new ChainPointerQueue();
  let L = 1;
  const item = { total: 0.5, delta: 0 };
  let holeRun = 0, maxRun = 0, tailHoles = 0;
  for (let t = 0; t <= totalTicks; t++) {
    if (t === t1) L = 2;
    if (t === t2) L = 3;
    const tailStop = L - 0.5;
    if (item.total < tailStop) {
      const old = item.total;
      item.total = Math.min(Math.round((old + STEP) * 40) / 40, tailStop);
      item.delta = item.total - old;
    } else item.delta = 0;
    q.tick(L, [{ total: item.total, stopped: item.delta === 0 }], cf);
    const behindArr = q.arrows.map((a) => a.pos).filter((p) => p < item.total - 0.02);
    const behind = behindArr.length ? Math.max(...behindArr) : -Infinity;
    const gap = item.total - behind;
    const isHole = behind > -Infinity && gap > 1.05;
    if (isHole) { holeRun++; maxRun = Math.max(maxRun, holeRun); if (t > totalTicks - 100) tailHoles++; }
    else holeRun = 0;
  }
  return { maxRun, tailHoles };
}
let worst = null, bad = 0;
for (let cf100 = 25; cf100 <= 70; cf100 += 5) {
  for (let t1 = 30; t1 <= 200; t1 += 10) {
    for (let t2 = t1 + 5; t2 <= 400; t2 += 10) {
      const r = run({ cf: cf100 / 100, t1, t2 });
      if (r.tailHoles > 0 || r.maxRun > 60) {
        bad++;
        if (!worst || r.tailHoles > worst.r.tailHoles) worst = { cf: cf100 / 100, t1, t2, r };
      }
    }
  }
}
console.log(bad === 0 ? '✅ 全参数扫描通过: 无持久空洞（最大瞬态 ≤60 Tick）, 稳态无洞' : `❌ ${bad} 组失败; 最差: ${JSON.stringify(worst)}`);
