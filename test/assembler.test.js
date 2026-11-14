// アセンブラのテスト：ソース → 期待する命令語（16進）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { assemble, toReadmemh, AsmError } from '../asm/assembler.js';
import { decodeWord } from '../sim/decode.js';
import { disassembleWord } from '../asm/disasm.js';
import { OP, SYS, EXC } from '../sim/isa.js';

const asm = (src, opts) => assemble(src, opts).words.map(w => w.toString(16).toUpperCase().padStart(8, '0'));
/** スロットの値（slot0から）と slot6 から命令語を作る（期待値の確認用） */
const W = (slots, s6 = 0) => {
  let w = 0;
  slots.forEach((v, i) => { w |= v << (27 - 5 * i); });
  return ((w | s6) >>> 0).toString(16).toUpperCase().padStart(8, '0');
};
const asmErrors = src => {
  try { assemble(src); } catch (e) {
    if (e instanceof AsmError) return e.errors;
    throw e;
  }
  assert.fail('エラーにならなかった');
};

// ---- 詰め込み ----

test('2つのSLITを1語に詰める', () => {
  assert.deepEqual(asm('PUSHQ #0\nPUSHQ #10'), ['B82EA000']);
  assert.equal(W([OP.SLIT, 0, OP.SLIT, 10]), 'B82EA000');
});

test('6スロットを埋め、7番目の RET は slot6（01）に置く', () => {
  assert.deepEqual(asm('DUP\nDROP\nSWAP\nOVER\n+\n-\nRET'), [W([10, 11, 12, 13, 14, 15], 1)]);
  assert.deepEqual(asm('DUP DROP SWAP OVER + - RET'.split(' ').join('\n')), ['52D8D73D']);
});

test('slot6 には + と DUP も置ける。他の命令は次の語へ', () => {
  assert.deepEqual(asm('DUP\nDUP\nDUP\nDUP\nDUP\nDUP\n+'), [W([10, 10, 10, 10, 10, 10], 2)]);
  assert.deepEqual(asm('DROP\nDROP\nDROP\nDROP\nDROP\nDROP\nDUP'), [W([11, 11, 11, 11, 11, 11], 3)]);
  assert.deepEqual(asm('DUP\nDUP\nDUP\nDUP\nDUP\nDUP\nSWAP'), [W([10, 10, 10, 10, 10, 10]), W([12])]);
});

test('useSlot6: false なら slot6 は常にNOP', () => {
  assert.deepEqual(asm('DUP\nDUP\nDUP\nDUP\nDUP\nDUP\nRET', { useSlot6: false }),
    [W([10, 10, 10, 10, 10, 10]), W([5])]);
});

test('SLIT・UA・SYS は slot5 に置けない（次の語へ）', () => {
  assert.deepEqual(asm('DUP\nDUP\nDUP\nDUP\nDUP\nPUSHQ #1'), [W([10, 10, 10, 10, 10]), W([OP.SLIT, 1])]);
  assert.deepEqual(asm('DUP\nDUP\nDUP\nDUP\nDUP\nLEA 3,U'), [W([10, 10, 10, 10, 10]), W([OP.UA, 3])]);
  assert.deepEqual(asm('DUP\nDUP\nDUP\nDUP\nDUP\nTID'), [W([10, 10, 10, 10, 10]), W([OP.SYS, SYS.TID])]);
  assert.deepEqual(asm('DUP\nDUP\nDUP\nDUP\nTID'), [W([10, 10, 10, 10, OP.SYS, SYS.TID])]);
});

test('CSR@・SENDM は3スロット（slot4以降には置けない）', () => {
  assert.deepEqual(asm('DUP\nDUP\nDUP\nMFC 10'), [W([10, 10, 10, OP.SYS, SYS['CSR@'], 10])]);
  assert.deepEqual(asm('DUP\nDUP\nDUP\nDUP\nMFC 10'), [W([10, 10, 10, 10]), W([OP.SYS, SYS['CSR@'], 10])]);
  assert.deepEqual(asm('SEND 2'), [W([OP.SYS, SYS.SENDM, 2])]);
  assert.deepEqual(asm('TRYSEND 4'), [W([OP.SYS, SYS['SENDM?'], 4])]);
});

test('LIT の定数語は命令語の直後に、使う順で並ぶ', () => {
  assert.deepEqual(asm('PUSH #5\nDUP'), ['0A800000', '00000005']);
  assert.deepEqual(asm('PUSH #1\nPUSH #$FFFFFFFF\nPUSH #-2'),
    [W([OP.LIT, OP.LIT, OP.LIT]), '00000001', 'FFFFFFFF', 'FFFFFFFE']);
});

