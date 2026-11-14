// 段階4：例外の入口と出口、二重例外、保護キーのテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Machine } from '../sim/machine.js';
import { makeConfig } from '../sim/config.js';
import { OP, SYS, EXC, IO } from '../sim/isa.js';
import { THREAD_STATE } from '../sim/devices/registers.js';
import { KEY } from '../sim/devices/keytable.js';
import { run, runWords, grantUserKey, W, ORG, NUM_VECTORS } from './helpers.js';

const S = THREAD_STATE;

/**
 * ローカルBSRAMに置くベクタ表（VBR＋番号×4）。handlers に挙げた番号はそのラベルへ分岐し、他はHALT。
 * 各ベクタを別の語にするため、1つずつラベルを付ける。
 */
function vectors(handlers = {}) {
  const lines = ['vectors:'];
  for (let n = 0; n < NUM_VECTORS; n++) lines.push(`v${n}: ${handlers[n] ? `BRA ${handlers[n]}` : 'HALT'}`);
  return lines.join('\n');
}
/** プログラムの先頭：VBRをローカルBSRAMのベクタ表に向ける（特権モード） */
const SET_VBR = 'LEA vectors,PC\nMTC 10';

/** 起きた例外のイベントを順に集めて実行する */
function runCollect(src, opts = {}) {
  const list = [];
  const r = run(src, {
    ...opts,
    setup: (m, th) => { m.on(e => { if (e.type === 'exception') list.push(e); }); opts.setup?.(m, th); },
  });
  return { ...r, list };
}

// ---------------------------------------------------------------- 入口と出口

test('SYSCALL：戻り先（次の語、bit0＝特権）を積んでベクタへ。RETIで次の語に戻る', () => {
  const r = run(`
        ${SET_VBR}
        PUSHQ #1
        TRAP
next:   PUSHQ #2
        HALT
h8:     PUSHQ #9
        PEEKR
        RTI
${vectors({ 8: 'h8' })}`);
  assert.equal(r.th.state, S.HALT);
  const next = r.asm.symbols.get('next');
  assert.deepEqual(r.stack, [1, 9, next | 1, 2]);
  assert.deepEqual(r.rstack, []);
  assert.equal(r.th.mode, 1);
});

test('一般モードからの例外：戻り先のbit0＝0、ハンドラは特権モード。ECAUSE・EPC・ESLOTを読める', () => {
  const r = run(`
        ${SET_VBR}
        LEA user,PC
        PSHR
        RTI
user:   PUSHQ #7
        TRAP
after:  HALT
h8:     PEEKR
        MFC 8
        MFC 11
        MFC 12
        MFC 14
        MFC 15
        HALT
${vectors({ 8: 'h8' })}`, { setup: grantUserKey });
  const sym = n => r.asm.symbols.get(n);
  assert.deepEqual(r.stack, [7, sym('after'), 1, EXC.SYSCALL, sym('user'), 2, 0]);
  assert.equal(r.th.state, S.HALT);
});

test('再開できる例外（スタックのアンダーフロー）：語の先頭からやり直す', () => {
  const r = runCollect(`
        ${SET_VBR}
        PUSHQ #1
start:  POP
        POP
        HALT
h1:     PUSHQ #5
        RTI
${vectors({ 1: 'h1' })}`);
  // 語「POP POP HALT」は深さ1でアンダーフロー → ハンドラが1つ積む → やり直して成功
  assert.deepEqual(r.list.map(e => e.exc), [EXC.DSTACK_UNDER]);
  assert.equal(r.list[0].resumeAddr, r.asm.symbols.get('start'));
  assert.equal(r.th.state, S.HALT);
  assert.deepEqual(r.stack, []);
  assert.deepEqual(r.rstack, []);
});

test('例外18：拡張命令をハンドラで代わりに実行し、次の語に戻る', () => {
  const r = runCollect(`
        ${SET_VBR}
        PUSHQ #7
        PUSHQ #2
        DIVU
        PUSHQ #9
        HALT
h18:    POP
        POP
        PUSHQ #1
        PUSHQ #3
        RTI
${vectors({ 18: 'h18' })}`, { config: makeConfig('9K', { features: 0 }) });
  assert.deepEqual(r.list.map(e => e.exc), [EXC.UNIMPL]);
  assert.deepEqual(r.stack, [1, 3, 9]);
});

test('BRK：戻り先は語の先頭', () => {
  const r = run(`
        ${SET_VBR}
brk:    PUSHQ #1
        BKPT
h9:     PEEKR
        MFC 12
        HALT
${vectors({ 9: 'h9' })}`);
  const brk = r.asm.symbols.get('brk');
  assert.deepEqual(r.stack, [brk | 1, brk]); // 語は実行していない（PUSHQ #1 もしていない）
});

test('ハンドラの中の例外は二重例外ではない（入れ子になる）', () => {
  const r = runCollect(`
        ${SET_VBR}
        TRAP
h8:     BKPT
${vectors({ 8: 'h8' })}`);
  assert.deepEqual(r.list.map(e => e.exc), [EXC.SYSCALL, EXC.BREAK]);
  assert.equal(r.th.state, S.HALT);      // ベクタ9のHALT
  assert.equal(r.rstack.length, 2);
});

