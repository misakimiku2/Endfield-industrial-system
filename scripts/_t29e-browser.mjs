// T2.29-e 浏览器视觉验证 — 用法: 先启动 dev server（npm run dev），然后:
//   node scripts/_t29e-browser.mjs
// 截图输出: log/t29e-s1-*.png / t29e-s2-*.png / t29e-s3*.png
//
// 场景（截图由读图模型 + 像素扫描 _t29e-imgscan.mjs 核验）:
//   S1 创建中指针覆盖（修复1）: 精炼炉(4,8) 顶中输出端口(5,8) 起，走真实创建系统
//      （__game.belt.toggleMode + setMouse/onPointerDown，等价逐段落盘）分 4 次延长
//      1→2→4→7 格，每次落盘后 ~0.3s 截图。核验: 新延长的段立即有指针。
//   S2 堵塞虚拟终点（修复2）: 精炼炉(6,10) 输入塞 999999 源矿 + 右口 6 格带接存货口
//      （持续流动）+ 左口 9 格直线断头链。等断头链完全堵塞（红）后 0.4s 连拍 8 张。
//      核验: (a)堵塞物品后方指针持续流动 (b)前沿渐隐 (c)堵塞格无箭头 (d)无交替闪烁。
//   S3 旧场景回归抽查: (a)两条异时创建空带流动且相位不同 (b)取货口→带物品前方无空白格
//      (c)满载流动带物品下方无指针。

const PW_URL = 'file:///C:/Users/Misaki/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173/';
const OUT_DIR = 'log';
const CELL = 64;

const { chromium } = await import(PW_URL);
import { mkdirSync, writeFileSync } from 'node:fs';

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
};

mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
const shot = (name) => page.screenshot({ path: `${OUT_DIR}/${name}.png` });

/** 相机对准某格（设 zoom 后再设中心，绕过 clamp 差异），CELL=64。 */
const focus = async (gx, gy, zoom = 0.6) => {
  await page.evaluate(({ gx, gy, zoom }) => {
    const g = window.__game;
    g.camera.setZoom(zoom);
    g.camera.x = (gx + 0.5) * 64;
    g.camera.y = (gy + 0.5) * 64;
  }, { gx, gy, zoom });
  await page.waitForTimeout(300);
};

/** 链上物品/堵塞状态诊断读数（按 chainId 前缀分组）。 */
const beltState = () => page.evaluate(() => {
  const g = window.__game;
  const chains = {};
  for (const h of g.world.query('BeltSegmentComp')) {
    const seg = g.world.getComponent(h, 'BeltSegmentComp');
    if (!chains[seg.chainId]) chains[seg.chainId] = { segs: 0, items: [], blocked: false };
    chains[seg.chainId].segs++;
    if (seg.blocked === true) chains[seg.chainId].blocked = true;
    for (const it of seg.items ?? []) {
      chains[seg.chainId].items.push({ idx: seg.segmentIndex, p: +it.progress.toFixed(3), d: it.delta ?? 0 });
    }
  }
  return chains;
});

/** 建一条竖直向上（direction 270）的直链带，返回实际创建段数。 */
const spawnBeltUp = (x, yBottom, len) => page.evaluate(({ x, yBottom, len }) => {
  const cells = [];
  for (let i = 0; i < len; i++) cells.push([x, yBottom - i]);
  return window.__game.spawnBelt(cells, 270);
}, { x, yBottom, len });

await page.goto(BASE_URL);
await page.waitForFunction(() => typeof window.__game === 'object', null, { timeout: 20000 });
await page.waitForTimeout(2500); // 等资产/首帧
await page.bringToFront();

// ═══════════ S1: 创建中指针覆盖（修复1）═══════════
console.log('\n[S1] 创建中指针覆盖: 真实创建系统逐段落盘 1→2→4→7 格，每次落盘后 ~0.3s 截图');
await page.evaluate(() => {
  const g = window.__game;
  g.clearAllPlaced();
  if (!g.placeAt('refining_unit', 4, 8, 0)) throw new Error('placeAt refining_unit 失败');
  g.belt.toggleMode(); // 进入传送带创建模式（hover 态）
});
// 在格子 (gx,gy) 中心执行一次鼠标移动+按下（button 0=左键落盘/选起点, 2=右键退出）
const beltClick = (gx, gy, button = 0) => page.evaluate(({ gx, gy, button }) => {
  const g = window.__game;
  const s = g.camera.worldToScreen(gx * 64 + 32, gy * 64 + 32);
  g.belt.setMouse(s.x, s.y, true);
  g.belt.onPointerDown(s.x, s.y, button);
  return g.belt.getMode?.() ?? 'n/a';
}, { gx, gy, button });

