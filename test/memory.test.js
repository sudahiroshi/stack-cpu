// メモリとバス（sim/memory.js）のテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from '../sim/memory.js';
import { makeConfig } from '../sim/config.js';
import { CpuException } from '../sim/cpu-exception.js';
import { EXC } from '../sim/isa.js';

const mem9k = () => new Memory(makeConfig('9K'));
const excOf = fn => {
  try { fn(); } catch (e) {
    if (e instanceof CpuException) return e.exc;
    throw e;
  }
  assert.fail('例外にならなかった');
};

test('リトルエンディアンで読み書きする', () => {
  const m = mem9k();
  m.write32(0x0100_0000, 0x11223344);
  assert.deepEqual([0, 1, 2, 3].map(i => m.read8(0x0100_0000 + i)), [0x44, 0x33, 0x22, 0x11]);
  m.write8(0x0100_0003, 0xAB);
  assert.equal(m.read32(0x0100_0000), 0xAB223344);
});

test('番地の振り分け', () => {
  const m = new Memory(makeConfig('20K'));
  assert.equal(m.region(0x0000_0000), null);
  assert.deepEqual(m.region(0x0010_0004), { kind: 'local', core: 0, buf: m.local[0], off: 4 });
  assert.equal(m.region(0x0011_0008).core, 1);
  assert.equal(m.region(0x0010_6000), null);   // 容量24KBの外
  assert.equal(m.region(0x0012_0000), null);   // コア2はない
  assert.equal(m.region(0x017F_FFFF).kind, 'ext');
  assert.equal(m.region(0x0180_0000), null);
  assert.equal(m.region(0xFFFF_0FFF).kind, 'rom');
  assert.equal(m.region(0xFF00_0000), null);   // 未登録のI/O
});

test('load は領域をまたいでも書け、ROMにも書ける。I/Oと割り当てのない番地には書けない', () => {
  const m = mem9k();
  m.load(0xFFFF_0000, new Uint8Array([1, 2, 3, 4]));
  assert.equal(m.read32(0xFFFF_0000), 0x04030201);
  assert.throws(() => m.load(0x0010_5FFE, new Uint8Array(4)), /読み込めない/);
  assert.throws(() => m.load(0x0000_0000, new Uint8Array(1)), /読み込めない/);
});

test('fetch32 は自コアのローカルとROMだけ', () => {
  const m = new Memory(makeConfig('20K'));
  assert.equal(m.fetch32(0x0010_0000, { core: 0 }), 0);
  assert.equal(m.fetch32(0xFFFF_0000, { core: 1 }), 0);
  assert.equal(excOf(() => m.fetch32(0x0011_0000, { core: 0 })), EXC.FETCH);
  assert.equal(excOf(() => m.fetch32(0x0100_0000, { core: 0 })), EXC.FETCH);
  assert.equal(excOf(() => m.fetch32(0x0010_0002, { core: 0 })), EXC.ALIGN);
});

test('デバイスの登録：重なりとI/O領域の外はエラー', () => {
  const m = mem9k();
  const dev = size => ({ name: 'x', size, read32: () => 7, write32: () => {} });
  m.mapDevice(0xFF00_0000, dev(0x10));
  assert.equal(m.read32(0xFF00_000C), 7);
  assert.equal(excOf(() => m.read32(0xFF00_0010)), EXC.BUS);
  assert.throws(() => m.mapDevice(0xFF00_0008, dev(0x10)), /重なる/);
  assert.throws(() => m.mapDevice(0x0100_0000, dev(0x10)), /I\/O領域の外/);
});
