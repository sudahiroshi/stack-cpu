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
// 保護キーによる検査は段階4で入れる（ctx にモードなどを渡す予定）。
import { MEM, EXC } from './isa.js';
import { CpuException } from './cpu-exception.js';

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

  #mapped(addr) {
    const r = this.region(addr);
    if (!r) throw new CpuException(EXC.BUS, addr);
    return r;
  }

  static #align(addr) {
    if (addr & 3) throw new CpuException(EXC.ALIGN, addr);
  }

  /** 32bitの読み出し（データ） */
  read32(addr, ctx = {}) {
    Memory.#align(addr);
    const r = this.#mapped(addr);
    if (r.kind === 'io') return r.dev.read32(r.off, ctx) >>> 0;
    return get32(r.buf, r.off);
  }

  /** 32bitの書き込み（データ） */
  write32(addr, value, ctx = {}) {
    Memory.#align(addr);
    const r = this.#mapped(addr);
    if (r.kind === 'rom') throw new CpuException(EXC.PROTECT, addr);
    if (r.kind === 'io') { r.dev.write32(r.off, value >>> 0, ctx); return; }
    put32(r.buf, r.off, value);
  }

  /** 8bitの読み出し（ゼロ拡張） */
  read8(addr, ctx = {}) {
    const r = this.#mapped(addr);
    if (r.kind === 'io') {
      if (!r.dev.read8) throw new CpuException(EXC.ALIGN, addr); // T-16
      return r.dev.read8(r.off, ctx) & 0xff;
    }
    return r.buf[r.off];
  }

  /** 8bitの書き込み */
  write8(addr, value, ctx = {}) {
    const r = this.#mapped(addr);
    if (r.kind === 'rom') throw new CpuException(EXC.PROTECT, addr);
    if (r.kind === 'io') {
      if (!r.dev.write8) throw new CpuException(EXC.ALIGN, addr); // T-16
      r.dev.write8(r.off, value & 0xff, ctx);
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
   */
  fetch32(addr, core) {
    Memory.#align(addr);
    const r = this.region(addr);
    if (!r || !((r.kind === 'local' && r.core === core) || r.kind === 'rom')) {
      throw new CpuException(EXC.FETCH, addr);
    }
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
