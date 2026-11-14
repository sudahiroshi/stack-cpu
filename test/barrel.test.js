// 段階3：バレル、イベント、WAIT、メールボックスのテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Machine } from '../sim/machine.js';
import { EXC } from '../sim/isa.js';
import { THREAD_STATE } from '../sim/devices/registers.js';
import { assemble } from '../asm/assembler.js';
import { runThreads, haltOthers, ORG } from './helpers.js';

const S = THREAD_STATE;
const TRUE = 0xFFFFFFFF;
const execs = (events, tid) => events.filter(e => e.type === 'exec' && (tid === undefined || e.tid === tid));
const blockStates = (events, tid) => events.filter(e => e.type === 'block' && e.tid === tid).map(e => e.state);

// 他のスレッドを待たせるための時間かせぎ（約 n×4 命令）
const delay = (label, n) => `
        PUSH #${n}
${label}: ADD #-1
        PUSH T
        BNZ ${label}
        POP`;

// ---------------------------------------------------------------- スケジューリング

test('リセット直後は全スレッドがROMの先頭から、スレッド0から順に発行する（9K、8スレッド）', () => {
  const m = new Machine('9K');
  const r = assemble('ORG $FFFF0000\nTID\nHALT');
  m.load(r.origin, r.bytes);
  const events = [];
  m.on(e => events.push(e));
  assert.equal(m.runUntilStop(1000).stopped, true);
  const ex = execs(events);
  // 8スレッド（D以上）なので、毎サイクル次のスレッドが発行する
  assert.deepEqual(ex.slice(0, 10).map(e => [e.cycle, e.tid]),
    [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 0], [9, 1]]);
  for (const th of m.threads) {
    assert.deepEqual(th.dataStack(), [th.tid]);
    assert.equal(th.state, S.HALT);
  }
});

test('実行可能なスレッドがDより少なければ空サイクルを入れる', () => {
  const r = runThreads('a: NOP\nNOP\nNOP\nHALT', { threads: { 0: 'a', 1: 'a' }, trace: true });
  assert.deepEqual(execs(r.events, 0).map(e => e.cycle).slice(0, 3), [0, 4, 8]);
  assert.deepEqual(execs(r.events, 1).map(e => e.cycle).slice(0, 3), [1, 5, 9]);
});

test('Dより多ければ各スレッドはスレッド数ごとに発行する（5スレッド）', () => {
  const r = runThreads('a: NOP\nNOP\nNOP\nHALT', { threads: { 0: 'a', 2: 'a', 3: 'a', 5: 'a', 7: 'a' }, trace: true });
  assert.deepEqual(execs(r.events).slice(0, 7).map(e => [e.cycle, e.tid]),
    [[0, 0], [1, 2], [2, 3], [3, 5], [4, 7], [5, 0], [6, 2]]);
});

test('止まったスレッドは飛ばす', () => {
  // スレッド0はすぐHALT、スレッド1・2は続ける
  const src = 'h: HALT\na: NOP\nNOP\nNOP\nNOP\nNOP\nNOP\nHALT';
  const r = runThreads(src, { threads: { 0: 'h', 1: 'a', 2: 'a' }, trace: true });
  const ex = execs(r.events);
  assert.deepEqual(ex.slice(0, 5).map(e => [e.cycle, e.tid]), [[0, 0], [1, 1], [2, 2], [5, 1], [6, 2]]);
});

test('20Kでは同じサイクルにコア0、コア1の順に発行する', () => {
  const r = runThreads('a: TID\nHALT', { config: '20K', threads: { 0: 'a', 0x10: 'a' }, trace: true });
  assert.deepEqual(execs(r.events).slice(0, 2).map(e => [e.cycle, e.tid]), [[0, 0], [0, 0x10]]);
  assert.deepEqual(r.m.thread(0x10).dataStack(), [0x10]);
});

