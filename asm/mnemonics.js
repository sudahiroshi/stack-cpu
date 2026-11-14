// ニーモニックの対応表（docs/spec.md 13.3節）。
// アセンブラは大文字・小文字を区別しない。複数語の名前（PUSH T など）は空白を1つに正規化して照合する。
import { OPS, SYS_OPS } from '../sim/isa.js';

/**
 * 名前 → { kind: 'op' | 'sys', code }
 * Forth風とレジスタ風の両方を登録する。
 * 注意：レジスタ風の LEA n,U、LEA label,PC、JSR (T)、PUSH #n、PUSHQ #n、MFC r などは
 * オペランドの形で区別するので、アセンブラ側で特別に解析する。
 */
export function buildMnemonicTable() {
  const table = new Map();
  const add = (name, entry) => {
    const key = name.toUpperCase().replace(/\s+/g, ' ');
    if (table.has(key)) throw new Error(`ニーモニックが重複: ${name}`);
    table.set(key, entry);
  };
  for (const o of OPS) {
    if (o.forth === 'SYS') continue; // SYSは直接は書かない（サブ命令の名前で書く）
    add(o.forth, { kind: 'op', code: o.op });
    if (o.reg !== o.forth && !['PUSH', 'LEA_U', 'JSR'].includes(o.reg)) {
      add(o.reg, { kind: 'op', code: o.op });
    }
  }
  for (const s of SYS_OPS) {
    add(s.forth, { kind: 'sys', code: s.sub });
    if (s.reg !== s.forth && s.reg !== 'LEA_PC') add(s.reg, { kind: 'sys', code: s.sub });
  }
  return table;
}

/** オペランドの形で区別するレジスタ風の書式 */
export const SPECIAL_FORMS = [
  { pattern: 'PUSH #expr',      means: 'LIT expr' },
  { pattern: 'PUSHQ #expr',     means: 'SLIT expr（−16〜+15）' },
  { pattern: 'JSR (T)',         means: 'EXEC' },
  { pattern: 'LEA n,U',         means: 'UA n' },
  { pattern: 'LEA label,PC',    means: 'PCREL label' },
  { pattern: 'MFC r / MTC r',   means: 'CSR@ #r / CSR! #r' },
  { pattern: 'SEND n / TRYSEND n', means: 'SENDM #n / SENDM? #n' },
];

/** マクロ（アセンブラが複数の命令に展開する） */
export const MACROS = [
  { pattern: 'LD n,U',      expand: ['LEA n,U', 'LD'] },
  { pattern: 'ST n,U',      expand: ['LEA n,U', 'ST'] },
  { pattern: 'LD label,PC', expand: ['LEA label,PC', 'LD'] },
  { pattern: 'LD addr',     expand: ['PUSH #addr', 'LD'] },
  { pattern: 'ST addr',     expand: ['PUSH #addr', 'ST'] },
  { pattern: 'ADD #n',      expand: ['PUSHQ #n（範囲外なら PUSH #n）', 'ADD'] },
  { pattern: 'CMP',         expand: ['SUB'] },
  { pattern: 'BNZ label',   expand: ['PUSHQ #0', 'CMPEQ', 'BZ label'] },
];
