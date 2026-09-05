import io

# 1) BeltSlotClock: maxDelta -> frontDelta
p = 'src/game/systems/belt/BeltSlotClock.ts'
s = io.open(p, encoding='utf-8', newline='').read()
nl = '\r\n' if '\r\n' in s else '\n'
old = """  /** 链上有物品（含 entering）。 */
  hasItems: boolean;
  /** 本 Tick 物品最大位移（BeltItem.delta 的链内最大值；停走=0）。 */
  maxDelta: number;"""
new = """  /** 链上有物品（含 entering）。 */
  hasItems: boolean;
  /** **队首物品**（total 最大者）本 Tick 的位移——delta 必须与相位锚（队首）同源:
   *  若取"任意物品最大位移"，队首冻结而后方物品向其压缩时 delta=0.025≠相位增量 0，
   *  渲染相位每 Tick 回弹 → 箭头抖动（T2.23 实测修正）。停走=0。 */
  frontDelta: number;"""
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 'clock seed iface'
s = s.replace(old, new, 1)
old = """      st.delta = Math.min(Math.max(seed.maxDelta, 0), 0.1);"""
new = """      st.delta = Math.min(Math.max(seed.frontDelta, 0), 0.1);"""
assert old in s, 'clock delta use'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok clock')

# 2) BeltSystem: track frontDelta
p = 'src/game/systems/BeltSystem.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = """      let seed = slotSeeds.get(seg.chainId);
      if (seed === undefined) {
        seed = { chainId: seg.chainId, hasItems: false, maxDelta: 0, frontTotal: 0 };
        slotSeeds.set(seg.chainId, seed);
      }
      for (const it of seg.items ?? []) {
        seed.hasItems = true;
        if (it.delta > seed.maxDelta) seed.maxDelta = it.delta;
        const total = idx + it.progress;
        if (total > seed.frontTotal) seed.frontTotal = total;
      }"""
new = """      let seed = slotSeeds.get(seg.chainId);
      if (seed === undefined) {
        seed = { chainId: seg.chainId, hasItems: false, frontDelta: 0, frontTotal: 0 };
        slotSeeds.set(seg.chainId, seed);
      }
      for (const it of seg.items ?? []) {
        seed.hasItems = true;
        const total = idx + it.progress;
        if (total > seed.frontTotal) {
          seed.frontTotal = total;
          seed.frontDelta = it.delta; // delta 与相位锚同源: 队首物品自身位移
        }
      }"""
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 'BeltSystem collect'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok BeltSystem')

# 3) diagnostic: segsOf keeps seg; guard extend; single-alpha detector
p = 'scripts/diagnose-pointer-flicker.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = """  const segsOf = (): Array<{ handle: EntityHandle; chainId: string; segIdx: number; gx: number; gy: number }> =>
    world.query('BeltSegmentComp', 'Position').map((h) => {
      const seg = world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp')!;
      const pos = world.getComponent<{ x: number; y: number }>(h, 'Position')!;
      return {
        handle: h, chainId: seg.chainId, segIdx: seg.segmentIndex ?? 0,
        gx: Math.round(pos.x / CELL_SIZE), gy: Math.round(pos.y / CELL_SIZE),
      };
    });"""
new = """  const segsOf = (): Array<{ handle: EntityHandle; chainId: string; segIdx: number; gx: number; gy: number; seg: BeltSegmentComp }> =>
    world.query('BeltSegmentComp', 'Position').map((h) => {
      const seg = world.getComponent<BeltSegmentComp>(h, 'BeltSegmentComp')!;
      const pos = world.getComponent<{ x: number; y: number }>(h, 'Position')!;
      return {
        handle: h, chainId: seg.chainId, segIdx: seg.segmentIndex ?? 0,
        gx: Math.round(pos.x / CELL_SIZE), gy: Math.round(pos.y / CELL_SIZE), seg,
      };
    });"""
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 'diag segsOf'
s = s.replace(old, new, 1)

old = """    if (t === opts.extendAt) {
      const bSegs = segs.filter((s) => s.chainId === bId).sort((p, q) => p.segIdx - q.segIdx);
      const oldTail = bSegs[bSegs.length - 1]!;
      oldTail.seg.isTail = false;
      for (let i = 0; i < opts.extendLen; i++) {
        const h = world.createEntity();
        world.addComponent(h, 'Position', { x: 6 * CELL_SIZE, y: (oldTail.gy - 1 - i) * CELL_SIZE });
        world.addComponent(h, 'BeltSegmentComp', {
          chainId: bId, direction: 270, isCorner: false, isTail: i === opts.extendLen - 1,
          segmentIndex: oldTail.segIdx + 1 + i, phaseOffset: 0, items: [], blocked: false,
        } as BeltSegmentComp);
      }
      segs = segsOf();
      console.log(`  [tick ${t}] \u5ef6\u957f B: \u539f\u5c3e(${oldTail.gx},${oldTail.gy}) isTail\u2192false\uff0c\u65b0\u589e ${opts.extendLen} \u6bb5`);
    }"""
new = """    if (t === opts.extendAt) {
      const bSegs = segs.filter((s) => s.chainId === bId).sort((p, q) => p.segIdx - q.segIdx);
      const oldTail = bSegs[bSegs.length - 1];
      if (oldTail !== undefined) {
        oldTail.seg.isTail = false;
        for (let i = 0; i < opts.extendLen; i++) {
          const h = world.createEntity();
          world.addComponent(h, 'Position', { x: 6 * CELL_SIZE, y: (oldTail.gy - 1 - i) * CELL_SIZE });
          world.addComponent(h, 'BeltSegmentComp', {
            chainId: bId, direction: 270, isCorner: false, isTail: i === opts.extendLen - 1,
            segmentIndex: oldTail.segIdx + 1 + i, phaseOffset: 0, items: [], blocked: false,
          } as BeltSegmentComp);
        }
        console.log(`  [tick ${t}] \u5ef6\u957f B: \u539f\u5c3e(${oldTail.gx},${oldTail.gy}) isTail\u2192false\uff0c\u65b0\u589e ${opts.extendLen} \u6bb5`);
      }
    }"""
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 'diag extend'
s = s.replace(old, new, 1)

old = """  for (const alpha of [0.25, 0.6, 0.95] as const) {
    const globalPhase = BeltSystem.beltPhase + alpha * 0.025;
    const sampleFlow = prevGlobalRef.v === null
      ? 0 : ((globalPhase - prevGlobalRef.v) % 1 + 1) % 1;
    prevGlobalRef.v = globalPhase;
    for (const s of segs) {
      const st = renderSlot(s.chainId);
      const base = st ? st.prevPhase + alpha * st.delta : 0;
      const phase = (((base - s.segIdx) % 1) + 1) % 1;
      const prev = prevState.get(`${s.gx},${s.gy}`);
      if (prev !== undefined) {
        const adv = ((phase - prev) % 1 + 1) % 1;
        const limit = sampleFlow * 1.15 + 0.002;
        if (adv > limit && adv < 1 - limit) {
          console.log(`  [tick ${t}] (${s.gx},${s.gy}) ${s.chainId.slice(-1)}\u5e26 seg${s.segIdx} \u76f8\u4f4d ${prev.toFixed(3)}\u2192${phase.toFixed(3)} \u524d\u8fdb${adv.toFixed(3)} > \u754c${limit.toFixed(3)} \u3010\u8df3\u53d8\u3011`);
          jumpTotal++;
        }
      }
      prevState.set(`${s.gx},${s.gy}`, phase);
    }
  }"""
new = """  // \u5355 alpha \u91c7\u6837: \u6821\u9a8c Tick \u7ea7\u76f8\u4f4d\u8fde\u7eed\u6027\uff08\u6d41\u52a8 +0.025 / \u505c\u8d70 0\uff09\u3002\u8de8 alpha \u6bd4\u8f83\u5bf9
  // \u91c7\u6837\u76f8\u4f4d\u8fc7\u4e8e\u654f\u611f\uff08\u5e27\u5185\u63d2\u503c\u4e0e Tick \u589e\u91cf\u6df7\u53e0\uff0c\u4ea7\u751f\u5047\u9633\u6027\uff09\u3002
  const alpha = 0.5;
  const globalPhase = BeltSystem.beltPhase + alpha * 0.025;
  const sampleFlow = prevGlobalRef.v === null
    ? 0 : ((globalPhase - prevGlobalRef.v) % 1 + 1) % 1;
  prevGlobalRef.v = globalPhase;
  for (const s of segs) {
    const st = renderSlot(s.chainId);
    const base = st ? st.prevPhase + alpha * st.delta : 0;
    const phase = (((base - s.segIdx) % 1) + 1) % 1;
    const prev = prevState.get(`${s.gx},${s.gy}`);
    if (prev !== undefined) {
      const adv = ((phase - prev) % 1 + 1) % 1;
      const limit = sampleFlow * 1.15 + 0.002;
      if (adv > limit && adv < 1 - limit) {
        console.log(`  [tick ${t}] (${s.gx},${s.gy}) ${s.chainId.slice(-1)}\u5e26 seg${s.segIdx} \u76f8\u4f4d ${prev.toFixed(3)}\u2192${phase.toFixed(3)} \u524d\u8fdb${adv.toFixed(3)} > \u754c${limit.toFixed(3)} \u3010\u8df3\u53d8\u3011`);
        jumpTotal++;
      }
    }
    prevState.set(`${s.gx},${s.gy}`, phase);
  }"""
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 'diag detector'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok diagnostic')