test('待機中のスレッドは番を使わない', () => {
  const r = runThreads('w: RECV\nHALT\na: NOP\nNOP\nNOP\nHALT', { threads: { 0: 'w', 1: 'a' }, trace: true });
  // スレッド0は最初の番でRECVの待ちに入り、その後はスレッド1だけが4サイクルごとに発行する
  assert.deepEqual(execs(r.events, 1).map(e => e.cycle).slice(0, 3), [1, 5, 9]);
  assert.deepEqual(r.blocked, [0]);
});

// ---------------------------------------------------------------- WAIT と SIGNAL

test('WAIT は SIGNAL が来るまで待ち、立っていたビットを返して消す', () => {
  const src = `
waiter: PUSHQ #2
        WAIT
        HALT
signaler: ${delay('l', 10)}
        PUSHQ #1
        SIGNAL
        HALT`;
  const r = runThreads(src, { threads: { 0: 'signaler', 1: 'waiter' }, trace: true });
  assert.equal(r.stopped, true);
  assert.deepEqual(r.m.thread(1).dataStack(), [2]);
  assert.equal(r.m.thread(1).events, 0);              // ラッチは消えた
  assert.ok(blockStates(r.events, 1).includes(S.WAIT)); // THREADSTAT 2
});

test('ラッチは立ったまま残り、WAIT はすぐに戻る。2回目は待つ', () => {
  const r = runThreads('a: PUSHQ #0\nSIGNAL\nPUSHQ #2\nWAIT\nPUSHQ #2\nWAIT\nHALT', { threads: { 0: 'a' } });
  assert.equal(r.stopped, true);
  assert.deepEqual(r.blocked, [0]);
  assert.deepEqual(r.m.thread(0).dataStack(), [2, 2]); // 2回目のWAITのmaskはスタックに残っている
  assert.equal(r.m.thread(0).state, S.WAIT);
});

test('WAIT が返すのは mask 内の立っているビットだけ', () => {
  const r = runThreads('a: PUSHQ #0\nSIGNAL\nPUSHQ #6\nWAIT\nMFC 9\nHALT', { threads: { 0: 'a' } });
  assert.deepEqual(r.m.thread(0).dataStack(), [2, 0]);
});

test('SIGNAL の tid＝−1 は自分を含む全スレッド（T-27）', () => {
  const src = `
sig:    PUSHQ #-1
        SIGNAL
        PUSHQ #2
        WAIT
        HALT
w:      PUSHQ #2
        WAIT
        HALT`;
  const r = runThreads(src, { threads: { 0: 'sig', 1: 'w', 5: 'w' } });
  assert.equal(r.stopped, true);
  assert.deepEqual(r.blocked, []);
  for (const tid of [0, 1, 5]) assert.deepEqual(r.m.thread(tid).dataStack(), [2], `tid ${tid}`);
});

test('存在しないtidへの SIGNAL は例外14', () => {
  for (const tid of ['8', '$10', '$100']) {
    const r = runThreads(`a: PUSH #${tid}\nSIGNAL\nHALT`, { threads: { 0: 'a' } });
    assert.equal(r.m.thread(0).lastException?.exc, EXC.BAD_TID, tid);
  }
  // 20Kならコア1のスレッドがある
  const r = runThreads('a: PUSH #$17\nSIGNAL\nHALT', { config: '20K', threads: { 0: 'a' } });
  assert.equal(r.m.thread(0).lastException, null);
  assert.equal(r.m.thread(0x17).events, 2);
});

test('mask＝0 の WAIT は永久に待つ（T-26）', () => {
  const r = runThreads('a: PUSHQ #0\nSIGNAL\nPUSHQ #0\nWAIT\nHALT', { threads: { 0: 'a' } });
  assert.equal(r.stopped, true);
  assert.deepEqual(r.blocked, [0]);
});

test('語の途中で待っても、再開すると続きのスロットから実行する', () => {
  const src = `
waiter: PUSHQ #5
        PUSHQ #2
        WAIT
        HALT
signaler: ${delay('l', 5)}
        PUSHQ #1
        SIGNAL
        HALT`;
  const r = runThreads(src, { threads: { 0: 'signaler', 1: 'waiter' } });
  assert.equal(r.asm.words[0] >>> 27, 23); // PUSHQ #5、PUSHQ #2、WAIT は同じ語
  assert.deepEqual(r.m.thread(1).dataStack(), [5, 2]);
});

