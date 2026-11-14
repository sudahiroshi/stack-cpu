// 段階6：ブートROM（起動、idleループ、例外のハンドラ、SYSCALL、拡張命令のソフトによる実行、モニタ）とサンプルのテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Machine } from '../sim/machine.js';
import { makeConfig } from '../sim/config.js';
import { assemble } from '../asm/assembler.js';
import { EXC, RESET, MEM } from '../sim/isa.js';
import { THREAD_STATE } from '../sim/devices/registers.js';
import { haltOthers, ORG, UP } from './helpers.js';

const S = THREAD_STATE;
const ROM_SRC = readFileSync(new URL('../rom/boot.asm', import.meta.url), 'utf8');
const ROM = assemble(ROM_SRC);
const example = name => readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8');
const APP = 0x0010_2000;           // テスト用のカーネルが起動するアプリの番地
const WELCOME = 'Welcome to Stack CPU\r\n';

/**
 * ブートROMとOSイメージを読み込み、リセットから実行する。
 * @param {{ os?: string, app?: string, config?: string|object, setup?: (m: Machine) => void, maxCycles?: number }} opts
 */
function boot({ os, app, config = '9K', setup, maxCycles = 20_000_000 } = {}) {
  const m = new Machine(config);
  m.load(ROM.origin, ROM.bytes);
  if (os) m.load(ORG, assemble(os, { origin: ORG }).bytes);
  if (app) m.load(APP, assemble(app, { origin: APP }).bytes);
  setup?.(m);
  const res = m.runUntilStop(maxCycles);
  m.run(40 * m.uart.byteCycles);      // UARTの送信が終わるまで
  return { m, res, out: m.uart.outputText, t: tid => m.thread(tid) };
}

/**
 * テスト用の簡易カーネル：ローカルBSRAMを全部キー1（W・X）にし、tid 1 に START（UP、APP＋モード、キー1）を送る。
 * その後、tid 1 からのメッセージを1つ受け取り、ヘッダと最初の n 語（最大3語）をスタックに残して止まる。
 */
function kernel({ mode = 0, up = UP } = {}) {
  return `
start:  PUSHQ #6
k_loop: PSHR
        PUSH  #$61616161
        PEEKR
        ADD   #-1
        PUSHQ #2
        LSL
        PUSH  #$FF081000
        ADD
        ST
        PULR
        ADD   #-1
        PUSH  T
        BNZ   k_loop
        POP
        PUSH  #${up}
        PUSH  #${APP + mode}
        PUSHQ #2
        PUSHQ #2
        PUSHQ #1
        PUSHQ #1
        SEND  4
        RECV
        PUSH  T
        PUSHQ #15
        AND
r_loop: PUSH  T
        BZ    r_end
        RECV
        EXG
        ADD   #-1
        BRA   r_loop
r_end:  POP
        HALT`;
}

/** ROMを読み込み、tid 0 で ORG からプログラムを直接実行する（例外はROMのハンドラが処理する） */
function direct(src, { config = '9K', setup, maxCycles = 20_000_000 } = {}) {
  const m = new Machine(config);
  m.load(ROM.origin, ROM.bytes);
  m.load(ORG, assemble(src, { origin: ORG }).bytes);
  haltOthers(m, [0]);
  m.thread(0).pc = ORG;
  m.thread(0).up = UP;
  setup?.(m);
  const res = m.runUntilStop(maxCycles);
  m.run(80 * m.uart.byteCycles);
  return { m, res, th: m.thread(0), out: m.uart.outputText, stack: m.thread(0).dataStack() };
}

// ---------------------------------------------------------------- ブートROMの形

test('ブートROMは4KBに収まり、ベクタは VBR＋番号×4 にある', () => {
  assert.equal(ROM.origin, MEM.ROM_BASE);
  assert.ok(ROM.bytes.length <= MEM.ROM_SIZE, `${ROM.bytes.length}バイト`);
  assert.deepEqual(ROM.warnings, []);
  assert.equal(ROM.symbols.get('reset'), RESET.PC);
  for (let n = 0; n <= 18; n++) assert.equal(ROM.symbols.get(`v${n}`), RESET.VBR + n * 4, `ベクタ${n}`);
});

// ---------------------------------------------------------------- 起動

