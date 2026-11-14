// マシン全体（雛形）。段階2以降で実装する。
// DOMに依存しないこと（ブラウザとNode.jsの両方で動かす）。
import { makeConfig } from './config.js';
import { RESET } from './isa.js';

export class Machine {
  /** @param {string|object} config '9K' | '20K' | 構成オブジェクト */
  constructor(config = '9K') {
    this.cfg = typeof config === 'string' ? makeConfig(config) : config;
    this.cycle = 0;            // 仮想時間（サイクル数）
    this.listeners = new Set(); // UIやトレース用のフック
    this.reset();
  }

  reset() {
    this.cycle = 0;
    // TODO(段階2): コア、スレッドの状態（PC=RESET.PC、特権モード、空のスタック、VBR=RESET.VBR）
    // TODO(段階3): スケジューラ、メールボックス
    // TODO(段階5): デバイス
    this.resetPC = RESET.PC;
  }

  /** イメージ（Uint8Array）を指定の番地に読み込む（OSイメージの直接読み込み、spec 11.2節） */
  load(_address, _bytes) {
    throw new Error('未実装（段階2）');
  }

  /** 1サイクル進める（バレルの1回の発行） */
  step() {
    throw new Error('未実装（段階2〜3）');
  }

  /** nサイクル進める */
  run(n) {
    for (let i = 0; i < n; i++) this.step();
  }

  /** 経過時間（マイクロ秒、仮想時間） */
  get microseconds() {
    return Math.floor(this.cycle / this.cfg.clockMHz);
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
