// UIの状態と、表示用のデータを作る部分（docs/ui.md）。DOMに依存しない（Node.jsでテストする）。
//
// Session が持つもの：機種、読み込んだプログラム、マシン、デバッガ、ブレークポイントの設定。
// 画面（ui/main.js）は Session のメソッドで操作し、Session が作ったデータを表示するだけにする。
import { Machine } from '../sim/machine.js';
import { Debugger, peekWord } from '../sim/debugger.js';
import { decodeWord } from '../sim/decode.js';
import { csrRead } from '../sim/core.js';
import { OP, SYS, CSR, MEM } from '../sim/isa.js';
import { assemble, AsmError } from '../asm/assembler.js';
import { formatInst } from '../asm/disasm.js';

export const hex8 = v => (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
export const hex = (v, n = 2) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');

/** THREADSTAT の名前（12.7.5節） */
export const STATE_NAMES = ['リセット直後', '実行中', 'WAIT', 'RECV待ち', 'SEND待ち', '除算・メモリ待ち', 'HALT', '二重例外'];

/** 例外の名前（7.2節） */
export const EXC_NAMES = [
  'データスタックのオーバーフロー', 'データスタックのアンダーフロー', 'リターンスタックのオーバーフロー',
  'リターンスタックのアンダーフロー', '不正命令', '配置違反', '特権違反', '命令フェッチ違反', 'SYSCALL',
  'ブレークポイント（BRK）', 'アドレスの境界違反', 'バスエラー', '保護違反', 'リモートXCHG違反',
  '不正なスレッド番号', '二重例外', '予約（データのページフォールト）', '予約（命令のページフォールト）', '未実装命令',
];

/** CSRの名前（8章）。番号の順 */
export const CSR_NAMES = Object.entries(CSR).filter(([n]) => n !== 'PTBASE' && n !== 'ASID').sort((a, b) => a[1] - b[1]);

export const DEFAULT_LOAD_ADDR = 0x0010_0000;
export const DEFAULT_DIRECT_UP = 0x0010_5F80;   // ローカルBSRAMの最後の128バイト（docs/ui.md 6章）

/**
 * ファイルの中身をプログラムにする。
 * @param {string} name ファイル名（拡張子で形式を決める）
 * @param {string | Uint8Array} data .asm・.hex は文字列、.bin はバイト列
 * @param {{ addr?: number }} [opts] .bin・.hex を読み込む番地
 * @returns {{ name, kind: 'asm'|'bin'|'hex', bytes: Uint8Array, addr: number, labels?: Map, layout?: object[], warnings: string[] }}
 * @throws {AsmError | Error}
 */
export function parseProgram(name, data, { addr = DEFAULT_LOAD_ADDR } = {}) {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === 'asm' || ext === 's') {
    const r = assemble(String(data), { origin: DEFAULT_LOAD_ADDR });
    return { name, kind: 'asm', bytes: r.bytes, addr: r.origin, labels: r.labels, layout: r.layout, warnings: r.warnings };
  }
  if (ext === 'bin') return { name, kind: 'bin', bytes: new Uint8Array(data), addr: addr >>> 0, warnings: [] };
  if (ext === 'hex' || ext === 'mem') return { name, kind: 'hex', bytes: parseReadmemh(String(data)), addr: addr >>> 0, warnings: [] };
  throw new Error(`対応していない形式です（.asm・.bin・.hex）: ${name}`);
}

/** $readmemh 形式（1行に32bitの16進。// のコメントと空行は無視。@番地 は使えない）をバイト列にする */
export function parseReadmemh(text) {
  const words = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.replace(/\/\/.*$/, '').trim();
    if (!t) return;
    for (const tok of t.split(/\s+/)) {
      if (!/^[0-9a-fA-F]{1,8}$/.test(tok)) throw new Error(`${i + 1}行: 16進の語ではありません: ${tok}`);
      words.push(parseInt(tok, 16) >>> 0);
    }
  });
  const b = new Uint8Array(words.length * 4);
  words.forEach((w, k) => { for (let j = 0; j < 4; j++) b[k * 4 + j] = (w >>> (8 * j)) & 0xff; });
  return b;
}

