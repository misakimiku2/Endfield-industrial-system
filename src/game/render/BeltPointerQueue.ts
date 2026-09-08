// 指针队列物理 — T2.29 纯逻辑模块（无 Pixi 依赖，node 诊断可直接驱动）。
//
// 模型（§十三 用户拍板的 0/1 统一模型完整版）: 指针 0 与物品 1 是同一类"带上的
// 东西"——0 无 ID、到带端循环、被 1 压住即消失，但**运行逻辑与 1 相同**: 以带速
// 流动、停在格心排队（被物品或其他 0 挡住就停）、与队列保持 ≥1 格间距。
// T2.28 的"任意相位纯滑行流"（全局时钟 + 链哈希）退役——那是图1"物品在格心、
// 指针以任意相位滑行/穿过静止物品队列"的直接根源。
//
// 与物品的交互（tick() 每 Tick 编排，渲染器/诊断脚本共用同一入口）:
//   - 阻挡: 0 与前方最近物品/0 保持 ≥1 格——停走队列把 0 整列冻结在格心上
//     （与物品排队同构），不穿过 1。
//   - 击杀（一格只能 0 或 1，用户 2026-09-07 拍板）: ① 物品**停稳**且与 0 距离
//     ≤ CONTACT_KILL_DIST → 该 0 移除（"1 停稳后 0 才消失"——排队中的 0 被
//     走过来的 1 盖住、1 停稳的瞬间消失，是唯一合法的同格瞬态）; ② **在流**指针
//     与物品重合（≤ CONTACT_KILL_DIST，物品停稳与否不论）→ 立即移除——注入
//     "弹入"链首格不检查指针，物品与入链指针同速同行永远解不开（用户实测
//     "满载运输时物品下方跟着指针"）; ③ **注入重合击杀**: 注入 Tick **先重相位**
//     （把 0.4~0.9 的亚格间距同行前兆归位到 0 或 ±1）**后移除与物品重合者**
//     （距离 ≈ 0）——⚠️ 判定是"重合"不是"距离 <1": 堵塞生长期移动中的物品
//     （class 0.0 格网）与已停稳的堵塞队列（class 0.5 格网）不在同一格网，
//     重相位只能对齐其一，合法停在另一格网上的 0 与物品距离恰 0.5，按 <1
//     判定会被整批误杀 = 带内全亮瞬消（2026-09-08 修复）。击杀消耗由补充回填。
//   - 循环: 0 滑出链尾余量 → 从链首带缘再进来（re-entry 槽与链首侧全部实体
//     保持 ≥1 格、≤ 链首边缘——链首被占时在带外等待，遮罩外不可见）。
//   - 补充: 数量 < 链长+1 时在最末**指针**后方一格回补（与既有指针同格网;
//     与物品冲突则整格后退到带外等待）——覆盖率（每空格一支 0）不随停走消耗
//     衰减。⚠️ 旧实现按"最末实体（含物品）"回补会在双格网时产出**离格指针**
//     （详见 replenish 注释）。
//
// 相位语义（用户 2026-09-07 拍板）: **每条带的图案相位 = 它自己的创建时刻**
// （chainId 时间戳派生，chainCreationClass）——空带各不相同（全局同相是缺陷）;
// 带过物品时被注入重相位对齐到物品格网（0 与 1 同格网，图1 根治），排空后
// **回归创建相位**（≤半格刚体平移一次）。注入重相位 = 最短模距离平移到新物品
// （=最末物品）格网: 正常流动下新物品与既有队列同相位（节拍 40 Tick = 整数格 +
// BeltSystem 1/40 栅格对齐），δ=0 零开销; 仅停走恢复后相位分裂时实际平移。
//
// 坐标系: 链上绝对坐标 d（格），0 = 链首带缘、chainLen = 链尾带缘；物品
// total = segmentIndex + progress。直段/转角的世界坐标映射在渲染器
// （BeltPointerRenderer.computePointerTransform），本模块只管链坐标。

import { ITEM_PROGRESS_PER_TICK } from '../systems/BeltSystem.ts';

/**
 * 接触击杀距离（格）: 物品半宽 0.25 + 指针半高 0.125 = 像素接触（§十三① 的
 * 0.5 → 0.375 修订，随队列化合并进击杀规则: 仅停稳物品触发）。
 */
export const CONTACT_KILL_DIST = 0.375;

