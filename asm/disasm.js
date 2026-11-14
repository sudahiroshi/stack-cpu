// 逆アセンブラ（docs/spec.md 13.3節）。Forth風・レジスタ風のどちらの表記でも出力できる。DOMに依存しない。
import { OP, OPS, SYS_OPS } from '../sim/isa.js';
import { decodeWord } from '../sim/decode.js';

const hex = v => '$' + (v >>> 0).toString(16).toUpperCase();

/**
 * デコード済みの1命令を文字列にする。
 * @param {{slot:number, op:number, sub?:number, imm?:number, offset?:number}} inst
 * @param {{ style?: 'reg'|'forth', addr?: number, lit?: number, litAddr?: number }} [ctx]
 *   addr: 命令語のアドレス（分岐先の表示に使う）、lit: 対応する定数語の値、litAddr: 定数語のアドレス
 */
export function formatInst(inst, ctx = {}) {
  const reg = (ctx.style ?? 'reg') === 'reg';
  const { op } = inst;
  if (op === OP.SYS) {
    const s = SYS_OPS[inst.sub];
    if (s.sub === 7) { // PCREL
      const t = ctx.lit !== undefined && ctx.litAddr !== undefined ? hex(ctx.litAddr + ctx.lit) : '?';
      return reg ? `LEA ${t},PC` : `PCREL ${t}`;
    }
    if (s.imm) {
      if (reg) return `${s.reg} ${inst.imm}`;
      return `${s.forth} #${inst.imm}`;
    }
    return reg ? s.reg : s.forth;
  }
  const o = OPS[op];
  if (o.operand === 'branch') {
    const t = ctx.addr !== undefined
      ? hex(ctx.addr + inst.offset * 4)
      : (inst.offset >= 0 ? '+' : '') + inst.offset;
    return `${reg ? o.reg : o.forth} ${t}`;
  }
  if (op === OP.LIT) {
    const v = ctx.lit !== undefined ? hex(ctx.lit) : '?';
    return reg ? `PUSH #${v}` : `LIT ${v}`;
  }
  if (op === OP.SLIT) return reg ? `PUSHQ #${inst.imm}` : `SLIT ${inst.imm}`;
  if (op === OP.UA) return reg ? `LEA ${inst.imm},U` : `UA ${inst.imm}`;
  if (op === OP.EXEC) return reg ? 'JSR (T)' : 'EXEC';
  return reg ? o.reg : o.forth;
}

/**
 * 命令語を逆アセンブルする。
 * @param {number} word
 * @param {{ style?: 'reg'|'forth', addr?: number, lits?: number[] }} [ctx]
 * @returns {{ text: string, litCount: number, fault: null | {exc:number, slot:number} }}
 * 後ろに続くNOP（埋め草）は表示しない。
 */
export function disassembleWord(word, ctx = {}) {
  const dec = decodeWord(word);
  const insts = dec.insts.slice();
  while (insts.length > 0 && insts[insts.length - 1].op === OP.NOP) insts.pop();
  let litIndex = 0;
  const parts = insts.map(inst => {
    const c = { style: ctx.style, addr: ctx.addr };
    const usesLit = inst.op === OP.LIT || (inst.op === OP.SYS && inst.sub === 7);
    if (usesLit) {
      if (ctx.lits) c.lit = ctx.lits[litIndex];
      if (ctx.addr !== undefined) c.litAddr = ctx.addr + 4 * (litIndex + 1);
      litIndex++;
    }
    const s = formatInst(inst, c);
    return inst.slot === 6 ? `[s6]${s}` : s;
  });
  let text = parts.length ? parts.join('  ') : 'NOP';
  if (dec.fault) text += `  !! 例外${dec.fault.exc}（slot${dec.fault.slot}）`;
  return { text, litCount: dec.litCount, fault: dec.fault };
}
