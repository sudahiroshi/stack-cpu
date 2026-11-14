// マシン全体（コア、スレッド、メモリ、デバイス）。DOMに依存しない（ブラウザとNode.jsの両方で動かす）。
//
// バレル（6.1節）
//   - コアごとに、実行可能なスレッドだけでラウンドロビンする。tidの小さい順に、前に発行したスレッドの次から探す。
//     リセット直後はスレッド0から探す（T-22）。発行できるスレッドがなければ空サイクル。
//   - 同じスレッドはD（pipelineDepth）サイクル以上あけて発行する。
//   - 時間のかかる操作（外部RAM、他コアのローカルBSRAM、除算器）は、完了するまで次の発行を待たせる
//     （ただしDより早くはならない）。待っている間の THREADSTAT は5（T-84）。
//   - 待機中（WAIT・RECV・SEND）のスレッドは、起きる条件が成り立てば実行可能になり、同じ命令をもう一度実行する。
//   - 20Kでは、1サイクルごとにコア0、コア1の順に1回ずつ進める（T-23）。
//
// デバイス（段階5）
//   - 時間で動くもの（UARTの送受信、タイマの比較、VSYNC）は、各デバイスの update(cycle) が
//     「次に何かが起きるサイクル」を返し、そのサイクルに達したときだけ進める。1サイクルの中では、デバイスを先に進める。
//   - runUntilStop は、全スレッドが待っているとき、次のデバイスの出来事まで時間を早送りする（結果は1サイクルずつ進めたときと同じ）。
import { makeConfig } from './config.js';
import { Memory } from './memory.js';
import { Thread } from './thread.js';
import { issue, canSend } from './core.js';
import { SYS, EV, IO } from './isa.js';
import { KeyTable } from './devices/keytable.js';
import { Uart } from './devices/uart.js';
import { Timer } from './devices/timer.js';
import { Gpio, UserPage, ThreadControl } from './devices/gpio.js';
import { Video } from './devices/video.js';
import { THREAD_STATE } from './devices/registers.js';

const S = THREAD_STATE;

export class Machine {
  /** @param {string|object} config '9K' | '20K' | 構成オブジェクト */
  constructor(config = '9K') {
    this.cfg = typeof config === 'string' ? makeConfig(config) : config;
    this.mem = new Memory(this.cfg);
    this.keytable = new KeyTable(this.cfg);
    this.mem.mapDevice(IO.KEYTABLE, this.keytable);
    this.mem.keytable = this.keytable;
    this.cores = Array.from({ length: this.cfg.ncores }, (_, c) => ({
      id: c,
      threads: Array.from({ length: this.cfg.nthreads }, (_, t) => new Thread(this.cfg, c, t)),
      last: this.cfg.nthreads - 1,  // 前に発行したスレッド（次はその次から探す）
      dividerFreeAt: 0,             // 除算器が空くサイクル
    }));
    // I/Oデバイス（12.1節）
    this.uart = new Uart(this);
    this.timer = new Timer(this);
    this.gpio = new Gpio(this);
    this.video = new Video(this);
    this.threadControl = new ThreadControl(this);
    this.userPage = new UserPage(this);
    this.mem.mapDevice(IO.UART, this.uart);
    this.mem.mapDevice(IO.TIMER, this.timer);
    this.mem.mapDevice(IO.GPIO, this.gpio);
    this.mem.mapDevice(IO.VIDEO, this.video);
    this.mem.mapDevice(IO.THREAD, this.threadControl);
    this.mem.mapDevice(IO.VRAM, this.video.vramDevice);
    this.mem.mapDevice(IO.FONT, this.video.fontDevice);
    this.mem.mapDevice(IO.USERPAGE, this.userPage);
    /** 時間で動くデバイス（update(cycle) を持つもの） */
    this.timedDevices = [this.uart, this.timer, this.video];
    this.listeners = new Set(); // UIやトレース用のフック。イベント：{ type: 'exec' | 'block' | 'exception', ... }
    this.reset();
  }

