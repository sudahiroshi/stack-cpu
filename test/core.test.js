// 段階2：1スレッドの命令実行のテスト（命令ごとのスタック効果と結果）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Machine } from '../sim/machine.js';
import { makeConfig } from '../sim/config.js';
import { decodeWord } from '../sim/decode.js';
import { OP, SYS, EXC, RESET, ISA_VERSION } from '../sim/isa.js';
import { THREAD_STATE } from '../sim/devices/registers.js';
import { assemble } from '../asm/assembler.js';
import { run, runWords, haltOthers, W, ORG, UP } from './helpers.js';

const u = v => v >>> 0;
const TRUE = 0xFFFFFFFF;

/** src の後に HALT を付けて実行し、例外が起きずにHALTで止まったことを確かめてスタックを返す */
function stackOf(src, opts) {
  const r = run(`${src}\nHALT`, opts);
  assert.equal(r.exc, null, `例外が起きた: ${JSON.stringify(r.exc)}`);
  assert.equal(r.th.state, THREAD_STATE.HALT);
  return r.stack;
}

/** 例外が起きることを確かめ、その記録を返す */
function excOf(src, opts) {
  const r = run(src, opts);
  assert.ok(r.exc, '例外が起きなかった');
  return { ...r.exc, r };
}

// ---------------------------------------------------------------- リセット

test('リセット時の状態（11.1節）', () => {
  const m = new Machine('9K');
  const th = m.thread(0);
  assert.equal(th.pc, RESET.PC);
  assert.equal(th.mode, 1);
  assert.equal(th.depth, 0);
  assert.equal(th.rdepth, 0);
  assert.equal(th.up, 0);
  assert.equal(th.vbr, RESET.VBR);
  // 全スレッドがリセット直後の状態（THREADSTAT 0）で、同じ番地から始まる
  for (const t of m.threads) {
    assert.equal(t.state, THREAD_STATE.RESET);
    assert.equal(t.pc, RESET.PC);
  }
});

test('ブートROMに読み込んで 0xFFFF_0000 から実行できる', () => {
  const m = new Machine('9K');
  const r = assemble(readFileSync(new URL('../rom/boot.asm', import.meta.url), 'utf8'));
  m.load(r.origin, r.bytes);
  assert.equal(m.runUntilStop(1000).stopped, true);
  assert.equal(m.thread(0).lastException, null);
  assert.equal(m.thread(0).state, THREAD_STATE.HALT);
});

// ---------------------------------------------------------------- 基本命令

test('NOP', () => assert.deepEqual(stackOf('NOP\nNOP'), []));

test('LIT（定数語を読む）', () => {
  assert.deepEqual(stackOf('PUSH #$12345678\nPUSH #-1'), [0x12345678, TRUE]);
});

test('SLIT（符号付き5bit）', () => {
  assert.deepEqual(stackOf('PUSHQ #-16\nPUSHQ #15\nPUSHQ #0'), [u(-16), 15, 0]);
});

test('UA は UP | (n<<2)', () => {
  assert.deepEqual(stackOf('LEA 0,U\nLEA 5,U\nLEA 31,U', { up: 0x0010_4080 }), [0x0010_4080, 0x0010_4094, 0x0010_40FC]);
});

test('DUP DROP SWAP OVER', () => {
  assert.deepEqual(stackOf('PUSHQ #1\nPUSHQ #2\nDUP'), [1, 2, 2]);
  assert.deepEqual(stackOf('PUSHQ #1\nPUSHQ #2\nDROP'), [1]);
  assert.deepEqual(stackOf('PUSHQ #1\nPUSHQ #2\nSWAP'), [2, 1]);
  assert.deepEqual(stackOf('PUSHQ #1\nPUSHQ #2\nOVER'), [1, 2, 1]);
});

test('>R R> R@', () => {
  const r = run('PUSHQ #7\nPSHR\nPEEKR\nHALT');
  assert.deepEqual(r.stack, [7]);
  assert.deepEqual(r.rstack, [7]);
  assert.deepEqual(stackOf('PUSHQ #7\nPSHR\nPUSHQ #1\nPULR'), [1, 7]);
});

