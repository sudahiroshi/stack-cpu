// 段階5：周辺回路（UART、タイマ、GPIO、ユーザーページ、画面、スレッドの制御）のテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Machine } from '../sim/machine.js';
import { assemble } from '../asm/assembler.js';
import { OP, EXC, RESET } from '../sim/isa.js';
import { THREAD_STATE } from '../sim/devices/registers.js';
import { DEFAULT_PALETTE, WIDTH } from '../sim/devices/video.js';
import { run, runThreads, haltOthers, grantUserKey, wordsToBytes, HALT_WORD, ORG, UP } from './helpers.js';

const S = THREAD_STATE;
const T9K = 469 * 10;          // 9Kで1バイトの送受信にかかるサイクル数（DIV×10）
const example = name => readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8');

/** 例外が起きずにHALTで止まったことを確かめてスタックを返す */
function stackOf(src, opts) {
  const r = run(`${src}\nHALT`, opts);
  assert.equal(r.exc, null, `例外が起きた: ${JSON.stringify(r.exc)}`);
  return r.stack;
}

// ---------------------------------------------------------------- UART

test('UART：リセット値（DIVは115,200bps相当、STATUSは送信完了）', () => {
  assert.deepEqual(stackOf('LD $FF000004\nLD $FF000008\nLD $FF000000'), [0b100, 469, 0x8000_0000]);
  assert.deepEqual(stackOf('LD $FF000008', { config: '20K' }), [625]);
});

test('UART：1バイトの送信に DIV×10 サイクル。続けて書くと順に送る（T-35）', () => {
  const sent = [];
  const writes = [];
  const r = run('PUSH #65\nST $FF000000\nPUSH #66\nST $FF000000\nHALT', {
    setup: m => {
      m.uart.onTx = (b, cycle) => sent.push([b, cycle]);
      m.on(e => { if (e.type === 'exec' && e.inst.op === OP['!']) writes.push(e.cycle); });
    },
  });
  r.m.run(3 * T9K);
  assert.deepEqual(sent, [[65, writes[0] + T9K], [66, writes[0] + 2 * T9K]]);
  assert.equal(r.m.uart.outputText, 'AB');
  assert.equal(r.m.mem.read32(0xFF00_0004) & 0b100, 0b100); // 送信がすべて完了
});

test('UART：送信FIFOは16バイト。一杯なら捨て、STATUSのbit1が立つ', () => {
  const r = run(`
        PUSH #18
l:      PSHR
        PUSH #88
        ST $FF000000
        PULR
        ADD #-1
        PUSH T
        BNZ l
        POP
        LD $FF000004
        HALT`);
  assert.equal(r.exc, null);
  assert.deepEqual(r.stack, [0b010]);   // 一杯（送信中なので完了ではない）
  r.m.run(20 * T9K);
  assert.equal(r.m.uart.output.length, 17); // 送信中の1バイト＋FIFOの16バイト。18バイト目は捨てた
});

test('UART：受信（DIV×10サイクルごとに1バイト届く）。WAITのビット4で待てる', () => {
  const r = run('PUSH #16\nWAIT\nLD $FF000000\nLD $FF000000\nHALT', { setup: m => m.uart.receive('AB') });
  assert.equal(r.exc, null);
  // 'A'が届いた直後に読むので、'B'はまだ届いていない
  assert.deepEqual(r.stack, [16, 0x41, 0x8000_0000]);
  assert.ok(r.m.cycle >= T9K && r.m.cycle < T9K + 100);
});

test('UART：受信FIFO（16バイト）があふれると STATUSのbit3。1を書くと消える', () => {
  const r = run('HALT', { setup: m => m.uart.receive(new Array(20).fill(0x30)) });
  const m = r.m;
  m.run(21 * T9K);
  assert.equal(m.uart.rxFifo.length, 16);
  assert.equal(m.mem.read32(0xFF00_0004), 0b1101);   // 受信データあり、送信完了、受信あふれ
  m.mem.write32(0xFF00_0004, 0b0111);                // bit3以外は無視
  assert.equal(m.mem.read32(0xFF00_0004), 0b1101);
  m.mem.write32(0xFF00_0004, 0b1000);
  assert.equal(m.mem.read32(0xFF00_0004), 0b0101);
});

