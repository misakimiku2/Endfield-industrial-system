// T2.0 阶段1 视觉验收 — 零依赖 CDP 脚本 v2
import { writeFileSync } from 'node:fs';

const CDP = 'http://localhost:9222';
const APP = 'http://localhost:5173';
const OUT = 'C:/Users/Misaki/.workbuddy/tmp/t20-shots';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res);
      this.ws.addEventListener('error', rej);
    });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}
async function mouseMove(cdp, x, y) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); }
async function mouseClick(cdp, x, y, button = 'left') {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
  await delay(120);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
  await delay(300);
}
async function keyPress(cdp, code, key, vk) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: vk });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk });
  await delay(400);
}
async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  console.log('shot:', name);
}
async function cellToScreen(cdp, gx, gy) {
  return evalJs(cdp, `(() => {
    const g = window.__game;
    const s = g.camera.worldToScreen(${gx} * 64 + 32, ${gy} * 64 + 32);
    return { x: s.x, y: s.y };
  })()`);
}
// 直接把相机设到目标并跑几帧让 lerp 完成
async function focusCamera(cdp, wx, wy) {
  await evalJs(cdp, `(() => {
    const c = window.__game.camera;
    if (typeof c.setPosition === 'function') { c.setPosition(${wx}, ${wy}); }
    else { c.x = ${wx}; c.y = ${wy}; }
    if (typeof c.updateTransform === 'function') c.updateTransform();
    return { x: c.x, y: c.y, zoom: c.zoom };
  })()`);
  await delay(200);
}

const t = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' }).then((r) => r.json());
console.log('tab:', t.id);
const cdp = new CDPClient(t.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await delay(500);
  ready = await evalJs(cdp, `!!(window.__game && window.__game.belt)`).catch(() => false);
}
console.log('game ready:', ready);
if (!ready) throw new Error('__game 未就绪');

// 初始相机位置
const cam0 = await evalJs(cdp, `({x:window.__game.camera.x, y:window.__game.camera.y, z:window.__game.camera.zoom})`);
console.log('camera init:', cam0);

// 移相机到 (10,10) 世界像素 (640,640) — 视口 1600x1000, zoom=1 能看到 x:640-800~640+800= -160~1440, y:640-500~640+500=140~1140
await focusCamera(cdp, 700, 700);
const cam1 = await evalJs(cdp, `({x:window.__game.camera.x, y:window.__game.camera.y, z:window.__game.camera.zoom})`);
console.log('camera focused:', cam1);

// 清空已有设备(防止残留)
await evalJs(cdp, `window.__game.clearAllPlaced()`).catch(() => {});
await evalJs(cdp, `window.__game.clearTestDevices()`).catch(() => {});
await delay(300);

// ── 1. 放精炼炉 (空地 8,8) ──
const placeOk = await evalJs(cdp, `window.__game.placeAt('refining_unit', 8, 8)`);
console.log('placeAt(8,8):', placeOk);
await delay(600);

// ── 2. spawnBelt 两条链: CW + CCW 转角 (避开精炼炉 8-10 x 8-10) ──
// 链A: (12,4)->(15,4)->(15,7) → →→→↓ CW (出口下, 外凸右下)
// 链B: (3,12)->(6,12)->(6,9)  → →→→↑ CCW (出口上, 镜像)
await evalJs(cdp, `window.__game.spawnBelt([[12,4],[15,4],[15,7]],0)`);
await evalJs(cdp, `window.__game.spawnBelt([[3,12],[6,12],[6,9]],0)`);
await delay(800);
await shot(cdp, 't20_belt_chain');

// ── 3. pointer 流动对比: 1s 后再截一张 ──
await delay(1000);
await shot(cdp, 't20_belt_pointer_t1');

// ── 4. E 进入创建模式, 端口高亮 ──
await keyPress(cdp, 'KeyE', 'e', 69);
console.log('mode after E:', await evalJs(cdp, `window.__game.belt.getMode()`));
await delay(300);
await shot(cdp, 't20_belt_mode_enter');

