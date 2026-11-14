// GPIO（docs/spec.md 12.4節、12.7.3節）、ユーザーページ（12.6節）、スレッドの制御（11.5節、12.7.5節）。DOMに依存しない。
import { EXC } from '../isa.js';
import { CpuException } from '../cpu-exception.js';
import { GPIO_REG, USERPAGE_REG, THREAD_REG } from './registers.js';
import { unassigned, protect, lo32, hi32 } from './common.js';

/**
 * GPIO（0xFF00_2000）
 *   +0x00 JOY  読み出しのみ。bit7〜0＝JOY0、bit15〜8＝JOY1（押されていれば1）。ホストが joy に設定する
 *   +0x04 LED  読み書き。bit5〜0＝基板のLED（1＝点灯）
 */
export class Gpio {
  constructor(machine) {
    this.m = machine;
    this.name = 'GPIO';
    this.size = 0x1000;
    this.joy = 0;          // ホストが設定する（リセットでは変えない：ボタンの状態なので）
    this.onLed = null;
    this.reset();
  }

  reset() {
    this.led = 0;
  }

  read32(off, ctx) {
    switch (off) {
      case GPIO_REG.JOY: return this.joy & 0xffff;
      case GPIO_REG.LED: return this.led;
    }
    return unassigned(ctx);
  }

  write32(off, v, ctx) {
    switch (off) {
      case GPIO_REG.JOY: return protect(ctx);
      case GPIO_REG.LED:
        this.led = v & 0x3f;
        this.onLed?.(this.led);
        return;
    }
    unassigned(ctx);
  }
}

/**
 * ユーザーページ（0xFF0F_0000〜0xFF0F_0FFF、一般モードからも使える）
 *   +0x000 CNT_LO / +0x004 CNT_HI  タイマのカウンタ（読み出しのみ）
 *   +0x008 CMP_LO / +0x00C CMP_HI  自分の比較レジスタ（アクセスしたスレッドのtidで選ぶ）
 *   +0x010 JOY                     ジョイパッド（読み出しのみ）
 *   +0x014〜                       バスエラー
 */
export class UserPage {
  constructor(machine) {
    this.m = machine;
    this.name = 'ユーザーページ';
    this.size = 0x1000;
  }

  reset() {}

  read32(off, ctx) {
    const { timer, gpio } = this.m;
    switch (off) {
      case USERPAGE_REG.CNT_LO: return lo32(timer.counter);
      case USERPAGE_REG.CNT_HI: return hi32(timer.counter);
      case USERPAGE_REG.CMP_LO: return timer.readCmp(ctx.tid, false);
      case USERPAGE_REG.CMP_HI: return timer.readCmp(ctx.tid, true);
      case USERPAGE_REG.JOY: return gpio.joy & 0xffff;
    }
    return unassigned(ctx);
  }

  write32(off, v, ctx) {
    switch (off) {
      case USERPAGE_REG.CNT_LO: case USERPAGE_REG.CNT_HI: case USERPAGE_REG.JOY: return protect(ctx);
      case USERPAGE_REG.CMP_LO: this.m.timer.writeCmp(ctx.tid, false, v); return;
      case USERPAGE_REG.CMP_HI: this.m.timer.writeCmp(ctx.tid, true, v); return;
    }
    unassigned(ctx);
  }
}

/**
 * スレッドの制御（0xFF00_4000、特権モードのみ）
 *   +0x000 THREADCTL        書き込みのみ。tidを書くと、そのスレッドをリセット状態にする（Machine.resetThread）
 *   +0x100＋tid×4 THREADSTAT 読み出しのみ。各スレッドの状態（0〜7）
 * 存在しないtidをTHREADCTLに書いたら例外14（T-92）。
 */
export class ThreadControl {
  constructor(machine) {
    this.m = machine;
    this.name = 'スレッドの制御';
    this.size = 0x1000;
  }

  reset() {}

  #statAt(off) {
    if (off < THREAD_REG.THREADSTAT) return null;
    return this.m.findThread((off - THREAD_REG.THREADSTAT) >>> 2);
  }

  read32(off, ctx) {
    if (off === THREAD_REG.THREADCTL) return protect(ctx);
    const th = this.#statAt(off);
    return th ? th.state : unassigned(ctx);
  }

  write32(off, v, ctx) {
    if (off === THREAD_REG.THREADCTL) {
      if (!this.m.findThread(v)) throw new CpuException(EXC.BAD_TID);
      this.m.resetThread(v);
      return;
    }
    if (this.#statAt(off)) return protect(ctx);
    unassigned(ctx);
  }
}