test('LIT は「次の語」の前に定数語を挟む（定数語の後が次の語）', () => {
  assert.deepEqual(asm('PUSH #7\nPUSH T\nPUSH T\nPUSH T\nPUSH T\nPUSH T\nPOP\nPOP'),
    [W([OP.LIT, 10, 10, 10, 10, 10]), '00000007', W([11, 11])]);
});

// ---- 語を閉じる命令 ----

test('EXEC・SYSCALL・拡張命令・SP!・RP! の後ろはNOPで埋めて語を閉じる', () => {
  assert.deepEqual(asm('DUP\nJSR (T)\nDUP'), [W([10, OP.EXEC]), W([10])]);
  assert.deepEqual(asm('DUP\nTRAP\nDUP'), [W([10, OP.SYS, SYS.SYSCALL]), W([10])]);
  assert.deepEqual(asm('DIVU\nDUP'), [W([OP.SYS, SYS['U/MOD']]), W([10])]);
  assert.deepEqual(asm('M*\nDUP'), [W([OP.SYS, SYS['M*']]), W([10])]);
  assert.deepEqual(asm('POP SP\nDUP'), [W([OP.SYS, SYS['SP!']]), W([10])]);
  assert.deepEqual(asm('RP!\nDUP'), [W([OP.SYS, SYS['RP!']]), W([10])]);
});

test('RET・RETI の後ろの命令は次の語へ', () => {
  assert.deepEqual(asm('DUP\nRTS\nDROP'), [W([10, 5]), W([11])]);
  assert.deepEqual(asm('RTI\nDROP'), [W([OP.SYS, SYS.RETI]), W([11])]);
});

// ---- 分岐 ----

test('1語のループ（オフセット0）', () => {
  assert.deepEqual(asm('loop: JMP loop'), ['10000000']);
  assert.deepEqual(asm('l: DUP\nJMP l'), ['50800000']);
});

test('前方への分岐と後方への分岐（符号付き、語単位）', () => {
  // JZ skip（語0、slot0）→ 語2
  assert.deepEqual(asm('JZ skip\nDUP\nskip: DROP'), ['18000002', W([10]), W([11])]);
  // 語1の slot0 から語0へ：オフセット −1（27bit）
  assert.deepEqual(asm('a: DUP\nb: JMP a'), [W([10]), '17FFFFFF']);
  // slot3 の分岐はオフセット12bit
  assert.deepEqual(asm('a: DUP\nDUP\nDUP\nBRA a'), [W([10, 10, 10, OP.JMP])]);
});

test('CALL の戻り先は次の語（分岐で語が閉じる）', () => {
  assert.deepEqual(asm('BSR f\nHALT\nf: RTS'), ['20000002', W([OP.SYS, SYS.HALT]), W([5])]);
});

test('ラベルは新しい語の先頭に置かれる', () => {
  const r = assemble('DUP\nx: DROP\ny: DROP');
  assert.deepEqual(r.words.map(w => w >>> 0), [0x50000000, 0x58000000, 0x58000000]);
  assert.equal(r.symbols.get('x'), 4);
  assert.equal(r.symbols.get('y'), 8);
});

test('分岐が届かなければNOPで埋めて次の語の slot0 へ移す', () => {
  const filler = n => Array.from({ length: n }, () => 'DC.L 0').join('\n');
  // slot4 の分岐は7bit（−64〜+63語）。+63語なら届く
  const near = assemble(`DUP\nDUP\nDUP\nDUP\nBRA far\n${filler(62)}\nfar: HALT`);
  assert.equal(near.words[0] >>> 0, parseInt(W([10, 10, 10, 10, OP.JMP]), 16) | 63);
  assert.equal(near.symbols.get('far'), 63 * 4);
  // +64語は届かないので次の語へ（語1の slot0 から +64語）
  const far = assemble(`DUP\nDUP\nDUP\nDUP\nBRA far\n${filler(63)}\nfar: HALT`);
  assert.equal(far.words[0] >>> 0, parseInt(W([10, 10, 10, 10]), 16));
  assert.equal(far.words[1] >>> 0, (OP.JMP << 27 | 64) >>> 0);
  assert.equal(far.symbols.get('far'), 65 * 4);
});

