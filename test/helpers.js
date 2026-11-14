// テストの補助関数
import { Machine } from '../sim/machine.js';
import { assemble } from '../asm/assembler.js';
import { THREAD_STATE } from '../sim/devices/registers.js';
import { KEY } from '../sim/devices/keytable.js';
import { RESET, OP, SYS } from '../sim/isa.js';

export const ORG = 0x0010_0000;   // コア0のローカルBSRAMの先頭（命令をフェッチできる）
export const UP = 0x0010_4000;    // テストで使うユーザー領域（128バイト境界）

/** スロットの値（slot0から）と slot6 から命令語を作る */
export function W(slots, s6 = 0) {
  let w = 0;
  slots.forEach((v, i) => { w |= v << (27 - 5 * i); });
  return (w | s6) >>> 0;
}

/** 32bit語の配列をリトルエンディアンのバイト列にする */
export function wordsToBytes(words) {
  const b = new Uint8Array(words.length * 4);
  words.forEach((w, i) => { for (let k = 0; k < 4; k++) b[i * 4 + k] = (w >>> (8 * k)) & 0xff; });
  return b;
}

export const HALT_WORD = W([OP.SYS, SYS.HALT]);
export const NUM_VECTORS = 19; // 例外0〜18

/** ブートROMの例外ベクタ（VBRのリセット値＋番号×4）をすべてHALTにする。例外が起きたらベクタ先で止まる */
export function installHaltVectors(m) {
  m.load(RESET.VBR, wordsToBytes(new Array(NUM_VECTORS).fill(HALT_WORD)));
}

/**
 * 一般モードで動かせるように、ローカルBSRAMの全ページをキー1（W・X）にし、スレッドにキー1を与える。
 */
export function grantUserKey(m, th, key = 1) {
  m.keytable.local[th.core].fill(key | KEY.W | KEY.X);
  th.pkread = 1 << key;
  th.pkwrite = 1 << key;
}

function start(m, image, { origin = ORG, up = UP, mode = 1, setup, maxCycles = 1_000_000, allowRunning = false }) {
  m.load(origin, image);
  installHaltVectors(m);
  haltOthers(m, [0]);
  const th = m.thread(0);
  th.pc = origin;
  th.up = up;
  th.mode = mode;
  if (mode === 0) grantUserKey(m, th);
  setup?.(m, th);
  const res = m.runUntilStop(maxCycles);
  if (!res.stopped && !allowRunning) throw new Error('止まらなかった');
  return { m, th, cycles: res.cycles, stack: th.dataStack(), rstack: th.returnStack(), exc: th.lastException };
}

/** tids 以外のスレッドを止めておく（1スレッドだけのテスト用） */
export function haltOthers(m, tids) {
  for (const th of m.threads) if (!tids.includes(th.tid)) th.state = THREAD_STATE.HALT;
}

/**
 * ソースをアセンブルしてローカルBSRAMに読み込み、tid 0 で止まるまで実行する。
 * @param {string} src
 * @param {{ config?: string|object, origin?: number, up?: number, mode?: number,
 *           setup?: (m: Machine, th: object) => void, maxCycles?: number }} [opts]
 */
export function run(src, opts = {}) {
  const m = new Machine(opts.config ?? '9K');
  const r = assemble(src, { origin: opts.origin ?? ORG });
  return { ...start(m, r.bytes, opts), asm: r };
}

/** 手で作った命令語を読み込んで実行する（アセンブラが作らない語のテスト用） */
export function runWords(words, opts = {}) {
  const m = new Machine(opts.config ?? '9K');
  return start(m, wordsToBytes(words), opts);
}

/**
 * 複数のスレッドを動かす。ソースをアセンブルして各コアのローカルBSRAMの先頭に読み込み、
 * threads に挙げたスレッドをそれぞれのラベルから始める（他のスレッドは止めておく）。
 * UPはスレッドごとに UP＋tid×128。
 * @param {string} src
 * @param {{ threads: Record<number, string>, config?: string|object, maxCycles?: number,
 *           setup?: (m: Machine) => void, trace?: boolean }} opts
 * @returns {{ m: Machine, asm: object, cycles: number, stopped: boolean, blocked: number[], events: object[] }}
 */
export function runThreads(src, { threads, config = '9K', maxCycles = 1_000_000, setup, trace = false }) {
  const m = new Machine(config);
  const asm = assemble(src, { origin: ORG });
  for (let c = 0; c < m.cfg.ncores; c++) m.load(ORG + c * 0x1_0000, asm.bytes);
  installHaltVectors(m);
  const tids = Object.keys(threads).map(Number);
  haltOthers(m, tids);
  for (const tid of tids) {
    const th = m.thread(tid);
    const sym = asm.symbols.get(threads[tid]);
    if (sym === undefined) throw new Error(`ラベルがない: ${threads[tid]}`);
    th.pc = sym + (tid >> 4) * 0x1_0000;
    th.up = UP + tid * 128;
  }
  setup?.(m);
  const events = [];
  if (trace) m.on(e => events.push(e));
  const res = m.runUntilStop(maxCycles);
  return { m, asm, ...res, events };
}
