import io

# 1) BeltSystem: span-delete the dbg block (from the slotDbgTick line to advanceSlots)
p = 'src/game/systems/BeltSystem.ts'
s = io.open(p, encoding='utf-8', newline='').read()
nl = '\r\n' if '\r\n' in s else '\n'
start = s.index('    this.slotDbgTick = ')
end = s.index('    advanceSlots(slotSeeds.values());')
s = s[:start] + s[end:]
old2 = '  private slotDbgTick: number | undefined;' + nl
assert old2 in s, 'field'
s = s.replace(old2, '', 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok BeltSystem')

# 2) diagnostic: remove the scenario dbg block
p = 'scripts/diagnose-pointer-flicker.ts'
s = io.open(p, encoding='utf-8', newline='').read()
start = s.index('    if (t >= 260 && t <= 263 && opts.extendAt > 1 << 29) {')
end = s.index('    sampleAndCheck(segs, t, prevGlobalRef);')
s = s[:start] + s[end:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok diagnostic')

# 3) S6 warm-up
p = 'scripts/diagnose-pointer-flicker.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = """  let accS = 0, accL = 0;
  let prevS = phaseOf(shortId), prevL = phaseOf(longId);"""
new = """  let accS = 0, accL = 0;
  beltSys.update(world, 50); // \u9884\u70ed\uff1a\u8ba9\u65f6\u949f\u4e3a\u4e24\u6761\u94fe\u64ad\u79cd\uff08\u9996\u6b21 phaseOf \u524d\u5fc5\u987b\u5df2\u5efa\u6863\uff09
  let prevS = phaseOf(shortId), prevL = phaseOf(longId);"""
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 'S6 warmup'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok S6')
