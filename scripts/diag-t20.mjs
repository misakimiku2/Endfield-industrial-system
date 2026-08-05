// 诊断脚本: 在 preview 状态下读 belt 内部状态
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
    await this.ready;
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
}
async function evalJs(cdp, e) {
  const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
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

const t = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' }).then((r) => r.json());
const cdp = new CDPClient(t.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

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

// E 进入
await keyPress(cdp, 'KeyE', 'e', 69);
console.log('mode:', await evalJs(cdp, `window.__game.belt.getMode()`));

// 移到端口 (9,8) — 端口屏幕坐标: world (9*64+32=608, 8*64+32=544). camera(700,700), vp(1600,1000), zoom=1
// screen = world - camera + halfvp = (608-700+800, 544-700+500) = (708, 344)
const portScreen = await evalJs(cdp, `(() => { const c=window.__game.camera; const s=c.worldToScreen(9*64+32, 8*64+32); return s; })()`);
console.log('port screen:', portScreen);

// 鼠标移到端口
await mouseMove(cdp, portScreen.x, portScreen.y);
await delay(300);
const hoverState = await evalJs(cdp, `(() => { const b=window.__game.belt; return JSON.stringify({mode:b.getMode(), mouseGrid:b.mouseGrid, inside:b.mouseInside, hovered: b.findHoveredStart ? !!b.findHoveredStart() : null}); })()`);
console.log('hover state:', hoverState);

// 点击
await mouseClick(cdp, portScreen.x, portScreen.y, 'left');
console.log('after click mode:', await evalJs(cdp, `window.__game.belt.getMode()`));

// 移到目标 (9,3) — world (608, 224). screen = (708, 24)
const tgtScreen = await evalJs(cdp, `(() => { const c=window.__game.camera; const s=c.worldToScreen(9*64+32, 3*64+32); return s; })()`);
console.log('target screen:', tgtScreen);
await mouseMove(cdp, tgtScreen.x, tgtScreen.y);
await delay(500);

// 关键诊断: preview 内部状态
const diag = await evalJs(cdp, `(() => {
  const b = window.__game.belt;
  const pc = b.previewContainer;
  return JSON.stringify({
    mode: b.getMode(),
    mouseGrid: b.mouseGrid,
    mouseInside: b.mouseInside,
    startPoint: b.startPoint ? {kind:b.startPoint.kind, cell:b.startPoint.cell, direction:b.startPoint.direction} : null,
    anchors: b.anchors,
    fullPath: b.fullPath,
    previewPath: b.previewPath,
    previewValid: b.previewValid,
    pcVisible: pc?.visible,
    pcChildCount: pc?.children?.length ?? -1,
    pcChildInfo: Array.from(pc?.children ?? []).slice(0, 3).map(c => ({
      type: c.constructor.name,
      x: c.x, y: c.y, alpha: c.alpha,
      rotation: c.rotation,
      scaleX: c.scale?.x, scaleY: c.scale?.y,
      visible: c.visible,
      width: c.width, height: c.height,
    })),
  });
})()`);
console.log('preview DIAG:', diag);

await shot(cdp, 't20_diag_preview');

process.exit(0);