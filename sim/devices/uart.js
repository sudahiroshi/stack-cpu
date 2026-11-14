// UART（docs/spec.md 12.3節、12.7.1節）。0xFF00_0000。DOMに依存しない。
//
//   +0x00 DATA    書く：下位8bitを送信FIFOへ（一杯なら捨てる）。読む：下位8bitが受信データ、bit31＝1なら受信データなし
//   +0x04 STATUS  bit0＝受信データあり、bit1＝送信FIFOが一杯、bit2＝送信がすべて完了、bit3＝受信あふれ（1を書くと消える）
//   +0x08 DIV     分周比＝クロック÷通信速度
// 1バイト（10ビット）の送受信に DIV×10 サイクルかかる（T-35）。送信FIFO・受信FIFOは16バイト。
// イベント4（受信データあり）・5（送信FIFOに空きあり）は状態のビット（Machine.statusEvents）。
//
// ホスト側の口：
//   onTx(byte, cycle)   送信し終えたバイトを受け取るコールバック（output にもためる）
//   receive(bytes)      受信するバイトを入れる。DIV×10サイクルごとに1バイトずつ受信FIFOに届く
import { UART_REG, UART_STATUS, UART_FIFO_DEPTH } from './registers.js';
import { unassigned } from './common.js';

export class Uart {
  constructor(machine) {
    this.m = machine;
    this.name = 'UART';
    this.size = 0x1000;
    this.onTx = null;
    this.reset();
  }

  reset() {
    this.div = Math.round(this.m.cfg.clockMHz * 1e6 / 115200); // 115,200bps相当（9Kは469、20Kは625）
    this.txFifo = [];
    this.txShift = null;     // 送信中のバイト { byte, done }
    this.rxFifo = [];
    this.rxLine = [];        // まだ届いていない受信データ { byte, at }
    this.lastRxAt = 0;
    this.overrun = false;
    this.output = [];        // 送信し終えたバイト（テストと表示用）
  }

  /** 1バイトの送受信にかかるサイクル数 */
  get byteCycles() {
    return Math.max(1, this.div) * 10;
  }

  /** ホスト：受信するバイトを入れる（文字列なら各文字の下位8bit） */
  receive(bytes) {
    const list = typeof bytes === 'string' ? Array.from(bytes, ch => ch.charCodeAt(0) & 0xff) : Array.from(bytes);
    for (const byte of list) {
      const at = Math.max(this.m.cycle, this.lastRxAt) + this.byteCycles;
      this.lastRxAt = at;
      this.rxLine.push({ byte: byte & 0xff, at });
      this.m.scheduleDevice(at);
    }
  }

  /** 送信し終えた文字列（テストと表示用） */
  get outputText() {
    return String.fromCharCode(...this.output);
  }

  /** 状態のイベントビット（6.4節） */
  get statusEvents() {
    let e = 0;
    if (this.rxFifo.length > 0) e |= 1 << 4;
    if (this.txFifo.length < UART_FIFO_DEPTH) e |= 1 << 5;
    return e;
  }

  /** 送信中か（送信FIFOか送信中のバイトがある） */
  get transmitting() {
    return this.txShift !== null || this.txFifo.length > 0;
  }

  /** 受信データが今後届く見込みがあるか、送信FIFOが空く見込みがあるか（待機の判定用） */
  get pendingEvents() {
    let e = 0;
    if (this.rxLine.length > 0) e |= 1 << 4;
    if (this.txShift) e |= 1 << 5;
    return e;
  }

  #startTx(at) {
    if (this.txShift || this.txFifo.length === 0) return;
    this.txShift = { byte: this.txFifo.shift(), done: at + this.byteCycles };
    this.m.scheduleDevice(this.txShift.done);
  }

  /** cycle までに起きることを進める。次に何かが起きるサイクルを返す */
  update(cycle) {
    while (this.txShift && this.txShift.done <= cycle) {
      const { byte, done } = this.txShift;
      this.txShift = null;
      this.output.push(byte);
      this.onTx?.(byte, done);
      this.#startTx(done);
    }
    while (this.rxLine.length && this.rxLine[0].at <= cycle) {
      const { byte } = this.rxLine.shift();
      if (this.rxFifo.length < UART_FIFO_DEPTH) this.rxFifo.push(byte);
      else this.overrun = true;
    }
    return Math.min(this.txShift?.done ?? Infinity, this.rxLine[0]?.at ?? Infinity);
  }

  read32(off, ctx) {
    switch (off) {
      case UART_REG.DATA:
        return this.rxFifo.length ? this.rxFifo.shift() : 0x8000_0000;
      case UART_REG.STATUS:
        return (this.rxFifo.length ? UART_STATUS.RXAVAIL : 0)
          | (this.txFifo.length >= UART_FIFO_DEPTH ? UART_STATUS.TXFULL : 0)
          | (!this.txShift && this.txFifo.length === 0 ? UART_STATUS.TXEMPTY : 0)
          | (this.overrun ? UART_STATUS.RXOVERRUN : 0);
      case UART_REG.DIV:
        return this.div;
    }
    return unassigned(ctx);
  }

  write32(off, v, ctx) {
    switch (off) {
      case UART_REG.DATA:
        if (this.txFifo.length < UART_FIFO_DEPTH) {   // 一杯なら捨てる
          this.txFifo.push(v & 0xff);
          this.#startTx(this.m.cycle);
        }
        return;
      case UART_REG.STATUS:
        if (v & UART_STATUS.RXOVERRUN) this.overrun = false; // bit3だけ、1を書くと消える。他のビットは無視
        return;
      case UART_REG.DIV:
        this.div = v >>> 0;
        return;
    }
    unassigned(ctx);
  }
}
