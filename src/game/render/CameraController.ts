// 相机输入控制器 — 把 DOM 事件翻译成 Camera 操作
// 依据: implementation-phase-1.md T1.2（中键拖拽、WASD、滚轮以鼠标为中心缩放）
//       A6 coordinate-spec.md §4（相机操作）
//
// 职责: 监听 canvas/window 上的鼠标与键盘事件，调用 Camera 的平移/缩放方法。
// 相机自身的边界约束、坐标转换由 Camera 负责；Controller 只负责事件归一化。
//
// 拖拽平移: 按住中键移动 → 相机反向跟随（拖地球向右，看到的画面向左移）。
//   屏幕位移 dx_screen → 世界位移 dx_world = dx_screen / zoom（相机中心 -= dx_world）。
// WASD: 按帧速 * CAMERA_KEY_PAN_SPEED 平移。
// 滚轮: 以鼠标位置为锚点缩放， deltaY > 0（向下滚）缩小， < 0 放大。

import { Camera } from './Camera';
import {
  CAMERA_ZOOM_WHEEL_STEP,
  CAMERA_KEY_PAN_SPEED,
} from './constants';

export class CameraController {
  private camera: Camera;
  private canvas: HTMLCanvasElement;

  /** 当前按下的 WASD（用于连续平移）。 */
  private keys = {
    up: false,
    down: false,
    left: false,
    right: false,
  };

  /** 中键拖拽状态。 */
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  /** 鼠标当前屏幕坐标（用于滚轮锚点）。 */
  private mouseX = 0;
  private mouseY = 0;

  // 持有解绑函数，destroy 时一次性移除所有监听。
  private disposers: Array<() => void> = [];

  constructor(camera: Camera, canvas: HTMLCanvasElement) {
    this.camera = camera;
    this.canvas = canvas;
    this.attach();
  }

  private attach(): void {
    // 阻止中键默认的"自动滚动"行为
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('auxclick', this.onAuxClick);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);

    this.disposers.push(() => {
      this.canvas.removeEventListener('mousedown', this.onMouseDown);
      this.canvas.removeEventListener('auxclick', this.onAuxClick);
      window.removeEventListener('mousemove', this.onMouseMove);
      window.removeEventListener('mouseup', this.onMouseUp);
      this.canvas.removeEventListener('wheel', this.onWheel);
      this.canvas.removeEventListener('contextmenu', this.onContextMenu);
      window.removeEventListener('keydown', this.onKeyDown);
      window.removeEventListener('keyup', this.onKeyUp);
      window.removeEventListener('blur', this.onBlur);
    });
  }

  destroy(): void {
    this.disposers.forEach(d => d());
    this.disposers = [];
  }

  // ───────────────────────── 鼠标 ─────────────────────────

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 1) {
      // 中键：开始拖拽
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      e.preventDefault();
    }
    this.mouseX = e.clientX - this.canvasRectLeft();
    this.mouseY = e.clientY - this.canvasRectTop();
  };

  private onAuxClick = (e: MouseEvent): void => {
    // 中键的 auxclick 在某些浏览器会触发自动滚动，阻止默认
    if (e.button === 1) e.preventDefault();
  };

  private onMouseMove = (e: MouseEvent): void => {
    const x = e.clientX - this.canvasRectLeft();
    const y = e.clientY - this.canvasRectTop();
    this.mouseX = x;
    this.mouseY = y;

    if (this.dragging) {
      const dxScreen = e.clientX - this.lastX;
      const dyScreen = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      // 屏幕拖拽方向 = 相机移动方向的反向（拖地球向右，画面向左）
      this.camera.panByWorld(-dxScreen / this.camera.zoom, -dyScreen / this.camera.zoom);
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 1) {
      this.dragging = false;
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // 标准化 wheel delta： deltaY > 0 表示向下滚 → 缩小
    // newZoom = zoom * (step ^ -sign)，向下滚缩小、向上滚放大
    const dir = e.deltaY > 0 ? -1 : 1;
    // 小幅度滚动（触控板）也至少推进 MIN_STEP，避免无感
    const factor = Math.pow(CAMERA_ZOOM_WHEEL_STEP, dir);
    const newZoom = this.camera.zoom * factor;
    this.camera.zoomAt({ x: this.mouseX, y: this.mouseY }, newZoom);
  };

  private onContextMenu = (e: MouseEvent): void => {
    // 相机阶段禁止右键菜单（后续放置系统会用右键取消）
    e.preventDefault();
  };

  // ───────────────────────── 键盘 ─────────────────────────

  private onKeyDown = (e: KeyboardEvent): void => {
    this.setKey(e.code, true);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.setKey(e.code, false);
  };

  private setKey(code: string, down: boolean): void {
    switch (code) {
      case 'KeyW':
      case 'ArrowUp':
        this.keys.up = down;
        break;
      case 'KeyS':
      case 'ArrowDown':
        this.keys.down = down;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        this.keys.left = down;
        break;
      case 'KeyD':
      case 'ArrowRight':
        this.keys.right = down;
        break;
    }
  }

  private onBlur = (): void => {
    // 窗口失焦时清空按键状态，避免"按住 W 切走再回来还在移动"
    this.keys.up = this.keys.down = this.keys.left = this.keys.right = false;
    this.dragging = false;
  };

  // ───────────────────────── 帧更新 ─────────────────────────

  /**
   * 每帧调用：处理 WASD 连续平移。
   * @param deltaMS 上一帧到本帧的毫秒数（用于平滑、帧率无关移动）
   */
  update(deltaMS: number): void {
    if (this.keys.up || this.keys.down || this.keys.left || this.keys.right) {
      const dist = (CAMERA_KEY_PAN_SPEED * deltaMS) / 1000;
      let dx = 0;
      let dy = 0;
      if (this.keys.left) dx -= dist;
      if (this.keys.right) dx += dist;
      if (this.keys.up) dy -= dist;
      if (this.keys.down) dy += dist;
      if (dx !== 0 || dy !== 0) {
        this.camera.panByWorld(dx, dy);
      }
    }
  }

  // ───────────────────────── 辅助 ─────────────────────────

  private canvasRectLeft(): number {
    return this.canvas.getBoundingClientRect().left;
  }

  private canvasRectTop(): number {
    return this.canvas.getBoundingClientRect().top;
  }
}