test('後方への遠い分岐も次の語へ移す', () => {
  const body = Array.from({ length: 70 }, () => 'DC.L 0').join('\n');
  const r = assemble(`top: HALT\n${body}\nDUP\nDUP\nDUP\nDUP\nBRA top`);
  const n = r.words.length;
  assert.equal(r.words[n - 2] >>> 0, parseInt(W([10, 10, 10, 10]), 16));
  assert.equal(r.words[n - 1] >>> 0, ((OP.JMP << 27) | ((-(n - 1)) & 0x7ffffff)) >>> 0);
});

test('分岐先の計算は32bitで一周しない（ROMからローカルBSRAMへは届かない。T-03）', () => {
  // 差は 0x00100000 − 0xFFFF0000 = −0xFFEF0000 バイト。27bit（±64M語）に収まらない
  assert.match(asmErrors('ORG $FFFF0000\nBRA $00100000')[0].message, /届かない/);
  // 逆向きも同じ
  assert.match(asmErrors('ORG $00100000\nBRA $FFFF0000')[0].message, /届かない/);
});

test('slot0の分岐は±64M語まで届く（27bit）', () => {
  // 最大は +(2^26−1) 語
  const max = (2 ** 26 - 1) * 4;
  assert.deepEqual(assemble(`BRA ${max}`).words, [((OP.JMP << 27) | (2 ** 26 - 1)) >>> 0]);
  assert.match(asmErrors(`BRA ${max + 4}`)[0].message, /届かない/);
});

// ---- PCREL ----

test('PCREL はオフセット語自身のアドレス＋オフセット', () => {
  // 語0：SYS PCREL、語1：オフセット、msg は 8 → オフセット 8−4＝4
  assert.deepEqual(asm('LEA msg,PC\nmsg: DC.L 7'), [W([OP.SYS, SYS.PCREL]), '00000004', '00000007']);
  // 後方：オフセット語は 12、ラベルは 0 → −12
  assert.deepEqual(asm('d: DC.L 1\nDUP\nPCREL d'), ['00000001', W([10, OP.SYS, SYS.PCREL]), 'FFFFFFF8']);
});

test('LD label,PC は PCREL ＋ LD', () => {
  assert.deepEqual(asm('LD v,PC\nv: DC.L 9'), [W([OP.SYS, SYS.PCREL, OP['@']]), '00000004', '00000009']);
});

// ---- マクロ ----

test('LD n,U / ST n,U / LD addr / ST addr', () => {
  assert.deepEqual(asm('LD 3,U\nST 31,U'), [W([OP.UA, 3, OP['@'], OP.UA, 31, OP['!']])]);
  assert.deepEqual(asm('LD $FF0F0010'), [W([OP.LIT, OP['@']]), 'FF0F0010']);
  assert.deepEqual(asm('ST $FF000000'), [W([OP.LIT, OP['!']]), 'FF000000']);
});

test('ADD #n：−16〜+15 は SLIT、範囲外は LIT', () => {
  assert.deepEqual(asm('ADD #-1'), [W([OP.SLIT, 31, OP['+']])]);
  assert.deepEqual(asm('ADD #15'), [W([OP.SLIT, 15, OP['+']])]);
  assert.deepEqual(asm('ADD #16'), [W([OP.LIT, OP['+']]), '00000010']);
  assert.deepEqual(asm('N EQU -16\nADD #N'), [W([OP.SLIT, 16, OP['+']])]);
});

test('CMP は SUB、BNZ は PUSHQ #0 ＋ CMPEQ ＋ BZ', () => {
  assert.deepEqual(asm('CMP'), [W([OP['-']])]);
  assert.deepEqual(asm('l: BNZ l'), [W([OP.SLIT, 0, OP['='], OP.JZ])]);
});

// ---- ニーモニック ----