test('+ と - は32bitで回る', () => {
  assert.deepEqual(stackOf('PUSH #$FFFFFFFF\nPUSHQ #2\nADD'), [1]);
  assert.deepEqual(stackOf('PUSHQ #1\nPUSHQ #2\nSUB'), [TRUE]);
  assert.deepEqual(stackOf('PUSHQ #10\nPUSHQ #3\nSUB'), [7]);
});

test('AND OR XOR', () => {
  assert.deepEqual(stackOf('PUSH #$F0F0\nPUSH #$FF00\nAND'), [0xF000]);
  assert.deepEqual(stackOf('PUSH #$F0F0\nPUSH #$FF00\nOR'), [0xFFF0]);
  assert.deepEqual(stackOf('PUSH #$F0F0\nPUSH #$FF00\nEOR'), [0x0FF0]);
  assert.deepEqual(stackOf('PUSHQ #5\nPUSHQ #-1\nEOR'), [u(~5)]); // INVERT
});

test('LSHIFT・RSHIFT（論理シフト、シフト量は下位5bit）', () => {
  assert.deepEqual(stackOf('PUSHQ #1\nPUSH #31\nLSL'), [0x8000_0000]);
  assert.deepEqual(stackOf('PUSHQ #1\nPUSH #33\nLSL'), [2]);
  assert.deepEqual(stackOf('PUSH #$80000000\nPUSH #31\nLSR'), [1]);
  assert.deepEqual(stackOf('PUSH #$80000000\nPUSH #32\nLSR'), [0x8000_0000]);
  assert.deepEqual(stackOf('PUSHQ #-1\nPUSHQ #4\nLSR'), [0x0FFF_FFFF]);
});

test('UM*（符号なし32×32→64、lo hi の順）', () => {
  assert.deepEqual(stackOf('PUSHQ #-1\nPUSHQ #-1\nMULU'), [1, 0xFFFF_FFFE]);
  assert.deepEqual(stackOf('PUSHQ #6\nPUSHQ #7\nMULU'), [42, 0]);
});

test('= < U<（真＝−1、偽＝0）', () => {
  assert.deepEqual(stackOf('PUSHQ #3\nPUSHQ #3\nCMPEQ\nPUSHQ #3\nPUSHQ #4\nCMPEQ'), [TRUE, 0]);
  assert.deepEqual(stackOf('PUSHQ #-1\nPUSHQ #1\nCMPLT\nPUSHQ #1\nPUSHQ #-1\nCMPLT'), [TRUE, 0]);
  assert.deepEqual(stackOf('PUSHQ #-1\nPUSHQ #1\nCMPLO\nPUSHQ #1\nPUSHQ #-1\nCMPLO'), [0, TRUE]);
  assert.deepEqual(stackOf('PUSHQ #2\nPUSHQ #2\nCMPLT'), [0]);
});

test('@ ! C@ C!（リトルエンディアン、C@はゼロ拡張）', () => {
  const r = run(`
    PUSH #$11223344
    ST 0,U
    LD 0,U
    LEA 0,U
    ADD #1
    LDB
    PUSH #$AB
    LEA 0,U
    ADD #2
    STB
    LD 0,U
    PUSH #$FF
    LEA 1,U
    STB
    LEA 1,U
    LDB
    HALT`);
  assert.equal(r.exc, null);
  assert.deepEqual(r.stack, [0x11223344, 0x33, 0x11AB3344, 0xFF]);
  assert.equal(r.m.mem.read32(UP), 0x11AB3344);
});

test('JMP', () => {
  assert.deepEqual(stackOf('BRA skip\nPUSHQ #1\nskip: PUSHQ #2'), [2]);
});

test('JZ：0なら分岐、0でなければ次の語へ（語の残りは実行しない）', () => {
  assert.deepEqual(stackOf('PUSHQ #0\nBZ skip\nPUSHQ #1\nskip: PUSHQ #2'), [2]);
  assert.deepEqual(stackOf('PUSHQ #5\nBZ skip\nPUSHQ #1\nskip: PUSHQ #2'), [1, 2]);
});

