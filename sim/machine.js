// マシン全体（コア、スレッド、メモリ、デバイス）。DOMに依存しない（ブラウザとNode.jsの両方で動かす）。
//
// 段階2：動かすのはコア0のスレッド0（tid 0）だけ。他のスレッドはリセット直後の状態のまま止めておく。
//        段階3でバレル（実行可能なスレッドだけのラウンドロビン）に置き換える。
import { makeConfig } from './config.js';
import { Memory } from './memory.js';
import { Thread } from './thread.js';
import { issue } from './core.js';
import { THREAD_STATE } from './devices/registers.js';

export class Machine {
  /** @param {string|object} config '9K' | '20K' | 構成オブジェクト */
  constructor(config = '9K') {
    this.cfg = typeof config === 'string' ? makeConfig(config) : config;
    this.mem = new Memory(this.cfg);
    this.cores = Array.from({ length: this.cfg.ncores }, (_, c) => ({
      id: c,
      threads: Array.from({ length: this.cfg.nthreads }, (_, t) => new Thread(this.cfg, c, t)),
    }));
    this.listeners = new Set(); // UIやトレース用のフック。イベント：{ type: 'exec' | 'exception', ... }
    this.reset();
  }

  /** リセット（11.1節）。メモリの中身は消さない */
  reset() {
    this.cycle = 0; // 仮想時間（サイクル数）
    for (const th of this.threads) th.reset();
    // TODO(段階3): 全スレッドを実行可能にする（11.1節：全スレッドが同時に同じ番地から始まる）
    this.thread(0).state = THREAD_STATE.RUNNING;
  }

  /** すべてのスレッド（コア0から順） */
  get threads() {
    return this.cores.flatMap(c => c.threads);
  }

  /** tid（上位4bit＝コア、下位4bit＝スレッド。6.3節）からスレッドを得る */
  thread(tid) {
    const th = this.cores[tid >> 4]?.threads[tid & 0xf];
    if (!th) throw new Error(`存在しないtid: ${tid}`);
    return th;
  }

  /** イメージ（Uint8Array）を指定の番地に読み込む（OSイメージの直接読み込み、11.2節） */
  load(address, bytes) {
    this.mem.load(address, bytes);
  }

  /**
   * 1サイクル進める。発行できるスレッドがあれば1命令を実行する。
   * 同じスレッドはD（pipelineDepth）サイクル以上あけて発行する（6.1節）。
   * @returns {boolean} 命令を発行したか
   */
  step() {
    const th = this.thread(0); // TODO(段階3): コアごとのラウンドロビン
    let issued = false;
    if (th.state === THREAD_STATE.RUNNING && this.cycle >= th.readyCycle) {
      issue(this, th);
      th.readyCycle = this.cycle + this.cfg.pipelineDepth;
      issued = true;
    }
    this.cycle++;
    return issued;
  }

  /** nサイクル進める */
  run(n) {
    for (let i = 0; i < n; i++) this.step();
  }

  /** 実行可能なスレッドがあるか */
  get running() {
    return this.threads.some(th => th.state === THREAD_STATE.RUNNING);
  }

  /**
   * 実行可能なスレッドがなくなるまで（または maxCycles サイクルまで）進める。
   * @returns {{ cycles: number, stopped: boolean }} stopped：すべて止まったか
   */
  runUntilStop(maxCycles = 10_000_000) {
    const start = this.cycle;
    while (this.running && this.cycle - start < maxCycles) this.step();
    return { cycles: this.cycle - start, stopped: !this.running };
  }

  /** 経過時間（マイクロ秒、仮想時間） */
  get microseconds() {
    return Math.floor(this.cycle / this.cfg.clockMHz);
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const l of this.listeners) l(event);
  }
}
