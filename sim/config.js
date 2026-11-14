// 機種ごとの構成（docs/spec.md 2.2節）。値は合成時のパラメータに相当する。
import { FEATURE } from './isa.js';

export const PRESETS = {
  '9K': {
    name: 'Tang Nano 9K',
    ncores: 1,
    nthreads: 8,
    pipelineDepth: 4,          // 同じスレッドの命令の最小間隔D
    clockMHz: 54,              // 仮想時間の計算に使う
    stackDepth: 16,
    localSize: 24 * 1024,
    extRamSize: 8 * 1024 * 1024,
    mboxWords: 512,            // 1コアあたり。スレッド数で等分
    features: FEATURE.DIVIDER | FEATURE.MULS,
    videoCaps: 0b0001,         // モード0のみ（当初）
  },
  '20K': {
    name: 'Tang Nano 20K',
    ncores: 2,
    nthreads: 8,
    pipelineDepth: 4,
    clockMHz: 72,
    stackDepth: 32,
    localSize: 24 * 1024,      // 要調整（spec 2.4節）
    extRamSize: 8 * 1024 * 1024,
    mboxWords: 512,
    features: FEATURE.DIVIDER | FEATURE.MULS,
    videoCaps: 0b0001,
  },
};

export function makeConfig(name = '9K', overrides = {}) {
  const base = PRESETS[name];
  if (!base) throw new Error(`未知の構成: ${name}`);
  const cfg = { ...base, ...overrides };
  cfg.mboxDepth = Math.floor(cfg.mboxWords / cfg.nthreads);
  return cfg;
}
