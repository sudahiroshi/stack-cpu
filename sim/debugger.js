// デバッガ：ステップ実行とブレークポイント（docs/ui.md 5章・7章）。DOMに依存しない。
//
// ブレークポイントはメモリを書き換えず、シミュレータの側で止める（CPUのBRK命令とは別）。
//   - 命令語の番地：どれかのスレッドが、その番地の語を実行し始める直前で止める（Machine.breakHook）。
//     止めたサイクルの残り（20Kでは後のコア）は、続けるときに実行するので、止めない実行と結果は同じになる。
//   - 例外：選んだ番号の例外の入口の処理を終えたサイクルの終わりで止める（Machine.exceptionHook）。
//   - メモリへの書き込み：指定した4バイトに書き込んだサイクルの終わりで止める（Memory.onWrite）。
//   - メッセージの到着：指定したスレッドのメールボックスにメッセージが届いたサイクルの終わりで止める（Machine.mailHook）。
//     受け取る側はまだ RECV していないので、メールボックスの中身を見られる。
// 止まった後に続けると、止まった語からそのまま進む（同じブレークポイントですぐに止まり直さない）。
//
// 止まった理由：
//   { type: 'breakpoint', tid, addr }   { type: 'exception', tid, exc }   { type: 'watch', tid, addr, writeAddr, size }
//   { type: 'mailbox', tid, src, header }  tid のメールボックスに src からメッセージが届いた
//   { type: 'step', tid? }  ステップの終わり     { type: 'stopped' }  すべてのスレッドが止まった
//   { type: 'limit' }       サイクル数・命令数の上限    { type: 'timeout', tid }  ステップが終わらない（上限で打ち切り）
import { OP } from './isa.js';
import { decodeWord } from './decode.js';
import { THREAD_STATE } from './devices/registers.js';

const S = THREAD_STATE;

export class Debugger {
  /** @param {import('./machine.js').Machine} machine */
  constructor(machine) {
    this.m = machine;
    /** 命令語の番地のブレークポイント（全スレッド共通） */
    this.breakpoints = new Set();
    /** 止める例外の番号 */
    this.exceptionBreaks = new Set();
    /** 書き込みを見張る番地（4バイト単位。下位2bitは0にする） */
    this.watches = new Set();
    /** メッセージが届いたら止めるスレッド（受け取る側のtid） */
    this.mailBreaks = new Set();
    /** ステップが終わらないときに打ち切るサイクル数 */
    this.stepLimit = 10_000_000;
    this.pending = null;   // 例外・書き込みで止める理由（サイクルの終わりで止める）
    this.skip = null;      // { tid, addr }：続けたとき、止まった語ですぐに止まり直さない
    this.breaksEnabled = true;
    machine.breakHook = th => this.#checkBreak(th);
    machine.exceptionHook = (th, exc) => {
      if (this.exceptionBreaks.has(exc)) this.pending ??= { type: 'exception', tid: th.tid, exc };
    };
    machine.mem.onWrite = (addr, size, ctx) => this.#checkWrite(addr, size, ctx);
    machine.mailHook = (target, header, from) => {
      if (this.mailBreaks.has(target.tid)) this.pending ??= { type: 'mailbox', tid: target.tid, src: from.tid, header };
    };
  }

  /** マシンをリセットしたときに呼ぶ（止まっていた状態を忘れる） */
  reset() {
    this.pending = null;
    this.skip = null;
  }

  /** 番地のブレークポイントを置く・外す。置いたら true */
  toggleBreakpoint(addr) {
    addr = (addr & ~3) >>> 0;
    if (this.breakpoints.has(addr)) { this.breakpoints.delete(addr); return false; }
    this.breakpoints.add(addr);
    return true;
  }

  /** 書き込みの見張りを置く・外す。置いたら true */
  toggleWatch(addr) {
    addr = (addr & ~3) >>> 0;
    if (this.watches.has(addr)) { this.watches.delete(addr); return false; }
    this.watches.add(addr);
    return true;
  }

  /** メッセージの到着で止めるスレッドを置く・外す。置いたら true */
  toggleMailBreak(tid) {
    if (this.mailBreaks.has(tid)) { this.mailBreaks.delete(tid); return false; }
    this.mailBreaks.add(tid);
    return true;
  }