test('起動：UARTに起動メッセージ、外部RAMの確認、OSの入口（コア0のローカルBSRAMの先頭）へ', () => {
  const r = boot({ os: example('06_start.asm') });
  assert.equal(r.out, `${WELCOME}Hello from tid 1\r\nEXIT\r\n`);
  assert.deepEqual(r.t(0).dataStack(), [7]);       // カーネルは終了コードを受け取った
  assert.equal(r.t(0).state, S.HALT);
  // tid 1 は EXIT で idle に戻り、他のスレッドも idle で START を待っている
  for (let tid = 1; tid < 8; tid++) assert.equal(r.t(tid).state, S.RECV, `tid ${tid}`);
  assert.equal(r.m.gpio.led, 0);
});

test('起動（20K）：コア1のスレッドも idle で待つ', () => {
  const r = boot({ os: example('06_start.asm'), config: '20K' });
  assert.equal(r.out, `${WELCOME}Hello from tid 1\r\nEXIT\r\n`);
  for (let i = 0; i < 8; i++) assert.equal(r.t(0x10 + i).state, S.RECV);
});

test('OSイメージがなければ、カーネルの例外でモニタに入る', () => {
  const r = boot();
  assert.ok(r.out.startsWith(WELCOME));
  assert.match(r.out, /\*\*\* MONITOR TID=00000000\r\nECAUSE=00000007 /);  // ローカルBSRAMの外のフェッチ
  assert.equal(r.t(0).state, S.WAIT);                                      // モニタがUARTの入力を待つ
});

/** 外部RAMの故障を作る（書き込みの番地か値を変える） */
function faultyRam(m, { addr = a => a, value = v => v }) {
  const w = m.mem.write32.bind(m.mem);
  m.mem.write32 = (a, v, ctx) => (a >= MEM.EXTRAM_BASE && a < MEM.EXTRAM_BASE + 0x80_0000 ? w(addr(a), value(v), ctx) : w(a, v, ctx));
}

test('外部RAMの確認：データ線の故障を見つけ、UARTとLEDに出してモニタに入る（T-41）', () => {
  const r = boot({ os: example('06_start.asm'), setup: m => faultyRam(m, { value: v => v & ~0x20 }) });
  assert.match(r.out, /^Welcome to Stack CPU\r\nRAM ERROR \$01000000\r\n\r\n\*\*\* MONITOR/);
  assert.equal(r.m.gpio.led, 0x2A);
  assert.doesNotMatch(r.out, /Hello/);
});

test('外部RAMの確認：アドレス線の故障（2つの番地が同じ場所を指す）を見つける', () => {
  const r = boot({ os: example('06_start.asm'), setup: m => faultyRam(m, { addr: a => a & ~0x0010_0000 }) });
  assert.match(r.out, /RAM ERROR \$01000000/);
});

// ---------------------------------------------------------------- idleループ

test('idle：カーネル以外からの START や他のメッセージは本文ごと捨て、カーネルの START で起動する', () => {
  // tid 2 が tid 1 に偽の START（4語）と2語のメッセージを送ってから終わる。
  // その後、カーネルが tid 1 に本物の START を送り、tid 1 は EXIT(9) で終わる
  const os = `
start:  PUSH  #${UP}
        LEA   app2,PC
        ADD   #1
        PUSHQ #0
        PUSHQ #0
        PUSHQ #1
        PUSHQ #2
        SEND  4                   ; tid 2 を特権モードで起動
        RECV                      ; tid 2 の EXITED
        RECV
        POP
        POP
        PUSH  #${UP}
        LEA   app1,PC
        ADD   #1
        PUSHQ #0
        PUSHQ #0
        PUSHQ #1
        PUSHQ #1
        SEND  4                   ; tid 1 を起動
        RECV                      ; ヘッダ
        RECV                      ; 終了コード
        HALT
app2:   LEA   bad,PC
        PUSHQ #-1
        PUSHQ #0
        PUSHQ #0
        PUSHQ #1                  ; tag START（送信元は tid 2）
        PUSHQ #1
        SEND  4
        PUSHQ #5
        PUSHQ #6
        PUSH  #$7001
        PUSHQ #1
        SEND  2
        PUSHQ #0
        PUSHQ #0
        TRAP                      ; EXIT
app1:   PUSHQ #9
        PUSHQ #0
        TRAP                      ; EXIT(9)
bad:    HALT`;
  const r = boot({ os });
  assert.deepEqual(r.t(0).dataStack(), [0x0100_0201, 9]);
  assert.equal(r.t(1).state, S.RECV);
  assert.deepEqual(r.t(1).mbox, []);
});