test('JZ で分岐しないときの「次の語」は定数語の後ろ', () => {
  // 語0：LIT LIT JZ、定数語2つ、語3：PUSHQ #9
  const r = run('PUSH #1\nPUSH #2\nBZ skip\nPUSHQ #9\nHALT\nskip: HALT');
  assert.equal(r.exc, null);
  assert.deepEqual(r.stack, [1, 9]);
});

test('後方への分岐でループ（1+2+…+10）', () => {
  assert.deepEqual(stackOf(`
        PUSHQ #0
        PUSHQ #10
  loop: PUSH T
        PSHR
        ADD
        PULR
        ADD #-1
        PUSH T
        BNZ loop
        POP`), [55]);
});

test('CALL と RET（戻り先は次の語。定数語の後ろ）', () => {
  const r = run('PUSH #7\nBSR f\nPUSHQ #1\nHALT\nf: PUSHQ #2\nRTS');
  assert.equal(r.exc, null);
  assert.deepEqual(r.stack, [7, 2, 1]);
  assert.deepEqual(r.rstack, []);
});

test('CALL が積む戻り先の値', () => {
  const r = run('BSR f\nf: HALT');
  assert.deepEqual(r.rstack, [ORG + 4]);
});

test('RET の後ろのスロットは実行しない', () => {
  // f の語：RET の後ろに PUSHQ を手で置く（アセンブラは作らない語）
  const words = [
    W([OP.CALL]) | 2,                      // 0: CALL +2
    W([OP.SYS, SYS.HALT]),                 // 1: HALT
    W([OP.SLIT, 1, OP.RET, OP.SLIT, 9]),   // 2: SLIT 1  RET  SLIT 9（実行されない）
  ];
  const r = runWords(words);
  assert.equal(r.exc, null);
  assert.deepEqual(r.stack, [1]);
});

test('EXEC（間接呼び出し、戻り先は次の語）', () => {
  const r = run('LEA f,PC\nJSR (T)\nPUSHQ #1\nHALT\nf: PUSHQ #2\nRTS');
  assert.equal(r.exc, null);
  assert.deepEqual(r.stack, [2, 1]);
});

test('slot6 の命令（01＝RET、10＝+、11＝DUP）を実行する', () => {
  assert.deepEqual(stackOf('PUSHQ #1\nPUSHQ #2\nPUSHQ #3\nADD'), [1, 5]);
  assert.deepEqual(stackOf('PUSHQ #1\nPUSHQ #2\nPUSHQ #3\nDUP'), [1, 2, 3, 3]);
  const r = run('BSR f\nHALT\nf: PUSHQ #1\nPUSHQ #2\nPUSHQ #3\nRTS');
  assert.equal(r.asm.words[2] & 3, 1); // slot6＝RET
  assert.equal(r.exc, null);
  assert.deepEqual(r.stack, [1, 2, 3]);
});

// ---------------------------------------------------------------- SYS拡張

test('TID', () => assert.deepEqual(stackOf('TID'), [0]));

test('FENCE は何もしない', () => assert.deepEqual(stackOf('PUSHQ #1\nFENCE'), [1]));

test('XCHG（古い値を返し、新しい値を書く）', () => {
  const r = run('PUSHQ #5\nST 0,U\nPUSHQ #9\nLEA 0,U\nXCHG\nHALT');
  assert.equal(r.exc, null);
  assert.deepEqual(r.stack, [5]);
  assert.equal(r.m.mem.read32(UP), 9);
});

test('PCREL はオフセット語自身のアドレス＋オフセット', () => {
  const r = run('LEA d,PC\nLEA d,PC\nLD\nHALT\nd: DC.L $CAFEBABE');
  assert.equal(r.exc, null);
  assert.deepEqual(r.stack, [r.asm.symbols.get('d'), 0xCAFEBABE]);
});

test('UP@ UP!', () => {
  assert.deepEqual(stackOf('PUSH #$00104100\nPOP U\nPUSH U'), [0x0010_4100]);
  const e = excOf('PUSH #$00104140\nPOP U\nHALT');
  assert.equal(e.exc, EXC.ALIGN);
  assert.equal(e.eaddr, 0x0010_4140);
});

