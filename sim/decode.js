// 命令語のデコードと配置規則の検査（docs/spec.md 3章）。DOMに依存しない。
// アセンブラの自己検査と逆アセンブラ、シミュレータのフェッチ時判定で共有する。
import { OP, OPS, SYS_OPS, SLOT6_OPS, NUM_SLOTS, EXC, getSlot, getSlot6, slotShift } from './isa.js';

/** 下位bitsビットを符号付きとして拡張する */
export function signExtend(v, bits) {
  const s = 32 - bits;
  return (v << s) >> s;
}

/**
 * 命令語を、実行されるスロットの並びに分解する。
 * @param {number} word 32bitの命令語
 * @returns {{
 *   insts: Array<{slot:number, op:number, sub?:number, imm?:number, offset?:number}>,
 *   litCount: number,           // この語が消費する定数語（LIT・PCREL）の数
 *   fault: null | {exc:number, slot:number},  // フェッチ時に検出する例外（4または5）
 *   end: 'normal' | 'branch' | 'ret',
 * }}
 * - 分岐（JMP/JZ/CALL）は語の残りをオフセットにする（offsetは語単位、符号付き）。
 * - RET・RETIの後ろのスロットは実行しないので、そこで打ち切る。
 * - 語の最後に置く命令（EXEC、SYSCALL、拡張命令、SP!、RP!）は、後ろのスロット
 *   （slot6を含む）がすべてNOPでなければ配置違反（例外5。T-02）。
 *   後ろのNOPも insts に入れる（埋め草のNOPも1回の番を使う。T-10）。
 *   EXEC・SYSCALLのように制御が移る命令では、実行側が残りを実行しない。
 * - slot6は、分岐・RET・RETIで打ち切られなかったときに insts の最後に入る（NOPも含む）。
 */
export function decodeWord(word) {
  word >>>= 0;
  const insts = [];
  let litCount = 0;
  let fault = null;
  let end = 'normal';
  const restIsNop = from => {
    for (let k = from; k < NUM_SLOTS; k++) if (getSlot(word, k) !== 0) return false;
    return getSlot6(word) === 0;
  };

  let i = 0;
  while (i < NUM_SLOTS) {
    const op = getSlot(word, i);
    const info = OPS[op];

    if (info.operand === 'branch') {
      const bits = slotShift(i);
      const offset = signExtend(word & ((1 << bits) - 1), bits);
      insts.push({ slot: i, op, offset });
      end = 'branch';
      break;
    }

    if (info.operand === 'slot') {
      if (i + 1 >= NUM_SLOTS) { fault = { exc: EXC.PLACEMENT, slot: i }; break; }
      const v = getSlot(word, i + 1);
      if (op === OP.SYS) {
        const s = SYS_OPS[v];
        if (!s) { fault = { exc: EXC.ILLEGAL, slot: i }; break; }
        let width = 2;
        let imm;
        if (s.imm) {
          if (i + 2 >= NUM_SLOTS) { fault = { exc: EXC.PLACEMENT, slot: i }; break; }
          imm = getSlot(word, i + 2);
          width = 3;
        }
        if (s.operand === 'word') litCount++;
        insts.push(imm === undefined ? { slot: i, op, sub: v } : { slot: i, op, sub: v, imm });
        if (s.last && !restIsNop(i + width)) { fault = { exc: EXC.PLACEMENT, slot: i }; break; }
        if (s.endsWord) { end = 'ret'; break; }
        i += width;
        continue;
      }
      insts.push({ slot: i, op, imm: op === OP.SLIT ? signExtend(v, 5) : v });
      i += 2;
      continue;
    }

    if (op === OP.LIT) litCount++;
    insts.push({ slot: i, op });
    if (info.last && !restIsNop(i + 1)) { fault = { exc: EXC.PLACEMENT, slot: i }; break; }
    if (info.endsWord) { end = 'ret'; break; }
    i++;
  }

  if (!fault && end === 'normal') insts.push({ slot: 6, op: SLOT6_OPS[getSlot6(word)] });
  return { insts, litCount, fault, end };
}