  /** リセット（11.1節）。メモリの中身は消さない。全スレッドが同時に同じ番地から始まる */
  reset() {
    this.cycle = 0; // 仮想時間（サイクル数）
    for (const th of this.threads) th.reset();
    this.keytable.reset(); // 全ページがキー0（11.1節）
    for (const d of [this.uart, this.timer, this.gpio, this.video, this.threadControl, this.userPage]) d.reset();
    this.nextDeviceCycle = 0; // 次にデバイスを進めるサイクル
    for (const core of this.cores) {
      core.last = this.cfg.nthreads - 1;
      core.dividerFreeAt = 0;
    }
  }

  /**
   * 1つのスレッドをリセット状態にする（THREADCTL。11.5節）。
   * メールボックスを空にし、そのスレッドが送信を待っていれば待ちを取り消す（T-87）。
   */
  resetThread(tid) {
    const th = this.thread(tid);
    for (const t of this.threads) {
      const i = t.sendQueue.indexOf(tid);
      if (i >= 0) t.sendQueue.splice(i, 1);
    }
    // このスレッドへの送信を待っている他のスレッドの順番（T-28）は残す
    const waiting = th.sendQueue;
    th.reset();
    th.sendQueue = waiting;
  }

  /** すべてのスレッド（コア0から順） */
  get threads() {
    return this.cores.flatMap(c => c.threads);
  }

  /** tid（上位4bit＝コア、下位4bit＝スレッド。6.3節）からスレッドを得る。存在しなければ null */
  findThread(tid) {
    if (tid > 0xff) return null;
    return this.cores[tid >> 4]?.threads[tid & 0xf] ?? null;
  }

  /** tidからスレッドを得る（存在しなければエラー） */
  thread(tid) {
    const th = this.findThread(tid);
    if (!th) throw new Error(`存在しないtid: ${tid}`);
    return th;
  }

  /** イメージ（Uint8Array）を指定の番地に読み込む（OSイメージの直接読み込み、11.2節） */
  load(address, bytes) {
    this.mem.load(address, bytes);
  }

  /**
   * スレッドの立っているイベント（6.4節。EVPENDの値）。
   * ラッチ式のビット＋状態のビット（0＝メールボックスが空でない、4・5＝UART）
   */
  pendingEvents(th) {
    let e = th.events | this.uart.statusEvents;
    if (th.mbox.length > 0) e |= 1 << EV.MAILBOX;
    return e >>> 0;
  }

  /** デバイスの「状態」のイベントビット（UART。全スレッドに共通） */
  get statusEvents() {
    return this.uart.statusEvents;
  }

  /** デバイスが cycle に何かをすることを知らせる（その時刻にデバイスを進める） */
  scheduleDevice(cycle) {
    if (cycle < this.nextDeviceCycle) this.nextDeviceCycle = cycle;
  }