await focus(5, 5, 0.8);
const mode0 = await beltClick(5, 8, 0); // 点顶中输出端口 (5,8) 选起点 → preview 态
ok(mode0 === 'preview' || mode0 === 'n/a', `S1 前置: 选中起点（mode=${mode0}，期望 preview）`);

const s1Steps = [
  { click: [5, 7], expectLen: 1, shot: 't29e-s1-1' },
  { click: [5, 6], expectLen: 1 + 1, shot: 't29e-s1-2' },
  { click: [5, 4], expectLen: 2 + 2, shot: 't29e-s1-3' },  // 一次预览 2 格 (5,5)(5,4)
  { click: [5, 1], expectLen: 4 + 3, shot: 't29e-s1-4' },  // 一次预览 3 格 (5,3)(5,2)(5,1)
];
for (const st of s1Steps) {
  await page.waitForTimeout(500);
  await beltClick(st.click[0], st.click[1], 0);
  await page.waitForTimeout(300); // 落盘后 ~0.3s（6 Tick，新段指针已补上并流动一小段）
  await shot(st.shot);
  const chains = await beltState();
  const lens = Object.values(chains).map((c) => c.segs);
  ok(lens.some((n) => n === st.expectLen),
    `S1 落盘(${st.click}) 后链长=${JSON.stringify(lens)}（期望含 ${st.expectLen}）→ ${st.shot}.png`);
}
await beltClick(5, 1, 2); // 右键退出创建模式
const chainsS1 = await beltState();
writeFileSync('log/t29e-s1-state.json', JSON.stringify(chainsS1, null, 1));
console.log('  截图: log/t29e-s1-1.png ~ t29e-s1-4.png（读图+像素核验新段即时覆盖）');

// ═══════════ S2: 堵塞虚拟终点（修复2）═══════════
console.log('\n[S2] 堵塞虚拟终点: 精炼炉(6,10)+右口6格带→存货口 + 左口9格断头链，等全堵（红）后 0.4s 连拍 8 张');
await page.evaluate(() => {
  const g = window.__game;
  g.clearAllPlaced();
  if (!g.placeAt('refining_unit', 6, 10, 0)) throw new Error('placeAt 失败');
  // 右口 (8,10): 6 格带接存货口（持续流动，让炉子连续生产出货）
  if (g.spawnBelt([[8, 9], [8, 8], [8, 7], [8, 6], [8, 5], [8, 4]], 270) !== 6) throw new Error('主带创建失败');
  if (!g.placeAt('depot_loader', 7, 3, 180)) throw new Error('存货口创建失败'); // 中间格 (8,3) 底面接带
  // 左口 (6,10): 9 格直线断头链 (6,9)…(6,1)，无 sink
  if (g.spawnBelt([[6, 9], [6, 8], [6, 7], [6, 6], [6, 5], [6, 4], [6, 3], [6, 2], [6, 1]], 270) !== 9) throw new Error('断头链创建失败');
  for (const h of g.world.query('BuildingComp')) {
    const c = g.world.getComponent(h, 'BuildingComp');
    if (c.definitionId === 'refining_unit') c.bufferInput[0] = { itemId: 'originium_ore', count: 999999 };
  }
  g.game.update();
});
await focus(7, 6, 1.0);
await page.waitForTimeout(20000); // 跑 ~20s 让主带满载流动（任务书节拍）
const midState = await beltState();
const mainChain = Object.entries(midState).find(([, c]) => c.segs === 6);
ok(!!mainChain && mainChain[1].items.length >= 4, `S2 前置: 主带 20s 后物品 ${mainChain ? mainChain[1].items.length : 'n/a'} 件（期望 ≥4，满载流动中）`);

