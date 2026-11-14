// I/Oデバイスで共通に使う関数（docs/spec.md 12.7節）。DOMに依存しない。
import { EXC } from '../isa.js';
import { CpuException } from '../cpu-exception.js';

/** 割り当てのないオフセット → バスエラー（例外11） */
export function unassigned(ctx) {
  throw new CpuException(EXC.BUS, ctx.addr ?? 0);
}

/** 読み出し専用のレジスタへの書き込み、書き込み専用のレジスタからの読み出し → 例外12 */
export function protect(ctx) {
  throw new CpuException(EXC.PROTECT, ctx.addr ?? 0);
}

/** 64bitの値の下位・上位32bit */
export const lo32 = v => v % 2 ** 32;
export const hi32 = v => Math.floor(v / 2 ** 32);
