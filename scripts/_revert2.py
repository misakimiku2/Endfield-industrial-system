import io, os

# ───────────────────────── 4. BeltSystem.ts：移除槽位时钟接入 ─────────────────────────
p = 'src/game/systems/BeltSystem.ts'
s = io.open(p, encoding='utf-8', newline='').read()
nl = '\r\n' if '\r\n' in s else '\n'
old = "import { advanceSlots, type ChainSlotSeed } from './belt/BeltSlotClock.ts';" + nl
assert old in s, 'BeltSystem import'
s = s.replace(old, '', 1)

start = s.index('    // \u2500\u2500 \u69fd\u4f4d\u65f6\u949f\u63a8\u8fdb (T2.23)')
end = s.index('    advanceSlots(slotSeeds.values());') + len('    advanceSlots(slotSeeds.values());') + len(nl)
s = s[:start] + s[end:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok BeltSystem')

# ───────────────────────── 5. MachineSystem.ts：门控逆补丁 ─────────────────────────
p = 'src/game/systems/MachineSystem.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = "import { atHeadBoundary, isChainStopped } from './belt/BeltSlotClock.ts';" + nl
assert old in s, 'MachineSystem import'
s = s.replace(old, '', 1)

old = """      (h): 'accept' | 'skip' | 'wait' => {
        const c = byHandle.get(h)!;
        if (c.seg.items.length > 0) return 'skip'; // \u6ee1\u5e26\uff08\u4e00\u683c\u4e00\u7269\u54c1\uff09
        if (isChainStopped(c.seg.chainId)) return 'skip'; // \u505c\u8d70\u94fe\u8fb9\u754c\u51bb\u7ed3\uff0c\u4e0d\u53ef\u5bf9\u9f50
        // T2.23 \u5bf9\u9f50\u95e8\u63a7: \u69fd\u4f4d\u8fb9\u754c\u672a\u5230\u94fe\u9996\u683c\u5165\u53e3 \u2192 'wait'\uff08\u7559\u5728\u961f\u9996\u7b49\u5bf9\u9f50\uff0c\u4e0d\u8df3\u8fc7
        // \u2014\u2014\u5426\u5219\u76f8\u4f4d\u4e0e\u53d1\u8d27\u8282\u62cd\u9519\u5f00\u7684\u5e26\u4f1a\u88ab\u6c38\u4e45\u997f\u6b7b\uff09\u3002\u7269\u54c1\u843d\u4f4d\u5bf9\u9f50\u69fd\u4f4d\u540e\uff0c\u5168\u94fe
        // \u7269\u54c1\u95f4\u8ddd\u6052\u4e3a\u6574\u6570\u683c\uff0c\u6307\u9488\u7f51\u683c\u4e0e\u7269\u54c1\u6c38\u8fdc\u5bf9\u9f50\uff08\u89c1 BeltSlotClock \u5934\u6ce8\u91ca\uff09\u3002
        return atHeadBoundary(c.seg.chainId) ? 'accept' : 'wait';
      },"""
new = """      (h) => byHandle.get(h)?.seg.items.length === 0, // \u4e00\u683c\u4e00\u7269\u54c1: \u6bb5\u7a7a\u624d\u53ef\u5199"""
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 'MachineSystem classify'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok MachineSystem')

# ───────────────────────── 6. OutputOps.ts：pollOutputBelt 回到布尔版 ─────────────────────────
p = 'src/game/systems/machine/OutputOps.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = """/**
 * \u8f93\u51fa\u8f6e\u8be2\u5355 Tick \u51b3\u7b56\uff08\u7eaf\u51fd\u6570\uff0cT2.21\u2192T2.23\uff1b\u8bbe\u5907\u7ea7\u8282\u62cd\u8ba1\u65f6\u5668\u7531 MachineSystem \u7ba1\u7406\uff09\u3002
 * \u5148 syncOutputBeltQueue \u540c\u6b65\u961f\u5217\uff0c\u518d\u4ece\u961f\u5934\u8d70\u8bbf**\u6700\u591a\u4e00\u8f6e**\uff0c\u6309 classify \u4e09\u6001\u5904\u7f6e:
 *  - 'accept': \u9996\u6761\u53ef\u5199\u5e26\u2014\u2014\u9009\u5b9a\u5e76\u79fb\u5230\u961f\u5c3e\uff08\u6210\u529f\u8f6e\u8f6c\uff09\uff0c\u8d70\u8bbf\u505c\u6b62\uff08\u8bbe\u5907\u7ea7\u8282\u62cd\u6bcf Tick
 *    \u81f3\u591a 1 \u4ef6\uff0c\u5176\u4f59\u5e26\u7559\u7ed9\u4e0b\u4e00\u8282\u62cd\u2014\u2014N \u6761\u5e26\u5404\u5f97 1/N \u9891\u7387\u3001\u603b\u901f\u7387\u6052\u4e3a 1 \u4ef6/40 Tick\uff09\u3002
 *  - 'skip': \u4e0d\u53ef\u5199\uff08\u6ee1\u5e26\u4e00\u683c\u4e00\u7269\u54c1\uff09\u2014\u2014\u79fb\u51fa\u961f\u5217\u672c Tick \u4e0d\u56de\u961f\uff0c\u4e0b\u4e00 Tick \u540c\u6b65\u65f6
 *    \u6309\u521b\u5efa\u5e8f\u91cd\u65b0\u8ffd\u52a0\u961f\u5c3e \u2248 A8 \u00a74.2"\u5835\u585e\u79fb\u51fa\u3001\u6062\u590d\u8ffd\u52a0\u961f\u5c3e"\u3002
 *  - 'wait': \u69fd\u4f4d\u8fb9\u754c\u672a\u5230\uff08T2.23 \u5bf9\u9f50\u95e8\u63a7\uff09\u2014\u2014**\u7559\u5728\u961f\u9996\u5e76\u505c\u6b62\u8d70\u8bbf**\uff1a\u8f6e\u8be2\u516c\u5e73\u6027
 *    \u8981\u6c42\u7b49\u5f85\u961f\u9996\u5e26\u7684\u8fb9\u754c\u800c\u4e0d\u662f\u8df3\u8fc7\u53bb\u670d\u52a1\u540e\u9762\u7684\u5e26\uff08\u5426\u5219\u961f\u9996\u5e26\u7684\u8fb9\u754c\u76f8\u4f4d\u4e0e
 *    \u53d1\u8d27\u8282\u62cd\u9519\u5f00\u65f6\u4f1a\u88ab\u6c38\u4e45\u997f\u6b7b\uff1a\u5176\u7a97\u53e3\u6c38\u8fdc\u8f6e\u4e0d\u5230\uff09\u3002
 * @param classify \u5e26\u5904\u7f6e\u5224\u5b9a\uff08accept/skip/wait\uff09
 * @returns \u65b0\u961f\u5217 + \u9009\u5b9a\u5e26 handle\uff08null = \u672c Tick \u4e0d\u51fa\u8d27\u3001\u4e0d\u91cd\u7f6e\u8282\u62cd\uff09\u3002
 */
export function pollOutputBelt(
  queue: readonly number[],
  candidates: ReadonlyArray<{ handle: number }>,
  classify: (handle: number) => 'accept' | 'skip' | 'wait',
): { queue: number[]; chosen: number | null } {
  const q = syncOutputBeltQueue(queue, candidates);
  let chosen: number | null = null;
  for (let remaining = q.length; remaining > 0 && chosen === null; remaining--) {
    const h = q.shift()!;
    const verdict = classify(h);
    if (verdict === 'accept') {
      chosen = h;
      q.push(h);
      break;
    }
    if (verdict === 'wait') {
      q.unshift(h); // \u7559\u5728\u961f\u9996\u7b49\u5f85\u69fd\u4f4d\u5bf9\u9f50\uff0c\u5176\u4f59\u5e26\u672c Tick \u4e0d\u8d70\u8bbf
      break;
    }
    // 'skip': \u5df2\u79fb\u51fa\u961f\u5217\uff08\u4e0b\u4e00 Tick \u540c\u6b65\u6309\u521b\u5efa\u5e8f\u91cd\u65b0\u8ffd\u52a0\u961f\u5c3e\uff09
  }
  return { queue: q, chosen };
}"""
new = """/**
 * \u8f93\u51fa\u8f6e\u8be2\u5355 Tick \u51b3\u7b56\uff08\u7eaf\u51fd\u6570\uff0cT2.21\uff1b\u8bbe\u5907\u7ea7\u8282\u62cd\u8ba1\u65f6\u5668\u7531 MachineSystem \u7ba1\u7406\uff09\u3002
 * \u5148 syncOutputBeltQueue \u540c\u6b65\u961f\u5217\uff0c\u518d\u4ece\u961f\u5934\u8d70\u8bbf**\u6700\u591a\u4e00\u8f6e**\uff1a\u961f\u5934\u5e26\u53ef\u5199 \u2192 \u9009\u5b9a
 * \u5e76\u79fb\u5230\u961f\u5c3e\uff08\u6210\u529f\u8f6e\u8f6c\uff09\uff1b\u4e0d\u53ef\u5199\uff08\u6ee1\u5e26\u4e00\u683c\u4e00\u7269\u54c1\uff09\u2192 \u79fb\u51fa\u961f\u5217\u672c Tick \u4e0d\u56de\u961f\uff0c
 * \u4e0b\u4e00 Tick \u540c\u6b65\u65f6\u6309\u521b\u5efa\u5e8f\u91cd\u65b0\u8ffd\u52a0\u961f\u5c3e \u2248 A8 \u00a74.2"\u5835\u585e\u79fb\u51fa\u3001\u6062\u590d\u8ffd\u52a0\u961f\u5c3e"\u3002
 * \u8d70\u8bbf\u5728\u9996\u6761\u53ef\u5199\u5e26\u5904\u505c\u6b62\u2014\u2014\u8bbe\u5907\u7ea7\u8282\u62cd\u4e0b\u6bcf Tick \u81f3\u591a\u51fa 1 \u4ef6\uff0c\u5176\u4f59\u5e26\u7559\u7ed9\u4e0b\u4e00\u8282\u62cd
 * \uff08\u8fd9\u6b63\u662f N \u6761\u5e26\u5404\u5f97 1/N \u9891\u7387\u3001\u603b\u901f\u7387\u6052\u4e3a 1 \u4ef6/40 Tick \u7684\u673a\u5236\u6838\u5fc3\uff09\u3002
 * @param canAccept \u5e26\u662f\u5426\u53ef\u5199\uff08\u6bb5\u7a7a = \u4e00\u683c\u4e00\u7269\u54c1\uff1b\u7531\u8c03\u7528\u65b9\u67e5 BeltSegmentComp\uff09
 * @returns \u65b0\u961f\u5217 + \u9009\u5b9a\u5e26 handle\uff08null = \u65e0\u53ef\u5199\u5e26\uff0c\u672c Tick \u4e0d\u51fa\u8d27\u3001\u4e0d\u91cd\u7f6e\u8282\u62cd\uff09\u3002
 */
export function pollOutputBelt(
  queue: readonly number[],
  candidates: ReadonlyArray<{ handle: number }>,
  canAccept: (handle: number) => boolean,
): { queue: number[]; chosen: number | null } {
  const q = syncOutputBeltQueue(queue, candidates);
  let chosen: number | null = null;
  for (let remaining = q.length; remaining > 0 && chosen === null; remaining--) {
    const h = q.shift()!;
    if (canAccept(h)) {
      chosen = h;
      q.push(h);
    }
  }
  return { queue: q, chosen };
}"""
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 'OutputOps pollOutputBelt'
s = s.replace(old, new, 1)

# header: remove the T2.23 gate line from the file header comment
old = """// \u8f6e\u8be2 (T2.21\uff0c2026-09-05 \u7528\u6237\u91cd\u5b9a\u8bed\u4e49): \u8f6e\u8be2\u5355\u5143 = **\u63a5\u6536\u4f20\u9001\u5e26**\uff08\u6309\u521b\u5efa\u987a\u5e8f\uff0c
//   \u4e0d\u518d\u6309\u7aef\u53e3\u5b9a\u4e49\u5e8f\uff09\uff1b\u8282\u6d41 = **\u8bbe\u5907\u7ea7**\u6bcf 40 Tick(=\u4e00\u683c\u4f20\u9001\u5e26\u65f6\u957f) \u81f3\u591a\u6210\u529f 1 \u4ef6
//   \u2014\u2014\u591a\u5e26\u53ea\u5206\u644a\u4e0d\u63d0\u901f\uff081 \u6761\u5e26 1-1-1 / 2 \u6761\u5404 1-0-1 / 3 \u6761\u5404 1-0-0\uff09\u3002\u961f\u5217\u8f6e\u8f6c/
//   \u540c\u6b65/\u8d70\u8bbf\u51b3\u7b56\u5728 pollOutputBelt\uff08\u672c\u6a21\u5757\uff09\uff0c\u8282\u62cd\u8ba1\u65f6\u5668\u7531 MachineSystem \u7ba1\u7406\u3002"""
new = """// \u8f6e\u8be2 (T2.21\uff0c2026-09-05 \u7528\u6237\u91cd\u5b9a\u8bed\u4e49): \u8f6e\u8be2\u5355\u5143 = **\u63a5\u6536\u4f20\u9001\u5e26**\uff08\u6309\u521b\u5efa\u987a\u5e8f\uff0c
//   \u4e0d\u518d\u6309\u7aef\u53e3\u5b9a\u4e49\u5e8f\uff09\uff1b\u8282\u6d41 = **\u8bbe\u5907\u7ea7**\u6bcf 40 Tick(=\u4e00\u683c\u4f20\u9001\u5e26\u65f6\u957f) \u81f3\u591a\u6210\u529f 1 \u4ef6
//   \u2014\u2014\u591a\u5e26\u53ea\u5206\u644a\u4e0d\u63d0\u901f\uff081 \u6761\u5e26 1-1-1 / 2 \u6761\u5404 1-0-1 / 3 \u6761\u5404 1-0-0\uff09\u3002\u961f\u5217\u8f6e\u8f6c/
//   \u540c\u6b65/\u8d70\u8bbf\u51b3\u7b56\u5728 pollOutputBelt\uff08\u672c\u6a21\u5757\uff09\uff0c\u8282\u62cd\u8ba1\u65f6\u5668\u7531 MachineSystem \u7ba1\u7406\u3002"""
# (identical \u2014 the header line was unchanged by T2.23 in OutputOps; skip)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok OutputOps')

# ───────────────────────── 7. DepotOps.ts：门控 + 容差逆补丁 ─────────────────────────
p = 'src/game/systems/machine/DepotOps.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = "import { atHeadBoundary } from '../belt/BeltSlotClock.ts';" + nl
assert old in s, 'DepotOps import'
s = s.replace(old, '', 1)

old = """ * T2.23 \u5bf9\u9f50\u95e8\u63a7: \u69fd\u4f4d\u8fb9\u754c\u672a\u5230\u94fe\u9996\u683c\u5165\u53e3\u65f6\u4e0d\u51fa\u8d27\uff08\u8c03\u7528\u65b9\u4e0b Tick \u91cd\u8bd5\uff09\u2014\u2014
 * \u53d6\u8d27\u53e3\u7269\u54c1\u4e0e\u751f\u4ea7\u8bbe\u5907\u7269\u54c1\u540c\u6837\u5fc5\u987b\u843d\u5728\u69fd\u4f4d\u7f51\u683c\u4e0a\uff0c\u5426\u5219\u6307\u9488\u7f51\u683c\u4e0e\u7269\u54c1\u9519\u4f4d\u3002
 * @returns \u653e\u51fa\u7684 itemId\uff1bnull = \u6bb5\u4e0a\u5df2\u6709\u7269\u54c1 / \u69fd\u4f4d\u8fb9\u754c\u672a\u5230\u3002
 */
export function emitSourceToBelt(
  seg: BeltSegmentComp,
  itemId: string = DEPOT_SOURCE_ITEM,
): string | null {
  const items = seg.items ?? (seg.items = []);
  if (items.length > 0) return null;
  if (!atHeadBoundary(seg.chainId)) return null;
  items.push({ itemId, progress: 0, delta: 0 });
  return itemId;
}"""
new = """ * @returns \u653e\u51fa\u7684 itemId\uff1bnull = \u6bb5\u4e0a\u5df2\u6709\u7269\u54c1\u3002
 */
export function emitSourceToBelt(
  seg: BeltSegmentComp,
  itemId: string = DEPOT_SOURCE_ITEM,
): string | null {
  const items = seg.items ?? (seg.items = []);
  if (items.length > 0) return null;
  items.push({ itemId, progress: 0, delta: 0 });
  return itemId;
}"""
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 'DepotOps gate'
s = s.replace(old, new, 1)

old = """  // T2.23 \u5bb9\u5dee 1e-6\uff1a0.475+0.025 \u6d6e\u70b9\u4e0b\u6b3a\u65f6\u5438\u6536\u6ede\u540e 1 Tick\uff0c\u540e\u8f66\u591a\u6d41 0.025 \u538b\u7f29\u95f4\u8ddd\uff0c
  // \u961f\u9996\u5207\u6362\u65f6\u69fd\u4f4d\u76f8\u4f4d\u8df3 +0.025\uff08\u6307\u9488\u7f51\u683c\u9519\u4f4d\uff09\u3002
  if (head === null || head.progress < PORT_ENTER_PROGRESS - 1e-6) return null;"""
new = "  if (head === null || head.progress < PORT_ENTER_PROGRESS) return null;"
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 'DepotOps absorb tolerance'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok DepotOps')

# ───────────────────────── 8. IntakeOps.ts：容差逆补丁 ─────────────────────────
p = 'src/game/systems/machine/IntakeOps.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = """    // T2.23: \u5bb9\u5dee 1e-6 \u2014\u2014 \u6700\u540e\u4e00\u6b65 1.475+0.025 \u6d6e\u70b9\u4e0b\u6b3a 2e-16\uff0c\u65e0\u5bb9\u5dee\u65f6\u7269\u54c1\u5728 1.5 \u95e8\u6ede\u7559 1 Tick\u3001
    // \u540e\u8f66\u7ee7\u7eed\u6d41\u52a8\u538b\u7f29\u95f4\u8ddd 0.025 \u2192 \u79fb\u9664\u65f6\u961f\u9996\u5207\u6362\u76f8\u4f4d\u8df3 +0.05\uff08\u6307\u9488\u95ea\u4f4d\uff09\u3002
    if (it.entering && it.progress >= PORT_RELEASE_PROGRESS - 1e-6) {"""
new = """    if (it.entering && it.progress >= PORT_RELEASE_PROGRESS) {"""
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 'IntakeOps release tolerance'
s = s.replace(old, new, 1)

old = """  // T2.23 \u5bb9\u5dee 1e-6\uff1a0.475+0.025 \u6d6e\u70b9\u4e0b\u6b3a\u65f6\u5438\u6536\u6ede\u540e 1 Tick\uff0c\u540e\u8f66\u591a\u6d41 0.025 \u538b\u7f29\u95f4\u8ddd\uff0c
  // \u961f\u9996\u5207\u6362\u65f6\u69fd\u4f4d\u76f8\u4f4d\u8df3 +0.025\uff08\u6307\u9488\u7f51\u683c\u9519\u4f4d\uff09\u3002
  if (head === null || head.progress < PORT_ENTER_PROGRESS - 1e-6) return null;"""
new = "  if (head === null || head.progress < PORT_ENTER_PROGRESS) return null;"
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 'IntakeOps absorb tolerance'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok IntakeOps')

# ───────────────────────── 9. 删除 T2.23 笔记 ─────────────────────────
f = 'doc/\u5b9e\u73b0\u7b14\u8bb0/T2.23-\u69fd\u4f4d\u65f6\u949f\u4e0e\u51fa\u8d27\u5bf9\u9f50.md'
if os.path.exists(f):
    os.remove(f)
    print('deleted', f)
