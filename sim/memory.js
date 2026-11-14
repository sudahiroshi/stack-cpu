// メモリとバス（docs/spec.md 9章、12.1節）。DOMに依存しない。
//
// 番地の振り分け
//   0x0000_0000〜0x000F_FFFF  割り当てなし（バスエラー）
//   0x0010_0000＋コア×0x1_0000  各コアのローカルBSRAM（窓は64KB。容量LOCALSIZEより後ろはバスエラー。T-14）
//   0x0100_0000〜              外部RAM（RAMSIZE）
//   0xFF00_0000〜0xFFFE_FFFF  I/O（登録したデバイスだけ。未登録はバスエラー）
//   0xFFFF_0000〜0xFFFF_0FFF  ブートROM（書き込みは例外12）
// 初期値はすべて0（T-15）。リトルエンディアン。
//
// 一般モード（ctx.mode === 0）のアクセスは、ページキー（9.4節）で判定する。特権モードは検査しない。
import { MEM, IO, EXC } from './isa.js';
import { CpuException } from './cpu-exception.js';
import { KEY } from './devices/keytable.js';

const USERPAGE_SIZE = 0x1000;

/**
 * I/Oデバイスの口。
 * @typedef {object} Device
 * @property {string} name
 * @property {number} size  番地の範囲の大きさ（バイト）
 * @property {(offset:number, ctx:object) => number} read32
 * @property {(offset:number, value:number, ctx:object) => void} write32
 * @property {(offset:number, ctx:object) => number} [read8]   8bitアクセスを許すデバイスだけ（T-16）
 * @property {(offset:number, value:number, ctx:object) => void} [write8]
 */

export class Memory {
  /** @param {object} cfg sim/config.js の構成 */
  constructor(cfg) {
    this.cfg = cfg;
    this.local = Array.from({ length: cfg.ncores }, () => new Uint8Array(cfg.localSize));
    this.ext = new Uint8Array(cfg.extRamSize);
    this.rom = new Uint8Array(MEM.ROM_SIZE);
    /** @type {Array<{base:number, dev:Device}>} */
    this.devices = [];
    /** 保護キー表（sim/devices/keytable.js）。Machine が登録する。一般モードのアクセスの判定に使う */
    this.keytable = null;
  }

  /** I/Oデバイスを登録する */
  mapDevice(base, dev) {
    base >>>= 0;
    if (base < MEM.IO_BASE || base + dev.size > MEM.ROM_BASE) throw new Error(`I/O領域の外: ${dev.name}`);
    for (const d of this.devices) {
      if (base < d.base + d.dev.size && d.base < base + dev.size) throw new Error(`I/Oの番地が重なる: ${dev.name} と ${d.dev.name}`);
    }
    this.devices.push({ base, dev });
  }

  /**
   * 番地がどこにあたるか。割り当てがなければ null。
   * @returns {null | {kind:'local', core:number, buf:Uint8Array, off:number}
   *                | {kind:'ext'|'rom', buf:Uint8Array, off:number}
   *                | {kind:'io', dev:Device, off:number}}
   */
  region(addr) {
    addr >>>= 0;
    const { cfg } = this;
    if (addr >= MEM.LOCAL_BASE && addr < MEM.LOCAL_BASE + cfg.ncores * MEM.LOCAL_WINDOW) {
      const core = (addr - MEM.LOCAL_BASE) >>> 16;
      const off = (addr - MEM.LOCAL_BASE) & (MEM.LOCAL_WINDOW - 1);
      return off < cfg.localSize ? { kind: 'local', core, buf: this.local[core], off } : null;
    }
    if (addr >= MEM.EXTRAM_BASE && addr < MEM.EXTRAM_BASE + cfg.extRamSize) {
      return { kind: 'ext', buf: this.ext, off: addr - MEM.EXTRAM_BASE };
    }
    if (addr >= MEM.ROM_BASE && addr < MEM.ROM_BASE + MEM.ROM_SIZE) {
      return { kind: 'rom', buf: this.rom, off: addr - MEM.ROM_BASE };
    }
    if (addr >= MEM.IO_BASE && addr < MEM.ROM_BASE) {
      for (const d of this.devices) {
        if (addr >= d.base && addr < d.base + d.dev.size) return { kind: 'io', dev: d.dev, off: addr - d.base };
      }
    }
    return null;
  }

