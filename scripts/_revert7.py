import io
nl = chr(13)+chr(10)

# 2c. restore the O-group body (the T2.21 fixed-tick version)
a = s.index("console.log('[O1.")
b = s.index("console.log(`\\n\u7ed3\u679c:")
new_o = """console.log('[O1. \u521b\u5efa\u5e8f\u8f6e\u8be2 + \u6210\u529f\u79fb\u961f\u5c3e + \u8d27\u5c3d\u505c\u53d1\u4e0d\u8bef\u6807\u5835\u585e + \u8bbe\u5907\u7ea7\u8282\u62cd]');
{
  const sc = makeScene();
  const f = sc.place(80, 12);
  f.bufferOutput[0] = { itemId: ITEM, count: 2 }; // \u53ea\u6709 2 \u4ef6\u8d27
  const cells = receiveCells(80, 12);
  cells.map(([x, y]) => sc.belt(x, y, 270)); // \u521b\u5efa\u5e8f \u5de6\u2192\u4e2d\u2192\u53f3\uff08x \u9012\u589e = chainId \u65f6\u95f4\u6233\u9012\u589e\uff09
  const [lh, mh, rh] = cells.map(([x, y]) => sc.handleAt(x, y));
  sc.tick(1);
  assertEq(sc.outputPortEvents(), [0], 'O1-a. \u9996\u4ef6\u7ed9\u521b\u5efa\u5e8f\u6700\u524d\u5e26\uff08\u5de6\u53e3\uff09\u2014\u2014\u8bbe\u5907\u7ea7\u8282\u62cd\u6bcf Tick \u81f3\u591a 1 \u4ef6');
  sc.tick(39);
  assertEq(sc.outputPortEvents(), [0], 'O1-b. \u8282\u62cd\u7a97\u53e3\u5185\uff0839 Tick\uff09\u4e0d\u51fa\u8d27\uff08\u76f8\u90bb\u6210\u529f\u51fa\u8d27\u6070\u9694 40 Tick\uff09');
  sc.tick(1);
  assertEq(sc.outputPortEvents(), [0, 1], 'O1-c. \u8282\u62cd\u5230 \u2192 \u7b2c 2 \u4ef6\u8f6e\u5230\u4e2d\u53e3\uff08\u8d27\u5c3d\u505c\u53d1\u4e0d\u8bef\u6807\u5835\u585e\uff09');
  assertEq(f.outputPollQueue, [rh, lh, mh], 'O1-d. \u961f\u5217 [\u53f3,\u5de6,\u4e2d]: \u6210\u529f\u8005\u79fb\u961f\u5c3e\u3001\u672a\u8f6e\u5230\u7684\u53f3\u5e26\u4fdd\u6301\u6d3b\u8dc3\uff08\u69fd\u7a7a\u2260\u5e26\u5835\u585e\uff09');
  f.bufferOutput[0] = { itemId: ITEM, count: 1 }; // \u8865 1 \u4ef6\u8d27
  sc.clearBelts(); // \u6e05\u7a7a\u5e26\u4e0a\u7269\u54c1\uff08\u6a21\u62df\u4e0b\u6e38\u5168\u90e8\u53d6\u8d70\uff0c\u5de6/\u4e2d\u5e26\u5934\u817e\u4f4d\uff09
  sc.tick(40);
  assertEq(sc.outputPortEvents().slice(-1), [2], 'O1-e. \u8865\u8d27\u540e\u4ece\u961f\u5217\u961f\u9996\uff08\u53f3\u5e26\uff09\u7ee7\u7eed\u2014\u2014\u8f6e\u8be2\u6b21\u5e8f\u8bb0\u5fc6\u4fdd\u6301');
}

console.log('[O2. \u65e0\u63a5\u6536\u5e26/\u6ee1\u5e26 \u2192 \u672c Tick \u79fb\u51fa\u8f6e\u8be2\uff1b\u5168\u90e8\u5019\u9009\u6ee1\u5e26 \u2192 \u505c\u53d1\u8d27\u7269\u7559\u69fd]');
{
  const sc = makeScene();
  const f = sc.place(90, 12);
  f.bufferOutput[0] = { itemId: ITEM, count: 5 };
  const cells = receiveCells(90, 12);
  sc.belt(cells[0][0], cells[0][1], 270); // \u53ea\u6709\u5de6\u3001\u53f3\u6709\u63a5\u6536\u5e26\uff0c\u4e2d\u95f4\u60ac\u7a7a
  sc.belt(cells[2][0], cells[2][1], 270);
  sc.tick(80); // \u4e24\u4e2a\u8282\u62cd\u7a97: \u5de6@t1\u3001\u53f3@t41\uff1b\u65ad\u5934\u5e26 1 \u4ef6\u5373\u6ee1
  assertEq(sc.outputPortEvents(), [0, 2], 'O2-a. \u4e2d\u95f4\u65e0\u63a5\u6536\u5e26\u88ab\u8df3\u8fc7\uff0c\u5de6\u53f3\u5404\u51fa 1 \u4ef6\uff08\u4e2d\u95f4\u6c38\u4e0d\u5165\u961f\uff09');
  assertEq(f.bufferOutput[0].count, 3, 'O2-b. \u7b2c\u4e09\u7a97\u8d77\u5de6\u53f3\u5e26\u5747\u6ee1 \u2192 \u505c\u53d1\uff0c\u5176\u4f59 3 \u4ef6\u7559\u5728\u8f93\u51fa\u69fd');
  const cand = new Set(cells.map(([x, y]) => sc.handleAt(x, y)));
  assert(f.outputPollQueue.every((h) => cand.has(h)),
    `O2-c. \u961f\u5217\u53ea\u542b\u5019\u9009\u5e26 handle\uff08\u65e0\u7aef\u53e3\u4e0b\u6807\u6b8b\u7559\uff1b\u5f53\u524d ${JSON.stringify(f.outputPollQueue)}\uff09`);
  sc.clearBelts(); // \u5168\u90e8\u758f\u901a
  sc.tick(40);
  assertEq(sc.outputPortEvents().slice(-1), [0], 'O2-d. \u817e\u4f4d\u5373\u6062\u590d: \u758f\u901a\u540e\u4e0b\u4e00\u8282\u62cd\u51fa\u8d27\uff08\u5de6\u5e26\u91cd\u65b0\u8ffd\u52a0\u961f\u5c3e\u540e\u8f6e\u5230\uff09');
}

console.log('[O3. \u76f8\u4f4d\u7a97\u53e3\u95f8\u95e8\u9000\u5f79: beltPhase \u9ad8\u4f4d\u4e0d\u963b\u62e6\u51fa\u8d27\uff08\u8282\u62cd\u7531\u8bbe\u5907\u8ba1\u65f6\u5668\u627f\u62c5\uff09]');
{
  const sc = makeScene();
  BeltSystem.beltPhase = 0.7; // \u65e7"\u7a97\u53e3\u5916"\u9ad8\u4f4d\u2014\u2014\u95f8\u95e8\u5df2\u79fb\u9664\uff0c\u4e0d\u5e94\u963b\u62e6
  const f = sc.place(100, 12);
  f.bufferOutput[0] = { itemId: ITEM, count: 3 };
  const cells = receiveCells(100, 12);
  sc.belt(cells[1][0], cells[1][1], 270); // \u53ea\u6709\u4e2d\u3001\u53f3\u6709\u63a5\u6536\u5e26
  sc.belt(cells[2][0], cells[2][1], 270);
  sc.tick(1);
  assertEq(sc.outputPortEvents(), [1], 'O3-a. beltPhase=0.7 \u9ad8\u4f4d\u4ecd\u51fa\u8d27\uff08\u9996\u4ef6\u7ed9\u521b\u5efa\u5e8f\u9996\u5e26=\u4e2d\u53e3\uff09');
  sc.tick(39);
  assertEq(sc.outputPortEvents(), [1], 'O3-b. \u8bbe\u5907\u8282\u62cd\u7a97\u53e3\u5185\u4e0d\u518d\u51fa\uff08\u4e0e beltPhase \u65e0\u5173\uff09');
  sc.tick(1);
  assertEq(sc.outputPortEvents(), [1, 2], 'O3-c. \u7b2c 40 Tick \u8282\u62cd\u5230 \u2192 \u7b2c 2 \u4ef6\u8f6e\u5230\u53f3\u53e3');
}

console.log('[O4. \u5835\u585e\u5e26\u6062\u590d \u2192 \u91cd\u65b0\u5165\u8f6e\u8be2\u4e14\u6392\u5728\u65e2\u6709\u6d3b\u8dc3\u5e26\u4e4b\u540e\uff08\u8ffd\u52a0\u961f\u5c3e\u8bed\u4e49\uff09]');
{
  const sc = makeScene();
  const f = sc.place(120, 12);
  f.bufferOutput[0] = { itemId: ITEM, count: 4 };
  const c = receiveCells(120, 12);
  const bLeft = sc.belt(c[0][0], c[0][1], 270, [[ITEM, 0.5]]); // \u5de6: \u9884\u7f6e\u6ee1\u5e26\uff08\u5835\u585e\uff09
  sc.belt(c[1][0], c[1][1], 270);                              // \u4e2d: \u7a7a
  sc.belt(c[2][0], c[2][1], 270);                              // \u53f3: \u7a7a
  sc.tick(1);
  assertEq(sc.outputPortEvents(), [1], 'O4-a. \u961f\u9996\u5de6\u5e26\u6ee1 \u2192 \u8df3\u8fc7\uff0c\u4e2d\u5e26\u51fa\u8d27\uff08\u8d70\u8bbf\u7ee7\u7eed\u627e\u53ef\u5199\u5e26\uff09');
  sc.tick(40);
  assertEq(sc.outputPortEvents(), [1, 2], 'O4-b. \u4e0b\u4e00\u8282\u62cd\u8f6e\u5230\u53f3\u5e26\uff08\u5de6\u5e26\u79fb\u51fa\u540e\u7531\u540c\u6b65\u8ffd\u52a0\u961f\u5c3e\u7b49\u5f85\u6062\u590d\uff09');
  bLeft.items.length = 0; // \u758f\u901a\u5de6\u5e26\uff08\u6a21\u62df\u4e0b\u6e38\u53d6\u8d70\uff09
  sc.tick(40);
  // \u672c\u7a97\u4e2d\u5e26\u6ee1\u5e26\u79fb\u51fa\u3001\u8d70\u8bbf\u7ee7\u7eed\uff1b\u5de6\u5e26\u6062\u590d\u540e\u6309"\u540c\u6b65\u8ffd\u52a0\u961f\u5c3e"\u7684\u4f4d\u7f6e\u8f6e\u5230 \u2192 \u6392\u5728\u53f3\u5e26\u4e4b\u540e\u51fa\u8d27
  assertEq(sc.outputPortEvents(), [1, 2, 0], 'O4-c. \u6062\u590d\u51fa\u8d27\u5e8f \u4e2d\u2192\u53f3\u2192\u5de6: \u6062\u590d\u5e26\u6392\u5728\u65e2\u6709\u6d3b\u8dc3\u5e26\u4e4b\u540e\uff08\u8ffd\u52a0\u961f\u5c3e\uff09');
}

"""
s = s[:a] + new_o.replace('\n', nl) + s[b:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok verify-t210')

# ── verify-t27-output-port.ts ──
p = 'scripts/verify-t27-output-port.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = """// T2.23: \u51fa\u8d27\u65f6\u523b = \u94fe\u9996\u69fd\u4f4d\u8fb9\u754c\uff08\u9996\u4ef6\u5728\u672c\u573a\u666f\u9996\u4e2a\u8fb9\u754c Tick\uff0c\u226440\uff09\uff0c\u56fa\u5b9a tick \u65ad\u8a00\u6539\u4e3a\u4e8b\u4ef6\u5f0f
let w12 = 0;
while (fD.bufferOutput[0].count === 5 && w12 < 100) { tick(1); w12++; }
assert(w12 < 100, `12a. \u9996\u4ef6\u5728\u69fd\u4f4d\u8fb9\u754c\u7ed9\u51fa\uff08${w12} tick\uff0cbeltPhase \u9ad8\u4f4d\u4e0d\u963b\u62e6\uff09`);
assertEq(fD.bufferOutput[0].count, 4, '12a2. \u8bbe\u5907\u7ea7\u8282\u62cd: \u9996\u4ef6\u4e00\u6b21\u4e00\u4ef6\uff085\u21924\uff09');
tick(39);
assertEq(fD.bufferOutput[0].count, 4, '12b. \u8282\u62cd\u7a97\u53e3\u5185\uff08+39 Tick\uff09\u4e0d\u518d\u51fa\u8d27');
tick(1);
assertEq(fD.bufferOutput[0].count, 3, '12c. \u7b2c 40 Tick \u8282\u62cd\u5230 \u2192 \u51fa\u7b2c 2 \u4ef6\uff084\u21923\uff09');
assertEq(outPorts12().slice(-2), [0, 1], '12d. \u8f6e\u8be2\u6309\u521b\u5efa\u5e8f: \u7b2c 1 \u4ef6\u7ed9\u5de6\u53e3\u3001\u7b2c 2 \u4ef6\u8f6e\u5230\u4e2d\u53e3');"""
new = """tick(1);
assertEq(fD.bufferOutput[0].count, 4, '12a. \u8bbe\u5907\u7ea7\u8282\u62cd: \u9996\u4ef6\u7acb\u5373\u51fa\uff085\u21924\uff09\uff0c\u4f59 2 \u4ef6\u672c\u8282\u62cd\u5185\u4e0d\u518d\u51fa');
tick(39);
assertEq(fD.bufferOutput[0].count, 4, '12b. \u8282\u62cd\u7a97\u53e3\u5185\uff08+39 Tick\uff0cbeltPhase \u9ad8\u4f4d\uff09\u4e0d\u518d\u51fa\u8d27');
tick(1);
assertEq(fD.bufferOutput[0].count, 3, '12c. \u7b2c 40 Tick \u8282\u62cd\u5230 \u2192 \u51fa\u7b2c 2 \u4ef6\uff084\u21923\uff09');
assertEq(outPorts12().slice(-2), [0, 1], '12d. \u8f6e\u8be2\u6309\u521b\u5efa\u5e8f: \u7b2c 1 \u4ef6\u7ed9\u5de6\u53e3\u3001\u7b2c 2 \u4ef6\u8f6e\u5230\u4e2d\u53e3');"""
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 't27 12-group'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok verify-t27')