test('SP@ RP@ は実行する直前の深さ', () => {
  assert.deepEqual(stackOf('PUSHQ #1\nPUSHQ #2\nPUSH SP'), [1, 2, 2]);
  assert.deepEqual(stackOf('PUSH SP'), [0]);
  assert.deepEqual(stackOf('PUSHQ #1\nPSHR\nPUSHQ #1\nPSHR\nPUSH RP'), [2]);
});

test('SP!：深さを減らす・増やす（増やした段は以前の値。T-12）', () => {
  assert.deepEqual(stackOf('PUSHQ #1\nPUSHQ #2\nPUSHQ #3\nPUSHQ #1\nPOP SP'), [1]);
  // 1 2 3 を積んで深さ1にし、3を積んで深さ3に戻す → ds[1] は上書きされ、ds[2] は残っている
  assert.deepEqual(stackOf('PUSHQ #1\nPUSHQ #2\nPUSHQ #3\nPUSHQ #1\nPOP SP\nPUSHQ #3\nPOP SP'), [1, 3, 3]);
});

test('SP!：書いたことのない段は0（T-12）', () => {
  // ds[0] には SP! の引数の4が残る
  assert.deepEqual(stackOf('PUSHQ #4\nPOP SP'), [4, 0, 0, 0]);
});

test('RP!', () => {
  const r = run('PUSHQ #9\nPSHR\nPUSHQ #9\nPSHR\nPUSHQ #1\nPOP RP\nHALT');
  assert.equal(r.exc, null);
  assert.deepEqual(r.rstack, [9]);
});

test('SP!・RP!に範囲外の値を与えると、次の語のフェッチ時に例外（T-13）', () => {
  let e = excOf('PUSH #17\nPOP SP\nNOP');     // 9Kの容量は16
  assert.equal(e.exc, EXC.DSTACK_OVER);
  assert.equal(e.epc, ORG + 8);               // 語0、定数語、語2
  e = excOf('PUSHQ #-1\nPOP SP\nNOP');
  assert.equal(e.exc, EXC.DSTACK_UNDER);
  e = excOf('PUSH #14\nPOP RP\nNOP');         // リターンスタックの容量は16−3＝13
  assert.equal(e.exc, EXC.RSTACK_OVER);
  e = excOf('PUSHQ #-1\nPOP RP\nNOP');
  assert.equal(e.exc, EXC.RSTACK_UNDER);
});

test('SYSCALL は例外8。戻り先は次の語', () => {
  const e = excOf('PUSHQ #1\nTRAP\nHALT');
  assert.equal(e.exc, EXC.SYSCALL);
  assert.equal(e.epc, ORG);
  assert.equal(e.resumeAddr, ORG + 4);
  assert.deepEqual(e.r.stack, [1]); // そのスロットまで実行している
});

test('RETI：戻り先とモード（bit0）を戻す', () => {
  // 一般モードに移ってから HALT（特権命令）で例外6
  const e = excOf('LEA user,PC\nPSHR\nRTI\nuser: PUSHQ #3\nHALT');
  assert.equal(e.exc, EXC.PRIVILEGE);
  assert.equal(e.mode, 0);
  assert.equal(e.epc, e.r.asm.symbols.get('user'));
  assert.deepEqual(e.r.stack, []); // フェッチ時の例外なので語は実行しない
  // bit0＝1なら特権モードのまま
  assert.deepEqual(stackOf('LEA priv,PC\nADD #1\nPSHR\nRTI\npriv: PUSHQ #3'), [3]);
});

test('HALT', () => {
  const r = run('PUSHQ #1\nHALT\nPUSHQ #2');
  assert.equal(r.th.state, THREAD_STATE.HALT);
  assert.equal(r.exc, null);
  assert.deepEqual(r.stack, [1]);
});

test('CSR@：構成の値（9K）', () => {
  assert.deepEqual(stackOf('MFC 0\nMFC 1\nMFC 2\nMFC 3\nMFC 4\nMFC 5\nMFC 6\nMFC 7\nMFC 8\nMFC 10'),
    [ISA_VERSION, 3, 1, 8, 16, 24 * 1024, 8 * 1024 * 1024, 64, 1, RESET.VBR]);
  assert.equal(ISA_VERSION, 0x0005);
});

test('CSR@：構成の値（20K）', () => {
  assert.deepEqual(stackOf('MFC 2\nMFC 3\nMFC 4', { config: '20K' }), [2, 8, 32]);
});

