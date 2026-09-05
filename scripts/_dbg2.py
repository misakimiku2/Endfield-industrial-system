import io
p = 'src/game/systems/belt/BeltSlotClock.ts'
s = io.open(p, encoding='utf-8', newline='').read()
nl = '\r\n' if '\r\n' in s else '\n'

# remove the broken Array.from instrumentation
old = """export function advanceSlots(seeds: Iterable<ChainSlotSeed>): void {
  const dbgArr = Array.from(seeds as Array<ChainSlotSeed>);
  if (globalSlotTicks >= 258 && globalSlotTicks <= 262) {
    for (const sd of dbgArr) {
      if (sd.chainId.endsWith('-A')) console.log(`[seed ${globalSlotTicks}] ${sd.chainId} hasItems=${sd.hasItems} frontTotal=${sd.frontTotal.toFixed(3)} frontDelta=${sd.frontDelta.toFixed(3)}`);
    }
  }
  const seen = new Set<string>();"""
new = """export function advanceSlots(seeds: Iterable<ChainSlotSeed>): void {
  const seen = new Set<string>();"""
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 'remove broken dbg'
s = s.replace(old, new, 1)

# instrument inside the for-of instead (after the state update)
old = """    if (seed.hasItems) {
      // \u7269\u54c1\u5b9a\u4e49\u7f51\u683c: \u76f8\u4f4d = \u961f\u9996 total mod 1\uff08\u5438\u6536\u6362\u4f4d\u56de\u9000\u6574\u6570\u683c \u2192 mod 1 \u8fde\u7eed\uff09
      st.delta = Math.min(Math.max(seed.frontDelta, 0), 0.1);
      st.phase = ((seed.frontTotal % 1) + 1) % 1;
    } else {"""
new = """    if (seed.hasItems) {
      // \u7269\u54c1\u5b9a\u4e49\u7f51\u683c: \u76f8\u4f4d = \u961f\u9996 total mod 1\uff08\u5438\u6536\u6362\u4f4d\u56de\u9000\u6574\u6570\u683c \u2192 mod 1 \u8fde\u7eed\uff09
      st.delta = Math.min(Math.max(seed.frontDelta, 0), 0.1);
      st.phase = ((seed.frontTotal % 1) + 1) % 1;
    } else {"""
assert old in s, 'flow branch anchor'
s = s.replace(old, new, 1)

old = """    } else {
      // \u7a7a\u94fe: \u5e26\u9762\u6309\u672c\u901f\u7ee7\u7eed\u6d41\u52a8
      st.delta = SLOT_FLOW_PER_TICK;
      st.phase = (st.phase + st.delta) % 1;
    }
  }"""
new = """    } else {
      // \u7a7a\u94fe: \u5e26\u9762\u6309\u672c\u901f\u7ee7\u7eed\u6d41\u52a8
      st.delta = SLOT_FLOW_PER_TICK;
      st.phase = (st.phase + st.delta) % 1;
    }
    if (globalSlotTicks >= 40 && globalSlotTicks <= 42 && seed.chainId.endsWith('-A')) {
      console.log(`[seed ${globalSlotTicks}] ${seed.chainId} hasItems=${seed.hasItems} frontTotal=${seed.frontTotal.toFixed(3)} frontDelta=${seed.frontDelta.toFixed(3)} -> phase=${st.phase.toFixed(3)} delta=${st.delta.toFixed(3)}`);
    }
  }"""
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 'insert in-loop dbg'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok')