/** 链尾滑出判定余量（格）——滑出即循环；也是链首/链尾渐变的半宽。 */
export const ARROW_WINDOW_MARGIN = 0.125;

/** 链上物品快照（渲染器从 BeltSegmentComp 收集；非 entering）。 */
export interface QueueItemRef {
  /** 链上绝对坐标（segmentIndex + progress）。 */
  total: number;
  /** 本 Tick 停走（delta === 0）——停稳物品触发接触击杀并冻结后方队列。 */
  stopped: boolean;
}

/** 单支指针（链坐标位置；id 供渲染器精灵池键控）。 */
export interface PointerArrow {
  id: number;
  pos: number;
  /** 上一 Tick 发生过位移（在流）——流动覆盖击杀的判定之一（排队静止的 0 例外，
   * 等待"停稳击杀"的覆盖过程是唯一合法同格瞬态）。 */
  flowing: boolean;
  /**
   * 出场口锁定（T2.29-f）: 进入渐隐区时锁定正在滑入的终点位置——堵塞虚拟
   * 终点是离散后跳的（每件物品停稳跳一格），不锁定会把渐隐中的指针瞬间
   * 硬传送回带首 = 用户实测"走入物品那格立刻消失/交替消失"。锁定后本支完整
   * 滑入原前沿、渐隐归零才循环（循环时清 null）; 前沿后跳只影响后来者。
   * null = 未锁定（远离终点，跟随当前终点）; 越过终点的存量指针锁定 chainLen
   * （堵塞形成瞬间它们在裸带上，去真实带尾完成滑出）; 疏通（终点前进越过
   * 锁定值）解锁跟随。
   */
  exitAt: number | null;
}

const EPS = 1e-9;

/**
 * 链的固有序位 [0,1): chainId 哈希（h×31+charCode mod 997，2026-08-25 旧
 * chainPhaseOf 同款）。每条带的图案相位 = 本值 + 流逝时间（freeRunClass）——
 * 空带相位各链各异且持续流动（用户 2026-09-07: 全部同步是缺陷）。
 *
 * ⚠️ 不得用 frac(创建时间戳/相位周期) 派生: 相位(T) = frac(ts/2000) + (T−ts)/2000
 * ≡ frac(T/2000)——创建偏移被"创建以来的流动量"**精确抵消**，任何空带都收敛到
 * 同一全局相位（浏览器像素实测三带相位差 0.000/0.000/0.010，T2.29-c 代理验证
 * 发现）。相位常数必须与流动时钟不相关——哈希满足（不同创建时间的 chainId
 * 含不同时间戳/序号，哈希雪崩，无周期混叠）。
 */
export function chainCreationClass(chainId: string, fallback: number): number {
  if (chainId.length === 0) return fallback;
  let h = 0;
  for (let i = 0; i < chainId.length; i++) {
    h = (h * 31 + chainId.charCodeAt(i)) % 997;
  }
  return h / 997;
}

export class ChainPointerQueue {
  /** 全体指针（advance 内排序，外部只读）。 */
  readonly arrows: PointerArrow[] = [];
  private nextId = 1;
  /** 是否已播种（tick 编排; 链首次可见时一次）。 */
  private seeded = false;
  /** 上一 Tick 的物品数（注入事件 = 数量增加; 注入重相位/覆盖清除的触发器）。 */
  private itemCount = 0;
  /**
   * 虚拟图案时钟 [0,1): 从链固有序位（chainCreationClass 哈希）起每 Tick +0.025
   * 持续累积——"这条带的图案从创建起以带速流动"的相位轨迹。空带回归的目标是
   * **它**而不是静态序位（静态目标会把指针锁死原地: 每 Tick 前进 0.025 又被拉回
   * = 用户实测全静止）。物品在场时指针被注入重相位对齐物品格网，时钟照走不停;
   * 排空后滑回当前时钟。哈希序位与流动时钟不相关 → 各链相位差不随时间收敛。
   */
  freeRunClass = 0;
  /** 上一 Tick 的链长——延长即覆盖的触发器。 */
  private lastChainLen = 0;

  /**
   * 播种（链首次可见时调用一次）: 在窗口 [−MARGIN, len+MARGIN] 的 classFrac
   * 格网上每格一支（≈len+1 支，与旧连续流同密度）。classFrac = 创建相位。
   */
  seed(chainLen: number, classFrac: number): void {
    this.arrows.length = 0;
    const nMin = Math.ceil(-ARROW_WINDOW_MARGIN - classFrac);
    const nMax = Math.floor(chainLen + ARROW_WINDOW_MARGIN - classFrac);
    for (let n = nMin; n <= nMax; n++) {
      this.arrows.push({ id: this.nextId++, pos: n + classFrac, flowing: true, exitAt: null });
    }
  }