test('CSR!：VBR、ESCRATCH0・1、PKREAD・PKWRITE は書ける', () => {
  assert.deepEqual(stackOf(`
    PUSH #$00105000
    MTC 10
    PUSHQ #1
    MTC 16
    PUSHQ #2
    MTC 17
    PUSHQ #3
    MTC 18
    PUSHQ #4
    MTC 19
    MFC 10
    MFC 16
    MFC 17
    MFC 18
    MFC 19`), [0x0010_5000, 1, 2, 3, 4]);
});

test('存在しないCSR・読み出し専用のCSRへのCSR!は例外4（フェッチ時。T-18）', () => {
  // アセンブラは MFC 22 をエラーにするので、命令語を手で作る
  const r = runWords([W([OP.SYS, SYS['CSR@'], 22])]);
  assert.equal(r.exc.exc, EXC.ILLEGAL);
  let e = excOf('PUSHQ #0\nMTC 0');
  assert.equal(e.exc, EXC.ILLEGAL);
  assert.deepEqual(e.r.stack, []); // 語は実行しない
  e = excOf('PUSHQ #0\nMTC 20');
  assert.equal(e.exc, EXC.ILLEGAL);
});

test('一般モード：CSR@ #0〜#9 はよい、#10以降とCSR!は例外6', () => {
  let e = excOf('MFC 9\nl: MFC 10', { mode: 0 });
  assert.equal(e.exc, EXC.PRIVILEGE);
  assert.equal(e.epc, ORG + 4);
  assert.deepEqual(e.r.stack, [0]);
  e = excOf('PUSHQ #0\nMTC 16', { mode: 0 });
  assert.equal(e.exc, EXC.PRIVILEGE);
  for (const src of ['PUSH #$00104000\nPOP U', 'PUSHQ #0\nPOP SP', 'PUSHQ #0\nPOP RP', 'HALT', 'PUSHQ #0\nPSHR\nRTI']) {
    assert.equal(excOf(src, { mode: 0 }).exc, EXC.PRIVILEGE, src);
  }
});

test('INSTRET は実行した命令数（埋め草のNOPとslot6を含み、オペランド用のスロットは数えない。T-10、T-19、T-81）', () => {
  assert.deepEqual(stackOf('NOP\nNOP\nMFC 20\nMFC 21'), [2, 0]);
  // 語0：SLIT、SP!、NOP、NOP、slot6のNOP（5命令）、語1：HALT（1命令）
  const r = run('PUSHQ #0\nPOP SP\nHALT');
  assert.equal(r.th.instret, 6);
});

test('M*（符号付き）', () => {
  assert.deepEqual(stackOf('PUSHQ #-3\nPUSHQ #5\nMULS'), [u(-15), TRUE]);
  assert.deepEqual(stackOf('PUSH #$80000000\nPUSH #$80000000\nMULS'), [0, 0x4000_0000]);
});

test('U/MOD（0除算は商＝全ビット1、余り＝被除数）', () => {
  assert.deepEqual(stackOf('PUSHQ #7\nPUSHQ #2\nDIVU'), [1, 3]);
  assert.deepEqual(stackOf('PUSHQ #-1\nPUSHQ #2\nDIVU'), [1, 0x7FFF_FFFF]);
  assert.deepEqual(stackOf('PUSHQ #7\nPUSHQ #0\nDIVU'), [7, TRUE]);
});

test('/MOD（0方向への切り捨て、−2³¹÷−1、0除算）', () => {
  assert.deepEqual(stackOf('PUSHQ #-7\nPUSHQ #2\nDIVS'), [u(-1), u(-3)]);
  assert.deepEqual(stackOf('PUSHQ #7\nPUSHQ #-2\nDIVS'), [1, u(-3)]);
  assert.deepEqual(stackOf('PUSHQ #-7\nPUSHQ #-2\nDIVS'), [u(-1), 3]);
  assert.deepEqual(stackOf('PUSH #$80000000\nPUSHQ #-1\nDIVS'), [0, 0x8000_0000]);
  assert.deepEqual(stackOf('PUSHQ #-7\nPUSHQ #0\nDIVS'), [u(-7), TRUE]);
});

