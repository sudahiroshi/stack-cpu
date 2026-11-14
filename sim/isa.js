// ISAの定数表（docs/spec.md が正。番号を変えるときは仕様書の手順に従うこと）

// ---- 命令語の形式（3.1節） ----
export const WORD_BITS = 32;
export const NUM_SLOTS = 6;          // 5bitのスロット（slot0〜slot5）
export const SLOT_BITS = 5;

/** slot i（0〜5）の最下位ビットの位置。slot0＝27、slot5＝2 */
export function slotShift(i) {
  return 27 - i * SLOT_BITS;
}

/** 命令語からslot i（0〜5）の値を取り出す */
export function getSlot(word, i) {
  return (word >>> slotShift(i)) & 0x1f;
}

/** slot6（2bit）の値を取り出す */
export function getSlot6(word) {
  return word & 0x3;
}

/** 分岐命令がslot iにあるとき、オフセットに使うビット数（3.3節） */
export function branchOffsetBits(i) {
  return slotShift(i); // slot0＝27bit、slot5＝2bit
}

// ---- 基本命令（4章） ----
// pop/push：データスタック、rpop/rpush：リターンスタック（フェッチ時の深さ判定に使う）
// operand: 'branch'（規則①）| 'slot'（規則②）| 'word'（規則③）| null
// last: true なら語の最後のスロットに置く（3.4節）
export const OPS = [
  { op: 0,  forth: 'NOP',    reg: 'NOP',     pop: 0, push: 0 },
  { op: 1,  forth: 'LIT',    reg: 'PUSH',    pop: 0, push: 1, operand: 'word' },
  { op: 2,  forth: 'JMP',    reg: 'BRA',     pop: 0, push: 0, operand: 'branch' },
  { op: 3,  forth: 'JZ',     reg: 'BZ',      pop: 1, push: 0, operand: 'branch' },
  { op: 4,  forth: 'CALL',   reg: 'BSR',     pop: 0, push: 0, rpush: 1, operand: 'branch' },
  { op: 5,  forth: 'RET',    reg: 'RTS',     pop: 0, push: 0, rpop: 1, endsWord: true },
  { op: 6,  forth: 'EXEC',   reg: 'JSR',     pop: 1, push: 0, rpush: 1, last: true },
  { op: 7,  forth: '>R',     reg: 'PSHR',    pop: 1, push: 0, rpush: 1 },
  { op: 8,  forth: 'R>',     reg: 'PULR',    pop: 0, push: 1, rpop: 1 },
  { op: 9,  forth: 'R@',     reg: 'PEEKR',   pop: 0, push: 1, rpop: 1, rpush: 1 },
  { op: 10, forth: 'DUP',    reg: 'PUSH T',  pop: 1, push: 2 },
  { op: 11, forth: 'DROP',   reg: 'POP',     pop: 1, push: 0 },
  { op: 12, forth: 'SWAP',   reg: 'EXG',     pop: 2, push: 2 },
  { op: 13, forth: 'OVER',   reg: 'PUSH N',  pop: 2, push: 3 },
  { op: 14, forth: '+',      reg: 'ADD',     pop: 2, push: 1 },
  { op: 15, forth: '-',      reg: 'SUB',     pop: 2, push: 1 },
  { op: 16, forth: 'AND',    reg: 'AND',     pop: 2, push: 1 },
  { op: 17, forth: 'OR',     reg: 'OR',      pop: 2, push: 1 },
  { op: 18, forth: 'XOR',    reg: 'EOR',     pop: 2, push: 1 },
  { op: 19, forth: 'LSHIFT', reg: 'LSL',     pop: 2, push: 1 },
  { op: 20, forth: 'RSHIFT', reg: 'LSR',     pop: 2, push: 1 },
  { op: 21, forth: 'UM*',    reg: 'MULU',    pop: 2, push: 2 },
  { op: 22, forth: '=',      reg: 'CMPEQ',   pop: 2, push: 1 },
  { op: 23, forth: 'SLIT',   reg: 'PUSHQ',   pop: 0, push: 1, operand: 'slot' },
  { op: 24, forth: '<',      reg: 'CMPLT',   pop: 2, push: 1 },
  { op: 25, forth: 'U<',     reg: 'CMPLO',   pop: 2, push: 1 },
  { op: 26, forth: '@',      reg: 'LD',      pop: 1, push: 1 },
  { op: 27, forth: '!',      reg: 'ST',      pop: 2, push: 0 },
  { op: 28, forth: 'C@',     reg: 'LDB',     pop: 1, push: 1 },
  { op: 29, forth: 'C!',     reg: 'STB',     pop: 2, push: 0 },
  { op: 30, forth: 'UA',     reg: 'LEA_U',   pop: 0, push: 1, operand: 'slot' },
  { op: 31, forth: 'SYS',    reg: 'SYS',     pop: 0, push: 0, operand: 'slot' },
];