  /**
   * 注入重相位（渲染器在物品数增加的帧调用）: 全体指针按最短模距离平移到
   * itemClassFrac 格网（≡ 新物品 total mod 1）。刚体平移保持间距/顺序，视觉上
   * 是 ≤半格的一次性整体滑动（正常流动 δ=0 不动）。
   */
  rephase(itemClassFrac: number): void {
    if (this.arrows.length === 0) return;
    const cur = ((this.arrows[0]!.pos % 1) + 1) % 1;
    let d = (((itemClassFrac - cur) % 1) + 1) % 1;
    if (d > 0.5 + EPS) d -= 1; // 最短模距离 ∈ (−0.5, 0.5]
    for (const a of this.arrows) a.pos += d;
  }

  /**
   * 渲染器每仿真 Tick 的编排（单一事实来源——诊断脚本直跑本方法，与渲染器
   * 行为零漂移）。顺序: 播种（首见）→ advance（击杀/前进/循环/补充）→
   * 注入格击杀 + 注入重相位（先推进后重相位: 注入 Tick 物品不推进而指针推进，
   * 先重相位会错开一个流动量）→ 空带回归创建相位。
   * @param creationClass 链创建相位（chainCreationClass 输出）
   * @returns 本 Tick 是否发生重相位类整体平移（连续性检测豁免用）
   */
  tick(chainLen: number, items: readonly QueueItemRef[], creationClass: number): boolean {
    if (!this.seeded) {
      this.seed(chainLen, creationClass);
      this.seeded = true;
      this.freeRunClass = creationClass;
      this.lastChainLen = chainLen;
    }
    // 延长即覆盖（用户实测: 创建中逐段落盘的后续段长时间无指针——链增长只能
    // 靠队尾补充从带外以带速流入, 新段要等 ~2s/格）: 链长增加时在新格的**既有
    // 格网**上立即补一支（与前沿恰距 1、与全部实体 ≥1——数量 ≤ 目标恒成立,
    // 间距不变量不破坏）。
    if (chainLen > this.lastChainLen) {
      let anchor: number;
      if (this.arrows.length > 0) {
        anchor = ((this.arrows[0]!.pos % 1) + 1) % 1;
      } else if (items.length > 0) {
        let rm = Infinity;
        for (const it of items) if (it.total < rm) rm = it.total;
        anchor = ((rm % 1) + 1) % 1;
      } else {
        anchor = this.freeRunClass;
      }
      for (let c = this.lastChainLen; c < chainLen; c++) {
        const pos = c + anchor;
        let conflict = false;
        for (const a of this.arrows) {
          if (Math.abs(a.pos - pos) < 1 - EPS) { conflict = true; break; }
        }
        if (!conflict) {
          for (const it of items) {
            if (Math.abs(it.total - pos) < 1 - EPS) { conflict = true; break; }
          }
        }
        if (!conflict) this.arrows.push({ id: this.nextId++, pos, flowing: true, exitAt: null });
      }
      this.lastChainLen = chainLen;
    } else if (chainLen < this.lastChainLen) {
      this.lastChainLen = chainLen;
    }
    this.freeRunClass = (this.freeRunClass + ITEM_PROGRESS_PER_TICK) % 1;
    const had = this.itemCount;
    this.itemCount = items.length;
    this.advance(chainLen, 1, items);
    if (items.length > 0) {
      let rearmost = Infinity;
      for (const it of items) if (it.total < rearmost) rearmost = it.total;
      if (items.length > had && rearmost < Infinity) {
        // 注入（先推进后重相位: 注入 Tick 物品不推进而指针推进，顺序颠倒会错开
        // 一个流动量）。**先重相位、后清除**——重相位把全体 0 刚体对齐到物品
        // 格网: 与物品亚格间距同行（0~0.9，同速永不自解）者归位到 0（被盖住）
        // 或 ±1（合法）; 随后清除**恰在物品身上**的 0（重相位后距离 ≡ 0）。
        // ⚠️ 不得按"注入格"在重相位**前**杀——重相位会把同格但距离 0.9 的 0
        // 归位到物品 +1 的合法槽，先杀 = 取货口前导空格 1-空-0-0-0（用户实测）。
        // ⚠️ 判定必须是"同格重合(距离 ≈ 0)"而非"距离 < 1": 后者在**双格网**下
        //    会误杀——堵塞生长期移动中的物品（class 0.0 格网）与已停稳的堵塞队列
        //    （class 0.5 格网）不在同一格网，重相位只能对齐到其中一个，此时合法
        //    停在另一格网上的 0 与物品距离恰 0.5（<1）→ 被整批删除 = 全亮(α=1)
        //    的指针瞬间消失（用户实测"刚走入物品那格就消失"的主因，2026-09-08）。
        //    重合距离用 1e-6: 重相位后指针必落在物品格网上（间距恒 1 的推论），
        //    距离非 0 即 ≥1，0.5 之类一律是合法槽位。
        this.rephase(((rearmost % 1) + 1) % 1);
        for (let i = this.arrows.length - 1; i >= 0; i--) {
          const a = this.arrows[i]!;
          for (const it of items) {
            if (Math.abs(it.total - a.pos) < 1e-6) {
              this.arrows.splice(i, 1);
              break;
            }
          }
        }
        return true;
      }
      return false;
    }
    // 空带回归**虚拟创建时钟**（持续前进的相位）——带过物品的链被注入重相位
    // 对齐到物品格网，排空后 ≤半格刚体滑回自己此刻的时钟相位（此后与时钟同步
    // 流动，各条空带相位 = 各自创建时刻 + 流逝时间，互不相同）。
    if (this.arrows.length > 0) {
      const cur = ((this.arrows[0]!.pos % 1) + 1) % 1;
      let d = (((this.freeRunClass - cur) % 1) + 1) % 1;
      if (d > 0.5 + EPS) d -= 1;
      if (Math.abs(d) > EPS) {
        this.rephase(this.freeRunClass);
        return true;
      }
    }
    return false;
  }