test('idle から一般モードで起動：UP・PKREAD・PKWRITEが設定される', () => {
  // UP と STATUS（一般モードから読めるのはCSR 0〜9だけ）を積んで EXIT(0)
  const app = 'PUSH U\nMFC 8\nPUSHQ #0\nPUSHQ #0\nTRAP';
  let seen;
  const r = boot({ os: kernel({ mode: 0, up: 0x0010_5000 }), app, setup: m => m.on(e => { if (e.type === 'exception' && e.tid === 1) seen = m.thread(1).dataStack(); }) });
  assert.deepEqual(seen, [0x0010_5000, 0, 0, 0]);         // UP、STATUS（一般モード）、終了コード、EXIT
  assert.deepEqual(r.t(0).dataStack(), [0x0100_0201, 0]);
  assert.equal(r.t(1).pkread, 2);                         // キー1
  assert.equal(r.t(1).pkwrite, 2);
});

// ---------------------------------------------------------------- FAULT

test('一般モードのスレッドの例外：カーネルに FAULT（例外番号、EPC、EADDR）を送って止まる', () => {
  const r = boot({ os: kernel(), app: 'NOP\nLD 0' });
  assert.deepEqual(r.t(0).dataStack(), [0x0100_0303, EXC.BUS, APP, 0]);
  assert.equal(r.t(1).state, S.HALT);
});

test('スタックのあふれも FAULT として扱う（T-43）', () => {
  const r = boot({ os: kernel(), app: 'l: PUSHQ #1\nBRA l' });
  const [hdr, exc] = r.t(0).dataStack();
  assert.equal(hdr, 0x0100_0303);
  assert.equal(exc, EXC.DSTACK_OVER);
  assert.equal(r.t(1).state, S.HALT);
});

test('特権命令（一般モード）も FAULT', () => {
  const r = boot({ os: kernel(), app: 'HALT' });
  assert.deepEqual(r.t(0).dataStack().slice(0, 2), [0x0100_0303, EXC.PRIVILEGE]);
});

// ---------------------------------------------------------------- SYSCALL

test('SYSCALL：DGETC で受け取り、DPUTC で送り、EXIT でカーネルに EXITED', () => {
  const app = 'PUSHQ #2\nTRAP\nPUSH T\nPUSHQ #1\nTRAP\nPUSHQ #0\nTRAP';  // c を受け取って送り、EXIT(c)
  const r = boot({ os: kernel(), app, setup: m => m.uart.receive('x') });
  assert.equal(r.out, `${WELCOME}x`);
  assert.deepEqual(r.t(0).dataStack(), [0x0100_0201, 0x78]);
});

test('SYSCALL：予約の番号は FAULT（T-96）', () => {
  const r = boot({ os: kernel(), app: 'PUSHQ #4\nTRAP' });
  assert.deepEqual(r.t(0).dataStack().slice(0, 2), [0x0100_0303, EXC.SYSCALL]);
});

// ---------------------------------------------------------------- 拡張命令のソフトによる実行（例外18）

test('拡張命令がない構成でも、ROMのハンドラが同じ結果を返す（M*、U/MOD、/MOD、UM/MOD）', () => {
  const cases = [
    ['MULS', [-3, 5]], ['MULS', [0x8000_0000, 0x8000_0000]], ['MULS', [-1, -1]], ['MULS', [0x7FFF_FFFF, 2]],
    ['MULS', [123456789, -987654]], ['MULS', [0, -5]],
    ['DIVU', [7, 2]], ['DIVU', [0xFFFF_FFFF, 2]], ['DIVU', [7, 0]], ['DIVU', [0xFFFF_FFFF, 0xFFFF_FFFF]],
    ['DIVU', [0x8000_0000, 0xFFFF_FFFF]], ['DIVU', [1000000007, 12345]], ['DIVU', [5, 7]],
    ['DIVS', [-7, 2]], ['DIVS', [7, -2]], ['DIVS', [-7, -2]], ['DIVS', [0x8000_0000, -1]], ['DIVS', [-7, 0]],
    ['DIVS', [0x8000_0000, 3]], ['DIVS', [123456789, -1000]],
    ['DIVUL', [1, 1, 2]], ['DIVUL', [7, 0, 2]], ['DIVUL', [7, 5, 5]], ['DIVUL', [7, 0, 0]],
    ['DIVUL', [0xFFFF_FFFF, 0xFFFF_FFFE, 0xFFFF_FFFF]], ['DIVUL', [0x1234_5678, 0x9ABC, 0xDEF01]],
  ];
  const noExt = makeConfig('9K', { features: 0 });
  for (const [op, args] of cases) {
    const src = `${args.map(a => `PUSH #${a >>> 0}`).join('\n')}\n${op}\nHALT`;
    const hw = direct(src);
    const sw = direct(src, { config: noExt });
    assert.equal(hw.th.lastException, null, `${op} ${args}`);
    assert.equal(sw.th.lastException?.exc, EXC.UNIMPL, `${op} ${args}`);
    assert.equal(sw.th.state, S.HALT, `${op} ${args}`);
    assert.deepEqual(sw.stack, hw.stack, `${op} ${args}`);
  }
});

