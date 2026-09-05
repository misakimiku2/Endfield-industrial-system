import io
p = 'src/game/systems/machine/OutputOps.ts'
s = io.open(p, encoding='utf-8', newline='').read()

# 1) doc block head
old = " * \u8f93\u51fa\u8f6e\u8be2\u5355 Tick \u51b3\u7b56\uff08\u7eaf\u51fd\u6570\uff0cT2.21\u2192T2.23\uff1b\u8bbe\u5907\u7ea7\u8282\u62cd\u8ba1\u65f6\u5668\u7531 MachineSystem \u7ba1\u7406\uff09\u3002"
assert old in s, 'doc head'
new = " * \u8f93\u51fa\u8f6e\u8be2\u5355 Tick \u51b3\u7b56\uff08\u7eaf\u51fd\u6570\uff0cT2.21\uff1b\u8bbe\u5907\u7ea7\u8282\u62cd\u8ba1\u65f6\u5668\u7531 MachineSystem \u7ba1\u7406\uff09\u3002"
s = s.replace(old, new, 1)

# 2) doc body lines (from "先 syncOutputBeltQueue...按 classify 三态处置:" through the @param line)
start = s.index(' * \u5148 syncOutputBeltQueue \u540c\u6b65\u961f\u5217\uff0c\u518d\u4ece\u961f\u5934\u8d70\u8bbf')
end = s.index(' * @param classify \u5e26\u5904\u7f6e\u5224\u5b9a\uff08accept/skip/wait\uff09')
end_line_end = s.index('\n', end)
new_doc = "\n".join([
    " * \u5148 syncOutputBeltQueue \u540c\u6b65\u961f\u5217\uff0c\u518d\u4ece\u961f\u5934\u8d70\u8bbf**\u6700\u591a\u4e00\u8f6e**\uff1a\u961f\u5934\u5e26\u53ef\u5199 \u2192 \u9009\u5b9a",
    " * \u5e76\u79fb\u5230\u961f\u5c3e\uff08\u6210\u529f\u8f6e\u8f6c\uff09\uff1b\u4e0d\u53ef\u5199\uff08\u6ee1\u5e26\u4e00\u683c\u4e00\u7269\u54c1\uff09\u2192 \u79fb\u51fa\u961f\u5217\u672c Tick \u4e0d\u56de\u961f\uff0c",
    " * \u4e0b\u4e00 Tick \u540c\u6b65\u65f6\u6309\u521b\u5efa\u5e8f\u91cd\u65b0\u8ffd\u52a0\u961f\u5c3e \u2248 A8 \u00a74.2\"\u5835\u585e\u79fb\u51fa\u3001\u6062\u590d\u8ffd\u52a0\u961f\u5c3e\"\u3002",
    " * \u8d70\u8bbf\u5728\u9996\u6761\u53ef\u5199\u5e26\u5904\u505c\u6b62\u2014\u2014\u8bbe\u5907\u7ea7\u8282\u62cd\u4e0b\u6bcf Tick \u81f3\u591a\u51fa 1 \u4ef6\uff0c\u5176\u4f59\u5e26\u7559\u7ed9\u4e0b\u4e00\u8282\u62cd",
    " * \uff08\u8fd9\u6b63\u662f N \u6761\u5e26\u5404\u5f97 1/N \u9891\u7387\u3001\u603b\u901f\u7387\u6052\u4e3a 1 \u4ef6/40 Tick \u7684\u673a\u5236\u6838\u5fc3\uff09\u3002",
    " * @param canAccept \u5e26\u662f\u5426\u53ef\u5199\uff08\u6bb5\u7a7a = \u4e00\u683c\u4e00\u7269\u54c1\uff1b\u7531\u8c03\u7528\u65b9\u67e5 BeltSegmentComp\uff09",
])
s = s[:start] + new_doc + s[end_line_end:]

# 3) signature
old = "  classify: (handle: number) => 'accept' | 'skip' | 'wait',"
assert old in s, 'signature'
s = s.replace(old, "  canAccept: (handle: number) => boolean,", 1)

# 4) body
old = """    const verdict = classify(h);
    if (verdict === 'accept') {
      chosen = h;
      q.push(h);
      break;
    }
    if (verdict === 'wait') {
      q.unshift(h); // \u7559\u5728\u961f\u9996\u7b49\u5f85\u69fd\u4f4d\u5bf9\u9f50\uff0c\u5176\u4f59\u5e26\u672c Tick \u4e0d\u8d70\u8bbf
      break;
    }
    // 'skip': \u5df2\u79fb\u51fa\u961f\u5217\uff08\u4e0b\u4e00 Tick \u540c\u6b65\u6309\u521b\u5efa\u5e8f\u91cd\u65b0\u8ffd\u52a0\u961f\u5c3e\uff09"""
new = """    if (canAccept(h)) {
      chosen = h;
      q.push(h);
    }"""
old, new = old.replace('\n', '\n'), new.replace('\n', '\n')
assert old in s, 'body'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok OutputOps')