// 等断头链完全堵塞: 9 格全有物品且 blocked（上限 150s，每 2s 轮询）
let deadOk = false, waitS = 0;
let deadState = null;
while (waitS < 150) {
  await page.waitForTimeout(2000);
  waitS += 2;
  deadState = await beltState();
  const dead = Object.entries(deadState).find(([, c]) => c.segs === 9);
  if (dead && dead[1].items.length >= 9 && dead[1].blocked) { deadOk = true; break; }
}
const deadFinal = deadState ? Object.entries(deadState).find(([, c]) => c.segs === 9) : null;
ok(deadOk, `S2 前置: 断头链 ${waitS}s 后完全堵塞（物品 ${deadFinal ? deadFinal[1].items.length : 0}/9, blocked=${deadFinal ? deadFinal[1].blocked : '?'}）`);
writeFileSync('log/t29e-s2-state.json', JSON.stringify(deadState, null, 1));
await page.waitForTimeout(3000); // 等堵塞红 tint 渐变到位 + 稳定
// 静置期抽查: 堵住后箭头仍应流动（验证不是全冻结）
const frozenProbe = [];
for (let i = 0; i < 3; i++) { frozenProbe.push(await shot(`t29e-s2-pre-${i + 1}`)); await page.waitForTimeout(500); }
const t0 = Date.now();
const s2Times = [];
for (let i = 1; i <= 8; i++) {
  await shot(`t29e-s2-${i}`);
  s2Times.push(Date.now());
  if (i < 8) await page.waitForTimeout(400);
}
const s2dt = s2Times.map((t, i) => i === 0 ? 0 : t - s2Times[i - 1]);
console.log(`  连拍实际间隔: ${s2dt.join(', ')} ms（0.4s=8Tick=0.2 格=${(0.2 * 64).toFixed(1)}px @zoom1.0）`);
writeFileSync('log/t29e-s2-times.json', JSON.stringify(s2dt));
console.log('  截图: log/t29e-s2-1.png ~ t29e-s2-8.png');

// ═══════════ S3: 旧场景回归抽查 ═══════════
console.log('\n[S3a] 两条异时创建空带: 3.2s 间隔创建，等 10s，0.5s 连拍 2 张（相位不同 + 都在流动）');
await page.evaluate(() => window.__game.clearAllPlaced());
await focus(6, 7, 0.6);
const a1 = await spawnBeltUp(4, 9, 5);
await page.waitForTimeout(3200);
const a2 = await spawnBeltUp(8, 9, 5);
ok(a1 === 5 && a2 === 5, `S3a 前置: 两条 5 格空带创建（${a1}/${a2}）`);
await page.waitForTimeout(10000);
await shot('t29e-s3a-1');
await page.waitForTimeout(500);
await shot('t29e-s3a-2');

console.log('\n[S3b] 取货口→带: depot_unloader(3,10) + 8 格带，物品前方无空白格，0.5s 连拍 2 张');
await page.evaluate(() => window.__game.clearAllPlaced());
await focus(4, 6, 0.6);
await page.evaluate(() => window.__game.placeAt('depot_unloader', 3, 10, 0));
const b1 = await spawnBeltUp(4, 9, 8);
ok(b1 === 8, `S3b 前置: 8 格带创建（${b1}）`);
await page.waitForTimeout(8000); // 物品上带并铺开
await shot('t29e-s3b-1');
await page.waitForTimeout(500);
await shot('t29e-s3b-2');

console.log('\n[S3c] 满载流动带: 精炼炉(2,10)+6 格带+存货口，输入 999999，跑 45s 至满载，截 1 张');
await page.evaluate(() => {
  const g = window.__game;
  g.clearAllPlaced();
  g.placeAt('refining_unit', 2, 10, 0);
  g.spawnBelt([[3, 9], [3, 8], [3, 7], [3, 6], [3, 5], [3, 4]], 270);
  g.placeAt('depot_loader', 2, 3, 180);
  for (const h of g.world.query('BuildingComp')) {
    const c = g.world.getComponent(h, 'BuildingComp');
    if (c.definitionId === 'refining_unit') c.bufferInput[0] = { itemId: 'originium_ore', count: 999999 };
  }
  g.game.update();
});
await focus(3, 7, 0.6);
await page.waitForTimeout(45000);
const cState = await beltState();
const cChain = Object.values(cState).find((c) => c.segs === 6);
ok(!!cChain && cChain.items.length >= 5, `S3c 前置: 满载带上物品 ${cChain ? cChain.items.length : 0} 件（期望 ≥5）`);
await shot('t29e-s3c-1');

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败（视觉结论见读图 + _t29e-imgscan.mjs 像素核验）`);
process.exit(failed > 0 ? 1 : 0);