// ---------------------------------------------------------------- モニタ

test('モニタ：SYSCALL の MONITOR で入り、R・S・D・G（続行）が使える（T-95）', () => {
  const src = 'PUSHQ #5\nPUSHQ #6\nPUSHQ #3\nTRAP\nADD\nHALT';
  const r = direct(src, { setup: m => m.uart.receive('r\rS\rD 100000\rG') });
  assert.equal(r.th.state, S.HALT);
  assert.deepEqual(r.stack, [11]);                         // 続行して ADD を実行した
  assert.match(r.out, /\*\*\* MONITOR TID=00000000\r\nECAUSE=00000008 EPC=00100004 /); // TRAPは2語目（1語目はPUSHQ 3つで埋まる）
  assert.match(r.out, /> r\r\nECAUSE=00000008 /);
  assert.match(r.out, /> S\r\nSP=00000002\r\n00000005 00000006 \r\n/);
  const w0 = r.m.mem.read32(ORG).toString(16).toUpperCase().padStart(8, '0');
  assert.match(r.out, new RegExp(`> D 100000\\r\\n00100000: ${w0} `));
  assert.match(r.out, /> G\r\n$/);
});

test('モニタ：BRK で入る。知らないコマンドは「?」', () => {
  const r = direct('PUSHQ #1\nBKPT', { setup: m => m.uart.receive('Z') });
  assert.match(r.out, /ECAUSE=00000009 /);
  assert.match(r.out, /> Z\r\n\?\r\n> $/);
  assert.equal(r.th.state, S.WAIT);
});

test('モニタ：T で外部RAMの全域を検査する（作業領域を除く）', () => {
  const small = makeConfig('9K', { extRamSize: 0x1_0000 });  // 64KB（テストの時間を短くするため）
  let r = direct('PUSHQ #3\nTRAP', { config: small, setup: m => m.uart.receive('T') });
  assert.match(r.out, /> T\r\nRAM OK\r\n> $/);
  r = direct('PUSHQ #3\nTRAP', {
    config: small,
    setup: m => { m.uart.receive('T'); faultyRam(m, { value: v => (v === 0x0100_8000 ? 0 : v) }); },
  });
  assert.match(r.out, /> T\r\nRAM ERROR \$01008000\r\n/);
});

// ---------------------------------------------------------------- サンプル（ブートROMから）

test('examples/03_uart_puts.asm をOSイメージにすると、起動メッセージの後に "Hello, world!"', () => {
  const r = boot({ os: example('03_uart_puts.asm') });
  assert.equal(r.out, `${WELCOME}Hello, world!\r\n`);
});

test('examples/04_vram_puts.asm をOSイメージにすると、画面に "HELLO"', () => {
  const r = boot({ os: example('04_vram_puts.asm') });
  assert.equal(r.m.video.textRow(5).slice(10, 15), 'HELLO');
});

test('examples/01・02 を START で（特権モードで）起動する', () => {
  let r = boot({ os: kernel({ mode: 1 }), app: example('01_sum.asm') });
  assert.equal(r.m.mem.read32(UP), 55);
  assert.equal(r.t(1).state, S.HALT);
  r = boot({ os: kernel({ mode: 1 }), app: example('02_max.asm') });
  assert.equal(r.m.mem.read32(UP), 1000);
});

test('examples/05_sleep_joy.asm を START で一般モードで起動し、Aボタンで EXIT', () => {
  const r = boot({ os: kernel({ mode: 0 }), app: example('05_sleep_joy.asm'), setup: m => { m.gpio.joy = 0x10; } });
  assert.deepEqual(r.t(0).dataStack(), [0x0100_0201, 0]);
  assert.equal(r.t(1).state, S.RECV);                       // EXIT で idle に戻った
  assert.ok(r.m.timer.counter >= 16_667);
});
