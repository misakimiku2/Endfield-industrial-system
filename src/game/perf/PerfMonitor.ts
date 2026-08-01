// 性能基准监控 — T1.10 FPS + 内存占用
// 依据: implementation-phase-1.md T1.10（100 设备 FPS ≥ 55）
//
// 除帧率外，T1.10 还关注内存占用，这里提供两类指标:
//   1. JS 堆内存: performance.memory.usedJSHeapSize（Chromium 私有 API，
//      其他浏览器返回 0/不可用）
//   2. GPU 纹理内存（估算）: 遍历 renderer.texture.managedTextures 里的
//      TextureSource，按 width×height×4B/px×(mip 链 1.33 系数) 估算。
//      这是近似值（RGBA8 假设），用于观察"设备数量变化 → 纹理内存是否异常增长"。
//      纹理图集是启动时一次性上传的，100 个设备共享同一批图集纹理，
//      正常情况下设备增删不应改变纹理内存（这是 T1.10 的内存验收点）。
//
// runFpsBenchmark 不阻塞主循环: 用 app.ticker.add 每帧采样一次 FPS，
// 按 memoryIntervalMs 间隔采样内存，窗口结束返回汇总报告。

import type { Application } from 'pixi.js';
import type { World } from '../ECS';
import type { RenderSystem } from '../systems/RenderSystem';
import type { OccupancyMap } from '../world/OccupancyMap';

const MB = 1048576;
const BYTES_PER_PIXEL = 4; // RGBA8 假设（估算用）
const MIP_CHAIN_FACTOR = 4 / 3; // 完整 mip 链比 mip0 多约 1/3

/** 一次内存快照（T1.10 内存验收的数据结构）。 */
export interface MemorySample {
  /** JS 堆已用内存（MB，Chromium performance.memory；不可用时为 0）。 */
  jsHeapMB: number;
  /** JS 堆上限（MB，仅用于展示）。 */
  jsHeapLimitMB: number;
  /** 已上传 GPU 的纹理源数量（图集 + 文本 + 暗角等）。 */
  textureSources: number;
  /** GPU 纹理内存估算（MB）。图集共享时与设备数量无关。 */
  textureMemoryMB: number;
  /** RenderSystem 管理的 Sprite 数（含 logo 子 Sprite 对应的 entry）。 */
  sprites: number;
  /** 视口剔除后可见的 Sprite 数。 */
  visibleSprites: number;
  /** ECS 实体总数。 */
  entities: number;
  /** 占用表 Cell 数。 */
  occupiedCells: number;
}

/** FPS 汇总统计。 */
export interface FpsStats {
  min: number;
  avg: number;
  max: number;
  /** 95 分位（95% 帧不低于此值）。 */
  p95: number;
}

/** 帧耗时汇总统计（ms）。 */
export interface FrameMsStats {
  avg: number;
  p95: number;
  max: number;
}

/** T1.10 benchmark 报告。 */
export interface BenchmarkReport {
  /** 采样窗口时长（ms）。 */
  durationMs: number;
  /** 采样帧数。 */
  frames: number;
  fps: FpsStats;
  frameMs: FrameMsStats;
  /** T1.10 验收线: 平均 FPS ≥ 55 且 95 分位 FPS ≥ 55。 */
  met55: boolean;
  memory: {
    baseline: MemorySample;
    final: MemorySample;
    /** 采样窗口内的 JS 堆峰值（MB）。 */
    jsHeapPeakMB: number;
    /** final − baseline 的 JS 堆增量（MB）。 */
    jsHeapDeltaMB: number;
    /** final − baseline 的纹理内存增量（MB）。 */
    textureMemoryDeltaMB: number;
  };
  /** 场景内各设备类型的数量（definitionId → count）。 */
  devices: Record<string, number>;
}

/** 内存压测（反复生成/清空 100 设备）的单轮结果。 */
export interface MemoryStressRound {
  cycle: number;
  placed: number;
  before: MemorySample;
  during: MemorySample;
  after: MemorySample;
  /** 清空后相对本轮基线的 JS 堆增量（MB）。 */
  heapAfterDeltaMB: number;
}

interface HeapMemoryLike {
  usedJSHeapSize?: number;
  jsHeapSizeLimit?: number;
}

interface TextureSystemLike {
  managedTextures?: ReadonlyArray<{
    width?: number;
    height?: number;
    mipLevelCount?: number;
  }>;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[idx];
}

/** 读取 Chromium 私有 performance.memory；不可用时返回 0（非 Chromium 环境）。 */
function jsHeapMB(): { usedMB: number; limitMB: number } {
  const mem = (performance as unknown as { memory?: HeapMemoryLike }).memory;
  const used = mem?.usedJSHeapSize ?? 0;
  const limit = mem?.jsHeapSizeLimit ?? 0;
  return { usedMB: used / MB, limitMB: limit / MB };
}

