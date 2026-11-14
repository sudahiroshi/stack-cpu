// スレッドごとの状態（docs/spec.md 6.2節、6.2.1節、11.1節）。DOMに依存しない。
import { RESET, RSTACK_REDZONE, CSR } from './isa.js';
import { THREAD_STATE } from './devices/registers.js';

export class Thread {
  /**
   * @param {object} cfg 構成
   * @param {number} core コア番号
   * @param {number} index コア内のスレッド番号
   */
  constructor(cfg, core, index) {
    this.core = core;
    this.index = index;
    this.tid = (core << 4) | index;               // 6.3節
    this.dcap = cfg.stackDepth;                    // データスタックの容量
    this.rcap = cfg.stackDepth - RSTACK_REDZONE;   // リターンスタックの容量（残り3段はレッドゾーン）
    // スタック用RAM。SP!・RP!で深さを増やした段は、ここに残っている以前の値になる（T-12）。
    // TとNもこの配列の上端として扱う（深さはTとNを含めた総数。6.2.1節）。
    this.ds = new Uint32Array(cfg.stackDepth);
    this.rs = new Uint32Array(cfg.stackDepth);
    this.reset();
  }

  /** リセット時の状態（11.1節）。スタック用RAMの中身は消さない */
  reset() {
    this.generation = (this.generation ?? 0) + 1; // リセットした回数（実行中の命令が自分をリセットしたかの判定用）
    this.pc = RESET.PC;          // 次にフェッチする語のアドレス
    this.mode = 1;               // 1＝特権
    this.depth = 0;              // データスタックの深さ（SP）。SP!で範囲外になりうる（T-13）
    this.rdepth = 0;             // リターンスタックの深さ（RP）
    this.up = 0;
    this.vbr = RESET.VBR;
    this.ecause = 0; this.epc = 0; this.eir = 0; this.eslot = 0; this.eaddr = 0;
    this.escratch = [0, 0];
    this.pkread = 0;
    this.pkwrite = 0;
    this.instret = 0;            // 実行した命令数（T-19）
    this.events = 0;             // イベントのラッチ（段階3）
    this.state = THREAD_STATE.RESET;
    this.readyCycle = 0;         // この番号のサイクル以降に発行できる（間隔D、時間のかかる操作）
    this.busyUntil = 0;          // 実行中の時間のかかる操作（外部RAM、除算）が終わるサイクル

    // メールボックス（10章）。受信用のFIFO（深さMBOXDEPTH）と、このスレッドへの送信を待っているスレッドのtid（待ち始めた順。T-28）
    // リセットで空にする（T-87）
    this.mbox = [];
    this.sendQueue = [];

    // 命令語バッファ（6.1節）。語の途中でブロックしても続きから実行できるように保持する
    this.word = 0;               // 実行中の命令語
    this.wordAddr = 0;           // その語のアドレス
    this.dec = null;             // decodeWord の結果。null なら次の番でフェッチする
    this.idx = 0;                // dec.insts の何番目を次に実行するか
    this.litPtr = 0;             // 次に読む定数語のアドレス
    this.nextPc = 0;             // 「次の語」のアドレス（定数語の後ろ）

    /** 最後に起きた例外の記録（テストと表示用。CSRとは別に、戻り先や例外の前のモードも残す） */
    this.lastException = null;
    /** 例外の入口の処理中（ベクタ先の語のフェッチが終わるまで）。この間の例外は二重例外（T-31） */
    this.inEntry = false;
    /** SP!・RP!で深さを設定した直後（次の語のフェッチで、始める時点の深さも判定する。T-13） */
    this.depthSet = false;
  }

  // ---- データスタック ----
  push(v) {
    if (this.depth >= this.ds.length) throw new Error('内部エラー: データスタックの範囲外（フェッチ時の判定をすり抜けた）');
    this.ds[this.depth++] = v >>> 0;
  }
  pop() {
    if (this.depth <= 0) throw new Error('内部エラー: データスタックが空（フェッチ時の判定をすり抜けた）');
    return this.ds[--this.depth] ?? 0; // SP!で物理的な段数より深くした段は0（決定的にするため）
  }
  /** 上からi番目（0＝T、1＝N） */
  peek(i = 0) { return this.ds[this.depth - 1 - i]; }

  // ---- リターンスタック ----
  rpush(v) {
    if (this.rdepth >= this.rs.length) throw new Error('内部エラー: リターンスタックの範囲外');
    this.rs[this.rdepth++] = v >>> 0;
  }
  rpop() {
    if (this.rdepth <= 0) throw new Error('内部エラー: リターンスタックが空');
    return this.rs[--this.rdepth] ?? 0;
  }

  /** データスタックの中身（底から順。テストと表示用） */
  dataStack() { return Array.from(this.ds.subarray(0, Math.max(0, Math.min(this.depth, this.ds.length)))); }
  /** リターンスタックの中身（底から順） */
  returnStack() { return Array.from(this.rs.subarray(0, Math.max(0, Math.min(this.rdepth, this.rs.length)))); }

  /** スレッドごとのCSRで書けるもの（8章）。それ以外へのCSR!はフェッチ時に例外4（T-18） */
  static WRITABLE_CSR = new Set([CSR.VBR, CSR.ESCRATCH0, CSR.ESCRATCH1, CSR.PKREAD, CSR.PKWRITE]);
}
