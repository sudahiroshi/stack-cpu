// タイマ（docs/spec.md 12.5節、12.7.2節）。0xFF00_1000（特権モードのみ）。DOMに依存しない。
//
//   +0x000 CNT_LO / +0x004 CNT_HI   64bitのフリーランカウンタ（1マイクロ秒、仮想時間）。読み出しのみ
//   +0x008 PRESCALE                 1マイクロ秒あたりのクロック数。読み出しのみ
//   +0x800＋tid×8 CMP_LO[tid]       各スレッドの比較レジスタ（下位）。書くと比較を開始
//   +0x804＋tid×8 CMP_HI[tid]       同上（上位）。書くと比較を止める（CMP_HI、CMP_LOの順に書く）
// カウンタが比較値以上になると、そのスレッドのイベント2を立てて比較を止める。
// カウンタ＝⌊サイクル数÷クロック（MHz）⌋。比較値cに達するのは、サイクル数が c×クロック 以上になったとき。
import { EV } from '../isa.js';
import { TIMER_REG } from './registers.js';
import { unassigned, protect, lo32, hi32 } from './common.js';

export class Timer {
  constructor(machine) {
    this.m = machine;
    this.name = 'タイマ';
    this.size = 0x1000;
    this.reset();
  }

  reset() {
    /** tid → { value, armed } */
    this.cmp = new Map(this.m.threads.map(th => [th.tid, { value: 0, armed: false }]));
  }

  /** カウンタの値（マイクロ秒） */
  get counter() {
    return Math.floor(this.m.cycle / this.m.cfg.clockMHz);
  }

  /** 比較値に達するサイクル */
  #dueCycle(value) {
    return value * this.m.cfg.clockMHz;
  }

  /** 比較を開始したか（待機の判定用） */
  armed(tid) {
    return this.cmp.get(tid)?.armed ?? false;
  }

  update(cycle) {
    let next = Infinity;
    for (const [tid, c] of this.cmp) {
      if (!c.armed) continue;
      const due = this.#dueCycle(c.value);
      if (due <= cycle) {
        c.armed = false;
        this.m.thread(tid).events |= 1 << EV.TIMER;
      } else {
        next = Math.min(next, due);
      }
    }
    return next;
  }

  // ---- 比較レジスタの読み書き（ユーザーページからも使う） ----
  readCmp(tid, hi) {
    const c = this.cmp.get(tid);
    return hi ? hi32(c.value) : lo32(c.value);
  }

  writeCmp(tid, hi, v) {
    const c = this.cmp.get(tid);
    if (hi) {
      c.value = v * 2 ** 32 + lo32(c.value);
      c.armed = false;
    } else {
      c.value = hi32(c.value) * 2 ** 32 + v;
      c.armed = true;
      this.m.scheduleDevice(Math.max(this.m.cycle, this.#dueCycle(c.value)));
    }
  }

  /** オフセット → 比較レジスタ（tid、上位か）。該当しなければ null */
  #cmpAt(off) {
    if (off < TIMER_REG.CMP_BASE) return null;
    const tid = (off - TIMER_REG.CMP_BASE) >>> 3;
    if (!this.cmp.has(tid)) return null;
    return { tid, hi: (off & 4) !== 0 };
  }

  read32(off, ctx) {
    switch (off) {
      case TIMER_REG.CNT_LO: return lo32(this.counter);
      case TIMER_REG.CNT_HI: return hi32(this.counter);
      case TIMER_REG.PRESCALE: return this.m.cfg.clockMHz;
    }
    const r = this.#cmpAt(off);
    return r ? this.readCmp(r.tid, r.hi) : unassigned(ctx);
  }

  write32(off, v, ctx) {
    if (off === TIMER_REG.CNT_LO || off === TIMER_REG.CNT_HI || off === TIMER_REG.PRESCALE) return protect(ctx);
    const r = this.#cmpAt(off);
    if (!r) return unassigned(ctx);
    this.writeCmp(r.tid, r.hi, v);
  }
}
