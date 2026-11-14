// デバッガ（sim/debugger.js）：ステップ実行とブレークポイントのテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Machine } from '../sim/machine.js';
import { Debugger, peekWord } from '../sim/debugger.js';
import { assemble } from '../asm/assembler.js';
import { EXC, RESET, OP } from '../sim/isa.js';
import { THREAD_STATE } from '../sim/devices/registers.js';
import { installHaltVectors, haltOthers, ORG, UP } from './helpers.js';

const S = THREAD_STATE;
const ROM = assemble(readFileSync(new URL('../rom/boot.asm', import.meta.url), 'utf8'));
const example = name => readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8');

/** プログラムを読み込み、threads のスレッドをラベルから始める（他は止める）。デバッガを付けて返す */
function setup(src, { threads = { 0: 'start' }, config = '9K' } = {}) {
  const m = new Machine(config);
  const asm = assemble(src, { origin: ORG });
  for (let c = 0; c < m.cfg.ncores; c++) m.load(ORG + c * 0x1_0000, asm.bytes);
  installHaltVectors(m);
  const tids = Object.keys(threads).map(Number);
  haltOthers(m, tids);
  for (const tid of tids) {
    m.thread(tid).pc = asm.symbols.get(threads[tid]) + (tid >> 4) * 0x1_0000;
    m.thread(tid).up = UP + tid * 128;
  }
  return { m, dbg: new Debugger(m), sym: n => asm.symbols.get(n), th: tid => m.thread(tid) };
}

const LOOP = `
start:  PUSHQ #3
l:      ADD #-1
        PUSH T
        BNZ l
        HALT`;

// ---------------------------------------------------------------- 番地のブレークポイント

test('番地のブレークポイント：語を実行し始める直前で止まり、続けると次の回でまた止まる', () => {
  const { dbg, sym, th } = setup(LOOP);
  dbg.toggleBreakpoint(sym('l'));
  const stacks = [];
  let r;
  while ((r = dbg.run()).type === 'breakpoint') {
    assert.deepEqual(r, { type: 'breakpoint', tid: 0, addr: sym('l') });
    assert.equal(th(0).pc, sym('l'));
    assert.equal(th(0).dec, null);
    stacks.push(th(0).dataStack()[0]);
  }
  assert.deepEqual(stacks, [3, 2, 1]);        // 3回とも、ADD #-1 を実行する前
  assert.equal(r.type, 'stopped');
  assert.equal(th(0).state, S.HALT);
});

test('番地のブレークポイントは全スレッド共通', () => {
  const { dbg, sym } = setup(LOOP, { threads: { 0: 'start', 1: 'start' } });
  dbg.toggleBreakpoint(sym('l'));
  const tids = [];
  let r;
  while ((r = dbg.run()).type === 'breakpoint') tids.push(r.tid);
  assert.deepEqual(tids, [0, 1, 0, 1, 0, 1]);
});

test('ブレークポイントを外せる', () => {
  const { dbg, sym } = setup(LOOP);
  assert.equal(dbg.toggleBreakpoint(sym('l')), true);
  assert.equal(dbg.toggleBreakpoint(sym('l')), false);
  assert.equal(dbg.run().type, 'stopped');
});

/** ブートROMとOSイメージで起動するマシン */
function bootMachine(config, os) {
  const m = new Machine(config);
  m.load(ROM.origin, ROM.bytes);
  m.load(ORG, assemble(os, { origin: ORG }).bytes);
  return m;
}

/** 比較用の状態（サイクル数、UARTの出力、全スレッドの状態とスタック） */
function snapshot(m) {
  return {
    cycle: m.cycle,
    out: m.uart.outputText,
    threads: m.threads.map(t => [t.tid, t.state, t.pc, t.instret, t.dataStack(), t.returnStack()]),
  };
}

