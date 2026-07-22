// 全局渲染/世界常量
// 依据: A2 world-model.md (世界边界), A6 coordinate-spec.md (CELL_SIZE/Camera 约束),
//       A2 §5 (配色), A5 simulation-spec.md (时钟)
//
// 这些常量是 Phase 1 多个模块的共享依据，集中定义避免魔数散落。

// ───────────────────────── 网格 / 世界 ─────────────────────────

/** 一个 Cell 的世界像素边长 (A6 §2, A2 §2.1)。常量，运行时不改变。 */
export const CELL_SIZE = 64;

/** Phase 1 世界宽度（单位: Cell）(A2 §8)。世界 64×64 cells。 */
export const WORLD_WIDTH_CELLS = 64;
/** Phase 1 世界高度（单位: Cell）(A2 §8)。 */
export const WORLD_HEIGHT_CELLS = 64;

/** 世界宽度（世界像素）= WORLD_WIDTH_CELLS * CELL_SIZE。 */
export const WORLD_WIDTH_PX = WORLD_WIDTH_CELLS * CELL_SIZE; // 4096
/** 世界高度（世界像素）= WORLD_HEIGHT_CELLS * CELL_SIZE。 */
export const WORLD_HEIGHT_PX = WORLD_HEIGHT_CELLS * CELL_SIZE; // 4096

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