test('例外の入口はレッドゾーンを使える（深さの判定の対象外）', () => {
  const r = run('PUSH #13\nPOP RP\nl: TRAP');  // 容量13いっぱい
  assert.equal(r.exc.exc, EXC.SYSCALL);
  assert.equal(r.th.state, S.HALT);
  assert.equal(r.rstack.length, 14);
});

// ---------------------------------------------------------------- 二重例外

test('二重例外：ベクタ先の語のフェッチで例外（T-31）', () => {
  const r = runCollect('PUSH #$01000000\nMTC 10\nl: TRAP');   // ベクタ表が外部RAM（フェッチできない）
  assert.deepEqual(r.list.map(e => e.exc), [EXC.SYSCALL, EXC.DOUBLE]);
  assert.equal(r.list[1].cause, EXC.FETCH);
  assert.equal(r.th.state, S.DOUBLE_FAULT);   // THREADSTAT 7
  assert.equal(r.th.ecause, EXC.DOUBLE);
});

test('二重例外：ベクタ先の語のフェッチ時の判定（BRK）でも二重例外', () => {
  const r = runCollect(`${SET_VBR}\nl: TRAP\n${vectors({})}`.replace('v8: HALT', 'v8: BKPT'));
  assert.deepEqual(r.list.map(e => e.exc), [EXC.SYSCALL, EXC.DOUBLE]);
  assert.equal(r.list[1].cause, EXC.BREAK);
});

test('二重例外：入口でリターンスタックに積めない（T-31）', () => {
  const r = runCollect('PUSH #16\nPOP RP\nNOP');  // 物理的な16段を使い切っている
  assert.deepEqual(r.list.map(e => e.exc), [EXC.DOUBLE]);
  assert.equal(r.list[0].cause, EXC.RSTACK_OVER);
  assert.equal(r.th.state, S.DOUBLE_FAULT);
});

test('二重例外で止まったスレッドは発行しない', () => {
  const r = runCollect('PUSH #$01000000\nMTC 10\nl: TRAP');
  assert.equal(r.m.running, false);
  const before = r.th.instret;
  r.m.run(100);
  assert.equal(r.th.instret, before);
  assert.equal(r.th.state, S.DOUBLE_FAULT);
});

// ---------------------------------------------------------------- 保護キー

test('保護キー表：C!で1ページ、!で4ページ。読み戻せる。範囲外のオフセットはバスエラー', () => {
  const r = run(`
        PUSH #$61
        PUSH #$FF080000
        STB
        PUSH #$44332211
        PUSH #$FF080004
        ST
        PUSH #$7F
        PUSH #$FF081002
        STB
        LD $FF080000
        PUSH #$FF080005
        LDB
        HALT`);
  assert.equal(r.exc, null);
  assert.deepEqual(r.stack, [0x61, 0x22]);
  assert.equal(r.m.keytable.ext[0], 0x61);
  assert.deepEqual([...r.m.keytable.ext.subarray(4, 8)], [0x11, 0x22, 0x33, 0x44]);
  assert.equal(r.m.keytable.local[0][2], 0x7F);
  assert.equal(run('LD $FF080800').exc.exc, EXC.BUS);   // 外部RAMは2048ページまで
  assert.equal(run('PUSH #$FF081040\nLDB').exc.exc, EXC.BUS); // ローカルは64項目まで
  assert.equal(run('LD $FF081100').exc.exc, EXC.BUS);   // 9Kにはコア1がない
});

test('リセットで全ページがキー0になる', () => {
  const m = new Machine('9K');
  m.keytable.ext[3] = 0x41;
  m.reset();
  assert.equal(m.keytable.ext[3], 0);
});

test('一般モード：読み出しは PKREAD[キー]、書き込みは PKWRITE[キー] かつ W（例外12）', () => {
  const user = { mode: 0 };   // ローカルBSRAMはキー1（W・X）、PKREAD＝PKWRITE＝キー1
  // 外部RAMのページ0はキー0：読めない
  let e = run('LD $01000000', user).exc;
  assert.equal(e.exc, EXC.PROTECT);
  assert.equal(e.eaddr, 0x0100_0000);
  // ページ0をキー1（W＝0）にすると読めるが書けない
  const ro = (m, th) => { grantUserKey(m, th); m.keytable.ext[0] = 1; };
  let r = run('LD $01000000\nPUSHQ #0\nST $01000000', { mode: 0, setup: ro });
  assert.equal(r.exc.exc, EXC.PROTECT);
  assert.deepEqual(r.stack, [0]);       // 読み出しはできた
  // Wがあっても PKWRITE にキーがなければ書けない
  const noPkw = (m, th) => { grantUserKey(m, th); m.keytable.ext[0] = 1 | KEY.W; th.pkwrite = 0; };
  assert.equal(run('PUSHQ #0\nST $01000000', { mode: 0, setup: noPkw }).exc.exc, EXC.PROTECT);
  // 外部RAMのページは4KB単位：ページ1は別のキー
  const p0 = (m, th) => { grantUserKey(m, th); m.keytable.ext[0] = 1 | KEY.W; };
  r = run('PUSHQ #5\nST $01000FFC\nLD $01000FFC\nLD $01001000', { mode: 0, setup: p0 });
  assert.equal(r.exc.exc, EXC.PROTECT);
  assert.equal(r.exc.eaddr, 0x0100_1000);
  assert.deepEqual(r.stack, [5]);
});

