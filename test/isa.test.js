// ISAの定数表の整合性テスト（段階1の前から通ること）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPS, OP, SYS_OPS, SLOT6_OPS, slotShift, getSlot, getSlot6, branchOffsetBits, EXC, CSR,
} from '../sim/isa.js';
import { buildMnemonicTable } from '../asm/mnemonics.js';
import { makeConfig } from '../sim/config.js';

test('基本命令は0〜31がちょうど1つずつ', () => {
  assert.equal(OPS.length, 32);
  OPS.forEach((o, i) => assert.equal(o.op, i));
});

test('SYS拡張命令の番号は0〜24が連続', () => {
  SYS_OPS.forEach((s, i) => assert.equal(s.sub, i));
  assert.equal(SYS_OPS.length, 25);
});

test('スロットのビット位置（slot0=bit31〜27、slot5=bit6〜2）', () => {
  assert.equal(slotShift(0), 27);
  assert.equal(slotShift(5), 2);
  const word = (0x1f << 27) | (0x01 << 2) | 0x3;
  assert.equal(getSlot(word >>> 0, 0), 0x1f);
  assert.equal(getSlot(word >>> 0, 5), 0x01);
  assert.equal(getSlot6(word >>> 0), 0x3);
});

test('分岐オフセットのビット数（slot0=27、slot3=12）', () => {
  assert.equal(branchOffsetBits(0), 27);
  assert.equal(branchOffsetBits(3), 12);
});

test('slot6は 00=NOP', () => {
  assert.equal(SLOT6_OPS[0], OP.NOP);
  assert.equal(SLOT6_OPS.length, 4);
});

test('語の最後に置く命令', () => {
  const lastSys = SYS_OPS.filter(s => s.last).map(s => s.forth).sort();
  assert.deepEqual(lastSys, ['/MOD', 'M*', 'RP!', 'SP!', 'SYSCALL', 'U/MOD', 'UM/MOD'].sort());
  assert.equal(OPS[OP.EXEC].last, true);
});

test('例外番号とCSR番号の代表値', () => {
  assert.equal(EXC.UNIMPL, 18);
  assert.equal(EXC.PROTECT, 12);
  assert.equal(CSR.PKWRITE, 19);
});

test('ニーモニック表に重複がない（両方の名前で引ける）', () => {
  const t = buildMnemonicTable();
  assert.deepEqual(t.get('+'), { kind: 'op', code: 14 });
  assert.deepEqual(t.get('ADD'), { kind: 'op', code: 14 });
  assert.deepEqual(t.get('PUSH T'), { kind: 'op', code: 10 });
  assert.deepEqual(t.get('EXG'), { kind: 'op', code: 12 });
  assert.deepEqual(t.get('DIVU'), { kind: 'sys', code: 21 });
  assert.deepEqual(t.get('POP U'), { kind: 'sys', code: 9 });
});

test('構成：メールボックスの深さ', () => {
  assert.equal(makeConfig('9K').mboxDepth, 64);
  assert.equal(makeConfig('20K').mboxDepth, 64); // 1コアあたり8スレッドで等分
});
