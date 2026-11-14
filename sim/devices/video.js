// 画面（docs/spec.md 12.2節、12.7.4節）。DOMに依存しない。UIは renderRGBA() の結果をcanvasに写す。
//
// 制御レジスタ（0xFF00_3000、特権モードのみ）
//   +0x00 VIDCAPS   読み出しのみ。bit0〜3＝モード0〜3が使えるか
//   +0x04 VIDMODE   bit1〜0＝モード。bit31＝エラー（使えないモードを書いた。読み出しのみ。正しいモードを書くと消える）
//   +0x08 CTRL      bit0＝表示の有効化（リセット値1）
//   +0x0C STATUS    読み出しのみ。bit0＝垂直帰線期間中
//   +0x10 CURSOR    bit6〜0＝桁（0〜79）、bit12〜8＝行（0〜29）
//   +0x14 CURSORCTL bit0＝表示、bit1＝点滅、bit11〜8＝開始ライン、bit15〜12＝終了ライン
//   +0x18 SCROLL    画面の先頭に表示する行（0〜29）
//   +0x40〜+0x7C PALETTE[0〜15]  bit23〜16＝R、bit15〜8＝G、bit7〜0＝B
// テキストVRAM（0xFF01_0000、8KBの窓）：文字n番（n＝行×80＋桁）の +2n が文字コード、+2n+1 が属性
//   （下位4bit＝文字色、上位4bit＝背景色）。4,800バイトより後ろはバスエラー
// フォントRAM（0xFF02_0000、4KB）：文字cのr行目が +c×16+r、bit7が左端
// どちらも8bit・32bitで読み書きできる（T-16）。
//
// タイミング（T-37）：1フレーム＝800×525ドット、1ライン＝800ドット、ピクセルクロック25.2MHz。
// 表示期間は480ライン。垂直帰線期間（45ライン）に入ったときにVSYNC（イベント3）を全スレッドに立てる。
// カーソルの点滅は32フレームごとに点灯と消灯を切り替える（T-39）。
import { EV } from '../isa.js';
import { VIDEO_REG, TEXT } from './registers.js';
import { unassigned, protect } from './common.js';
import { makeInitialFont } from './font8x16.js';

export const PIXEL_CLOCK_MHZ = 25.2;
export const FRAME_DOTS = 800 * 525;
export const VBLANK_START_DOTS = 800 * 480;
export const BLINK_FRAMES = 32;
export const WIDTH = TEXT.COLS * TEXT.CELL_W;   // 640
export const HEIGHT = TEXT.ROWS * TEXT.CELL_H;  // 480
const VRAM_BYTES = TEXT.COLS * TEXT.ROWS * 2;   // 4,800

/** パレットのリセット値（CGAの16色。T-36） */
export const DEFAULT_PALETTE = [
  0x000000, 0x0000AA, 0x00AA00, 0x00AAAA, 0xAA0000, 0xAA00AA, 0xAA5500, 0xAAAAAA,
  0x555555, 0x5555FF, 0x55FF55, 0x55FFFF, 0xFF5555, 0xFF55FF, 0xFFFF55, 0xFFFFFF,
];

export class Video {
  constructor(machine) {
    this.m = machine;
    this.name = '画面の制御';
    this.size = 0x1000;
    const cpd = machine.cfg.clockMHz / PIXEL_CLOCK_MHZ;   // 1ドットあたりのCPUサイクル
    this.frameCycles = Math.round(FRAME_DOTS * cpd);       // 9K：900,000、20K：1,200,000
    this.vblankStart = Math.round(VBLANK_START_DOTS * cpd);
    this.vram = new Uint8Array(VRAM_BYTES);
    this.font = new Uint8Array(256 * 16);
    this.vramDevice = new ByteArrayDevice('テキストVRAM', 0x2000, this.vram);
    this.fontDevice = new ByteArrayDevice('フォントRAM', 0x1000, this.font);
    this.reset();
  }

  reset() {
    this.mode = 0;
    this.modeError = false;
    this.ctrl = 1;
    this.cursor = 0;
    this.cursorCtl = 0;
    this.scroll = 0;
    this.palette = DEFAULT_PALETTE.slice();
    this.lastVsyncFrame = -1;
    this.vram.fill(0);
    this.font.set(makeInitialFont());
  }

  /** フレーム番号（0から） */
  get frame() {
    return Math.floor(this.m.cycle / this.frameCycles);
  }

  /** 垂直帰線期間中か */
  get inVblank() {
    return this.m.cycle % this.frameCycles >= this.vblankStart;
  }

  /** cycle までに起きることを進める（帰線期間の始まりでVSYNC）。次に何かが起きるサイクルを返す */
  update(cycle) {
    const f = Math.floor(cycle / this.frameCycles);
    const thisVsync = f * this.frameCycles + this.vblankStart;
    if (cycle >= thisVsync && this.lastVsyncFrame < f) {
      this.lastVsyncFrame = f;
      this.m.raiseEvent(EV.VSYNC);
    }
    return cycle < thisVsync ? thisVsync : thisVsync + this.frameCycles;
  }