test('UM/MOD（64÷32、商があふれたら商＝全ビット1・余り＝0。T-21）', () => {
  assert.deepEqual(stackOf('PUSHQ #1\nPUSHQ #1\nPUSHQ #2\nDIVUL'), [1, 0x8000_0000]);
  assert.deepEqual(stackOf('PUSHQ #7\nPUSHQ #0\nPUSHQ #2\nDIVUL'), [1, 3]);
  assert.deepEqual(stackOf('PUSHQ #7\nPUSHQ #5\nPUSHQ #5\nDIVUL'), [0, TRUE]);
  assert.deepEqual(stackOf('PUSHQ #7\nPUSHQ #0\nPUSHQ #0\nDIVUL'), [0, TRUE]); // u＝0 も hi ≥ u（T-83）
});

test('拡張命令がハードウェアにない構成では例外18（そのスロットまで実行し、戻り先は次の語）', () => {
  const config = makeConfig('9K', { features: 0 });
  for (const op of ['MULS', 'DIVU', 'DIVS']) {
    const e = excOf(`PUSHQ #7\nPUSHQ #2\n${op}\nHALT`, { config });
    assert.equal(e.exc, EXC.UNIMPL, op);
    assert.deepEqual(e.r.stack, [7, 2], op); // オペランドはスタックに残る
    assert.equal(e.resumeAddr, ORG + 4, op);
    assert.equal(e.eslot, 4, op);
  }
  assert.equal(excOf('PUSHQ #1\nPUSHQ #2\nPUSHQ #3\nDIVUL\nHALT', { config }).exc, EXC.UNIMPL);
  // M*だけあって除算器がない構成
  const mulOnly = makeConfig('9K', { features: 2 });
  assert.deepEqual(stackOf('PUSHQ #2\nPUSHQ #3\nMULS', { config: mulOnly }), [6, 0]);
  assert.equal(excOf('PUSHQ #2\nPUSHQ #3\nDIVU\nHALT', { config: mulOnly }).exc, EXC.UNIMPL);
});

test('BRK はフェッチ時に例外9（語は実行しない、戻り先は語の先頭）', () => {
  const e = excOf('PUSHQ #1\nBKPT\nHALT');
  assert.equal(e.exc, EXC.BREAK);
  assert.equal(e.eslot, 2);
  assert.equal(e.resumeAddr, ORG);
  assert.deepEqual(e.r.stack, []);
});

// ---------------------------------------------------------------- フェッチ時の判定

test('配置違反（例外5）と不正命令（例外4）はフェッチ時', () => {
  let r = runWords([W([OP.EXEC, OP.DUP])]);
  assert.equal(r.exc.exc, EXC.PLACEMENT);
  assert.equal(r.exc.eir, W([OP.EXEC, OP.DUP]));
  r = runWords([W([OP.SLIT, 1, OP.SYS, 25])]);
  assert.equal(r.exc.exc, EXC.ILLEGAL);
  assert.equal(r.exc.eslot, 2);
  assert.deepEqual(r.stack, []);
});

test('語の最後に置く命令の後ろのNOPもデコードの並びに入る（T-10）', () => {
  const d = decodeWord(W([OP.SLIT, 0, OP.SYS, SYS['SP!']]));
  assert.deepEqual(d.insts.map(i => i.slot), [0, 2, 4, 5, 6]);
  assert.equal(d.fault, null);
});

test('スタック深さはフェッチ時に判定し、違反した語は実行しない', () => {
  let e = excOf('PUSHQ #1\nPOP\nPOP');          // 1語：SLIT DROP DROP
  assert.equal(e.exc, EXC.DSTACK_UNDER);
  assert.equal(e.eslot, 3);
  assert.deepEqual(e.r.stack, []);
  // PUSHQ は1語に3つ詰まる。16個目と17個目を含む語（深さ15から17になる）はまとめて実行しない
  e = excOf(Array(17).fill('PUSHQ #1').join('\n'));
  assert.equal(e.exc, EXC.DSTACK_OVER);
  assert.equal(e.eslot, 2);
  assert.equal(e.r.stack.length, 15);
  e = excOf('PULR');
  assert.equal(e.exc, EXC.RSTACK_UNDER);
  // 1語に2組。13組目と14組目を含む語（12から14になる）は実行しない（容量は16−3＝13）
  e = excOf(Array(14).fill('PUSHQ #1\nPSHR').join('\n'));
  assert.equal(e.exc, EXC.RSTACK_OVER);
  assert.equal(e.r.rstack.length, 12);
});