  /**
   * 推进 steps Tick（tick() 内部用 steps=1; S6/S13/S14 等纯队列单测直调）。
   * 顺序: 击杀 → 前进/钳制（队首优先，锁步冻结）→ 循环 re-entry → 补充。
   * @param items 链上非 entering 物品快照（本 Tick 位置，帧内不变）
   */
  advance(chainLen: number, steps: number, items: readonly QueueItemRef[]): void {
    const move = ITEM_PROGRESS_PER_TICK * steps;
    if (this.arrows.length === 0) return;

    // 最末物品（re-entry 相位锚 + 注入重相位的目标）
    let rearmost = Infinity;
    for (const it of items) if (it.total < rearmost) rearmost = it.total;
    const itemClass = items.length > 0 && rearmost < Infinity
      ? ((rearmost % 1) + 1) % 1
      : null;

    // 1. 击杀（一格只能 0 或 1）: **在流**指针与**流动**物品重合（注入弹入/亚格
    //    间距同行，同速永不自解）→ 立即让位。停止物品不击杀——堵塞虚拟终点
    //    语义（用户 2026-09-07 拍板，推翻"1 停稳后 0 才消失"）: 0 以带速渐变
    //    滑入停止物品（渲染层 fade），到终点余量循环回带首，不停走不消失。
    if (items.length > 0) {
      for (let i = this.arrows.length - 1; i >= 0; i--) {
        const a = this.arrows[i]!;
        if (!a.flowing) continue;
        let dead = false;
        for (const it of items) {
          if (it.stopped) continue;
          if (Math.abs(it.total - a.pos) <= CONTACT_KILL_DIST + EPS) {
            dead = true;
            break;
          }
        }
        if (dead) this.arrows.splice(i, 1);
      }
    }
    if (this.arrows.length === 0) {
      this.replenish(chainLen, items);
      return;
    }

    // 2. 前进 + 钳制（降序=队首优先）。对每支指针:
    //    - 前方 ≥1 格的物品/指针: 正常排队钳制（上限 = 对方位置 − 1，流动中整列
    //      lockstep，堵塞时从停稳物品向后逐格冻结，不后退、不穿人）;
    //    - 前方 <1 格的物品（骑行区——指针被物品碾住或从后方追平）: 上限 = 物品
    //      **当前位置**（跟随同速流动，不得超车——进入接触距离由击杀规则②收尾）;
    //    - 前排已到链尾余量（== 即将循环离场）: 不再钳制后方——否则整列（全员
    //      恰距 1）跟停一 Tick、循环腾位晚一 Tick 释放 = 全场每圈停顿一次
    //      （周期 123/241 ≠ 120/240，实测定位）。mid-tick 的 0.975 间距存在于
    //      移动与循环两 pass 之间，不参与渲染/判定，循环 pass 结束即恢复 ≥1。
    const sorted = this.arrows.slice().sort((a, b) => b.pos - a.pos);
    // 堵塞虚拟终点（用户 2026-09-07 拍板，推翻"堵塞时 0 排队停走"）: 最前方的
    // 停止物品 = 指针的"带尾"——后方 0 不排队不停走，以带速渐变滑入（渲染层
    // fade，与真实带尾同款），越过终点余量即循环回带首。无停止物品 = 真带尾。
    let stoppedFront = Infinity;
    for (const it of items) {
      if (it.stopped && it.total < stoppedFront) stoppedFront = it.total;
    }
    const terminus = Math.min(chainLen, stoppedFront);
    // 出场口（T2.29-f）: 逐支锁定——虚拟终点离散后跳（每件物品停稳跳一格），
    // 渐隐中的指针若被拉到新终点会瞬间硬传送 = "走入物品那格立刻消失/交替
    // 消失"（用户实测）。锁定规则: 进入渐隐区（terminus−余量）→ 锁当前终点，
    // 完整滑入归零才循环; 越过终点的存量（堵塞形成瞬间在裸带上）→ 锁真实
    // 带尾; 疏通（终点前进越过锁定值）→ 解锁跟随。
    const exitOf = (a: PointerArrow): number => {
      if (a.exitAt === null) {
        // 顺序: **先判"越过终点"**（终点后跳把它甩在身后的存量/在途指针）→ 去真实
        // 带尾完成滑出; 再判"渐隐区"→ 锁当前终点。旧代码先判渐隐区且用单侧条件
        // `pos ≥ terminus−余量`, 会把**远在终点之后**的指针也锁到 terminus（一个在
        // 它身后的值）→ 当 Tick 被判越界、立即硬传送回带首 = "刚走到下一格就突然
        // 消失"（用户实测的交替消失的另一半来源）。
        if (a.pos > terminus + ARROW_WINDOW_MARGIN + EPS) {
          a.exitAt = chainLen;
        } else if (a.pos >= terminus - ARROW_WINDOW_MARGIN - EPS) {
          a.exitAt = terminus;
        }
      } else if (terminus > a.exitAt + EPS) {
        a.exitAt = null; // 疏通: 跟随前进后的新终点
      }
      return a.exitAt ?? terminus;
    };
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]!;
      const myExit = exitOf(a);
      const myTailLimit = myExit + ARROW_WINDOW_MARGIN;
      let limit = myTailLimit;
      for (const it of items) {
        if (it.stopped) continue; // 停止物品 = 虚拟终点（出场口承担），不排队
        if (it.total <= a.pos + EPS) continue; // 身下/身后: 不钳（随物品同速流动）
        const l = it.total < a.pos + 1 - EPS ? it.total : it.total - 1;
        if (l < limit) limit = l;
      }
      const prevExit = i > 0 ? exitOf(sorted[i - 1]!) + ARROW_WINDOW_MARGIN : Infinity;
      if (i > 0 && sorted[i - 1]!.pos < prevExit - EPS && sorted[i - 1]!.pos - 1 < limit) {
        limit = sorted[i - 1]!.pos - 1;
      }
      const oldPos = a.pos;
      a.pos = Math.max(a.pos, Math.min(a.pos + move, limit));
      a.flowing = a.pos - oldPos > EPS;
    }

    // 3. 循环（尾→首瞬移，遮罩外不可见; 移动 pass 之后执行——ents/锚定全部用
    //    本 Tick 推进后的新鲜位置，无流动量陈旧）: 到达链尾余量的指针立即入链。
    //    槽位 = 链首带缘侧、≡ 锚定类（有物品 = 当前物品格网【新鲜锚定】; 空带 =
    //    最末其他指针的类【类保持】——空带若用未对齐的 base 本身，会与队尾指针
    //    连生两次 ≥1 冲突下移、落到队尾后约 2 格 = 移动空洞"0-0-0-空"，用户实测;
    //    锚定类后恰落队尾 −1，整列间距恒 1、圈长恰 len+1，连续流无空洞）、与
    //    全部实体 ≥1 格; 被占时整格下移到带外更深处等待（保持格网），随队列
    //    流动 lockstep 跟进、首个钳位处精确对齐（自愈）。base 用**未截断**越界
    //    位置（被 tailLimit 截断会丢越界余量的相位）。
    for (const a of sorted) {
      const myExit = a.exitAt ?? terminus;
      if (a.pos < myExit + ARROW_WINDOW_MARGIN) continue;
      const base = a.pos + move - chainLen;
      let anchor = itemClass;
      if (anchor === null) {
        for (let k = sorted.length - 1; k >= 0; k--) {
          const o = sorted[k]!;
          if (o !== a) {
            anchor = ((o.pos % 1) + 1) % 1;
            break;
          }
        }
      }
      const ents: number[] = [];
      for (const it of items) ents.push(it.total);
      for (const o of sorted) if (o !== a) ents.push(o.pos);
      a.pos = ChainPointerQueue.entrySlot(base, anchor, ents);
      a.flowing = true; // 循环转运中的指针视为在流（覆盖击杀判定用）
      a.exitAt = null; // 循环回带首: 出场口解锁，跟随当前终点
    }

    // 4. 补充: 击杀/循环消耗后维持密度（链长+1）。
    this.replenish(chainLen, items);
  }

  /**
   * re-entry 槽位: ≤ base（链首带缘侧）、≡ itemClass (mod 1)（itemClass null 时
   * = base 自身，空带自循环自保持相位）、与全部实体距离 ≥1 的最大格位。
   * 冲突（链首侧被物品/其他指针占住）时整格下移 = 在带外更深处等待——
   * 下移保持格网，随队列流动 lockstep 跟进，首个钳位处精确对齐（自愈）。
   */
  private static entrySlot(base: number, itemClass: number | null, ents: readonly number[]): number {
    let slot = base;
    if (itemClass !== null) slot -= (((base - itemClass) % 1) + 1) % 1;
    const guard = ents.length + 64;
    for (let i = 0; i < guard; i++) {
      let conflict = false;
      for (const e of ents) {
        if (Math.abs(e - slot) < 1 - EPS) {
          conflict = true;
          break;
        }
      }
      if (!conflict) return slot;
      slot -= 1;
    }
    return slot;
  }

  /**
   * 密度维持: 数量 < 链长+1 时回补（该槽必与全部实体 ≥1 格）。
   *
   * ⚠️ 落点必须与**既有指针同格网**（最末指针 − 1）——旧实现取"最末实体（含物品）
   * − 1"（认为"该槽必在物品格网上"）: 当最末实体是物品、且它的格网 ≠ 指针格网时
   * （堵塞生长期移动中的物品在 class 0.0 格网、已停稳的堵塞队列在 class 0.5 格网，
   * 二者不同格网），补出的指针落在**异格网**上 = 离格指针，直接破坏"0 与 1 同格网"
   * 不变量: 它此后既不在注入清扫的判定格网上（永远杀不掉），又会一路流进带内与
   * 物品重合被击杀 → **带内全亮(α=1)瞬消**（用户实测"走入物品那格立刻消失"，
   * 2026-09-08 根因③）。落点与物品冲突时**整格后退**（保持指针格网，退到带外
   * 等待区，遮罩外不可见）。
   */
  private replenish(chainLen: number, items: readonly QueueItemRef[]): void {
    const target = chainLen + 1;
    while (this.arrows.length < target) {
      let base = Infinity;
      for (const a of this.arrows) if (a.pos < base) base = a.pos;
      if (base === Infinity) {
        // 无指针（全部被击杀）: 从最末物品后方一格起步（此刻物品格网 = 新指针格网）
        for (const it of items) if (it.total < base) base = it.total;
        if (base === Infinity) base = 0; // 空链: 段首 0 起步
      }
      let pos = base - 1;
      const guard = items.length + this.arrows.length + 64;
      for (let i = 0; i < guard; i++) {
        let conflict = false;
        for (const it of items) {
          if (Math.abs(it.total - pos) < 1 - 1e-6) { conflict = true; break; }
        }
        if (!conflict) {
          for (const a of this.arrows) {
            if (Math.abs(a.pos - pos) < 1 - 1e-6) { conflict = true; break; }
          }
        }
        if (!conflict) break;
        pos -= 1;
      }
      this.arrows.push({ id: this.nextId++, pos, flowing: true, exitAt: null });
    }
  }
}