  #updateDevices() {
    let next = Infinity;
    for (const d of this.timedDevices) next = Math.min(next, d.update(this.cycle));
    this.nextDeviceCycle = next;
  }

  /**
   * 待機中のスレッドを、今後デバイスの出来事が起こしうるか（runUntilStop の早送りの判定）。
   * VSYNCは毎フレーム、タイマは比較を開始していれば、UARTは受信データや送信中のバイトがあれば起きる。
   */
  #deviceMayWake(th) {
    if (th.state !== S.WAIT) return false;
    const future = (1 << EV.VSYNC) | (this.timer.armed(th.tid) ? 1 << EV.TIMER : 0) | this.uart.pendingEvents;
    return (th.peek(0) & future) !== 0;
  }

  #anyDeviceMayWake() {
    return this.threads.some(th => this.#deviceMayWake(th));
  }

  /** デバイスのイベントを全スレッドのラッチに立てる（6.4節。VSYNCなど） */
  raiseEvent(bit) {
    for (const th of this.threads) th.events |= 1 << bit;
  }

  /** 待機中のスレッドが起きられるか */
  #wakeable(th) {
    const inst = th.dec?.insts[th.idx];
    switch (th.state) {
      case S.WAIT: return (this.pendingEvents(th) & th.peek(0)) !== 0;
      case S.RECV: return th.mbox.length > 0;
      case S.SEND: return canSend(this, th, this.findThread(th.peek(0)), inst.imm, inst.sub === SYS['SENDM?']);
    }
    return false;
  }

  /** 止まっていない（いずれ実行しうる）スレッドか */
  isActive(th) {
    switch (th.state) {
      case S.HALT: case S.DOUBLE_FAULT: return false;
      case S.WAIT: case S.RECV: case S.SEND: return this.#wakeable(th);
    }
    return true;
  }

  /** このサイクルで発行できるか */
  #ready(th) {
    return this.cycle >= th.readyCycle && this.isActive(th);
  }

  /** 1つのコアを1サイクル進める。発行したスレッドを返す（空サイクルなら null） */
  #stepCore(core) {
    const n = core.threads.length;
    for (let k = 1; k <= n; k++) {
      const i = (core.last + k) % n;
      const th = core.threads[i];
      if (!this.#ready(th)) continue;
      core.last = i;
      th.state = S.RUNNING;
      issue(this, th);
      const next = this.cycle + this.cfg.pipelineDepth;
      th.readyCycle = Math.max(next, th.busyUntil);
      if (th.state === S.RUNNING && th.readyCycle > next) th.state = S.PARKED; // 外部RAM・除算の完了待ち
      return th;
    }
    return null;
  }

  /**
   * 1サイクル進める（コア0から順に、各コアで発行できるスレッドがあれば1命令）。
   * @returns {boolean} どれかのコアで命令を発行したか
   */
  step() {
    if (this.cycle >= this.nextDeviceCycle) this.#updateDevices();
    let issued = false;
    for (const core of this.cores) if (this.#stepCore(core)) issued = true;
    this.cycle++;
    return issued;
  }

  /** nサイクル進める */
  run(n) {
    for (let i = 0; i < n; i++) this.step();
  }

  /** 動いているスレッドが次に発行できる最も早いサイクル（いまのサイクルで発行できればいまのサイクル） */
  #nextIssueCycle() {
    let t = Infinity;
    for (const th of this.threads) {
      if (this.isActive(th)) t = Math.min(t, Math.max(this.cycle, th.readyCycle));
    }
    return t;
  }

  /** 止まっていないスレッドがあるか */
  get running() {
    return this.threads.some(th => this.isActive(th));
  }

  /**
   * 止まっていないスレッドがなくなるまで（または maxCycles サイクルまで）進める。
   * 待機中で、他のスレッドもデバイスも起こす見込みのないスレッドは止まっているとみなす。
   * @returns {{ cycles: number, stopped: boolean, blocked: number[] }}
   *   stopped：すべて止まったか（動けるスレッドがなく、デバイスが起こす見込みもない）。
   *   maxCycles で打ち切ったときは false。blocked：待機中のスレッドのtid
   */
  runUntilStop(maxCycles = 10_000_000) {
    const start = this.cycle;
    const end = start + maxCycles;
    while (this.cycle < end) {
      if (this.running) {
        // 発行できるスレッドがなければ、次に発行できるサイクルかデバイスの出来事まで早送りする
        const t = this.#nextIssueCycle();
        if (t > this.cycle) this.cycle = Math.min(t, this.nextDeviceCycle, end);
        if (this.cycle >= end) break;
        this.step();
        continue;
      }
      if (!this.#anyDeviceMayWake()) break;
      this.cycle = Math.max(this.cycle, Math.min(this.nextDeviceCycle, end));
      if (this.cycle >= end) break;
      this.step();
    }
    const blocked = this.threads.filter(th => [S.WAIT, S.RECV, S.SEND].includes(th.state)).map(th => th.tid);
    return { cycles: this.cycle - start, stopped: !this.running && !this.#anyDeviceMayWake(), blocked };
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