for (const config of ['9K', '20K']) {
  test(`ブレークポイントで何度止めて続けても、止めない実行と結果が同じ（${config}、ブートROM＋examples/06）`, () => {
    const os = example('06_start.asm');
    const plain = bootMachine(config, os);
    plain.runUntilStop(5_000_000);

    const m = bootMachine(config, os);
    const dbg = new Debugger(m);
    // OSイメージの全部の語と、ブートROMの idle の受信（全スレッドが通る。20Kではコア1のスレッドで、サイクルの途中で止まる）
    for (let a = ORG; a < ORG + 0x80; a += 4) dbg.toggleBreakpoint(a);
    dbg.toggleBreakpoint(ROM.symbols.get('id_rx'));
    dbg.toggleBreakpoint(ROM.symbols.get('puts'));
    let stops = 0;
    let midCycle = 0;
    let r;
    while ((r = dbg.run({ maxCycles: 5_000_000 })).type === 'breakpoint') {
      stops++;
      if (m.resumeCore > 0) midCycle++;
    }
    assert.equal(r.type, 'stopped');
    assert.ok(stops > 50, `${stops}回`);
    if (config === '20K') assert.ok(midCycle > 0, 'コア1で止まったことがある');
    assert.deepEqual(snapshot(m), snapshot(plain));
  });
}

// ---------------------------------------------------------------- 例外・書き込み

test('例外で止める：入口の処理を終えた直後（ベクタの番地にいる）', () => {
  const { m, dbg, th } = setup('start: NOP\nLD 0\nHALT');
  dbg.exceptionBreaks.add(EXC.BUS);
  const r = dbg.run();
  assert.deepEqual(r, { type: 'exception', tid: 0, exc: EXC.BUS });
  assert.equal(th(0).pc, RESET.VBR + EXC.BUS * 4);
  assert.equal(th(0).rdepth, 1);
  assert.equal(dbg.run().type, 'stopped');    // ベクタのHALTで止まる
  assert.equal(m.thread(0).state, S.HALT);
});

test('選んでいない例外では止まらない', () => {
  const { dbg } = setup('start: NOP\nLD 0\nHALT');
  dbg.exceptionBreaks.add(EXC.ALIGN);
  assert.equal(dbg.run().type, 'stopped');
});

test('メモリへの書き込みで止める（4バイト単位。8bitの書き込みも、XCHGも）', () => {
  const src = `
start:  PUSHQ #7
        ST $00104000
        PUSHQ #1
        ST $00104004
        PUSHQ #2
        PUSH #$00104002
        STB
        PUSHQ #3
        PUSH #$00104000
        XCHG
        HALT`;
  const { m, dbg } = setup(src);
  dbg.toggleWatch(0x0010_4001);                 // 下位2bitは無視して 0x0010_4000 の4バイト
  let r = dbg.run();
  assert.deepEqual(r, { type: 'watch', tid: 0, addr: 0x0010_4000, writeAddr: 0x0010_4000, size: 4 });
  assert.equal(m.mem.read32(0x0010_4000), 7);   // 書き込んだ後で止まる
  r = dbg.run();                                // +4 への書き込みでは止まらず、+2 の STB で止まる
  assert.deepEqual(r, { type: 'watch', tid: 0, addr: 0x0010_4000, writeAddr: 0x0010_4002, size: 1 });
  r = dbg.run();
  assert.equal(r.type, 'watch');                // XCHG
  assert.equal(dbg.run().type, 'stopped');
});

// ---------------------------------------------------------------- ステップ

test('1サイクル：全体を1サイクル進める（番地のブレークポイントでは止めない）', () => {
  const { m, dbg, sym } = setup(LOOP, { threads: { 0: 'start', 1: 'start' } });
  dbg.toggleBreakpoint(sym('start'));
  assert.deepEqual(dbg.stepCycle(), { type: 'step' });
  assert.equal(m.cycle, 1);
  assert.deepEqual(m.lastIssue.map(t => t.tid), [0]);
  dbg.stepCycle();
  assert.deepEqual(m.lastIssue.map(t => t.tid), [1]);
  dbg.stepCycle();
  dbg.stepCycle();
  assert.deepEqual(m.lastIssue, []);           // 2スレッドしかいないので空サイクル
});

test('1命令：選んだスレッドが1命令を実行するまで（その間に他のスレッドも動く）', () => {
  const { dbg, th } = setup('start: NOP\nNOP\nNOP\nNOP\nHALT', { threads: { 0: 'start', 1: 'start' } });
  dbg.stepInstruction(0);
  const r = dbg.stepInstruction(1);
  assert.deepEqual(r, { type: 'step', tid: 1 });
  assert.equal(th(1).instret, 1);
  assert.equal(th(0).instret, 1);
  dbg.stepInstruction(1);
  assert.equal(th(1).instret, 2);
  assert.equal(th(0).instret, 2);
});