test('slot6 の DUP もスタック深さの判定に入る（T-01）', () => {
  // 深さ16で、slot6がDUPの語
  const r = runWords([W([0, 0, 0, 0, 0, 0], 3)], { setup: (m, th) => { th.depth = 16; } });
  assert.equal(r.exc.exc, EXC.DSTACK_OVER);
  assert.equal(r.exc.eslot, 6);
});

test('優先順位：例外4は例外6より先（T-32）', () => {
  assert.equal(excOf('PUSHQ #0\nMTC 0', { mode: 0 }).exc, EXC.ILLEGAL);
});

// ---------------------------------------------------------------- メモリの例外

test('境界違反（例外10）', () => {
  let e = excOf('LEA 0,U\nADD #1\nLD\nHALT');
  assert.equal(e.exc, EXC.ALIGN);
  assert.equal(e.eaddr, UP + 1);
  e = excOf('PUSHQ #0\nLEA 0,U\nADD #2\nST\nHALT');
  assert.equal(e.exc, EXC.ALIGN);
  e = excOf('PUSHQ #0\nLEA 0,U\nADD #2\nXCHG\nHALT');
  assert.equal(e.exc, EXC.ALIGN);
  e = excOf('LEA f,PC\nADD #2\nJSR (T)\nf: HALT');
  assert.equal(e.exc, EXC.ALIGN);
  e = excOf('PUSHQ #6\nPSHR\nRTS');             // RETで下位2bitが0でない
  assert.equal(e.exc, EXC.ALIGN);
  assert.equal(e.eaddr, 6);
});

test('バスエラー（例外11）', () => {
  assert.equal(excOf('LD 0').exc, EXC.BUS);                    // ヌルポインタ
  assert.equal(excOf('LD $000FFFFC').exc, EXC.BUS);
  assert.equal(excOf('LD $00106000').exc, EXC.BUS);            // ローカルの窓のうち容量（24KB）の外（T-14）
  assert.equal(excOf('LD $00110000').exc, EXC.BUS);            // 9Kにはコア1がない
  assert.equal(excOf('LD $01800000').exc, EXC.BUS);            // 外部RAMの外
  assert.equal(excOf('LD $FF000000').exc, EXC.BUS);            // 未登録のI/O
  assert.equal(excOf('LD $FFFF1000').exc, EXC.BUS);            // ROMの外
  const e = excOf('PUSHQ #0\nST $00106000');
  assert.equal(e.exc, EXC.BUS);
  assert.equal(e.eaddr, 0x0010_6000);
});

test('外部RAMとローカルBSRAMは読み書きでき、初期値は0（T-15）', () => {
  assert.deepEqual(stackOf('LD $01000000\nPUSH #123\nST $017FFFFC\nLD $017FFFFC\nLD $00105FFC'), [0, 123, 0]);
});

test('ブートROMへの書き込みは例外12、読み出しはできる', () => {
  assert.equal(excOf('PUSHQ #0\nST $FFFF0000').exc, EXC.PROTECT);
  assert.equal(excOf('PUSHQ #0\nPUSH #$FFFF0003\nSTB').exc, EXC.PROTECT);
  assert.deepEqual(stackOf('LD $FFFF0000'), [0]);
});

test('I/Oへの8bitアクセスは、8bitを許すデバイスだけ（T-16）', () => {
  const setup = m => {
    m.mem.mapDevice(0xFF00_2000, { name: '32bitだけ', size: 0x10, read32: () => 0x1234, write32: () => {} });
    m.mem.mapDevice(0xFF01_0000, { name: '8bitも', size: 0x10, read32: () => 0, write32: () => {}, read8: off => off + 0x40, write8: () => {} });
  };
  assert.deepEqual(stackOf('LD $FF002000\nPUSH #$FF010003\nLDB', { setup }), [0x1234, 0x43]);
  const e = excOf('PUSH #$FF002000\nLDB\nHALT', { setup });
  assert.equal(e.exc, EXC.ALIGN);
  assert.equal(excOf('PUSHQ #0\nPUSH #$FF002000\nSTB\nHALT', { setup }).exc, EXC.ALIGN);
});

