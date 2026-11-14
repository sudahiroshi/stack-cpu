// UIの入口（雛形）。DOMを触るのはui/だけにする。
import { makeConfig } from '../sim/config.js';

const cfg = makeConfig('9K');
document.getElementById('status').textContent =
  `${cfg.name}：${cfg.ncores}コア×${cfg.nthreads}スレッド（シミュレータ本体は未実装）`;

// 画面の仮表示（80×30文字の枠だけ描く）
const ctx = document.getElementById('screen').getContext('2d');
ctx.fillStyle = '#000';
ctx.fillRect(0, 0, 640, 480);
ctx.fillStyle = '#0a0';
ctx.font = '16px monospace';
ctx.fillText('mode 0: 80x30 text (not implemented yet)', 8, 20);