test('一般モード：XCHGは読み出しと書き込みの両方の権限が要る', () => {
  const ro = (m, th) => { grantUserKey(m, th); m.keytable.ext[0] = 1; };
  assert.equal(run('PUSHQ #0\nPUSH #$01000000\nXCHG', { mode: 0, setup: ro }).exc.exc, EXC.PROTECT);
});

test('一般モード：実行は PKREAD[キー] かつ X（違反は例外12。T-88）', () => {
  // f はローカルBSRAMのページ1（1KB単位）。そのページだけXを外す
  const src = 'LEA f,PC\nJSR (T)\nORG $00100400\nf: HALT';
  const noX = (m, th) => { grantUserKey(m, th); m.keytable.local[0][1] = 1 | KEY.W; };
  const e = run(src, { mode: 0, setup: noX }).exc;
  assert.equal(e.exc, EXC.PROTECT);
  assert.equal(e.epc, 0x0010_0400);
  assert.equal(e.eaddr, 0x0010_0400);
  assert.equal(e.eslot, 0);
});

test('一般モード：ブートROMは読み出しも実行もできない（T-34）', () => {
  assert.equal(run('LD $FFFF0000', { mode: 0 }).exc.exc, EXC.PROTECT);
  const e = run('PUSH #$FFFF0000\nJSR (T)', { mode: 0 }).exc;
  assert.equal(e.exc, EXC.PROTECT);
  assert.equal(e.epc, 0xFFFF_0000);
});

test('一般モード：I/Oはユーザーページ以外アクセスできない（例外12）', () => {
  // 一般モードのテストではHALTを書かない（HALTは特権命令なので、同じ語にあるとフェッチ時に例外6になる）
  assert.equal(run('LD $FF080000', { mode: 0 }).exc.exc, EXC.PROTECT);   // 保護キー表
  assert.equal(run('LD $FF000000', { mode: 0 }).exc.exc, EXC.PROTECT);   // UART（未登録でも12）
  assert.equal(run('PUSHQ #0\nPUSH #$FF080000\nSTB', { mode: 0 }).exc.exc, EXC.PROTECT);
  // ユーザーページは一般モードからアクセスできる（デバイスは段階5なので、いまはバスエラー）
  assert.equal(run(`LD $${IO.USERPAGE.toString(16)}`, { mode: 0 }).exc.exc, EXC.BUS);
});

test('特権モードはキーを検査しない', () => {
  const r = run('PUSHQ #3\nST $01000000\nLD $01000000\nLD $FFFF0000\nHALT');
  assert.equal(r.exc, null);
  assert.deepEqual(r.stack, [3, 0]);
});

// ---------------------------------------------------------------- 例外表（7.2節）

test('例外表のすべての例外（0〜15、18）を起こせる。16・17は起きない', () => {
  const user = { mode: 0 };
  const cases = [
    [EXC.DSTACK_OVER, () => run(Array(17).fill('PUSHQ #1').join('\n'))],
    [EXC.DSTACK_UNDER, () => run('POP')],
    [EXC.RSTACK_OVER, () => run(Array(14).fill('PUSHQ #1\nPSHR').join('\n'))],
    [EXC.RSTACK_UNDER, () => run('PULR')],
    [EXC.ILLEGAL, () => runWords([W([OP.SYS, 25])])],
    [EXC.PLACEMENT, () => runWords([W([OP.EXEC, OP.DUP])])],
    [EXC.PRIVILEGE, () => run('HALT', user)],
    [EXC.FETCH, () => run('PUSH #$01000000\nJSR (T)')],
    [EXC.SYSCALL, () => run('TRAP')],
    [EXC.BREAK, () => run('BKPT')],
    [EXC.ALIGN, () => run('LD $00104001')],
    [EXC.BUS, () => run('LD 0')],
    [EXC.PROTECT, () => run('PUSHQ #0\nST $FFFF0000')],
    [EXC.REMOTE_XCHG, () => run('PUSHQ #0\nPUSH #$00110000\nXCHG', { config: '20K' })],
    [EXC.BAD_TID, () => run('PUSHQ #8\nSIGNAL')],
    [EXC.DOUBLE, () => run('PUSH #$01000000\nMTC 10\nl: TRAP')],
    [EXC.UNIMPL, () => run('PUSHQ #1\nPUSHQ #1\nDIVU', { config: makeConfig('9K', { features: 0 }) })],
  ];
  const seen = new Set();
  for (const [exc, f] of cases) {
    const r = f();
    assert.equal(r.th.lastException?.exc, exc, `例外${exc}`);
    seen.add(exc);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [...Array(16).keys(), 18]);
  assert.ok(!seen.has(EXC.PAGE_DATA) && !seen.has(EXC.PAGE_INST));
});