// ---------------------------------------------------------------- メールボックス

test('SENDM と RECV（ヘッダ：送信元tid、tag、n）', () => {
  const src = `
sender: ${delay('l', 5)}
        PUSH #$11
        PUSH #$22
        PUSH #$0123
        PUSHQ #1
        SEND 2
        HALT
recver: RECV
        RECV
        RECV
        HALT`;
  const r = runThreads(src, { threads: { 0: 'sender', 1: 'recver' }, trace: true });
  assert.equal(r.stopped, true);
  assert.deepEqual(r.blocked, []);
  assert.deepEqual(r.m.thread(1).dataStack(), [0x0001_2302, 0x11, 0x22]);
  assert.deepEqual(r.m.thread(0).dataStack(), []);
  assert.ok(blockStates(r.events, 1).includes(S.RECV)); // THREADSTAT 3
});

test('ヘッダの送信元tidはハードウェアが入れる（20K、コアをまたぐ送信）', () => {
  const src = `
sender: PUSHQ #9
        PUSH #$7001
        PUSHQ #0
        SEND 1
        HALT
recver: RECV
        RECV
        HALT`;
  const r = runThreads(src, { config: '20K', threads: { 0x13: 'sender', 0: 'recver' } });
  assert.deepEqual(r.m.thread(0).dataStack(), [0x1370_0101, 9]);
});

test('tag は下位16bitを使う', () => {
  const r = runThreads('a: PUSH #$12345\nPUSHQ #0\nSEND 0\nRECV\nHALT', { threads: { 0: 'a' } });
  assert.deepEqual(r.m.thread(0).dataStack(), [0x0023_4500]);
});

test('自分自身への送信もできる（T-29）', () => {
  const r = runThreads('a: PUSHQ #9\nPUSHQ #5\nPUSHQ #0\nSEND 1\nRECV\nRECV\nHALT', { threads: { 0: 'a' } });
  assert.deepEqual(r.m.thread(0).dataStack(), [0x0000_0501, 9]);
});

test('存在しないtidへの SENDM・SENDM? は例外14', () => {
  for (const op of ['SEND 0', 'TRYSEND 0']) {
    const r = runThreads(`a: PUSHQ #0\nPUSHQ #8\n${op}\nHALT`, { threads: { 0: 'a' } });
    assert.equal(r.m.thread(0).lastException?.exc, EXC.BAD_TID, op);
  }
});

test('FIFOにn＋1語の空きがなければ SENDM は待ち、空いたら送る', () => {
  // 5語（ヘッダ＋4語）のメッセージを13回送る。64語のFIFOには12回分（60語）しか入らない
  const src = `
sender: PUSHQ #13
s_loop: PSHR
        PUSHQ #1
        PUSHQ #2
        PUSHQ #3
        PUSHQ #4
        PUSHQ #7
        PUSHQ #1
        SEND 4
        PULR
        ADD #-1
        PUSH T
        BNZ s_loop
        POP
        HALT`;
  const r = runThreads(src, { threads: { 0: 'sender' }, trace: true });
  const m = r.m;
  assert.deepEqual(r.blocked, [0]);
  assert.equal(m.thread(0).state, S.SEND);              // THREADSTAT 4
  assert.equal(m.thread(1).mbox.length, 60);
  assert.deepEqual(m.thread(0).dataStack(), [1, 2, 3, 4, 7, 1]); // 引数はまだ消費していない
  // 空きは4語。1語取れば5語の空きができて送れる
  m.thread(1).mbox.shift();
  assert.equal(m.runUntilStop(1000).stopped, true);
  assert.equal(m.thread(0).state, S.HALT);
  assert.equal(m.thread(1).mbox.length, 64);
  assert.deepEqual(m.thread(1).mbox.slice(-5), [0x0000_0704, 1, 2, 3, 4]); // 最後のメッセージ（tag 7、n 4）
});