/** 估算已上传 GPU 的纹理内存（MB）。返回源数量 + 估算字节。 */
function estimateTextureMemory(app: Application): { sources: number; memoryMB: number } {
  const texSystem = app.renderer as unknown as { texture?: TextureSystemLike };
  const sources = texSystem.texture?.managedTextures ?? [];
  let bytes = 0;
  for (const s of sources) {
    const w = s.width ?? 0;
    const h = s.height ?? 0;
    if (w <= 0 || h <= 0) continue;
    const mips = Math.max(1, s.mipLevelCount ?? 1);
    const chainFactor = mips > 1 ? MIP_CHAIN_FACTOR : 1;
    bytes += w * h * BYTES_PER_PIXEL * chainFactor;
  }
  return { sources: sources.length, memoryMB: bytes / MB };
}

export class PerfMonitor {
  private app: Application;
  private world: World;
  private renderSystem: RenderSystem;
  private occupancy: OccupancyMap;

  constructor(
    app: Application,
    world: World,
    renderSystem: RenderSystem,
    occupancy: OccupancyMap,
  ) {
    this.app = app;
    this.world = world;
    this.renderSystem = renderSystem;
    this.occupancy = occupancy;
  }

  /** 当前内存/场景快照。 */
  sampleMemory(): MemorySample {
    const heap = jsHeapMB();
    const tex = estimateTextureMemory(this.app);
    return {
      jsHeapMB: round1(heap.usedMB),
      jsHeapLimitMB: round1(heap.limitMB),
      textureSources: tex.sources,
      textureMemoryMB: round1(tex.memoryMB),
      sprites: this.renderSystem.spriteCount,
      visibleSprites: this.renderSystem.visibleSpriteCount,
      entities: this.world.entityCount(),
      occupiedCells: this.occupancy.occupiedCount,
    };
  }

  /**
   * 在 durationMs 窗口内每帧采样 FPS、每 memoryIntervalMs 采样内存，
   * 汇总成 BenchmarkReport。不阻塞主循环。
   */
  runFpsBenchmark(
    durationMs = 5000,
    memoryIntervalMs = 500,
  ): Promise<BenchmarkReport> {
    const baseline = this.sampleMemory();
    const fpsSamples: number[] = [];
    const memorySamples: MemorySample[] = [baseline];
    const start = performance.now();
    let lastMemAt = start;

    return new Promise((resolve) => {
      const collector = (): void => {
        const now = performance.now();
        fpsSamples.push(this.app.ticker.FPS);
        if (now - lastMemAt >= memoryIntervalMs) {
          lastMemAt = now;
          memorySamples.push(this.sampleMemory());
        }
        if (now - start >= durationMs) {
          this.app.ticker.remove(collector);
          const elapsed = performance.now() - start;
          resolve(this.buildReport(fpsSamples, memorySamples, elapsed));
        }
      };
      this.app.ticker.add(collector);
    });
  }

  private buildReport(
    fpsSamples: number[],
    memorySamples: MemorySample[],
    durationMs: number,
  ): BenchmarkReport {
    const sorted = [...fpsSamples].sort((a, b) => a - b);
    const avgFps = fpsSamples.reduce((s, v) => s + v, 0) / Math.max(1, fpsSamples.length);
    const frameMs = fpsSamples.map((fps) => 1000 / Math.max(1, fps)).sort((a, b) => a - b);
    const p95Fps = percentile(sorted, 0.95);
    const baseline = memorySamples[0];
    const final = memorySamples[memorySamples.length - 1] ?? baseline;
    const jsHeapPeakMB = Math.max(...memorySamples.map((m) => m.jsHeapMB));

    const devices: Record<string, number> = {};
    for (const handle of this.world.query('BuildingComp')) {
      const building = this.world.getComponent<{ definitionId: string }>(
        handle,
        'BuildingComp',
      );
      if (!building) continue;
      devices[building.definitionId] = (devices[building.definitionId] ?? 0) + 1;
    }

    return {
      durationMs: Math.round(durationMs),
      frames: fpsSamples.length,
      fps: {
        min: round1(sorted[0] ?? 0),
        avg: round1(avgFps),
        max: round1(sorted[sorted.length - 1] ?? 0),
        p95: round1(p95Fps),
      },
      frameMs: {
        avg: round1(frameMs.reduce((s, v) => s + v, 0) / Math.max(1, frameMs.length)),
        p95: round1(percentile(frameMs, 0.95)),
        max: round1(frameMs[frameMs.length - 1] ?? 0),
      },
      met55: avgFps >= 55 && p95Fps >= 55,
      memory: {
        baseline,
        final,
        jsHeapPeakMB: round1(jsHeapPeakMB),
        jsHeapDeltaMB: round1(final.jsHeapMB - baseline.jsHeapMB),
        textureMemoryDeltaMB: round1(final.textureMemoryMB - baseline.textureMemoryMB),
      },
      devices,
    };

  }
}
