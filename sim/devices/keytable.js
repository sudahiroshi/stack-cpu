// 保護キー表（docs/spec.md 9.4節、12.7.6節）。I/Oの0xFF08_0000に置く（特権モードのみ）。DOMに依存しない。
//
//   +0x0000〜+0x07FF            外部RAMのページ0〜2047（4KB単位、1ページ1バイト）
//   +0x1000＋コア番号×0x100     各コアのローカルBSRAMのページ（1KB単位、最大64項目）
// 1項目（1バイト）：bit4〜0＝キー、bit5＝W、bit6＝X、bit7＝予約。リセット直後は全ページがキー0（W＝X＝0）。
// C!で1ページずつ、!（32bit）で4ページ分をまとめて読み書きできる（リトルエンディアン）。
import { EXC } from '../isa.js';
import { CpuException } from '../cpu-exception.js';
import { KEYTABLE, KEY_ENTRY } from './registers.js';

export const EXT_PAGE_SHIFT = 12;    // 外部RAMのページ：4KB
export const LOCAL_PAGE_SHIFT = 10;  // ローカルBSRAMのページ：1KB
const EXT_PAGES = 2048;
const LOCAL_ENTRIES = 64;

export class KeyTable {
  constructor(cfg) {
    this.name = '保護キー表';
    this.ext = new Uint8Array(EXT_PAGES);
    this.local = Array.from({ length: cfg.ncores }, () => new Uint8Array(LOCAL_ENTRIES));
    this.size = KEYTABLE.LOCAL + cfg.ncores * KEYTABLE.LOCAL_STRIDE;
  }

  /** リセット：全ページがキー0 */
  reset() {
    this.ext.fill(0);
    for (const t of this.local) t.fill(0);
  }

  /** メモリの領域（Memory.region の結果）に対応する項目 */
  entryFor(r) {
    if (r.kind === 'ext') return this.ext[r.off >>> EXT_PAGE_SHIFT];
    if (r.kind === 'local') return this.local[r.core][r.off >>> LOCAL_PAGE_SHIFT];
    throw new Error(`内部エラー: キー表の対象外の領域 ${r.kind}`);
  }

  /** I/Oのオフセット → [配列, 添字]。割り当てのないオフセットはバスエラー */
  #locate(off, addrForError) {
    if (off < KEYTABLE.LOCAL) {
      if (off < EXT_PAGES) return [this.ext, off];
    } else {
      const core = (off - KEYTABLE.LOCAL) >>> 8;
      const i = (off - KEYTABLE.LOCAL) & 0xff;
      if (core < this.local.length && i < LOCAL_ENTRIES) return [this.local[core], i];
    }
    throw new CpuException(EXC.BUS, addrForError);
  }

  // ---- Device の口（offはデバイス内のオフセット。ctx.addr は使わず、例外の番地は呼び出し側の番地で報告する） ----
  read8(off, ctx = {}) {
    const [t, i] = this.#locate(off, ctx.addr ?? off);
    return t[i];
  }

  write8(off, v, ctx = {}) {
    const [t, i] = this.#locate(off, ctx.addr ?? off);
    t[i] = v & 0xff;
  }

  read32(off, ctx = {}) {
    let v = 0;
    for (let k = 0; k < 4; k++) v |= this.read8(off + k, ctx) << (8 * k);
    return v >>> 0;
  }

  write32(off, v, ctx = {}) {
    for (let k = 0; k < 4; k++) this.write8(off + k, (v >>> (8 * k)) & 0xff, ctx);
  }
}

/** 項目のビット */
export const KEY = { MASK: KEY_ENTRY.KEY_MASK, W: KEY_ENTRY.W, X: KEY_ENTRY.X };