export const OP = Object.fromEntries(OPS.map(o => [o.forth, o.op]));

// ---- slot6（2bit）の符号（3.1節。01〜11は仮） ----
export const SLOT6_OPS = [OP.NOP, OP.RET, OP['+'], OP.DUP];

// ---- SYS拡張命令（5章） ----
// imm: true なら、サブ命令の番号の次のスロットを即値として使う
// priv: true なら特権命令。privImmMax: CSR@で一般モードに許すCSR番号の上限
// ext: true なら拡張命令（ハードウェアにない場合は例外18）
// popN: SENDM系の追加の消費数は即値nに依存（pop = n + 2）
export const SYS_OPS = [
  { sub: 0,  forth: 'TID',     reg: 'TID',     pop: 0, push: 1 },
  { sub: 1,  forth: 'WAIT',    reg: 'WAIT',    pop: 1, push: 1 },
  { sub: 2,  forth: 'SIGNAL',  reg: 'SIGNAL',  pop: 1, push: 0 },
  { sub: 3,  forth: 'SENDM',   reg: 'SEND',    pop: 2, push: 0, imm: true, popN: true },
  { sub: 4,  forth: 'RECV',    reg: 'RECV',    pop: 0, push: 1 },
  { sub: 5,  forth: 'FENCE',   reg: 'FENCE',   pop: 0, push: 0 },
  { sub: 6,  forth: 'XCHG',    reg: 'XCHG',    pop: 2, push: 1 },
  { sub: 7,  forth: 'PCREL',   reg: 'LEA_PC',  pop: 0, push: 1, operand: 'word' },
  { sub: 8,  forth: 'UP@',     reg: 'PUSH U',  pop: 0, push: 1 },
  { sub: 9,  forth: 'UP!',     reg: 'POP U',   pop: 1, push: 0, priv: true },
  { sub: 10, forth: 'SP@',     reg: 'PUSH SP', pop: 0, push: 1 },
  { sub: 11, forth: 'SP!',     reg: 'POP SP',  pop: 1, push: 0, priv: true, last: true },
  { sub: 12, forth: 'RP@',     reg: 'PUSH RP', pop: 0, push: 1 },
  { sub: 13, forth: 'RP!',     reg: 'POP RP',  pop: 1, push: 0, priv: true, last: true },
  { sub: 14, forth: 'SYSCALL', reg: 'TRAP',    pop: 0, push: 0, last: true },
  { sub: 15, forth: 'RETI',    reg: 'RTI',     pop: 0, push: 0, rpop: 1, priv: true, endsWord: true },
  { sub: 16, forth: 'HALT',    reg: 'HALT',    pop: 0, push: 0, priv: true },
  { sub: 17, forth: 'CSR@',    reg: 'MFC',     pop: 0, push: 1, imm: true, priv: true, privImmMax: 9 },
  { sub: 18, forth: 'CSR!',    reg: 'MTC',     pop: 1, push: 0, imm: true, priv: true },
  { sub: 19, forth: 'M*',      reg: 'MULS',    pop: 2, push: 2, ext: true, last: true },
  { sub: 20, forth: 'BRK',     reg: 'BKPT',    pop: 0, push: 0 },
  { sub: 21, forth: 'U/MOD',   reg: 'DIVU',    pop: 2, push: 2, ext: true, last: true },
  { sub: 22, forth: '/MOD',    reg: 'DIVS',    pop: 2, push: 2, ext: true, last: true },
  { sub: 23, forth: 'UM/MOD',  reg: 'DIVUL',   pop: 3, push: 2, ext: true, last: true },
  { sub: 24, forth: 'SENDM?',  reg: 'TRYSEND', pop: 2, push: 1, imm: true, popN: true },
];
// SYSの25〜31は予約（不正命令、例外4）
export const SYS = Object.fromEntries(SYS_OPS.map(o => [o.forth, o.sub]));