test('Forth風とレジスタ風で同じ命令語になる', () => {
  const forth = `
    SLIT -3
    LIT 1000
    UA 2
    >R
    R>
    R@
    DUP
    DROP
    SWAP
    OVER
    +
    -
    AND
    OR
    XOR
    LSHIFT
    RSHIFT
    UM*
    =
    <
    U<
    @
    !
    C@
    C!
    TID
    WAIT
    SIGNAL
    RECV
    FENCE
    XCHG
    UP@
    UP!
    SP@
    RP@
    HALT
    BRK
    CSR@ #10
    CSR! #18
    SENDM #3
    SENDM? #1
    PCREL x
    EXEC
    SYSCALL
    U/MOD
    /MOD
    UM/MOD
    M*
    SP!
    RP!
    RETI
    x: CALL x
    JZ x
    JMP x
    RET`;
  const reg = `
    PUSHQ #-3
    PUSH #1000
    LEA 2,U
    PSHR
    PULR
    PEEKR
    PUSH T
    POP
    EXG
    PUSH N
    ADD
    SUB
    AND
    OR
    EOR
    LSL
    LSR
    MULU
    CMPEQ
    CMPLT
    CMPLO
    LD
    ST
    LDB
    STB
    TID
    WAIT
    SIGNAL
    RECV
    FENCE
    XCHG
    PUSH U
    POP U
    PUSH SP
    PUSH RP
    HALT
    BKPT
    MFC 10
    MTC 18
    SEND 3
    TRYSEND 1
    LEA x,PC
    JSR (T)
    TRAP
    DIVU
    DIVS
    DIVUL
    MULS
    POP SP
    POP RP
    RTI
    x: BSR x
    BZ x
    BRA x
    RTS`;
  assert.deepEqual(asm(forth), asm(reg));
});

test('ニーモニックは大文字・小文字を区別しない', () => {
  assert.deepEqual(asm('push t\npushq #1\nadd'), asm('PUSH T\nPUSHQ #1\nADD'));
});

// ---- 疑似命令・式 ----

test('EQU と式（+ − * / 括弧、前方参照）', () => {
  const r = assemble('PUSH #A+(5*80+10)*2\nPUSH #B/3\nA EQU $FF010000\nB EQU -7');
  assert.deepEqual(r.words.slice(1), [0xFF010334, (-2 >>> 0)]);
  assert.equal(r.symbols.get('A'), 0xFF010000);
});

test('DC.B（文字列と数値）と DC.L はリトルエンディアン。DC.L は4バイト境界に揃える', () => {
  const r = assemble('DC.B "AB",1\nDC.L $11223344');
  assert.deepEqual([...r.bytes], [0x41, 0x42, 0x01, 0x00, 0x44, 0x33, 0x22, 0x11]);
});

test('DC.B の後の命令は4バイト境界から始まる。DC.B の直前のラベルは揃えない', () => {
  const r = assemble('DC.B 1\ns: DC.B 2\nt: DUP');
  assert.equal(r.symbols.get('s'), 1);
  assert.equal(r.symbols.get('t'), 4);
  assert.deepEqual([...r.bytes], [1, 2, 0, 0, 0x00, 0x00, 0x00, 0x50]);
});

test('ORG で開始番地を決める', () => {
  const r = assemble('ORG $FFFF0000\nreset: HALT');
  assert.equal(r.origin, 0xFFFF0000);
  assert.equal(r.symbols.get('reset'), 0xFFFF0000);
  assert.deepEqual(r.words, [0xFC000000]);
});

test('ORG で前に進めた隙間は0で埋める', () => {
  const r = assemble('ORG $100\nDUP\nORG $10C\nDROP');
  assert.equal(r.origin, 0x100);
  assert.deepEqual(r.words, [0x50000000, 0, 0, 0x58000000]);
});

test('toReadmemh', () => {
  assert.equal(toReadmemh([0xB82EA000, 5]), 'b82ea000\n00000005\n');
});

// ---- 誤りの検出 ----

test('範囲外の即値はエラー', () => {
  assert.match(asmErrors('PUSHQ #16')[0].message, /SLIT/);
  assert.match(asmErrors('PUSHQ #-17')[0].message, /SLIT/);
  assert.match(asmErrors('LEA 32,U')[0].message, /UA/);
  assert.match(asmErrors('SEND 5')[0].message, /語数/);
  assert.match(asmErrors('MFC 22')[0].message, /CSR/);
  assert.match(asmErrors('DC.B 256')[0].message, /8bit/);
  assert.match(asmErrors('PUSH #$100000000')[0].message, /32bit/);
});