test('UART：割り当てのないオフセットはバスエラー、8bitアクセスは例外10', () => {
  assert.equal(run('LD $FF00000C').exc.exc, EXC.BUS);
  assert.equal(run('PUSH #$FF000000\nLDB').exc.exc, EXC.ALIGN);
});

test('examples/03_uart_puts.asm：UARTに "Hello, world!" を出す', () => {
  const r = run(example('03_uart_puts.asm'));
  assert.equal(r.exc, null);
  // スレッドが止まっても、UARTの送信を出し終えるまで進める
  assert.equal(r.m.uart.outputText, 'Hello, world!\r\n');
  assert.equal(r.m.uart.transmitting, false);
});

// ---------------------------------------------------------------- タイマ

test('タイマ：カウンタは1マイクロ秒（仮想時間）、PRESCALEは1マイクロ秒あたりのクロック数', () => {
  const r = run('LD $FF001008\nLD $FF001000\nLD $FF001004\nHALT');
  assert.equal(r.exc, null);
  assert.equal(r.stack[0], 54);
  assert.equal(r.stack[2], 0);
  assert.deepEqual(stackOf('LD $FF001008', { config: '20K' }), [72]);
  const m = new Machine('9K');
  m.cycle = 54 * 1234 + 53;
  assert.equal(m.timer.counter, 1234);
});

test('タイマ：CMP_HI、CMP_LOの順に書くと比較を開始し、達したらイベント2（ユーザーページ）', () => {
  const r = run(`
        PUSHQ #0
        ST $FF0F000C
        PUSH #100
        ST $FF0F0008
        PUSHQ #4
        WAIT
        LD $FF0F0000
        HALT`);
  assert.equal(r.exc, null);
  assert.deepEqual(r.stack, [4, 100]);       // 100マイクロ秒で起き、カウンタは100
  assert.equal(r.th.events, 0);              // ラッチは消えた
  assert.equal(r.m.timer.armed(0), false);   // 比較は止まった
});

test('タイマ：CMP_HIを書くと比較は止まる（起きる見込みがないので止まったとみなす）', () => {
  const r = run('PUSH #100\nST $FF0F0008\nPUSHQ #0\nST $FF0F000C\nPUSHQ #4\nWAIT\nHALT');
  assert.equal(r.th.state, S.WAIT);
  assert.equal(r.m.timer.armed(0), false);
});

test('タイマ：すでに過ぎた値を書くとすぐにイベント2', () => {
  assert.deepEqual(stackOf('PUSHQ #0\nST $FF0F0008\nPUSHQ #4\nWAIT'), [4]);
});

test('タイマ：特権モードの番地から他のスレッドの比較レジスタを書ける', () => {
  const r = run('PUSH #10\nST $FF001808\nLD $FF001808\nHALT');   // CMP_LO[1]
  assert.deepEqual(r.stack, [10]);
  r.m.run(54 * 11);
  assert.equal(r.m.thread(1).events & 4, 4);
  assert.equal(r.th.events & 4, 0);
});

test('タイマ：読み出し専用への書き込みは例外12、割り当てのないオフセットは例外11', () => {
  assert.equal(run('PUSHQ #0\nST $FF001000').exc.exc, EXC.PROTECT);
  assert.equal(run('PUSHQ #0\nST $FF001008').exc.exc, EXC.PROTECT);
  assert.equal(run('LD $FF00100C').exc.exc, EXC.BUS);
  assert.equal(run('LD $FF001840').exc.exc, EXC.BUS);   // 9Kにtid 8はない
});

// ---------------------------------------------------------------- GPIO・ユーザーページ

test('GPIO：JOYはホストが設定する（読み出しのみ）、LEDは6bit', () => {
  const setup = m => { m.gpio.joy = 0x8011; };
  assert.deepEqual(stackOf('LD $FF002000\nPUSHQ #-1\nST $FF002004\nLD $FF002004', { setup }), [0x8011, 0x3f]);
  assert.equal(run('PUSHQ #0\nST $FF002000').exc.exc, EXC.PROTECT);
  assert.equal(run('LD $FF002008').exc.exc, EXC.BUS);
});