  read32(off, ctx) {
    switch (off) {
      case VIDEO_REG.VIDCAPS: return this.m.cfg.videoCaps;
      case VIDEO_REG.VIDMODE: return ((this.modeError ? 0x8000_0000 : 0) | this.mode) >>> 0;
      case VIDEO_REG.CTRL: return this.ctrl;
      case VIDEO_REG.STATUS: return this.inVblank ? 1 : 0;
      case VIDEO_REG.CURSOR: return this.cursor;
      case VIDEO_REG.CURSORCTL: return this.cursorCtl;
      case VIDEO_REG.SCROLL: return this.scroll;
    }
    if (off >= VIDEO_REG.PALETTE && off < VIDEO_REG.PALETTE + 64) return this.palette[(off - VIDEO_REG.PALETTE) >>> 2];
    return unassigned(ctx);
  }

  write32(off, v, ctx) {
    switch (off) {
      case VIDEO_REG.VIDCAPS: case VIDEO_REG.STATUS: return protect(ctx);
      case VIDEO_REG.VIDMODE: {
        const mode = v & 3;
        if (this.m.cfg.videoCaps & (1 << mode)) { this.mode = mode; this.modeError = false; }
        else this.modeError = true; // 使えないモードは切り替えず、エラーのビットを立てる
        return;
      }
      case VIDEO_REG.CTRL: this.ctrl = v & 1; return;
      case VIDEO_REG.CURSOR: this.cursor = v & 0x1f7f; return;
      case VIDEO_REG.CURSORCTL: this.cursorCtl = v & 0xff03; return;
      case VIDEO_REG.SCROLL: this.scroll = v & 0x1f; return;
    }
    if (off >= VIDEO_REG.PALETTE && off < VIDEO_REG.PALETTE + 64) {
      this.palette[(off - VIDEO_REG.PALETTE) >>> 2] = v & 0xffffff;
      return;
    }
    unassigned(ctx);
  }

  /**
   * 画面（モード0）を描く。
   * @param {Uint8ClampedArray} [out] 640×480×4（RGBA）。省略すると作る
   * @returns {Uint8ClampedArray}
   */
  renderRGBA(out = new Uint8ClampedArray(WIDTH * HEIGHT * 4)) {
    if (!(this.ctrl & 1)) {                 // 表示しない：黒
      for (let i = 0; i < out.length; i += 4) { out[i] = out[i + 1] = out[i + 2] = 0; out[i + 3] = 255; }
      return out;
    }
    const curCol = this.cursor & 0x7f;
    const curRow = (this.cursor >> 8) & 0x1f;
    const blinkOn = !(this.cursorCtl & 2) || Math.floor(this.frame / BLINK_FRAMES) % 2 === 0;
    const curShow = (this.cursorCtl & 1) && blinkOn;
    const curStart = (this.cursorCtl >> 8) & 0xf;
    const curEnd = (this.cursorCtl >> 12) & 0xf;
    for (let sy = 0; sy < TEXT.ROWS; sy++) {
      const row = (sy + this.scroll) % TEXT.ROWS;  // VRAMを30行の輪として扱う
      for (let col = 0; col < TEXT.COLS; col++) {
        const n = row * TEXT.COLS + col;
        const ch = this.vram[2 * n];
        const attr = this.vram[2 * n + 1];
        const fg = this.palette[attr & 0xf];
        const bg = this.palette[attr >> 4];
        const isCursor = curShow && row === curRow && col === curCol; // カーソルの行はVRAM上の行（T-91）
        for (let r = 0; r < TEXT.CELL_H; r++) {
          let bits = this.font[ch * 16 + r];
          if (isCursor && r >= curStart && r <= curEnd) bits = 0xff;
          let p = ((sy * TEXT.CELL_H + r) * WIDTH + col * TEXT.CELL_W) * 4;
          for (let x = 0; x < TEXT.CELL_W; x++, p += 4) {
            const c = bits & (0x80 >> x) ? fg : bg;
            out[p] = c >> 16; out[p + 1] = (c >> 8) & 0xff; out[p + 2] = c & 0xff; out[p + 3] = 255;
          }
        }
      }
    }
    return out;
  }

  /** テキストVRAMの1行を文字列にする（テストと表示用） */
  textRow(row) {
    let s = '';
    for (let col = 0; col < TEXT.COLS; col++) s += String.fromCharCode(this.vram[2 * (row * TEXT.COLS + col)]);
    return s;
  }
}

/** バイト配列をそのまま見せるデバイス（テキストVRAM、フォントRAM）。8bit・32bitで読み書きできる */
class ByteArrayDevice {
  constructor(name, size, buf) {
    this.name = name;
    this.size = size;
    this.buf = buf;
  }

  reset() {}

  #check(off, n, ctx) {
    if (off + n > this.buf.length) unassigned(ctx);
  }

  read8(off, ctx) { this.#check(off, 1, ctx); return this.buf[off]; }
  write8(off, v, ctx) { this.#check(off, 1, ctx); this.buf[off] = v & 0xff; }
  read32(off, ctx) {
    this.#check(off, 4, ctx);
    const b = this.buf;
    return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
  }
  write32(off, v, ctx) {
    this.#check(off, 4, ctx);
    for (let k = 0; k < 4; k++) this.buf[off + k] = (v >>> (8 * k)) & 0xff;
  }
}