  /**
   * アクセスの検査をして領域を返す（9.2節、9.4節）。
   * @param {'r'|'w'} op
   * @param {{ mode?: number, pkread?: number, pkwrite?: number }} ctx  mode===0 なら一般モード
   */
  #access(addr, op, ctx) {
    addr >>>= 0;
    const user = ctx.mode === 0;
    // I/Oは、ユーザーページを除いて一般モードからアクセスできない（未登録の番地でも例外12を先にする）
    if (user && addr >= MEM.IO_BASE && addr < MEM.ROM_BASE && !(addr >= IO.USERPAGE && addr < IO.USERPAGE + USERPAGE_SIZE)) {
      throw new CpuException(EXC.PROTECT, addr);
    }
    const r = this.region(addr);
    if (!r) throw new CpuException(EXC.BUS, addr);
    if (r.kind === 'rom' && op === 'w') throw new CpuException(EXC.PROTECT, addr);
    if (user) this.#checkKey(addr, r, op, ctx);
    return r;
  }

  /**
   * ページキーの判定（一般モードのみ。9.4節）。
   * 読み出し：PKREAD[キー]、実行：PKREAD[キー] かつ X、書き込み：PKWRITE[キー] かつ W。違反は例外12。
   * ブートROMは一般モードから読み出しも実行もできない（T-34）。I/Oはキー表の対象外。
   */
  #checkKey(addr, r, op, ctx) {
    if (r.kind === 'io') return;
    if (r.kind === 'rom') throw new CpuException(EXC.PROTECT, addr);
    const e = this.keytable.entryFor(r);
    const key = e & KEY.MASK;
    const ok = op === 'w'
      ? ((ctx.pkwrite >>> key) & 1) && (e & KEY.W)
      : ((ctx.pkread >>> key) & 1) && (op !== 'x' || (e & KEY.X));
    if (!ok) throw new CpuException(EXC.PROTECT, addr);
  }

  static #align(addr) {
    if (addr & 3) throw new CpuException(EXC.ALIGN, addr);
  }

  /** 32bitの読み出し（データ） */
  read32(addr, ctx = {}) {
    Memory.#align(addr);
    const r = this.#access(addr, 'r', ctx);
    if (r.kind === 'io') return r.dev.read32(r.off, { ...ctx, addr: addr >>> 0 }) >>> 0;
    return get32(r.buf, r.off);
  }

  /** 32bitの書き込み（データ） */
  write32(addr, value, ctx = {}) {
    Memory.#align(addr);
    const r = this.#access(addr, 'w', ctx);
    if (r.kind === 'io') { r.dev.write32(r.off, value >>> 0, { ...ctx, addr: addr >>> 0 }); return; }
    put32(r.buf, r.off, value);
  }

  /** 8bitの読み出し（ゼロ拡張） */
  read8(addr, ctx = {}) {
    const r = this.#access(addr, 'r', ctx);
    if (r.kind === 'io') {
      if (!r.dev.read8) throw new CpuException(EXC.ALIGN, addr); // T-16
      return r.dev.read8(r.off, { ...ctx, addr: addr >>> 0 }) & 0xff;
    }
    return r.buf[r.off];
  }

  /** 8bitの書き込み */
  write8(addr, value, ctx = {}) {
    const r = this.#access(addr, 'w', ctx);
    if (r.kind === 'io') {
      if (!r.dev.write8) throw new CpuException(EXC.ALIGN, addr); // T-16
      r.dev.write8(r.off, value & 0xff, { ...ctx, addr: addr >>> 0 });
      return;
    }
    r.buf[r.off] = value & 0xff;
  }

  /**
   * データのアクセスにかかるサイクル数（9.2節。T-25）。
   * 外部RAM・他コアのローカルBSRAMは構成の待ち時間、それ以外は localLatency。
   */
  latency(addr, core) {
    const r = this.region(addr);
    if (r?.kind === 'ext') return this.cfg.extRamLatency;
    if (r?.kind === 'local' && r.core !== core) return this.cfg.remoteLocalLatency;
    return this.cfg.localLatency;
  }

  /**
   * 命令フェッチ（命令語とLIT・PCRELの定数語）。
   * 自コアのローカルBSRAMとブートROMからだけ読める（9.2節）。それ以外は例外7（ローカルの容量の外を含む。T-82）。
   * 一般モードでは、さらにページキーで判定する（PKREAD かつ X。違反は例外12。TODO(T-88)）。
   * @param {{ core: number, mode?: number, pkread?: number, pkwrite?: number }} ctx
   */
  fetch32(addr, ctx) {
    Memory.#align(addr);
    const r = this.region(addr);
    if (!r || !((r.kind === 'local' && r.core === ctx.core) || r.kind === 'rom')) {
      throw new CpuException(EXC.FETCH, addr);
    }
    if (ctx.mode === 0) this.#checkKey(addr >>> 0, r, 'x', ctx);
    return get32(r.buf, r.off);
  }

  /**
   * イメージを直接読み込む（11.2節。ROMにも書ける）。I/Oには読み込めない。
   * @param {number} addr
   * @param {Uint8Array} bytes
   */
  load(addr, bytes) {
    addr >>>= 0;
    for (let i = 0; i < bytes.length;) {
      const r = this.region(addr + i);
      if (!r || r.kind === 'io') throw new Error(`読み込めない番地: $${((addr + i) >>> 0).toString(16).toUpperCase()}`);
      const n = Math.min(bytes.length - i, r.buf.length - r.off);
      r.buf.set(bytes.subarray(i, i + n), r.off);
      i += n;
    }
  }
}

function get32(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

function put32(buf, off, v) {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
  buf[off + 2] = (v >>> 16) & 0xff;
  buf[off + 3] = (v >>> 24) & 0xff;
}
