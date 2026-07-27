// 全局渲染/世界常量
// 依据: A2 world-model.md (世界边界), A6 coordinate-spec.md (CELL_SIZE/Camera 约束),
//       A2 §5 (配色), A5 simulation-spec.md (时钟)
//
// 这些常量是 Phase 1 多个模块的共享依据，集中定义避免魔数散落。

// ───────────────────────── 网格 / 世界 ─────────────────────────

/** 一个 Cell 的世界像素边长 (A6 §2, A2 §2.1)。常量，运行时不改变。 */
export const CELL_SIZE = 64;

// ⚠️ 世界尺寸不再是全局常量（A11 WV-003 §4.4，A2 §8 修订）。
// 原 WORLD_WIDTH/HEIGHT_CELLS 与 WORLD_WIDTH/HEIGHT_PX 已下放到 MapInstance
// （src/game/world/MapInstance.ts），占用表 / 相机边界 clamp 都读地图实例属性。
// 这样 Phase 3a 把世界换成 Chunk 化时无需扫全代码改硬编码。
//
// 此处仅保留"默认地图尺寸"作为 createDefaultMap 的取值来源（语义是默认值，非全局世界尺寸）。
/** 默认地图尺寸（单位: Cell）(A2 §8)。Phase 1-2 默认 64×64。 */
export const WORLD_DEFAULT_CELLS = 64;

// ───────────────────────── 相机 ─────────────────────────

/** 最小缩放倍率 (A6 §4.1)。25% = 看到大范围。 */
export const CAMERA_ZOOM_MIN = 0.25;
/** 最大缩放倍率 (A6 §4.1)。400% = 放大看清细节。 */
export const CAMERA_ZOOM_MAX = 4.0;
/** 默认缩放。 */
export const CAMERA_ZOOM_DEFAULT = 1.0;

/** 滚轮缩放灵敏度（每次滚动的缩放因子指数底数）。 */
export const CAMERA_ZOOM_WHEEL_STEP = 1.15;
/** 滚轮缩放前后允许的最大单次变化（防止一次滚动跳太多）。 */
export const CAMERA_ZOOM_WHEEL_MIN_STEP = 0.02;

/** 键盘平移速度（世界像素/秒）。 */
export const CAMERA_KEY_PAN_SPEED = 900;
/** 中键拖拽平移：1 屏幕像素拖拽对应的世界像素位移 = 1 / zoom。 */
// (拖拽时直接按 screenDelta / zoom 反算 worldDelta，无需额外常量)

// ───────────────────────── 视图操作 (T1.5) ─────────────────────────

/** 边缘滚动触发带宽度（屏幕像素）。鼠标距窗口边缘 ≤ 此值时触发边缘滚动。 */
export const CAMERA_EDGE_SCROLL_MARGIN = 32;
/** 边缘滚动速度（世界像素/秒），对齐 WASD 的 900px/s。 */
export const CAMERA_EDGE_SCROLL_SPEED = 900;

/** 视图旋转(Ctrl+R)过渡动画时长（ms）。0 = 瞬间切换(旧行为)，~200ms 有平滑手感又不拖沓。 */
export const CAMERA_ROTATE_ANIM_MS = 220;

// ───────────────────────── 配色 (A2 §5) ─────────────────────────

/** 网格背景底色 (A2 §5.1)。 */
export const COLOR_GRID_BG = 0xe6e4e4;
/** 网格线颜色 (A2 §5.1)，略深于背景。 */
export const COLOR_GRID_LINE = 0xd6d4d4;
/** 暗角颜色 rgba(0,0,0,0.3) (A2 §5.1)。 */
export const COLOR_VIGNETTE = 'rgba(0,0,0,0.3)';

// ───────────────────────── 仿真 (A5) ─────────────────────────

/** 仿真 Tick 步长（ms）@ 20 TPS (A5 §2, DD-004)。 */
export const SIM_STEP_MS = 50;
/** 螺旋追赶保护上限（ms）(A5 §2)。 */
export const SIM_ACCUMULATOR_MAX_MS = 250;