test('SENDM? は空きがなければ偽を返し、引数を消費する。空きがあれば真', () => {
  const full = m => { m.thread(1).mbox = new Array(64).fill(0); };
  let r = runThreads('a: PUSHQ #3\nPUSHQ #5\nPUSHQ #7\nPUSHQ #1\nTRYSEND 1\nHALT', { threads: { 0: 'a' }, setup: full });
  assert.deepEqual(r.m.thread(0).dataStack(), [3, 0]);
  assert.equal(r.m.thread(1).mbox.length, 64);
  r = runThreads('a: PUSHQ #3\nPUSHQ #5\nPUSHQ #7\nPUSHQ #1\nTRYSEND 1\nHALT', { threads: { 0: 'a' } });
  assert.deepEqual(r.m.thread(0).dataStack(), [3, TRUE]);
  assert.deepEqual(r.m.thread(1).mbox, [0x0000_0701, 5]);
});

test('同じ相手を待つ送信者は、待ち始めた順に送る（先頭が送れなければ後ろも待つ。T-28）', () => {
  const src = `
a:      PUSHQ #1
        PUSHQ #2
        PUSHQ #7
        PUSHQ #3
        SEND 2
        HALT
b:      PUSHQ #8
        PUSHQ #3
        SEND 0
        HALT`;
  const setup = m => { m.thread(3).mbox = new Array(64).fill(0); };
  const r = runThreads(src, { threads: { 1: 'a', 2: 'b' }, setup });
  const m = r.m;
  const t3 = m.thread(3);
  assert.deepEqual(r.blocked, [1, 2]);
  assert.deepEqual(t3.sendQueue, [1, 2]);
  // 1語空く：後ろのスレッド2（1語でよい）も、先頭のスレッド1（3語必要）を追い越さない
  t3.mbox.shift();
  m.runUntilStop(1000);
  assert.deepEqual(t3.sendQueue, [1, 2]);
  // 3語空く：スレッド1が送る。FIFOはまた一杯
  t3.mbox.splice(0, 2);
  m.runUntilStop(1000);
  assert.equal(m.thread(1).state, S.HALT);
  assert.deepEqual(t3.sendQueue, [2]);
  assert.deepEqual(t3.mbox.slice(-3), [0x0100_0702, 1, 2]);
  // 1語空く：スレッド2が送る
  t3.mbox.shift();
  m.runUntilStop(1000);
  assert.equal(m.thread(2).state, S.HALT);
  assert.deepEqual(t3.sendQueue, []);
  assert.deepEqual(t3.mbox.slice(-1), [0x0200_0800]);
});

test('メールボックスのイベント（ビット0）は状態を表し、WAITで消えない', () => {
  const src = `
recver: PUSHQ #1
        WAIT
        MFC 9
        RECV
        MFC 9
        HALT
sender: ${delay('l', 5)}
        PUSHQ #0
        PUSHQ #1
        SEND 0
        HALT`;
  const r = runThreads(src, { threads: { 0: 'sender', 1: 'recver' } });
  assert.equal(r.m.thread(0).lastException, null);
  // WAITの結果1、EVPEND 1（まだ空でない）、ヘッダ、EVPEND 0（空になった）
  assert.deepEqual(r.m.thread(1).dataStack(), [1, 1, 0x0000_0000, 0]);
});

// ---------------------------------------------------------------- 時間のかかる操作

test('除算器：32サイクルかかり、その間は次の発行を待つ（THREADSTAT 5）', () => {
  const m = new Machine('9K');
  m.load(ORG, assemble('PUSHQ #7\nPUSHQ #2\nDIVU\nHALT', { origin: ORG }).bytes);
  haltOthers(m, [0]);
  m.thread(0).pc = ORG;
  const events = [];
  m.on(e => events.push(e));
  const states = [];
  while (m.running) { m.step(); states.push(m.thread(0).state); }
  const ex = execs(events, 0);
  assert.deepEqual(ex.map(e => e.cycle), [0, 4, 8, 40, 44]); // SLIT、SLIT、DIVU、slot6のNOP、HALT
  assert.ok(states.includes(S.PARKED));
  assert.deepEqual(m.thread(0).dataStack(), [1, 3]);
});

