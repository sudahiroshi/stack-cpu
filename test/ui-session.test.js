// UIの状態（ui/session.js、DOM非依存）のテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Session, parseProgram, parseReadmemh, hex8, DEFAULT_DIRECT_UP } from '../ui/session.js';
import { toReadmemh } from '../asm/assembler.js';
import { THREAD_STATE } from '../sim/devices/registers.js';

const ROM_SRC = readFileSync(new URL('../rom/boot.asm', import.meta.url), 'utf8');
const example = name => readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8');

test('parseProgram：.asm はアセンブルし、ラベルと配置の情報を持つ', () => {
  const p = parseProgram('a.asm', 'start: PUSH #5\nl: BRA l');
  assert.equal(p.kind, 'asm');
  assert.equal(p.addr, 0x0010_0000);
  assert.equal(p.labels.get('l'), 0x0010_0008);
  assert.deepEqual(p.layout.map(e => e.kind), ['inst', 'lit', 'inst']);
});

test('parseProgram：.hex（$readmemh）と .bin は同じバイト列になる。番地を指定できる', () => {
  const asm = parseProgram('x.asm', example('01_sum.asm'));
  const hexText = toReadmemh(Array.from({ length: asm.bytes.length / 4 }, (_, i) =>
    new DataView(asm.bytes.buffer).getUint32(i * 4, true)));
  const h = parseProgram('x.hex', hexText, { addr: 0x0010_2000 });
  assert.deepEqual([...h.bytes], [...asm.bytes]);
  assert.equal(h.addr, 0x0010_2000);
  const b = parseProgram('x.bin', asm.bytes);
  assert.deepEqual([...b.bytes], [...asm.bytes]);
  assert.throws(() => parseReadmemh('12345678\nxyz'), /2行/);
  assert.throws(() => parseProgram('x.txt', ''), /対応していない/);
});

test('Session：ブートROMから起動（examples/06）', () => {
  const s = new Session(ROM_SRC);
  s.load(parseProgram('06.asm', example('06_start.asm')), { boot: 'boot' });
  assert.equal(s.dbg.run({ maxCycles: 5_000_000 }).type, 'stopped');
  s.m.run(50 * s.m.uart.byteCycles);
  assert.equal(s.m.uart.outputText, 'Welcome to Stack CPU\r\nHello from tid 1\r\nEXIT\r\n');
});

test('Session：tid 0 で直接実行（ブートROMの起動を飛ばす。UPを指定できる）', () => {
  const s = new Session(ROM_SRC);
  s.load(parseProgram('01.asm', example('01_sum.asm')), { boot: 'direct' });
  assert.equal(s.m.thread(0).up, DEFAULT_DIRECT_UP);
  s.dbg.run({ maxCycles: 1_000_000 });
  assert.equal(s.m.mem.read32(DEFAULT_DIRECT_UP), 55);
  assert.equal(s.m.uart.outputText, '');              // 起動メッセージは出ない
  assert.equal(s.m.thread(1).state, THREAD_STATE.RECV); // 他のスレッドは idle
});

test('Session：機種を変えても、ブレークポイントとプログラムを引き継ぐ', () => {
  const s = new Session(ROM_SRC);
  s.load(parseProgram('06.asm', example('06_start.asm')), { boot: 'boot' });
  s.breakpoints.add(0x0010_0000);
  s.setConfig('20K');
  assert.equal(s.m.cfg.ncores, 2);
  assert.ok(s.dbg.breakpoints.has(0x0010_0000));
  assert.deepEqual(s.dbg.run({ maxCycles: 5_000_000 }), { type: 'breakpoint', tid: 0, addr: 0x0010_0000 });
});

test('threadSummary', () => {
  const s = new Session(ROM_SRC);
  const t = s.threadSummary(s.m.thread(0));
  assert.equal(t.stateName, 'リセット直後');
  assert.equal(t.pc, 0xFFFF_0000);
  assert.equal(t.mode, '特権');
  assert.equal(t.dcap, 16);
  assert.equal(t.rcap, 13);
});