  #checkBreak(th) {
    if (!this.breaksEnabled || !this.breakpoints.has(th.pc)) return null;
    if (this.skip && this.skip.tid === th.tid && this.skip.addr === th.pc) {
      this.skip = null;
      return null;
    }
    return { type: 'breakpoint', tid: th.tid, addr: th.pc };
  }

  #checkWrite(addr, size, ctx) {
    if (this.watches.size === 0 || this.pending) return;
    for (const w of this.watches) {
      if (addr < w + 4 && addr + size > w) {
        this.pending = { type: 'watch', tid: ctx.tid, addr: w, writeAddr: addr, size };
        return;
      }
    }
  }

  /** breakHook で止まったときの理由（続けたとき同じ語で止まり直さないように覚える） */
  #stopAtBreak() {
    const r = this.m.breakReason;
    this.m.breakReason = null;
    this.skip = { tid: r.tid, addr: r.addr };
    return r;
  }

  #takePending() {
    const p = this.pending;
    this.pending = null;
    return p;
  }

  /**
   * 通常の実行。ブレークポイント、例外、書き込みの見張り、すべての停止、上限で止まる。
   * Machine.hostInput が true（UI）のときは、UARTの入力を待つスレッドがいると止まらないので、maxCycles を付けて呼ぶ。
   * @param {{ maxCycles?: number, maxIssues?: number }} [opts]  maxIssues：発行の回数の上限（「ゆっくり」の実行用）
   */
  run({ maxCycles = Infinity, maxIssues = Infinity } = {}) {
    const end = this.m.cycle + maxCycles;
    let issues = 0;
    this.pending = null;
    for (;;) {
      const r = this.m.stepFast(end);
      if (r === 'break') return this.#stopAtBreak();
      if (r === 'stopped') return { type: 'stopped' };
      if (r === 'limit') return { type: 'limit' };
      if (this.pending) return this.#takePending();
      issues += this.m.lastIssue.length;
      if (issues >= maxIssues) return { type: 'limit' };
    }
  }

  /** 全体を1サイクル進める（番地のブレークポイントでは止めない） */
  stepCycle() {
    this.pending = null;
    this.breaksEnabled = false;
    try {
      this.m.step();
    } finally {
      this.breaksEnabled = true;
    }
    return this.#takePending() ?? { type: 'step' };
  }

  /** 選んだスレッドが次に1命令を実行する（発行される）まで進める */
  stepInstruction(tid) {
    return this.#stepThread(tid, () => true);
  }

  /** 選んだスレッドが今の語を最後まで実行する（または分岐する、止まる）まで進める */
  stepWord(tid) {
    return this.#stepThread(tid, th => th.dec === null || th.state === S.HALT || th.state === S.DOUBLE_FAULT);
  }

  /** 次の命令が CALL・EXEC なら、呼んだ先から戻るまで進める。それ以外は stepInstruction と同じ */
  stepOver(tid) {
    const th = this.m.thread(tid);
    const next = this.nextInstruction(th);
    if (!next || !(next.inst.op === OP.CALL || next.inst.op === OP.EXEC)) return this.stepInstruction(tid);
    const base = th.rdepth;
    const ret = next.nextWord;
    return this.#stepThread(tid, t =>
      (t.dec === null && t.pc === ret && t.rdepth === base) || t.state === S.HALT || t.state === S.DOUBLE_FAULT);
  }

  /**
   * スレッドが次に実行する命令と、その語の「次の語」の番地。命令語が読めなければ null。
   * @returns {null | { inst: object, wordAddr: number, nextWord: number }}
   */
  nextInstruction(th) {
    if (th.dec) return { inst: th.dec.insts[th.idx], wordAddr: th.wordAddr, nextWord: th.nextPc };
    const word = peekWord(this.m, th.pc);
    if (word === null) return null;
    const dec = decodeWord(word);
    if (dec.insts.length === 0) return null;
    return { inst: dec.insts[0], wordAddr: th.pc, nextWord: th.pc + 4 + 4 * dec.litCount };
  }

  /** 選んだスレッドが発行され、isDone が真になるまで進める（他のスレッドのブレークポイントでも止まる） */
  #stepThread(tid, isDone) {
    const th = this.m.thread(tid);
    this.pending = null;
    if (th.dec === null && this.breakpoints.has(th.pc)) this.skip = { tid, addr: th.pc }; // いまいる語のブレークポイントは飛ばす
    const end = this.m.cycle + this.stepLimit;
    for (;;) {
      const r = this.m.stepFast(end);
      if (r === 'break') return this.#stopAtBreak();
      if (r === 'stopped') return { type: 'stopped' };
      if (r === 'limit') return { type: 'timeout', tid };
      const done = this.m.lastIssue.includes(th) && isDone(th);
      if (this.pending) return this.#takePending();
      if (done) return { type: 'step', tid };
    }
  }
}

/** 番地の語を、副作用なしに読む（I/Oや割り当てのない番地は null）。表示用 */
export function peekWord(m, addr) {
  addr >>>= 0;
  if (addr & 3) return null;
  const r = m.mem.region(addr);
  if (!r || r.kind === 'io') return null;
  const b = r.buf, o = r.off;
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