test('ユーザーページ：一般モードから CNT・自分のCMP・JOYを使える', () => {
  const r = run('PUSH #77\nST $FF0F0008\nLD $FF0F0008\nLD $FF0F0010\nLD $FF0F0004\nTRAP', {
    mode: 0, setup: (m, th) => { grantUserKey(m, th); m.gpio.joy = 0x10; },
  });
  assert.equal(r.exc.exc, EXC.SYSCALL);
  assert.deepEqual(r.stack, [77, 0x10, 0]);
  assert.equal(run('PUSHQ #0\nST $FF0F0000', { mode: 0 }).exc.exc, EXC.PROTECT);
  assert.equal(run('PUSHQ #0\nST $FF0F0010', { mode: 0 }).exc.exc, EXC.PROTECT);
});

test('ユーザーページの「自分の」比較レジスタは、アクセスしたスレッドのもの', () => {
  const src = 'a: TID\nADD #5\nST $FF0F0008\nHALT';
  const r = runThreads(src, { threads: { 0: 'a', 3: 'a' } });
  assert.equal(r.m.timer.readCmp(0, false), 5);
  assert.equal(r.m.timer.readCmp(3, false), 8);
});

test('examples/05_sleep_joy.asm：約1/60秒ごとにジョイパッドを見て、Aボタンで止まる', () => {
  const m = new Machine('9K');
  m.load(ORG, assemble(example('05_sleep_joy.asm'), { origin: ORG }).bytes);
  m.load(RESET.VBR, wordsToBytes(new Array(19).fill(HALT_WORD)));
  haltOthers(m, [0]);
  m.thread(0).pc = ORG;
  m.thread(0).up = UP;
  // Aを押していなければ回り続ける
  let res = m.runUntilStop(54 * 100_000);    // 0.1秒
  assert.equal(res.stopped, false);
  // Aを押すと、次に見たときに止まる
  m.gpio.joy = 0x10;
  res = m.runUntilStop(54 * 100_000);
  assert.equal(res.stopped, true);
  // 最後は SYSCALL の EXIT（このテストではROMのハンドラの代わりにベクタのHALTで止まる）
  assert.equal(m.thread(0).lastException?.exc, EXC.SYSCALL);
  assert.ok(m.timer.counter >= 100_000 && m.timer.counter < 100_000 + 2 * 16_667);
});

// ---------------------------------------------------------------- 画面

test('画面：VIDCAPS、VIDMODE（使えないモードはエラーのビット）、CTRLのリセット値', () => {
  assert.deepEqual(stackOf(`
    LD $FF003000
    PUSHQ #1
    ST $FF003004
    LD $FF003004
    PUSHQ #0
    ST $FF003004
    LD $FF003004
    LD $FF003008`), [1, 0x8000_0000, 0, 1]);
  assert.equal(run('PUSHQ #0\nST $FF003000').exc.exc, EXC.PROTECT);
  assert.equal(run('PUSHQ #0\nST $FF00300C').exc.exc, EXC.PROTECT);
  assert.equal(run('LD $FF00301C').exc.exc, EXC.BUS);
  assert.equal(run('LD $FF003100').exc.exc, EXC.BUS);
});

test('画面：パレットのリセット値はCGAの16色（T-36）。書き換えられる', () => {
  const lds = Array.from({ length: 16 }, (_, i) => `LD $${(0xFF003040 + i * 4).toString(16)}`).join('\n');
  assert.deepEqual(stackOf(lds), DEFAULT_PALETTE);
  assert.deepEqual(stackOf('PUSH #$FF123456\nST $FF003044\nLD $FF003044'), [0x123456]);
});