// hover 输出端口 (9,8)
let p = await cellToScreen(cdp, 9, 8);
console.log('port screen pos:', p);
await mouseMove(cdp, p.x, p.y);
await delay(400);
await shot(cdp, 't20_belt_port_hover');

// 点击端口 → preview
await mouseClick(cdp, p.x, p.y, 'left');
console.log('mode after click port:', await evalJs(cdp, `window.__game.belt.getMode()`));

// 移鼠标到 (9,3)
p = await cellToScreen(cdp, 9, 3);
await mouseMove(cdp, p.x, p.y);
await delay(500);
await shot(cdp, 't20_belt_preview_blue');

// 移鼠标到 (12,3) — L 形: 上→右(verticalFirst, 因为竖直位移大)
p = await cellToScreen(cdp, 12, 3);
await mouseMove(cdp, p.x, p.y);
await delay(500);
await shot(cdp, 't20_belt_preview_l_shape');

// ── 5. 右键落盘 + 退出 ──
await mouseClick(cdp, p.x, p.y, 'right');
console.log('mode after right-click:', await evalJs(cdp, `window.__game.belt.getMode()`));
await delay(400);
await shot(cdp, 't20_belt_placed_yellow');

// ── 6. 占用格测试 ──
// 先确认模式 — 右键落盘后 mode=hover(回 hover 不退出). 再按 E 退出
await keyPress(cdp, 'KeyE', 'e', 69);  // toggle: hover → idle
console.log('after exit E, mode:', await evalJs(cdp, `window.__game.belt.getMode()`));

// 再 E 进入
await keyPress(cdp, 'KeyE', 'e', 69);
p = await cellToScreen(cdp, 8, 8); // 另一输出端口
await mouseMove(cdp, p.x, p.y);
await delay(300);
await mouseClick(cdp, p.x, p.y, 'left');
console.log('mode (occupied test) after click:', await evalJs(cdp, `window.__game.belt.getMode()`));

// 鼠标移到精炼炉内部 (9,9) — 被占用, 路径不可达
p = await cellToScreen(cdp, 9, 9);
await mouseMove(cdp, p.x, p.y);
await delay(500);
await shot(cdp, 't20_belt_occupied_target');
const prevInfo = await evalJs(cdp, `(() => { const b=window.__game.belt; return JSON.stringify({mode:b.getMode(), visible:b.previewContainer?.visible, sprites:b.previewContainer?.children?.length ?? -1, valid:b.previewValid}); })()`);
console.log('preview (occupied target):', prevInfo);

// 移到 (13,8) — 空地, 看是否蓝色预览
p = await cellToScreen(cdp, 13, 8);
await mouseMove(cdp, p.x, p.y);
await delay(500);
await shot(cdp, 't20_belt_preview_after_occupied');

// ── 7. 退出 ──
await keyPress(cdp, 'KeyE', 'e', 69);
await keyPress(cdp, 'KeyE', 'e', 69); // 确保 idle

// ── 8. 断头末端延长: 从已落盘的 (9,3) 链尾延长 ──
await keyPress(cdp, 'KeyE', 'e', 69);
p = await cellToScreen(cdp, 9, 3);
await mouseMove(cdp, p.x, p.y);
await delay(400);
await shot(cdp, 't20_belt_tail_hover');
await mouseClick(cdp, p.x, p.y, 'left');
console.log('mode after tail click:', await evalJs(cdp, `window.__game.belt.getMode()`));
p = await cellToScreen(cdp, 14, 3);
await mouseMove(cdp, p.x, p.y);
await delay(500);
await shot(cdp, 't20_belt_extend_preview');
await mouseClick(cdp, p.x, p.y, 'right');
await delay(400);
await shot(cdp, 't20_belt_extended');

// pointer 流动再截一张
await delay(1000);
await shot(cdp, 't20_belt_pointer_t2');

console.log('DONE');
process.exit(0);