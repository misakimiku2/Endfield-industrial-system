import io, os

# ── 0. 清理残留补丁脚本 ──
for f in ['scripts/_revert5.py']:
    if os.path.exists(f):
        os.remove(f)
        print('removed', f)

# ── 1. test-output-polling.ts：回到布尔 canAccept 装置 ──
p = 'scripts/test-output-polling.ts'
s = io.open(p, encoding='utf-8', newline='').read()
nl = '\r\n' if '\r\n' in s else '\n'

old = """// 传送带物理按既有 BeltSystem 模型最小化建模（只建模轮询决策依赖的部分）:
// 注入段首 progress=0、+0.025/Tick 推进、一格一物品 → 物品恰在注入后 40 Tick 跨出
// 首格，故"首格可注入" ⇔ 距该带上次注入 ≥ 40 Tick。T2.23 增加槽位门控模型: 每带
// 相位 = (种子 + T×0.025) mod 1，classify 三态（accept=头空且边界到 / skip=头占用 /
// wait=边界未到），与 MachineSystem 的真实门控同构。决策逻辑直接调用产物代码
// OutputOps.syncOutputBeltQueue / pollOutputBelt（纯函数，无渲染依赖）。"""
new = """// 传送带物理按既有 BeltSystem 模型最小化建模（只建模轮询决策依赖的部分）:
// 注入段首 progress=0、+0.025/Tick 推进、一格一物品 → 物品恰在注入后 40 Tick 跨出
// 首格，故"首格可注入" ⇔ 距该带上次注入 ≥ 40 Tick。决策逻辑直接调用产物代码
// OutputOps.syncOutputBeltQueue / pollOutputBelt（纯函数，无渲染依赖）。"""
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 'harness header'
s = s.replace(old, new, 1)

old = """  neverAccepts: boolean; // 永堵（断头预置满）
  injections: number[]; // 历次注入 tick
  phaseSeed: number; // 槽位相位种子（0 = 与全局网格同步）
}"""
new = """  neverAccepts: boolean; // 永堵（断头预置满）
  injections: number[]; // 历次注入 tick
}"""
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 'harness iface'
s = s.replace(old, new, 1)

old = """    const classify = (h: number): 'accept' | 'skip' | 'wait' => {
      const b = belts.find((x) => x.handle === h)!;
      const last = b.injections[b.injections.length - 1];
      if (b.neverAccepts || (last !== undefined && T - last < INTERVAL)) return 'skip'; // 头格占用
      const phase = (b.phaseSeed + T * 0.025) % 1;
      return phase < 0.025 ? 'accept' : 'wait'; // T2.23 槽位边界门控
    };
    const r = pollOutputBelt(queue, candidates, classify);"""
new = """    const canAccept = (h: number): boolean => {
      const b = belts.find((x) => x.handle === h)!;
      if (b.neverAccepts) return false;
      const last = b.injections[b.injections.length - 1];
      return last === undefined || T - last >= INTERVAL; // 一格一物品: 物品 40 Tick 跨出首格
    };
    const r = pollOutputBelt(queue, candidates, canAccept);"""
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 'harness classify'
s = s.replace(old, new, 1)

s = s.replace(', injections: [], phaseSeed: 0 }', ', injections: [] }')
s = s.replace("injections: [] as number[],\r\n    phaseSeed: 0,", "injections: [] as number[],")
s = s.replace("injections: [] as number[],\n    phaseSeed: 0,", "injections: [] as number[],")
assert 'phaseSeed' not in s, 'phaseSeed remnants'
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok test-output-polling')

# ── 2. verify-t210-polling.ts：O 组回到固定 tick 版 ──
p = 'scripts/verify-t210-polling.ts'
s = io.open(p, encoding='utf-8', newline='').read()