test('画面：VSYNC（イベント3）は帰線期間に入ったとき。STATUSのbit0は帰線期間中（T-37）', () => {
  const r = run('PUSHQ #8\nWAIT\nLD $FF00300C\nHALT');
  assert.equal(r.exc, null);
  assert.deepEqual(r.stack, [8, 1]);
  const vblank = Math.round(800 * 480 * 54 / 25.2);   // 822,857
  assert.ok(r.m.cycle >= vblank && r.m.cycle < vblank + 100);
  assert.equal(r.m.video.frameCycles, 900_000);
  assert.equal(new Machine('20K').video.frameCycles, 1_200_000);
});

test('画面：VSYNCは毎フレーム', () => {
  const r = run('PUSHQ #8\nWAIT\nPUSHQ #8\nWAIT\nHALT', { maxCycles: 3_000_000 });
  assert.deepEqual(r.stack, [8, 8]);
  assert.ok(r.m.cycle >= 900_000 + 822_857 && r.m.cycle < 900_000 + 822_857 + 100);
});

test('早送りしても、1サイクルずつ進めたときと同じ結果になる', () => {
  const src = 'PUSHQ #8\nWAIT\nLD $FF001000\nHALT';
  const a = run(src);
  const m = new Machine('9K');
  m.load(ORG, assemble(src, { origin: ORG }).bytes);
  m.load(RESET.VBR, wordsToBytes(new Array(19).fill(HALT_WORD)));
  haltOthers(m, [0]);
  m.thread(0).pc = ORG;
  while (m.thread(0).state !== S.HALT) m.step();
  assert.deepEqual(m.thread(0).dataStack(), a.stack);
  assert.equal(m.cycle, a.m.cycle);
});

test('テキストVRAMとフォントRAMは8bit・32bitで読み書きできる。VRAMは4,800バイトまで', () => {
  assert.deepEqual(stackOf(`
    PUSH #$41
    PUSH #$FF010000
    STB
    PUSH #$1F
    PUSH #$FF010001
    STB
    LD $FF010000
    PUSH #$FF020000
    ADD #$41*16+2
    LDB`), [0x1F41, 0b0100_0100]); // 'A' の2行目（図柄の2行目「#...#」を縦に2倍した1行目）
  assert.equal(run('LD $FF0112C0').exc.exc, EXC.BUS);   // +4800
  assert.deepEqual(stackOf('PUSH #$AA55\nST $FF020000\nLD $FF020000'), [0xAA55]);
});

test('フォントの初期値：0x20〜0x7Eは図柄があり、それ以外は空白（T-38）', () => {
  const { font } = new Machine('9K').video;
  const blank = c => font.subarray(c * 16, c * 16 + 16).every(b => b === 0);
  assert.ok(blank(0x00) && blank(0x1F) && blank(0x7F) && blank(0x80) && blank(0xFF) && blank(0x20));
  for (let c = 0x21; c <= 0x7E; c++) assert.ok(!blank(c), String.fromCharCode(c));
});

test('examples/04_vram_puts.asm：5行目・10桁目に色付きの "HELLO"', () => {
  const r = run(example('04_vram_puts.asm'));
  assert.equal(r.exc, null);
  assert.equal(r.m.video.textRow(5).slice(10, 15), 'HELLO');
  const base = (5 * 80 + 10) * 2;
  assert.deepEqual([...r.m.video.vram.subarray(base, base + 10)].filter((_, i) => i % 2), [0x1E, 0x1E, 0x1E, 0x1E, 0x1E]);
});

/** RGBAの画面の点(x, y)の色 */
const pixel = (img, x, y) => {
  const p = (y * WIDTH + x) * 4;
  return (img[p] << 16) | (img[p + 1] << 8) | img[p + 2];
};