test('命令フェッチは自コアのローカルBSRAMとブートROMからだけ（例外7）', () => {
  let e = excOf('PUSH #$01000000\nJSR (T)');
  assert.equal(e.exc, EXC.FETCH);
  assert.equal(e.epc, 0x0100_0000);
  assert.equal(e.eaddr, 0x0100_0000);
  e = excOf('PUSH #$00106000\nJSR (T)');           // ローカルの容量の外（T-82）
  assert.equal(e.exc, EXC.FETCH);
  e = excOf('PUSH #$00110000\nJSR (T)', { config: '20K' }); // 他コアのローカル
  assert.equal(e.exc, EXC.FETCH);
});

test('他コアのローカルBSRAMへのXCHGは例外13（20K）', () => {
  const e = excOf('PUSHQ #1\nPUSH #$00110000\nXCHG\nHALT', { config: '20K' });
  assert.equal(e.exc, EXC.REMOTE_XCHG);
  assert.equal(e.eaddr, 0x0011_0000);
  // 普通の読み書きはできる
  assert.deepEqual(stackOf('PUSHQ #5\nST $00110000\nLD $00110000', { config: '20K' }), [5]);
});

test('分岐先が32bitの範囲外になったら例外7（T-80）', () => {
  // ORG（0x0010_0000）から −0x40001語 → −4
  const r = runWords([((OP.JMP << 27) | (-0x40001 & 0x7FF_FFFF)) >>> 0]);
  assert.equal(r.exc.exc, EXC.FETCH);
  assert.equal(r.exc.eaddr, ORG);
});

// ---------------------------------------------------------------- 時間とトレース

test('1スレッドだけなら D（4）サイクルごとに1命令。仮想時間はクロックから計算', () => {
  const r = run('NOP\nNOP\nHALT');        // NOP NOP HALT の3命令
  assert.equal(r.th.instret, 3);
  assert.equal(r.cycles, 4 * 2 + 1);      // 0、4、8サイクル目に発行
  const m = new Machine('9K');
  m.cycle = 54 * 1000;
  assert.equal(m.microseconds, 1000);     // 9Kは54MHz（T-11）
});

test('実行トレース（listeners）', () => {
  const m = new Machine('9K');
  const r = assemble('PUSHQ #1\nPUSHQ #2\nADD\nHALT', { origin: ORG });
  m.load(ORG, r.bytes);
  haltOthers(m, [0]);
  m.thread(0).pc = ORG;
  const events = [];
  m.on(e => events.push(e));
  m.runUntilStop(1000);
  const execs = events.filter(e => e.type === 'exec');
  assert.equal(execs.length, m.thread(0).instret);
  assert.deepEqual(execs.slice(0, 3).map(e => [e.slot, e.T, e.depth]), [[0, 1, 1], [2, 2, 2], [4, 3, 1]]);
});

test('例外のイベント', () => {
  const m = new Machine('9K');
  m.load(ORG, assemble('LD 0', { origin: ORG }).bytes);
  haltOthers(m, [0]);
  m.thread(0).pc = ORG;
  const events = [];
  m.on(e => events.push(e));
  m.runUntilStop(1000);
  assert.deepEqual(events.filter(e => e.type === 'exception').map(e => e.exc), [EXC.BUS]);
});

// ---------------------------------------------------------------- サンプル

test('examples/01_sum.asm：ユーザー変数0が55', () => {
  const r = run(readFileSync(new URL('../examples/01_sum.asm', import.meta.url), 'utf8'));
  assert.equal(r.exc, null);
  assert.equal(r.m.mem.read32(UP), 55);
  assert.deepEqual(r.stack, []);
});

test('examples/02_max.asm：ユーザー変数0が1000', () => {
  const r = run(readFileSync(new URL('../examples/02_max.asm', import.meta.url), 'utf8'));
  assert.equal(r.exc, null);
  assert.equal(r.m.mem.read32(UP), 1000);
});