# 2a. header O description
old = """//   输出轮询 (A8 §4.2，T2.21 修订 2026-09-05 用户重定语义——轮询单元=接收传送带
//   按创建序、设备级节拍每 40 Tick 至多 1 件):
//     O1. 创建序轮询 左→中→右、成功者移队尾；货尽停发不误标堵塞（队列保留，
//         补货后从队首继续）；节拍: 相邻两次出货恰隔 40 Tick
//     O2. 无接收带/满带的带移出轮询（本 Tick），下一 Tick 同步按创建序追加队尾；
//         全部候选满带 → 停发不出货、货物留槽
//     O3. 相位窗口闸门退役: beltPhase 高位不再阻拦出货（节拍由设备计时器承担）
//     O4. 堵塞带恢复 → 重新进入轮询且排在既有活跃带之后（追加队尾语义）"""
new = """//   输出轮询 (A8 §4.2，T2.21 修订 2026-09-05 用户重定语义——轮询单元=接收传送带
//   按创建序、设备级节拍每 40 Tick 至多 1 件):
//     O1. 创建序轮询 左→中→右、成功者移队尾；货尽停发不误标堵塞（队列保留，
//         补货后从队首继续）；节拍: 相邻两次出货恰隔 40 Tick
//     O2. 无接收带/满带的带移出轮询（本 Tick），下一 Tick 同步按创建序追加队尾；
//         全部候选满带 → 停发不出货、货物留槽
//     O3. 相位窗口闸门退役: beltPhase 高位不再阻拦出货（节拍由设备计时器承担）
//     O4. 堵塞带恢复 → 重新进入轮询且排在既有活跃带之后（追加队尾语义）"""
assert old in s, 't210 header (unchanged check)'
# (identical — the T2.23 round didn't change the header; skip)

# 2b. remove the INTERVAL + waitOutputs helper
start = s.index('const INTERVAL = 40;')
end = s.index('// ═══════════════════ 输入轮询')
s = s[:start] + s[end:]