test('除算器は1コアに1個。使用中なら空くまで待ち、発行した順に使う（T-24）', () => {
  const r = runThreads('a: PUSHQ #7\nPUSHQ #2\nDIVU\nHALT', { threads: { 0: 'a', 1: 'a' }, trace: true });
  const div = tid => execs(r.events, tid).find(e => e.inst.sub === 21).cycle;
  const after = tid => execs(r.events, tid).find(e => e.cycle > div(tid)).cycle;
  assert.equal(div(0), 8);
  assert.equal(div(1), 9);
  assert.equal(after(0), 8 + 32);
  assert.equal(after(1), 8 + 64);   // スレッド0の除算が終わってから32サイクル
});

test('20Kでは除算器はコアごと', () => {
  const r = runThreads('a: PUSHQ #7\nPUSHQ #2\nDIVU\nHALT', { config: '20K', threads: { 0: 'a', 0x10: 'a' }, trace: true });
  const after = tid => execs(r.events, tid)[3].cycle;
  assert.equal(after(0), 40);
  assert.equal(after(0x10), 40);
});

test('外部RAMへのアクセスは8サイクル（T-25）', () => {
  const r = runThreads('a: LD $01000000\nl: HALT', { threads: { 0: 'a' }, trace: true });
  // LIT（0）、@（4）、NOP…（12〜）
  assert.deepEqual(execs(r.events, 0).map(e => e.cycle).slice(0, 3), [0, 4, 12]);
  const st = runThreads('a: PUSHQ #1\nST $01000000\nl: HALT', { threads: { 0: 'a' }, trace: true });
  assert.deepEqual(execs(st.events, 0).map(e => e.cycle).slice(0, 4), [0, 4, 8, 16]);
});

test('自コアのローカルBSRAMは待たない。他コアのローカル（2サイクル）はDに隠れる', () => {
  let r = runThreads('a: LD $00104000\nl: HALT', { threads: { 0: 'a' }, trace: true });
  assert.deepEqual(execs(r.events, 0).map(e => e.cycle).slice(0, 3), [0, 4, 8]);
  r = runThreads('a: LD $00110000\nl: HALT', { config: '20K', threads: { 0: 'a' }, trace: true });
  assert.deepEqual(execs(r.events, 0).map(e => e.cycle).slice(0, 3), [0, 4, 8]);
});

test('待ち時間は構成で変えられる', () => {
  const r = runThreads('a: LD $01000000\nl: HALT', { config: { ...new Machine('9K').cfg, extRamLatency: 20 }, threads: { 0: 'a' }, trace: true });
  assert.deepEqual(execs(r.events, 0).map(e => e.cycle).slice(0, 3), [0, 4, 24]);
});

test('resetThread（THREADCTL）：メールボックスを空にし、送信の待ちを取り消す（T-87）', () => {
  const src = `
a:      PUSHQ #8
        PUSHQ #3
        SEND 0
        HALT`;
  const setup = m => { m.thread(3).mbox = new Array(64).fill(0); };
  const r = runThreads(src, { threads: { 1: 'a', 2: 'a' }, setup });
  const m = r.m;
  assert.deepEqual(m.thread(3).sendQueue, [1, 2]);
  // 送信を待っているスレッド1をリセット：待ち行列から外れる
  m.resetThread(1);
  assert.deepEqual(m.thread(3).sendQueue, [2]);
  assert.equal(m.thread(1).state, S.RESET);
  // 受信側のスレッド3をリセット：受信FIFOは空になるが、送信の待ち行列（スレッド2）は残る
  m.resetThread(3);
  assert.deepEqual(m.thread(3).mbox, []);
  assert.deepEqual(m.thread(3).sendQueue, [2]);
});
