import io

# 1) IntakeOps: release tolerance (float undershoot at PORT_ENTER_DONE)
p = 'src/game/systems/machine/IntakeOps.ts'
s = io.open(p, encoding='utf-8', newline='').read()
nl = '\r\n' if '\r\n' in s else '\n'
old = "    if (it.entering && it.progress >= PORT_RELEASE_PROGRESS) {"
new = ("    // T2.23: \u5bb9\u5dee 1e-6 \u2014\u2014 \u6700\u540e\u4e00\u6b65 1.475+0.025 \u6d6e\u70b9\u4e0b\u6b3a 2e-16\uff0c\u65e0\u5bb9\u5dee\u65f6\u7269\u54c1\u5728 1.5 \u95e8\u6ede\u7559 1 Tick\u3001" + nl +
       "    // \u540e\u8f66\u7ee7\u7eed\u6d41\u52a8\u538b\u7f29\u95f4\u8ddd 0.025 \u2192 \u79fb\u9664\u65f6\u961f\u9996\u5207\u6362\u76f8\u4f4d\u8df3 +0.05\uff08\u6307\u9488\u95ea\u4f4d\uff09\u3002" + nl +
    "    if (it.entering && it.progress >= PORT_RELEASE_PROGRESS - 1e-6) {")
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 'release condition'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok IntakeOps')

# 2) BeltSystem: remove collect dbg
p = 'src/game/systems/BeltSystem.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = """    this.slotDbgTick = (this.slotDbgTick ?? 0) + 1;
    if (this.slotDbgTick >= 259 && this.slotDbgTick <= 262) {
      for (const seed of slotSeeds.values()) {
        if (seed.chainId.endsWith('-A')) {
          console.log(`[collect ${this.slotDbgTick}] ${seed.chainId} hasItems=${seed.hasItems} frontTotal=${seed.frontTotal.toFixed(3)} frontDelta=${seed.frontDelta.toFixed(3)}`);
        }
      }
    }
    advanceSlots(slotSeeds.values());"""
new = "    advanceSlots(slotSeeds.values());"
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 'remove collect dbg'
s = s.replace(old, new, 1)
old2 = "  private slotDbgTick: number | undefined;" + nl
assert old2 in s, 'remove field'
s = s.replace(old2, '', 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok BeltSystem')

# 3) runScenario dbg removal
p = 'scripts/diagnose-pointer-flicker.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = """    if (t >= 260 && t <= 263 && opts.extendAt > 1 << 29) {
      for (const s of segs) {
        if (s.chainId.slice(-1) !== 'A') continue;
        const st = renderSlot(s.chainId)!;
        const items = (s.seg.items ?? []).map((it) => `${it.progress.toFixed(3)}/d${it.delta.toFixed(3)}${it.entering ? 'E' : ''}`).join(' ') || '(empty)';
        console.log(`  [dbg ${t}] ${s.chainId} seg${s.segIdx} @(${s.gx},${s.gy}) items: ${items} | phase=${st.phase.toFixed(3)} prev=${st.prevPhase.toFixed(3)} delta=${st.delta.toFixed(3)}`);
      }
    }
"""
old, new = old.replace('\n', nl), '' .replace('\n', nl)
assert old in s, 'remove scenario dbg'
s = s.replace(old, new, 1)

# 4) S5/S6: null-guard + warm-up update before first phaseOf
old = """  let accS = 0, accL = 0;
  let prevS = phaseOf(shortId), prevL = phaseOf(longId);"""
new = """  let accS = 0, accL = 0;
  beltSys.update(world, 50); // \u9884\u70ed: \u8ba9\u65f6\u949f\u4e3a\u4e24\u6761\u94fe\u64ad\u79cd\uff08\u9996\u6b21 phaseOf \u524d\u5fc5\u987b\u5df2\u5efa\u6863\uff09
  let prevS = phaseOf(shortId), prevL = phaseOf(longId);"""
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 'S6 warmup'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok diagnostic')
