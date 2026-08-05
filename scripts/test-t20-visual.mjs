// T2.0 阶段1 视觉验收脚本 — puppeteer-core
// 流程:
//   1. spawnBelt 直链+转角链 → 截图(渲染+转角) → 等1s 再截图(pointer 流动)
//   2. placeAt 精炼炉 → E 进入创建模式 → 截图端口高亮 → 点击端口 → 移动鼠标 → 截图蓝色预览
//   3. 右键落盘 → 截图黄色传送带
//   4. 占用格测试: 起点后把鼠标移到被占用格 → 截图(观察预览行为: 消失 or 变红)
import puppeteer from 'puppeteer-core';

const OUT = 'gui-test-screenshots';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// 等待 __game 就绪
async function waitGame(page) {
  for (let i = 0; i < 60; i++) {
    const ok = await page.evaluate(() => !!(window.__game && window.__game.belt));
    if (ok) return true;
    await delay(500);
  }
  return false;
}

// 世界格子 → 屏幕坐标
async function cellToScreen(page, gx, gy) {
  return page.evaluate(([x, y]) => {
    const g = window.__game;
    const cam = g.camera ?? g.app.stage.children?.[0]?.__camera;
    // 优先用 camera 实例; worldToScreen 输入世界像素
    const wx = x * 64 + 32;
    const wy = y * 64 + 32;
    if (g.camera && typeof g.camera.worldToScreen === 'function') {
      const s = g.camera.worldToScreen(wx, wy);
      return { x: s.x, y: s.y };
    }
    return { x: -9999, y: -9999 };
  }, [gx, gy]);
}

// 模拟左键点击(pointerdown+up)
async function clickAt(page, sx, sy, button = 'left') {
  await page.mouse.move(sx, sy);
  await delay(80);
  await page.mouse.down({ button });
  await delay(120);
  await page.mouse.up({ button });
  await delay(250);
}

const browser = await puppeteer.launch({
  headless: 'shell',
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('T2.0') || t.includes('传送带') || t.includes('error') || t.includes('Error')) {
    console.log('[console]', t.slice(0, 200));
  }
});
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

await page.goto('http://localhost:5173', { waitUntil: 'networkidle2', timeout: 60000 });
const ready = await waitGame(page);
console.log('game ready:', ready);
if (!ready) throw new Error('__game 未就绪');

console.log('__game keys:', await page.evaluate(() => Object.keys(window.__game).join(',')));

// ── 1. spawnBelt 直链+两种转角 ──
const n1 = await page.evaluate(() => window.__game.spawnBelt([[5, 5], [8, 5], [8, 8]], 0)); // →→→↓ CW转角
const n2 = await page.evaluate(() => window.__game.spawnBelt([[12, 12], [15, 12], [15, 9]], 0)); // →→→↑ CCW转角
console.log('spawnBelt created:', n1, n2);
await delay(700);
await page.screenshot({ path: `${OUT}/t20_belt_chain.png` });
console.log('shot: t20_belt_chain.png');
await delay(1000);
await page.screenshot({ path: `${OUT}/t20_belt_pointer_t1.png` });
console.log('shot: t20_belt_pointer_t1.png');

// ── 2. 放精炼炉 + E 进入创建模式 ──
const placed = await page.evaluate(() => window.__game.placeAt('refining_unit', 8, 8));
console.log('placeAt refining_unit(8,8):', placed);
await delay(600);
await page.keyboard.press('KeyE');
await delay(400);
const mode = await page.evaluate(() => window.__game.belt.getMode());
console.log('belt mode after E:', mode);
await page.screenshot({ path: `${OUT}/t20_belt_mode_enter.png` });
console.log('shot: t20_belt_mode_enter.png');

// hover 输出端口 (9,8) — 精炼炉(8,8)占用8~10,输出端口在顶排(8,8)(9,8)(10,8)
const pPort = await cellToScreen(page, 9, 8);
await page.mouse.move(pPort.x, pPort.y);
await delay(400);
await page.screenshot({ path: `${OUT}/t20_belt_port_hover.png` });
console.log('shot: t20_belt_port_hover.png');

// 点击端口 → preview 态
await clickAt(page, pPort.x, pPort.y, 'left');
const mode2 = await page.evaluate(() => window.__game.belt.getMode());
console.log('belt mode after click port:', mode2);

// 移动鼠标到 (9,3) — 端口正上方, 竖直预览
const pTarget = await cellToScreen(page, 9, 3);
await page.mouse.move(pTarget.x, pTarget.y);
await delay(400);
await page.screenshot({ path: `${OUT}/t20_belt_preview_blue.png` });
console.log('shot: t20_belt_preview_blue.png');

// ── 3. 右键落盘整链 + 退出 ──
await page.mouse.down({ button: 'right' });
await delay(120);
await page.mouse.up({ button: 'right' });
await delay(500);
const mode3 = await page.evaluate(() => window.__game.belt.getMode());
console.log('belt mode after right-click place:', mode3);
await page.screenshot({ path: `${OUT}/t20_belt_placed_yellow.png` });
console.log('shot: t20_belt_placed_yellow.png');

// ── 4. 占用格测试: 再进创建模式, 点端口(10,8), 鼠标移到精炼炉内部(9,9)被占用格 ──
await page.keyboard.press('KeyE');
await delay(400);
const pPort2 = await cellToScreen(page, 10, 8);
await page.mouse.move(pPort2.x, pPort2.y);
await delay(300);
await clickAt(page, pPort2.x, pPort2.y, 'left');
const mode4 = await page.evaluate(() => window.__game.belt.getMode());
console.log('belt mode (occupied test) after click port:', mode4);
const pOcc = await cellToScreen(page, 9, 9); // 精炼炉内部
await page.mouse.move(pOcc.x, pOcc.y);
await delay(500);
await page.screenshot({ path: `${OUT}/t20_belt_occupied_target.png` });
console.log('shot: t20_belt_occupied_target.png');
// 观察预览 container 是否有 sprite / 是否可见
const prevInfo = await page.evaluate(() => {
  const b = window.__game.belt;
  return {
    mode: b.getMode(),
    previewVisible: b.previewContainer?.visible,
    previewSpriteCount: b.previewContainer?.children?.length ?? -1,
  };
});
console.log('preview info (occupied target):', JSON.stringify(prevInfo));

// 退出创建模式
await page.keyboard.press('KeyE');
await delay(300);

// ── 5. 断头末端延长测试: 从刚落的链尾 (9,3) 继续延长 ──
// 进入创建模式, hover (9,3) 应高亮为断头末端起点
await page.keyboard.press('KeyE');
await delay(300);
const pTail = await cellToScreen(page, 9, 3);
await page.mouse.move(pTail.x, pTail.y);
await delay(400);
await page.screenshot({ path: `${OUT}/t20_belt_tail_hover.png` });
console.log('shot: t20_belt_tail_hover.png');
// 点击尾格 → 起点, 移到 (14,3) 横向延长
await clickAt(page, pTail.x, pTail.y, 'left');
const pExt = await cellToScreen(page, 14, 3);
await page.mouse.move(pExt.x, pExt.y);
await delay(400);
await page.screenshot({ path: `${OUT}/t20_belt_extend_preview.png` });
console.log('shot: t20_belt_extend_preview.png');
// 右键落盘
await page.mouse.down({ button: 'right' });
await delay(120);
await page.mouse.up({ button: 'right' });
await delay(500);
await page.screenshot({ path: `${OUT}/t20_belt_extended.png` });
console.log('shot: t20_belt_extended.png');

await browser.close();
console.log('DONE');
