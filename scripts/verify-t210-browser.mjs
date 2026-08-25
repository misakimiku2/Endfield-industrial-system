// T2.10 浏览器验收 — 端口轮询系统（Playwright 驱动系统 Chrome）
// 依据: implementation-phase-2.md T2.10（部分验收: 控制台模拟 3 条传送带物品到达 →
//       轮询顺序左→中→右；中间端口堵塞 → 物品从左右进入。完整验收留在 T2.13）
//
// 用法: 先启动 dev server（npm run dev），然后:
//       node scripts/verify-t210-browser.mjs
//       （BASE_URL 环境变量可覆盖，默认 http://localhost:5175/）
//
// 验收内容:
//   A 一键测试 __game.test('t210') 全流程跑通:
//     场景A 三条供给带喂三个输入口、满槽逐位腾出 → 补货序列 输入口1→2→3→1→2→3
//     场景B 三条断头接收带 + 预填中带 → 出货跳过中口(输出口1→3)，清带后恢复(→1→2)
//   B 事件日志复核: recentEvents 里 input 事件 portIndex 尾 6 位 = [0,1,2,0,1,2]，
//     output 事件尾 4 位 = [0,2,0,1]
//   C portStatus() 含"输入轮询指针/输出轮询队列"展示行（截图人工核验）
//
// 截图输出: gui-test-screenshots/t210-*.png
const PW_URL = 'file:///C:/Users/Misaki/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5175/';
const OUT_DIR = 'gui-test-screenshots';

const { chromium } = await import(PW_URL);
import { mkdirSync } from 'node:fs';

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
};

mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
page.on('console', (msg) => {
  const t = msg.text();
  // 只转发一键测试的关键步骤行，避免刷屏
  if (t.includes('[步骤') || t.includes('════') || t.includes('测试失败')) {
    console.log(`  [page] ${t}`);
  }
});
await page.goto(BASE_URL);
await page.waitForFunction(() => typeof window.__game === 'object', null, { timeout: 15000 });
await page.waitForTimeout(1500); // 等资产/首帧

const shot = (name) => page.screenshot({ path: `${OUT_DIR}/${name}.png` });

// ══ A+B. 一键测试全流程 + 事件日志复核 ══
console.log('[A] 运行 __game.test("t210")——场景A 输入左中右轮转 + 场景B 输出堵塞跳过/恢复');
const result = await page.evaluate(() => window.__game.test('t210'));
console.log(`  一键测试返回: ${result}`);
ok(typeof result === 'string' && result.includes('一键测试完成'),
  `A1. t210 一键测试跑通（结果: ${result}）`);

const seq = await page.evaluate(() => {
  const g = window.__game;
  const pick = (type) => g.productionLog().filter((e) => e.type === type)
    .map((e) => e.portIndex ?? -1);
  return {
    input: pick('input'),
    output: pick('output'),
    messages: g.productionLog().filter((e) => e.type === 'input').map((e) => e.message),
  };
});
console.log(`  input 全史: ${JSON.stringify(seq.input)}\n  output 全史: ${JSON.stringify(seq.output)}`);
if (!seq.messages.every((m) => m.includes('输入口'))) {
  console.log('  ⚠ input 消息缺少端口序号:', seq.messages.slice(-8));
}
const inTail = seq.input.slice(-6);
ok(JSON.stringify(inTail) === JSON.stringify([0, 1, 2, 0, 1, 2]),
  `B1. input 事件尾 6 位 = [0,1,2,0,1,2]（实际 ${JSON.stringify(inTail)}）——补货顺序左→中→右轮转`);
// 场景B 的出货序 = 最后 4 条 output（此前只有场景A 排水口的 idx1 事件）
const outTail = seq.output.slice(-4);
ok(JSON.stringify(outTail) === JSON.stringify([0, 2, 0, 1]),
  `B2. output 事件尾 4 位 = [0,2,0,1]（实际 ${JSON.stringify(outTail)}）——中口堵塞跳过、恢复探测随后出货`);

// ══ C. portStatus 轮询状态展示 ══
console.log('[C] portStatus() 轮询状态展示');
const status = await page.evaluate(() => window.__game.portStatus());
ok(status.includes('输入轮询指针') && status.includes('输出轮询队列'),
  'C1. portStatus() 包含"输入轮询指针/输出轮询队列"两行（与端口高亮同屏对照）');
console.log('  ---\n' + status.split('\n').map((l) => '  ' + l).join('\n') + '\n  ---');
await shot('t210-c1-portstatus');

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