test('disasmWindow：ラベル、ソース、定数語、実行中の命令、ブレークポイント', () => {
  const s = new Session(ROM_SRC);
  s.load(parseProgram('t.asm', 'start: PUSH #$1234\nl: PUSHQ #1\nBRA l'), { boot: 'direct' });
  s.breakpoints.add(0x0010_0008);
  const th = s.m.thread(0);
  let rows = s.disasmWindow(th.pc, { th, before: 0, after: 3 });
  assert.equal(rows[0].label, 'start');
  assert.equal(rows[0].current, true);
  assert.deepEqual(rows[0].parts.map(p => p.text), ['PUSH #$1234']);
  assert.equal(rows[0].parts[0].current, true);
  assert.equal(rows[1].kind, 'lit');
  assert.equal(rows[1].word, 0x1234);
  assert.equal(rows[2].label, 'l');
  assert.equal(rows[2].bp, true);
  assert.deepEqual(rows[2].parts.map(p => p.text), ['PUSHQ #1', 'BRA $100008 (l)']);
  assert.deepEqual(rows[2].source, ['l: PUSHQ #1', 'BRA l']);
  // Forth風
  rows = s.disasmWindow(th.pc, { th, before: 0, after: 3, style: 'forth' });
  assert.deepEqual(rows[2].parts.map(p => p.text), ['SLIT 1', 'JMP $100008 (l)']);
  // ブレークポイントで止めると、2番目の命令が強調される
  s.dbg.run();
  s.dbg.stepInstruction(0);
  rows = s.disasmWindow(th.dec ? th.wordAddr : th.pc, { th, before: 0, after: 0 });
  assert.deepEqual(rows[0].parts.map(p => p.current), [false, true]);
});

test('disasmWindow：配置の情報がない番地は、命令語と定数語を推測する（.bin）', () => {
  const asm = parseProgram('t.asm', 'PUSH #$1234\nPUSH #$5678\nHALT');
  const s = new Session(ROM_SRC);
  s.load(parseProgram('t.bin', asm.bytes), { boot: 'direct' });
  const rows = s.disasmWindow(0x0010_0000, { before: 0, after: 3 });
  assert.deepEqual(rows.map(r => r.kind), ['inst', 'lit', 'lit', 'inst']);
});

test('disasmWindow：データ（DC.B）は範囲のすべての語をデータとして表示する', () => {
  const s = new Session(ROM_SRC);
  s.load(parseProgram('t.asm', 'start: HALT\nmsg: DC.B "Hello, world!",0\nnext: HALT'), { boot: 'direct' });
  const rows = s.disasmWindow(0x0010_0000, { before: 0, after: 5 });
  assert.deepEqual(rows.map(r => r.kind), ['inst', 'data', 'data', 'data', 'data', 'inst']);
  assert.equal(rows[5].label, 'next');
});

test('ROMのラベルも表示に使う', () => {
  const s = new Session(ROM_SRC);
  const rows = s.disasmWindow(0xFFFF_0000, { before: 0, after: 0 });
  assert.equal(rows[0].label, 'reset');
});

test('csrList・mailboxView・memoryRows', () => {
  const s = new Session(ROM_SRC);
  const th = s.m.thread(1);
  const csr = s.csrList(th);
  assert.equal(csr.find(c => c.name === 'VBR').value, 0xFFFF_0100);
  assert.equal(csr.length, 22);
  th.mbox.push(0x0000_0102, 7, 8);
  const mb = s.mailboxView(th);
  assert.deepEqual(mb.items.map(i => i.header), [true, false, false]);
  assert.deepEqual([mb.items[0].src, mb.items[0].tag, mb.items[0].n], [0, 1, 2]);
  const mem = s.memoryRows(0xFFFF_0000, { rows: 1 });
  assert.equal(mem[0].values[0], s.m.mem.read32(0xFFFF_0000));
  assert.deepEqual(s.memoryRows(0xFF00_0000, { rows: 1 })[0].values, [null, null, null, null]);
});

test('parseAddress と hex8', () => {
  assert.equal(Session.parseAddress('$00100000'), 0x0010_0000);
  assert.equal(Session.parseAddress('0x1_0000'), 0x1_0000);
  assert.equal(Session.parseAddress('100000'), 0x10_0000);
  assert.equal(Session.parseAddress('xyz'), null);
  assert.equal(Session.parseAddress('123456789'), null);
  assert.equal(hex8(255), '000000FF');
});
