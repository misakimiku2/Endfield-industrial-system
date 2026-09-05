import io, os

NL = '\r\n'

# ── OutputOps body（CRLF）──
p = 'src/game/systems/machine/OutputOps.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = "\r\n".join([
    "    const verdict = classify(h);",
    "    if (verdict === 'accept') {",
    "      chosen = h;",
    "      q.push(h);",
    "      break;",
    "    }",
    "    if (verdict === 'wait') {",
    "      q.unshift(h); // \u7559\u5728\u961f\u9996\u7b49\u5f85\u69fd\u4f4d\u5bf9\u9f50\uff0c\u5176\u4f59\u5e26\u672c Tick \u4e0d\u8d70\u8bbf",
    "      break;",
    "    }",
    "    // 'skip': \u5df2\u79fb\u51fa\u961f\u5217\uff08\u4e0b\u4e00 Tick \u540c\u6b65\u6309\u521b\u5efa\u5e8f\u91cd\u65b0\u8ffd\u52a0\u961f\u5c3e\uff09",
])
new = "\r\n".join([
    "    if (canAccept(h)) {",
    "      chosen = h;",
    "      q.push(h);",
    "    }",
])
assert old in s, 'OutputOps body'
s = s.replace(old, new, 1)
old = "  classify: (handle: number) => 'accept' | 'skip' | 'wait',"
assert old in s, 'OutputOps signature'
s = s.replace(old, "  canAccept: (handle: number) => boolean,", 1)
old = " * \u8f93\u51fa\u8f6e\u8be2\u5355 Tick \u51b3\u7b56\uff08\u7eaf\u51fd\u6570\uff0cT2.21\u2192T2.23\uff1b\u8bbe\u5907\u7ea7\u8282\u62cd\u8ba1\u65f6\u5668\u7531 MachineSystem \u7ba1\u7406\uff09\u3002"
assert old in s, 'OutputOps doc head'
s = s.replace(old, " * \u8f93\u51fa\u8f6e\u8be2\u5355 Tick \u51b3\u7b56\uff08\u7eaf\u51fd\u6570\uff0cT2.21\uff1b\u8bbe\u5907\u7ea7\u8282\u62cd\u8ba1\u65f6\u5668\u7531 MachineSystem \u7ba1\u7406\uff09\u3002", 1)
start = s.index(' * \u5148 syncOutputBeltQueue \u540c\u6b65\u961f\u5217\uff0c\u518d\u4ece\u961f\u5934\u8d70\u8bbf')
end = s.index(' * @param classify \u5e26\u5904\u7f6e\u5224\u5b9a\uff08accept/skip/wait\uff09')
end_eol = s.index('\n', end)
new_doc = "\r\n".join([
    " * \u5148 syncOutputBeltQueue \u540c\u6b65\u961f\u5217\uff0c\u518d\u4ece\u961f\u5934\u8d70\u8bbf**\u6700\u591a\u4e00\u8f6e**\uff1a\u961f\u5934\u5e26\u53ef\u5199 \u2192 \u9009\u5b9a",
    " * \u5e76\u79fb\u5230\u961f\u5c3e\uff08\u6210\u529f\u8f6e\u8f6c\uff09\uff1b\u4e0d\u53ef\u5199\uff08\u6ee1\u5e26\u4e00\u683c\u4e00\u7269\u54c1\uff09\u2192 \u79fb\u51fa\u961f\u5217\u672c Tick \u4e0d\u56de\u961f\uff0c",
    " * \u4e0b\u4e00 Tick \u540c\u6b65\u65f6\u6309\u521b\u5efa\u5e8f\u91cd\u65b0\u8ffd\u52a0\u961f\u5c3e \u2248 A8 \u00a74.2\"\u5835\u585e\u79fb\u51fa\u3001\u6062\u590d\u8ffd\u52a0\u961f\u5c3e\"\u3002",
    " * \u8d70\u8bbf\u5728\u9996\u6761\u53ef\u5199\u5e26\u5904\u505c\u6b62\u2014\u2014\u8bbe\u5907\u7ea7\u8282\u62cd\u4e0b\u6bcf Tick \u81f3\u591a\u51fa 1 \u4ef6\uff0c\u5176\u4f59\u5e26\u7559\u7ed9\u4e0b\u4e00\u8282\u62cd",
    " * \uff08\u8fd9\u6b63\u662f N \u6761\u5e26\u5404\u5f97 1/N \u9891\u7387\u3001\u603b\u901f\u7387\u6052\u4e3a 1 \u4ef6/40 Tick \u7684\u673a\u5236\u6838\u5fc3\uff09\u3002",
    " * @param canAccept \u5e26\u662f\u5426\u53ef\u5199\uff08\u6bb5\u7a7a = \u4e00\u683c\u4e00\u7269\u54c1\uff1b\u7531\u8c03\u7528\u65b9\u67e5 BeltSegmentComp\uff09",
])
s = s[:start] + new_doc + s[end_eol:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok OutputOps')

# ── DepotOps ──
p = 'src/game/systems/machine/DepotOps.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = "import { atHeadBoundary } from '../belt/BeltSlotClock.ts';" + NL
assert old in s, 'DepotOps import'
s = s.replace(old, '', 1)
start = s.index(' * T2.23 \u5bf9\u9f50\u95e8\u63a7')
end = s.index(' * @returns \u653e\u51fa\u7684 itemId\uff1bnull = \u6bb5\u4e0a\u5df2\u6709\u7269\u54c1\u3002')
s = s[:start] + s[end:]
old = "  if (!atHeadBoundary(seg.chainId)) return null;" + NL
assert old in s, 'DepotOps gate'
s = s.replace(old, '', 1)
old = "\r\n".join([
    "  // T2.23 \u5bb9\u5dee 1e-6\uff1a0.475+0.025 \u6d6e\u70b9\u4e0b\u6b3a\u65f6\u5438\u6536\u6ede\u540e 1 Tick\uff0c\u540e\u8f66\u591a\u6d41 0.025 \u538b\u7f29\u95f4\u8ddd\uff0c",
    "  // \u961f\u9996\u5207\u6362\u65f6\u69fd\u4f4d\u76f8\u4f4d\u8df3 +0.025\uff08\u6307\u9488\u7f51\u683c\u9519\u4f4d\uff09\u3002",
    "  if (head === null || head.progress < PORT_ENTER_PROGRESS - 1e-6) return null;",
])
new = "  if (head === null || head.progress < PORT_ENTER_PROGRESS) return null;"
assert old in s, 'DepotOps absorb tolerance'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok DepotOps')

# ── IntakeOps ──
p = 'src/game/systems/machine/IntakeOps.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = "\r\n".join([
    "    // T2.23: \u5bb9\u5dee 1e-6 \u2014\u2014 \u6700\u540e\u4e00\u6b65 1.475+0.025 \u6d6e\u70b9\u4e0b\u6b3a 2e-16\uff0c\u65e0\u5bb9\u5dee\u65f6\u7269\u54c1\u5728 1.5 \u95e8\u6ede\u7559 1 Tick\u3001",
    "    // \u540e\u8f66\u7ee7\u7eed\u6d41\u52a8\u538b\u7f29\u95f4\u8ddd 0.025 \u2192 \u79fb\u9664\u65f6\u961f\u9996\u5207\u6362\u76f8\u4f4d\u8df3 +0.05\uff08\u6307\u9488\u95ea\u4f4d\uff09\u3002",
    "    if (it.entering && it.progress >= PORT_RELEASE_PROGRESS - 1e-6) {",
])
new = "    if (it.entering && it.progress >= PORT_RELEASE_PROGRESS) {"
assert old in s, 'IntakeOps release tolerance'
s = s.replace(old, new, 1)
old = "\r\n".join([
    "  // T2.23 \u5bb9\u5dee 1e-6\uff1a0.475+0.025 \u6d6e\u70b9\u4e0b\u6b3a\u65f6\u5438\u6536\u6ede\u540e 1 Tick\uff0c\u540e\u8f66\u591a\u6d41 0.025 \u538b\u7f29\u95f4\u8ddd\uff0c",
    "  // \u961f\u9996\u5207\u6362\u65f6\u69fd\u4f4d\u76f8\u4f4d\u8df3 +0.025\uff08\u6307\u9488\u7f51\u683c\u9519\u4f4d\uff09\u3002",
    "  if (head === null || head.progress < PORT_ENTER_PROGRESS - 1e-6) return null;",
])
new = "  if (head === null || head.progress < PORT_ENTER_PROGRESS) return null;"
assert old in s, 'IntakeOps absorb tolerance'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok IntakeOps')

# ── 删除 T2.23 笔记 ──
f = 'doc/\u5b9e\u73b0\u7b14\u8bb0/T2.23-\u69fd\u4f4d\u65f6\u949f\u4e0e\u51fa\u8d27\u5bf9\u9f50.md'
if os.path.exists(f):
    os.remove(f)
    print('deleted', f)