// ---- 例外番号（7.2節） ----
export const EXC = {
  DSTACK_OVER: 0, DSTACK_UNDER: 1, RSTACK_OVER: 2, RSTACK_UNDER: 3,
  ILLEGAL: 4, PLACEMENT: 5, PRIVILEGE: 6, FETCH: 7, SYSCALL: 8, BREAK: 9,
  ALIGN: 10, BUS: 11, PROTECT: 12, REMOTE_XCHG: 13, BAD_TID: 14, DOUBLE: 15,
  PAGE_DATA: 16, PAGE_INST: 17, UNIMPL: 18,
};
export const RSTACK_REDZONE = 3;

// ---- CSR番号（8章） ----
export const CSR = {
  ISAVER: 0, FEATURES: 1, NCORES: 2, NTHREADS: 3, STACKDEPTH: 4, LOCALSIZE: 5,
  RAMSIZE: 6, MBOXDEPTH: 7, STATUS: 8, EVPEND: 9, VBR: 10, ECAUSE: 11, EPC: 12,
  EIR: 13, ESLOT: 14, EADDR: 15, ESCRATCH0: 16, ESCRATCH1: 17, PKREAD: 18,
  PKWRITE: 19, INSTRET_LO: 20, INSTRET_HI: 21, PTBASE: 22, ASID: 23,
};
export const CSR_USER_READABLE_MAX = 9; // CSR@ #0〜#9 は一般モードでも可

// ISAVER（CSR 0）の値＝仕様書の版（主番号 << 8 | 副番号）。v0.3 → 0x0003、v1.0 → 0x0100。
// 仕様書の版を上げたら必ず合わせる（test/isa.test.js で docs/spec.md の表題と照合している）。
export const ISA_VERSION = 0x0004;

export const FEATURE = { DIVIDER: 1 << 0, MULS: 1 << 1, EXTEXEC: 1 << 2, EXTFRAME: 1 << 3 };

// ---- イベントのビット（6.4節） ----
export const EV = { MAILBOX: 0, SIGNAL: 1, TIMER: 2, VSYNC: 3, UART_RX: 4, UART_TX: 5 };

// ---- メモリマップ（9.1節、12.1節） ----
export const MEM = {
  NULL_END:    0x0010_0000,
  LOCAL_BASE:  0x0010_0000, // ＋コア番号×LOCAL_WINDOW
  LOCAL_WINDOW: 0x0001_0000,
  EXTRAM_BASE: 0x0100_0000,
  IO_BASE:     0xFF00_0000,
  ROM_BASE:    0xFFFF_0000,
  ROM_SIZE:    0x1000,
};
export const IO = {
  UART:      0xFF00_0000,
  TIMER:     0xFF00_1000,
  GPIO:      0xFF00_2000,
  VIDEO:     0xFF00_3000,
  THREAD:    0xFF00_4000,
  VRAM:      0xFF01_0000,
  FONT:      0xFF02_0000,
  KEYTABLE:  0xFF08_0000,
  USERPAGE:  0xFF0F_0000,
};

export const RESET = { PC: 0xFFFF_0000, VBR: 0xFFFF_0100 };