export class Session {
  /** @param {string} romSource ブートROMのソース（rom/boot.asm） */
  constructor(romSource) {
    this.rom = assemble(romSource);
    this.config = '9K';
    /** 読み込んだプログラム（parseProgram の結果＋ boot: 'boot'|'direct'、up） */
    this.program = null;
    // ブレークポイントの設定（マシンを作り直しても引き継ぐ）
    this.breakpoints = new Set();
    this.exceptionBreaks = new Set();
    this.watches = new Set();
    this.mailBreaks = new Set();
    this.rebuild();
  }

  /** 機種を変えて作り直す */
  setConfig(name) {
    this.config = name;
    this.rebuild();
  }

  /**
   * プログラムを読み込んで作り直す。
   * @param {object} program parseProgram の結果
   * @param {{ boot: 'boot'|'direct', up?: number }} opts
   */
  load(program, { boot, up = DEFAULT_DIRECT_UP }) {
    this.program = { ...program, boot, up };
    this.rebuild();
  }

  /** マシンを作り直す（リセット）。ブートROMと、読み込んだプログラムを読み込む */
  rebuild() {
    const m = new Machine(this.config);
    m.load(this.rom.origin, this.rom.bytes);
    const p = this.program;
    if (p) {
      m.load(p.addr, p.bytes);
      if (p.boot === 'direct') {
        const th = m.thread(0);
        th.pc = p.addr;          // ブートROMの起動の処理を飛ばす。他のスレッドはブートROMの idle へ
        th.up = p.up >>> 0;
      }
    }
    m.hostInput = true;   // UIでは、利用者がいつでもUARTに入力できる
    this.m = m;
    this.dbg = new Debugger(m);
    this.dbg.breakpoints = this.breakpoints;
    this.dbg.exceptionBreaks = this.exceptionBreaks;
    this.dbg.watches = this.watches;
    this.dbg.mailBreaks = this.mailBreaks;
    this.#trackWrites();
    this.prev = new Map();
    this.#buildIndex();
  }

  // ---------------------------------------------------------------- 変わった箇所の強調
  /** 書き込みを覚える語の数の上限（実行を長く続けたとき、覚えるのをやめる） */
  static WRITTEN_LIMIT = 8192;