test('未定義の名前・重複・不明な命令・書式の誤りはエラー（行番号つき）', () => {
  assert.deepEqual(asmErrors('DUP\nBRA nowhere').map(e => e.line), [2]);
  assert.match(asmErrors('a: DUP\na: DUP')[0].message, /重複/);
  assert.match(asmErrors('FOO')[0].message, /不明な命令/);
  assert.match(asmErrors('PUSH 5')[0].message, /#/);
  assert.match(asmErrors('DUP 5')[0].message, /オペランド/);
  assert.match(asmErrors('BRA')[0].message, /オペランド/);
  assert.match(asmErrors('ST x,PC\nx: DC.L 0')[0].message, /ST label,PC/);
  assert.match(asmErrors('ORG $10\nDUP\nORG $0\nDUP')[0].message, /ORG/);
  assert.match(asmErrors('A EQU B\nB EQU A\nPUSH #A')[0].message, /循環/);
  assert.match(asmErrors('BRA x\nDC.B 1\nx: DC.B 2')[0].message, /4バイト境界/);
});

test('複数のエラーをまとめて報告する', () => {
  assert.deepEqual(asmErrors('FOO\nDUP\nBAR').map(e => e.line), [1, 3]);
});

test('LIT でモジュール内の番地を埋め込むと警告', () => {
  const r = assemble('PUSH #x\nx: DUP');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /PCREL/);
  assert.equal(assemble('A EQU 5\nPUSH #A').warnings.length, 0);
});

// ---- デコードと配置規則の検査（sim/decode.js） ----

test('decodeWord：配置違反（例外5）と不正命令（例外4）', () => {
  // EXEC の後ろにNOP以外
  assert.equal(decodeWord(parseInt(W([OP.EXEC, 10]), 16)).fault.exc, EXC.PLACEMENT);
  // EXEC の後ろの slot6 がNOP以外
  assert.equal(decodeWord(parseInt(W([OP.EXEC], 3), 16)).fault.exc, EXC.PLACEMENT);
  // EXEC が途中でも後ろがすべてNOPならよい
  assert.equal(decodeWord(parseInt(W([10, OP.EXEC]), 16)).fault, null);
  // SLIT が slot5
  assert.equal(decodeWord(parseInt(W([0, 0, 0, 0, 0, OP.SLIT]), 16)).fault.exc, EXC.PLACEMENT);
  // CSR@ のオペランドが入らない
  assert.equal(decodeWord(parseInt(W([0, 0, 0, 0, OP.SYS, SYS['CSR@']]), 16)).fault.exc, EXC.PLACEMENT);
  // SYSCALL の後ろにNOP以外
  assert.equal(decodeWord(parseInt(W([OP.SYS, SYS.SYSCALL, 10]), 16)).fault.exc, EXC.PLACEMENT);
  // SYSの予約番号
  assert.equal(decodeWord(parseInt(W([OP.SYS, 25]), 16)).fault.exc, EXC.ILLEGAL);
});

test('decodeWord：分岐オフセット、定数語の数、RET での打ち切り', () => {
  const d = decodeWord(0x55C161FF); // PUSH T  PUSHQ #0  CMPEQ  BZ −1
  assert.deepEqual(d.insts.map(i => i.op), [OP.DUP, OP.SLIT, OP['='], OP.JZ]);
  assert.equal(d.insts[3].offset, -1);
  assert.equal(d.end, 'branch');
  assert.equal(decodeWord(parseInt(W([OP.LIT, OP.SYS, SYS.PCREL, OP.LIT]), 16)).litCount, 3);
  const r = decodeWord(parseInt(W([10, 5, 10]), 16)); // RET の後ろは実行しない
  assert.deepEqual(r.insts.map(i => i.op), [OP.DUP, OP.RET]);
  assert.equal(r.fault, null);
});

test('逆アセンブル（両方の表記）', () => {
  assert.equal(disassembleWord(0x51DC8BFE).text, 'PUSH T  PSHR  ADD  PULR  PUSHQ #-1  [s6]ADD');
  assert.equal(disassembleWord(0x51DC8BFE, { style: 'forth' }).text, 'DUP  >R  +  R>  SLIT -1  [s6]+');
  assert.equal(disassembleWord(0x55C161FF, { addr: 8 }).text, 'PUSH T  PUSHQ #0  CMPEQ  BZ $4');
});

// ---- サンプル ----

for (const dir of ['examples', 'rom']) {
  for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url)).filter(n => n.endsWith('.asm'))) {
    test(`${dir}/${f} がアセンブルでき、すべての命令語が配置の規則を満たす`, () => {
      const r = assemble(readFileSync(new URL(`../${dir}/${f}`, import.meta.url), 'utf8'));
      assert.ok(r.words.length > 0);
      assert.deepEqual(r.warnings, []);
    });
  }
}

test('examples/01_sum.asm の命令語', () => {
  const r = assemble(readFileSync(new URL('../examples/01_sum.asm', import.meta.url), 'utf8'));
  assert.deepEqual(r.words.map(w => w.toString(16).toUpperCase()), ['B82EA000', '51DC8BFE', '55C161FF', '5F81BFC0']);
});