# 2c. restore the O-group body (the T2.21 fixed-tick version)
a = s.index("console.log('[O1.")
b = s.index("console.log(`\\n结果:")
new_o = """console.log('[O1. 创建序轮询 + 成功移队尾 + 货尽停发不误标堵塞 + 设备级节拍]');
{
  const sc = makeScene();
  const f = sc.place(80, 12);
  f.bufferOutput[0] = { itemId: ITEM, count: 2 }; // 只有 2 件货
  const cells = receiveCells(80, 12);
  cells.map(([x, y]) => sc.belt(x, y, 270)); // 创建序 左→中→右（x 递增 = chainId 时间戳递增）
  const [lh, mh, rh] = cells.map(([x, y]) => sc.handleAt(x, y));
  sc.tick(1);
  assertEq(sc.outputPortEvents(), [0], 'O1-a. 首件给创建序最前带（左口）——设备级节拍每 Tick 至多 1 件');
  sc.tick(39);
  assertEq(sc.outputPortEvents(), [0], 'O1-b. 节拍窗口内（39 Tick）不出货（相邻成功出货恰隔 40 Tick）');
  sc.tick(1);
  assertEq(sc.outputPortEvents(), [0, 1], 'O1-c. 节拍到 → 第 2 件轮到中口（货尽停发不误标堵塞）');
  assertEq(f.outputPollQueue, [rh, lh, mh], 'O1-d. 队列 [右,左,中]: 成功者移队尾、未轮到的右带保持活跃（槽空≠带堵塞）');
  f.bufferOutput[0] = { itemId: ITEM, count: 1 }; // 补 1 件货
  sc.clearBelts(); // 清空带上物品（模拟下游全部取走，左/中带头腾位）
  sc.tick(40);
  assertEq(sc.outputPortEvents().slice(-1), [2], 'O1-e. 补货后从队列队首（右带）继续——轮询次序记忆保持');
}

console.log('[O2. 无接收带/满带 → 本 Tick 移出轮询；全部候选满带 → 停发货物留槽]');
{
  const sc = makeScene();
  const f = sc.place(90, 12);
  f.bufferOutput[0] = { itemId: ITEM, count: 5 };
  const cells = receiveCells(90, 12);
  sc.belt(cells[0][0], cells[0][1], 270); // 只有左、右有接收带，中间悬空
  sc.belt(cells[2][0], cells[2][1], 270);
  sc.tick(80); // 两个节拍窗: 左@t1、右@t41；断头带 1 件即满
  assertEq(sc.outputPortEvents(), [0, 2], 'O2-a. 中间无接收带被跳过，左右各出 1 件（中间永不入队）');
  assertEq(f.bufferOutput[0].count, 3, 'O2-b. 第三窗起左右带均满 → 停发，其余 3 件留在输出槽');
  const cand = new Set(cells.map(([x, y]) => sc.handleAt(x, y)));
  assert(f.outputPollQueue.every((h) => cand.has(h)),
    `O2-c. 队列只含候选带 handle（无端口下标残留；当前 ${JSON.stringify(f.outputPollQueue)}）`);
  sc.clearBelts(); // 全部疏通
  sc.tick(40);
  assertEq(sc.outputPortEvents().slice(-1), [0], 'O2-d. 腾位即恢复: 疏通后下一节拍出货（左带重新追加队尾后轮到）');
}

console.log('[O3. 相位窗口闸门退役: beltPhase 高位不阻拦出货（节拍由设备计时器承担）]');
{
  const sc = makeScene();
  BeltSystem.beltPhase = 0.7; // 旧"窗口外"高位——闸门已移除，不应阻拦
  const f = sc.place(100, 12);
  f.bufferOutput[0] = { itemId: ITEM, count: 3 };
  const cells = receiveCells(100, 12);
  sc.belt(cells[1][0], cells[1][1], 270); // 只有中、右有接收带
  sc.belt(cells[2][0], cells[2][1], 270);
  sc.tick(1);
  assertEq(sc.outputPortEvents(), [1], 'O3-a. beltPhase=0.7 高位仍出货（首件给创建序首带=中口）');
  sc.tick(39);
  assertEq(sc.outputPortEvents(), [1], 'O3-b. 设备节拍窗口内不再出（与 beltPhase 无关）');
  sc.tick(1);
  assertEq(sc.outputPortEvents(), [1, 2], 'O3-c. 第 40 Tick 节拍到 → 第 2 件轮到右口');
}

console.log('[O4. 堵塞带恢复 → 重新入轮询且排在既有活跃带之后（追加队尾语义）]');
{
  const sc = makeScene();
  const f = sc.place(120, 12);
  f.bufferOutput[0] = { itemId: ITEM, count: 4 };
  const c = receiveCells(120, 12);
  const bLeft = sc.belt(c[0][0], c[0][1], 270, [[ITEM, 0.5]]); // 左: 预置满带（堵塞）
  sc.belt(c[1][0], c[1][1], 270);                              // 中: 空
  sc.belt(c[2][0], c[2][1], 270);                              // 右: 空
  sc.tick(1);
  assertEq(sc.outputPortEvents(), [1], 'O4-a. 队首左带满 → 跳过，中带出货（走访继续找可写带）');
  sc.tick(40);
  assertEq(sc.outputPortEvents(), [1, 2], 'O4-b. 下一节拍轮到右带（左带移出后由同步追加队尾等待恢复）');
  bLeft.items.length = 0; // 疏通左带（模拟下游取走）
  sc.tick(40);
  // 本窗中带满带移出、走访继续；左带恢复后按"同步追加队尾"的位置轮到 → 排在右带之后出货
  assertEq(sc.outputPortEvents(), [1, 2, 0], 'O4-c. 恢复出货序 中→右→左: 恢复带排在既有活跃带之后（追加队尾）');
}

"""
s = s[:a] + new_o.replace('\n', nl) + s[b:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok verify-t210')

# ── 3. verify-t27-output-port.ts：12 组回到固定 tick 版 ──
p = 'scripts/verify-t27-output-port.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = """// T2.23: 出货时刻 = 链首槽位边界（首件在本场景首个边界 Tick，≤40），固定 tick 断言改为事件式
let w12 = 0;
while (fD.bufferOutput[0].count === 5 && w12 < 100) { tick(1); w12++; }
assert(w12 < 100, `12a. 首件在槽位边界给出（${w12} tick，beltPhase 高位不阻拦）`);
assertEq(fD.bufferOutput[0].count, 4, '12a2. 设备级节拍: 首件一次一件（5→4）');
tick(39);
assertEq(fD.bufferOutput[0].count, 4, '12b. 节拍窗口内（+39 Tick）不再出货');
tick(1);
assertEq(fD.bufferOutput[0].count, 3, '12c. 第 40 Tick 节拍到 → 出第 2 件（4→3）');
assertEq(outPorts12().slice(-2), [0, 1], '12d. 轮询按创建序: 第 1 件给左口、第 2 件轮到中口');"""
new = """tick(1);
assertEq(fD.bufferOutput[0].count, 4, '12a. 设备级节拍: 首件立即出（5→4），余 2 件本节拍内不再出');
tick(39);
assertEq(fD.bufferOutput[0].count, 4, '12b. 节拍窗口内（+39 Tick，beltPhase 高位）不再出货');
tick(1);
assertEq(fD.bufferOutput[0].count, 3, '12c. 第 40 Tick 节拍到 → 出第 2 件（4→3）');
assertEq(outPorts12().slice(-2), [0, 1], '12d. 轮询按创建序: 第 1 件给左口、第 2 件轮到中口');"""
old, new = old.replace('\n', nl), new.replace('\n', nl)
assert old in s, 't27 12-group'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok verify-t27')
