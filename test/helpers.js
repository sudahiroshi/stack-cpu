// テストの補助関数
import { Machine } from '../sim/machine.js';
import { assemble } from '../asm/assembler.js';

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

function start(m, image, { origin = ORG, up = UP, mode = 1, setup, maxCycles = 1_000_000, allowRunning = false }) {
  m.load(origin, image);
  const th = m.thread(0);
  th.pc = origin;
  th.up = up;
  th.mode = mode;
  setup?.(m, th);
  const res = m.runUntilStop(maxCycles);
  if (!res.stopped && !allowRunning) throw new Error('止まらなかった');
  return { m, th, cycles: res.cycles, stack: th.dataStack(), rstack: th.returnStack(), exc: th.lastException };
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
