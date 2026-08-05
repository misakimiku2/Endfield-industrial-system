// 绕过事件传递: 直接调 belt.setMouse 验证实现逻辑
import { writeFileSync } from 'node:fs';
const CDP = 'http://localhost:9222';
const APP = 'http://localhost:5173';
const OUT = 'C:/Users/Misaki/.workbuddy/tmp/t20-shots';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result.value;
}
async function mouseClick(cdp, x, y, button='left') {
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

const t = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' }).then((r) => r.json());
const cdp = new CDPClient(t.webSocketDebuggerUrl);
await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await delay(500);
  ready = await evalJs(cdp, `!!(window.__game && window.__game.belt)`).catch(() => false);
}
await evalJs(cdp, `(() => { const c=window.__game.camera; c.setPosition(700,700); c.updateTransform?.(); })()`);
await evalJs(cdp, `window.__game.clearAllPlaced?.()`);
await evalJs(cdp, `window.__game.clearTestDevices?.()`);
await delay(300);
await evalJs(cdp, `window.__game.placeAt('refining_unit',8,8)`);
await delay(500);

await keyPress(cdp, 'KeyE', 'e', 69);
console.log('mode:', await evalJs(cdp, `window.__game.belt.getMode()`));

// 计算端口和目标屏幕坐标
const portScreen = await evalJs(cdp, `window.__game.camera.worldToScreen(9*64+32, 8*64+32)`);
const tgtScreen = await evalJs(cdp, `window.__game.camera.worldToScreen(9*64+32, 3*64+32)`);
console.log('port screen:', portScreen, 'target screen:', tgtScreen);

// 强制让 belt 知道鼠标在端口
await evalJs(cdp, `window.__game.belt.setMouse(${portScreen.x}, ${portScreen.y}, true)`);
await delay(150);
console.log('after setMouse port:', await evalJs(cdp, `JSON.stringify({mode:window.__game.belt.getMode(), mouseGrid:window.__game.belt.mouseGrid})`));

// 点击端口(用真实 mouseClick 触发 onPointerDown)
await mouseClick(cdp, portScreen.x, portScreen.y, 'left');
console.log('after click port mode:', await evalJs(cdp, `window.__game.belt.getMode()`));

// 强制让 belt 知道鼠标移到目标(直接调 setMouse, 模拟 pointermove 触发)
await evalJs(cdp, `window.__game.belt.setMouse(${tgtScreen.x}, ${tgtScreen.y}, true)`);
await delay(300);

const diag = await evalJs(cdp, `(() => {
  const b = window.__game.belt;
  return JSON.stringify({
    mode: b.getMode(),
    mouseGrid: b.mouseGrid,
    anchors: b.anchors,
    previewPath: b.previewPath,
    previewValid: b.previewValid,
    pcVisible: b.previewContainer?.visible,
    pcChildCount: b.previewContainer?.children?.length ?? -1,
  });
})()`);
console.log('preview DIAG (forced setMouse):', diag);

await shot(cdp, 't20_forced_preview_blue');

// 鼠标移到 (12,3) — L形预览(先上后右, 因为竖直位移大→verticalFirst=true)
const tgt2 = await evalJs(cdp, `window.__game.camera.worldToScreen(12*64+32, 3*64+32)`);
await evalJs(cdp, `window.__game.belt.setMouse(${tgt2.x}, ${tgt2.y}, true)`);
await delay(300);
await shot(cdp, 't20_forced_preview_lshape');

// 右键落盘(用真实 mouseClick)
await mouseClick(cdp, tgt2.x, tgt2.y, 'right');
console.log('after right mode:', await evalJs(cdp, `window.__game.belt.getMode()`));
await delay(300);
await shot(cdp, 't20_forced_placed');

// 检查落盘了多少段
const segCount = await evalJs(cdp, `window.__game.world.query('Position','BeltSegmentComp').length`);
console.log('belt segments after place:', segCount);

// ── 占用格测试: 再进模式, 点端口 (10,8), 强制 setMouse 到精炼炉内部 (9,9) ──
await keyPress(cdp, 'KeyE', 'e', 69);
const port2 = await evalJs(cdp, `window.__game.camera.worldToScreen(10*64+32, 8*64+32)`);
await evalJs(cdp, `window.__game.belt.setMouse(${port2.x}, ${port2.y}, true)`);
await delay(150);
await mouseClick(cdp, port2.x, port2.y, 'left');
console.log('occupied test mode:', await evalJs(cdp, `window.__game.belt.getMode()`));

const occ = await evalJs(cdp, `window.__game.camera.worldToScreen(9*64+32, 9*64+32)`);
await evalJs(cdp, `window.__game.belt.setMouse(${occ.x}, ${occ.y}, true)`);
await delay(300);
const diag2 = await evalJs(cdp, `(() => { const b=window.__game.belt; return JSON.stringify({mode:b.getMode(), mouseGrid:b.mouseGrid, previewPath:b.previewPath, valid:b.previewValid, visible:b.previewContainer?.visible, sprites:b.previewContainer?.children?.length}); })()`);
console.log('occupied DIAG:', diag2);
await shot(cdp, 't20_forced_occupied');

// 退出
await keyPress(cdp, 'KeyE', 'e', 69);
await keyPress(cdp, 'KeyE', 'e', 69); // 再按一次确保 idle

// pointer 流动对比: 等 1s 再截
await delay(1000);
await shot(cdp, 't20_forced_pointer_t1');

console.log('DONE');
process.exit(0);