  /** CPUのメモリへの書き込みを覚える（デバッガの書き込みのブレークポイントと両立させる） */
  #trackWrites() {
    const mem = this.m.mem;
    const dbgHook = mem.onWrite;
    this.written = new Map();   // 語の番地 → 書き込まれたバイトのビット（bit0＝番地+0 … bit3＝番地+3）
    mem.onWrite = (addr, size, ctx) => {
      dbgHook?.(addr, size, ctx);
      const w = (addr & ~3) >>> 0;
      const old = this.written.get(w);
      if (old === undefined && this.written.size >= Session.WRITTEN_LIMIT) return;
      this.written.set(w, (old ?? 0) | (size === 4 ? 0xf : 1 << (addr & 3)));
    };
  }

  /**
   * いまの状態を「直前」として覚える（ステップ・実行を始めるときに呼ぶ）。
   * 以後、表示はこれと比べて変わった箇所を強調する。メモリは、これ以後に書き込まれた番地を強調する。
   */
  takeSnapshot() {
    this.prev = new Map();
    for (const th of this.threads) {
      this.prev.set(th.tid, {
        ds: th.dataStack(), rs: th.returnStack(),
        summary: this.threadSummary(th),
        csr: this.csrList(th).map(c => c.value),
        mbox: th.mbox.slice(), waiting: th.sendQueue.slice(),
        up: th.up >>> 0, evpend: this.m.pendingEvents(th) >>> 0, lastException: th.lastException,
      });
    }
    this.written.clear();
  }

  /** 語（unit＝4）・バイト（unit＝1）が、覚えてから書き込まれたか */
  isWritten(addr, unit = 4) {
    const bits = this.written.get((addr & ~3) >>> 0);
    if (!bits) return false;
    return unit === 4 ? true : (bits & (1 << (addr & 3))) !== 0;
  }

  /**
   * メールボックスで、覚えてから届いた語の数（FIFOの後ろの何語が新しいか）。
   * 前から取り出された分を飛ばして、前の中身の残りがいまの先頭と一致するところを探す。
   */
  mailboxArrived(th) {
    const prev = this.prev.get(th.tid)?.mbox;
    const cur = th.mbox;
    if (!prev) return 0;
    for (let k = 0; k <= prev.length; k++) {
      const rest = prev.length - k;
      if (rest > cur.length) continue;
      let same = true;
      for (let i = 0; i < rest; i++) if (prev[k + i] !== cur[i]) { same = false; break; }
      if (same) return cur.length - rest;
    }
    return cur.length;
  }

  /** 番地 → ラベル、番地 → 配置の情報 */
  #buildIndex() {
    this.labelAt = new Map();
    this.layoutAt = new Map();
    const add = (labels, layout) => {
      for (const [name, a] of labels ?? []) if (!this.labelAt.has(a)) this.labelAt.set(a, name);
      for (const e of layout ?? []) {
        this.layoutAt.set(e.addr, e);
        // データは範囲のすべての語をデータとして扱う（先頭の語以外は source なし）
        if (e.kind === 'data') {
          for (let a = ((e.addr & ~3) >>> 0) + 4; a < e.addr + e.size; a += 4) {
            if (!this.layoutAt.has(a)) this.layoutAt.set(a, { addr: a, kind: 'data' });
          }
        }
      }
    };
    add(this.program?.labels, this.program?.layout);  // プログラムのラベルを先に（ROMと重なればプログラムを優先）
    add(this.rom.labels, this.rom.layout);
  }

  get threads() {
    return this.m.threads;
  }

  /** 一覧の1行（docs/ui.md 4.1節） */
  threadSummary(th) {
    const cur = th.dec ? th.wordAddr : th.pc;
    const slot = th.dec ? th.dec.insts[th.idx]?.slot ?? 0 : 0;
    return {
      tid: th.tid,
      state: th.state,
      stateName: STATE_NAMES[th.state] ?? String(th.state),
      mode: th.mode ? '特権' : '一般',
      pc: cur >>> 0,
      slot,
      depth: th.depth, dcap: th.dcap,
      rdepth: th.rdepth, rcap: th.rcap,
      T: th.depth > 0 ? th.peek(0) : null,
      N: th.depth > 1 ? th.peek(1) : null,
      instret: th.instret,
    };
  }

  /** 番地の語の種類：配置の情報があればそれ、なければ null（推測する） */
  kindAt(addr) {
    return this.layoutAt.get(addr)?.kind ?? null;
  }

  /**
   * 逆アセンブルの窓（docs/ui.md 4.1節）。
   * @param {number} center 中央に置く語の番地
   * @param {{ before?: number, after?: number, style?: 'reg'|'forth', th?: object }} [opts]
   *   th：そのスレッドが実行中の語と、次に実行する命令を強調する
   * @returns {Array<{ addr, kind: 'inst'|'lit'|'data'|'none', word: number|null, parts: Array<{text, current, slot}>,
   *                   label?: string, source?: string[], bp: boolean, current: boolean }>}
   */
  disasmWindow(center, { before = 6, after = 14, style = 'reg', th = null } = {}) {
    center = (center & ~3) >>> 0;
    const start = Math.max(0, center - before * 4);
    const rows = [];
    let litLeft = 0;     // 推測：直前の命令語が消費する定数語の残り
    let litFrom = null;  // 推測：その命令語の番地
    // 窓の前から推測を始めて、定数語の位置をなるべく合わせる
    for (let a = Math.max(0, start - 16 * 4); a < start; a += 4) {
      const k = this.kindAt(a);
      const w = peekWord(this.m, a);
      if (k === 'inst' || (k === null && litLeft === 0 && w !== null)) { litLeft = w === null ? 0 : decodeWord(w).litCount; litFrom = a; }
      else if (litLeft > 0) litLeft--;
    }
    const curWord = th ? (th.dec ? th.wordAddr : th.pc) >>> 0 : null;
    for (let a = start; a <= center + after * 4; a += 4) {
      const word = peekWord(this.m, a);
      let kind = this.kindAt(a);
      if (kind === null) kind = word === null ? 'none' : (litLeft > 0 ? 'lit' : 'inst');
      const row = { addr: a, kind, word, parts: [], label: this.labelAt.get(a), source: this.layoutAt.get(a)?.source, bp: this.breakpoints.has(a), current: a === curWord };
      if (kind === 'inst' && word !== null) {
        const dec = decodeWord(word);
        litLeft = dec.litCount;
        litFrom = a;
        const lits = [];
        for (let k = 1; k <= dec.litCount; k++) lits.push(peekWord(this.m, a + 4 * k));
        let litIndex = 0;
        // 後ろに続くNOP（埋め草）は表示しない。ただし実行中の命令なら表示する
        let last = dec.insts.length - 1;
        const curIdx = row.current && th.dec && th.wordAddr === a ? th.idx : (row.current ? 0 : -1);
        while (last >= 0 && dec.insts[last].op === OP.NOP && last !== curIdx) last--;
        dec.insts.forEach((inst, i) => {
          const usesLit = inst.op === OP.LIT || (inst.op === OP.SYS && inst.sub === SYS.PCREL);
          const ctx = { style, addr: a };
          if (usesLit) { ctx.lit = lits[litIndex] ?? undefined; ctx.litAddr = a + 4 * (litIndex + 1); litIndex++; }
          if (i > last) return;
          let text = formatInst(inst, ctx);
          if (inst.op === OP.JMP || inst.op === OP.JZ || inst.op === OP.CALL) {
            const t = a + inst.offset * 4;
            const l = this.labelAt.get(t);
            if (l) text += ` (${l})`;
          }
          row.parts.push({ text: inst.slot === 6 ? `[s6]${text}` : text, current: i === curIdx, slot: inst.slot });
        });
        if (row.parts.length === 0) row.parts.push({ text: 'NOP', current: false, slot: 0 });   // NOPだけの語
        if (dec.fault) row.parts.push({ text: `!! 例外${dec.fault.exc}`, current: false, slot: dec.fault.slot });
      } else if (kind === 'lit') {
        if (litLeft > 0) litLeft--;
        row.litOf = litFrom;
      } else if (kind === 'data') {
        litLeft = 0;
      }
      rows.push(row);
    }
    return rows;
  }

  /** CSRの一覧（選んだスレッド） */
  csrList(th) {
    return CSR_NAMES.map(([name, n]) => ({ n, name, value: csrRead(this.m, th, n) >>> 0 }));
  }

  /** メールボックスの中身：ヘッダを分解する（10.3節） */
  mailboxView(th) {
    const items = [];
    let left = 0;
    for (const w of th.mbox) {
      if (left === 0) {
        const n = w & 0xf;
        items.push({ header: true, word: w, src: w >>> 24, tag: (w >>> 8) & 0xffff, n });
        left = n;
      } else {
        items.push({ header: false, word: w });
        left--;
      }
    }
    return { items, waiting: th.sendQueue.slice() };
  }

  /**
   * メモリのダンプ（副作用なし。I/Oと割り当てのない番地は null）。
   * @returns {Array<{ addr: number, values: Array<number|null> }>}
   */
  memoryRows(addr, { rows = 16, perRow = 4, unit = 4 } = {}) {
    addr = unit === 4 ? (addr & ~3) >>> 0 : addr >>> 0;
    const out = [];
    for (let r = 0; r < rows; r++) {
      const base = (addr + r * perRow * unit) >>> 0;
      const values = [];
      for (let k = 0; k < perRow; k++) {
        const a = (base + k * unit) >>> 0;
        if (unit === 4) values.push(peekWord(this.m, a));
        else {
          const reg = this.m.mem.region(a);
          values.push(!reg || reg.kind === 'io' ? null : reg.buf[reg.off]);
        }
      }
      out.push({ addr: base, values });
    }
    return out;
  }

  /** 番地の文字列を数にする。番地は16進で書く（先頭の $ や 0x、途中の _ は書いてもよい）。だめなら null */
  static parseAddress(text) {
    const t = String(text).trim().replace(/_/g, '').replace(/^(\$|0x)/i, '');
    if (!/^[0-9a-f]{1,8}$/i.test(t)) return null;
    return parseInt(t, 16) >>> 0;
  }
}

export { AsmError, MEM };