test('1語：今の語を最後まで実行する（埋め草のNOPとslot6も含む）', () => {
  const { dbg, th } = setup('start: PUSHQ #1\nPUSHQ #2\nPUSHQ #3\nnext: HALT');
  const r = dbg.stepWord(0);
  assert.equal(r.type, 'step');
  assert.deepEqual(th(0).dataStack(), [1, 2, 3]);
  assert.equal(th(0).instret, 4);              // SLIT×3 と slot6 のNOP
  assert.equal(th(0).dec, null);
});

test('飛ばす：CALLで呼んだ先から戻るまで進める', () => {
  const src = `
start:  BSR f
next:   PUSHQ #9
        HALT
f:      PUSHQ #5
fl:     ADD #-1
        PUSH T
        BNZ fl
        POP
        RTS`;
  const { dbg, sym, th } = setup(src);
  const r = dbg.stepOver(0);
  assert.deepEqual(r, { type: 'step', tid: 0 });
  assert.equal(th(0).pc, sym('next'));
  assert.equal(th(0).rdepth, 0);
  assert.ok(th(0).instret > 10);
  assert.deepEqual(th(0).dataStack(), []);
});

test('飛ばす：EXECも。CALL・EXEC以外は1命令と同じ', () => {
  const src = `
start:  LEA f,PC
        JSR (T)
next:   HALT
f:      PUSHQ #4
        RTS`;
  const { dbg, sym, th } = setup(src);
  assert.equal(dbg.nextInstruction(th(0)).inst.op, OP.SYS);   // PCREL
  dbg.stepOver(0);                                             // PCREL は1命令だけ
  assert.equal(th(0).instret, 1);
  assert.equal(dbg.nextInstruction(th(0)).inst.op, OP.EXEC);
  dbg.stepOver(0);
  assert.equal(th(0).pc, sym('next'));
  assert.deepEqual(th(0).dataStack(), [4]);
});

test('飛ばす：呼んだ先のブレークポイントでは止まる', () => {
  const src = 'start: BSR f\nHALT\nf: PUSHQ #1\ng: RTS';
  const { dbg, sym } = setup(src);
  dbg.toggleBreakpoint(sym('g'));
  assert.deepEqual(dbg.stepOver(0), { type: 'breakpoint', tid: 0, addr: sym('g') });
});

test('ブレークポイントで止まっている語から、ステップで進める', () => {
  const { dbg, sym, th } = setup(LOOP);
  dbg.toggleBreakpoint(sym('l'));
  dbg.run();
  assert.equal(dbg.stepInstruction(0).type, 'step');   // 同じブレークポイントで止まり直さない
  assert.deepEqual(th(0).dataStack(), [3, 0xFFFF_FFFF]); // ADD #-1 は PUSHQ #-1 と ADD の2命令。その1つ目
});

test('ステップが終わらないときは打ち切る', () => {
  // スレッド0は回り続け、スレッド1はRECVで待ち続ける
  const { dbg } = setup('start: BRA start\nw: RECV\nHALT', { threads: { 0: 'start', 1: 'w' } });
  dbg.stepInstruction(1);                 // RECVを実行して待機に入る
  dbg.stepLimit = 1000;
  assert.deepEqual(dbg.stepInstruction(1), { type: 'timeout', tid: 1 });
});

test('すべてのスレッドが止まっていれば stopped', () => {
  const { dbg } = setup('start: HALT');
  dbg.run();
  assert.deepEqual(dbg.stepInstruction(0), { type: 'stopped' });
});

// ---------------------------------------------------------------- 実行の上限

test('実行の上限：サイクル数と発行の回数', () => {
  let { m, dbg } = setup('start: BRA start');
  assert.deepEqual(dbg.run({ maxCycles: 100 }), { type: 'limit' });
  assert.equal(m.cycle, 100);
  ({ m, dbg } = setup('start: BRA start'));
  assert.deepEqual(dbg.run({ maxIssues: 10 }), { type: 'limit' });
  assert.equal(m.thread(0).instret, 10);
});

test('peekWord：副作用なしに語を読む（I/Oと割り当てのない番地は null）', () => {
  const { m } = setup('start: HALT');
  assert.equal(peekWord(m, ORG), m.mem.read32(ORG));
  assert.equal(peekWord(m, 0), null);
  assert.equal(peekWord(m, 0xFF00_0000), null);
  assert.equal(peekWord(m, ORG + 2), null);
});