test('画面を描く：文字色・背景色、SCROLL、表示の無効化', () => {
  const m = new Machine('9K');
  const v = m.video;
  v.vram[0] = 0x41; v.vram[1] = 0x1F;           // 0行0桁：'A'、背景1（青）、文字色15（白）
  v.vram[160] = 0x42; v.vram[161] = 0x4E;       // 1行0桁：'B'、背景4（赤）、文字色14（黄）
  let img = v.renderRGBA();
  assert.equal(pixel(img, 0, 0), 0x0000AA);     // 背景
  assert.equal(pixel(img, 2, 0), 0xFFFFFF);     // 'A' の1行目「.###.」の左端（1ドット右にずらしてある）
  assert.equal(pixel(img, 0, 16), 0xAA0000);
  v.scroll = 1;                                 // 画面の先頭にVRAMの1行目
  img = v.renderRGBA();
  assert.equal(pixel(img, 0, 0), 0xAA0000);
  assert.equal(pixel(img, 0, 29 * 16), 0x0000AA); // VRAMの0行目は画面の最下行
  v.ctrl = 0;
  img = v.renderRGBA();
  assert.equal(pixel(img, 2, 0), 0x000000);
});

test('画面を描く：カーソル（開始・終了ライン、点滅は32フレームごと。T-39）', () => {
  const m = new Machine('9K');
  const v = m.video;
  v.vram[2 * 81] = 0x20; v.vram[2 * 81 + 1] = 0x07;  // 1行1桁：空白、文字色7
  v.cursor = (1 << 8) | 1;
  v.cursorCtl = (15 << 12) | (14 << 8) | 0b11;      // 表示・点滅、14〜15ライン
  let img = v.renderRGBA();
  assert.equal(pixel(img, 8, 16 + 14), 0xAAAAAA);    // カーソルは文字色
  assert.equal(pixel(img, 8, 16 + 13), 0x000000);
  m.cycle = 32 * v.frameCycles;                      // 消えている期間
  img = v.renderRGBA();
  assert.equal(pixel(img, 8, 16 + 14), 0x000000);
  m.cycle = 64 * v.frameCycles;
  img = v.renderRGBA();
  assert.equal(pixel(img, 8, 16 + 14), 0xAAAAAA);
});

// ---------------------------------------------------------------- スレッドの制御

test('THREADCTL：他のスレッドをリセットする。THREADSTATで状態を読める', () => {
  const src = `
ctl:    LD $FF004104
        PUSHQ #1
        ST $FF004000
        LD $FF004104
        HALT
w:      RECV
        HALT`;
  const r = runThreads(src, { threads: { 1: 'w', 0: 'ctl' } });
  // スレッド1は最初の番でRECVの待ちに入る（3）。リセットするとROMの先頭から動き出す（1）
  const t0 = r.m.thread(0);
  const t1 = r.m.thread(1);
  assert.equal(t0.lastException, null);
  assert.deepEqual(t0.dataStack(), [S.RECV, S.RUNNING]);
  // ROMは0（NOP）なので、VBR（0xFFFF_0100）のHALTまで進んで止まる
  assert.equal(t1.state, S.HALT);
  assert.equal(t1.lastException, null);
  assert.equal(t1.pc, RESET.VBR);
});

test('THREADCTL：自分自身もリセットできる（ROMの先頭からやり直す）', () => {
  const m = new Machine('9K');
  m.load(ORG, assemble('TID\nST $FF004000\nHALT', { origin: ORG }).bytes);
  m.load(RESET.PC, wordsToBytes([HALT_WORD]));
  m.load(RESET.VBR, wordsToBytes(new Array(19).fill(HALT_WORD)));
  haltOthers(m, [0]);
  m.thread(0).pc = ORG;
  m.runUntilStop(10_000);
  const th = m.thread(0);
  assert.equal(th.state, S.HALT);
  assert.equal(th.lastException, null);
  assert.equal(th.pc, RESET.PC);       // ROMの先頭のHALTの語で止まった（HALTは語の途中で止まるのでPCは語の先頭）
  assert.equal(th.instret, 1);         // リセットでINSTRETも0に戻り、HALTの1命令だけ
});

test('THREADCTL：存在しないtidは例外14（T-92）、読み出しは例外12', () => {
  assert.equal(run('PUSHQ #8\nST $FF004000').exc.exc, EXC.BAD_TID);
  assert.equal(run('LD $FF004000').exc.exc, EXC.PROTECT);
  assert.equal(run('PUSHQ #0\nST $FF004100').exc.exc, EXC.PROTECT);
  assert.equal(run('LD $FF004120').exc.exc, EXC.BUS);    // 9Kにtid 8はない
});
