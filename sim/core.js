// 命令のフェッチと実行（docs/spec.md 3〜5章、7章）。DOMに依存しない。
//
// 1回の番（issue）で1命令を実行する。オペランド用のスロット（SLITの値、SYSのサブ命令番号など）は
// 命令の一部として同じ番で読み、番を使わない（T-81）。埋め草のNOPも1回の番を使う（T-10）。
//
// 語のフェッチは、その語の最初の番で行い、次の判定をする（7.1節）。
//   例外7（フェッチ違反）、4（不正命令、存在しないCSR、読み出し専用のCSRへのCSR!）、5（配置違反）、
//   6（特権違反）、0〜3（スタック深さ）、9（BRK）。同時に起きたときはこの順（TODO(T-32)）。
//
// 段階2では、例外が起きたら記録してスレッドを止める（raise）。例外の入口は段階4で作る。
import {
  OP, OPS, SYS, SYS_OPS, EXC, CSR, FEATURE, ISA_VERSION, CSR_USER_READABLE_MAX,
} from './isa.js';
import { decodeWord } from './decode.js';
import { CpuException } from './cpu-exception.js';
import { Thread } from './thread.js';
import { THREAD_STATE } from './devices/registers.js';

const TRUE = 0xFFFFFFFF;
const CSR_EXISTS_MAX = 21; // 22・23は予約、24〜31は存在しない → 例外4
const FETCH_PRIORITY = [   // TODO(T-32)
  EXC.FETCH, EXC.ILLEGAL, EXC.PLACEMENT, EXC.PRIVILEGE,
  EXC.DSTACK_OVER, EXC.DSTACK_UNDER, EXC.RSTACK_OVER, EXC.RSTACK_UNDER, EXC.BREAK,
];

// execute の戻り値
const NEXT = 0;    // 同じ語の次の命令へ
const JUMP = 1;    // 制御が移った（th.pc に次の語のアドレスを入れてある）

/** 命令のスタック効果（フェッチ時の深さの判定に使う） */
export function stackEffect(inst) {
  if (inst.op === OP.SYS) {
    const s = SYS_OPS[inst.sub];
    return { pop: s.popN ? inst.imm + 2 : s.pop, push: s.push, rpop: s.rpop ?? 0, rpush: s.rpush ?? 0 };
  }
  const o = OPS[inst.op];
  return { pop: o.pop, push: o.push, rpop: o.rpop ?? 0, rpush: o.rpush ?? 0 };
}

/**
 * 例外を起こす。段階2の仮の扱い：CSRに記録してスレッドを止める。
 * @param {object} info { slot, addr, wordAddr, word, resumeAddr }
 *   resumeAddr：再開する番地（語の先頭、または例外8・18では次の語）。段階4の入口で使う
 */
export function raise(m, th, exc, { slot = 0, addr = 0, wordAddr, word = 0, resumeAddr }) {
  th.ecause = exc;
  th.epc = wordAddr >>> 0;
  th.eir = word >>> 0;
  th.eslot = slot;
  th.eaddr = addr >>> 0;
  th.lastException = {
    exc, epc: th.epc, eir: th.eir, eslot: slot, eaddr: th.eaddr,
    resumeAddr: (resumeAddr ?? wordAddr) >>> 0, mode: th.mode,
  };
  // TODO(段階4): 戻り先をリターンスタックに積み、特権モードにして VBR＋番号×4 へ
  th.state = THREAD_STATE.HALT;
  th.dec = null;
  m.emit({ type: 'exception', tid: th.tid, ...th.lastException });
}

/**
 * 語をフェッチしてデコードし、フェッチ時の判定をする。
 * @returns {boolean} 実行を続けられれば true（例外を起こしたら false）
 */
function fetch(m, th) {
  const addr = th.pc;
  let word;
  try {
    word = m.mem.fetch32(addr, th.core);
  } catch (e) {
    if (!(e instanceof CpuException)) throw e;
    raise(m, th, e.exc, { slot: 0, addr: e.addr, wordAddr: addr });
    return false;
  }
  const dec = decodeWord(word);

  // 起きうる例外を集め、優先順位の一番高いものを起こす
  const faults = [];
  if (dec.fault) faults.push(dec.fault);
  for (const inst of dec.insts) {
    if (inst.op !== OP.SYS) continue;
    const s = SYS_OPS[inst.sub];
    if (inst.sub === SYS['CSR@'] && inst.imm > CSR_EXISTS_MAX) faults.push({ exc: EXC.ILLEGAL, slot: inst.slot });
    if (inst.sub === SYS['CSR!'] && !Thread.WRITABLE_CSR.has(inst.imm)) faults.push({ exc: EXC.ILLEGAL, slot: inst.slot }); // T-18
    if (th.mode === 0 && s.priv && !(inst.sub === SYS['CSR@'] && inst.imm <= CSR_USER_READABLE_MAX)) {
      faults.push({ exc: EXC.PRIVILEGE, slot: inst.slot });
    }
    if (inst.sub === SYS.BRK) faults.push({ exc: EXC.BREAK, slot: inst.slot });
  }
  faults.push(...depthFaults(th, dec.insts));

  if (faults.length) {
    const rank = f => FETCH_PRIORITY.indexOf(f.exc);
    faults.sort((a, b) => rank(a) - rank(b) || a.slot - b.slot);
    raise(m, th, faults[0].exc, { slot: faults[0].slot, wordAddr: addr, word });
    return false;
  }

  th.word = word;
  th.wordAddr = addr;
  th.dec = dec;
  th.idx = 0;
  th.litPtr = addr + 4;
  th.nextPc = addr + 4 + 4 * dec.litCount;
  return true;
}

/**
 * スタック深さの判定（6.2.1節、7.1節）。語の命令の増減を累積し、途中の最大・最小で判定する。
 * slot6も含める（TODO(T-01)）。SP!・RP!で範囲外の深さになっていれば、ここで例外になる（T-13）。
 */
function depthFaults(th, insts) {
  const found = new Map();
  const note = (exc, slot) => { if (!found.has(exc)) found.set(exc, { exc, slot }); };
  let d = th.depth, r = th.rdepth;
  if (d > th.dcap) note(EXC.DSTACK_OVER, 0);
  if (d < 0) note(EXC.DSTACK_UNDER, 0);
  if (r > th.rcap) note(EXC.RSTACK_OVER, 0);
  if (r < 0) note(EXC.RSTACK_UNDER, 0);
  for (const inst of insts) {
    const e = stackEffect(inst);
    d -= e.pop; if (d < 0) note(EXC.DSTACK_UNDER, inst.slot);
    d += e.push; if (d > th.dcap) note(EXC.DSTACK_OVER, inst.slot);
    r -= e.rpop; if (r < 0) note(EXC.RSTACK_UNDER, inst.slot);
    r += e.rpush; if (r > th.rcap) note(EXC.RSTACK_OVER, inst.slot);
  }
  return [...found.values()];
}

/** 1回の番：必要ならフェッチし、1命令を実行する */
export function issue(m, th) {
  if (!th.dec && !fetch(m, th)) return;
  const inst = th.dec.insts[th.idx];
  let r;
  try {
    r = execute(m, th, inst);
  } catch (e) {
    if (!(e instanceof CpuException)) throw e;
    raise(m, th, e.exc, {
      slot: inst.slot, addr: e.addr, wordAddr: th.wordAddr, word: th.word,
      resumeAddr: e.resumeNext ? th.nextPc : th.wordAddr,
    });
    return;
  }
  th.instret++;
  if (m.listeners.size) {
    m.emit({
      type: 'exec', tid: th.tid, cycle: m.cycle, wordAddr: th.wordAddr, slot: inst.slot, inst,
      depth: th.depth, T: th.depth > 0 ? th.peek(0) : undefined, N: th.depth > 1 ? th.peek(1) : undefined,
      rdepth: th.rdepth,
    });
  }
  if (r === JUMP) { th.dec = null; return; }
  th.idx++;
  if (th.idx >= th.dec.insts.length) {
    th.pc = th.nextPc;
    th.dec = null;
  }
}

// ---------------------------------------------------------------- 実行

function jump(th, target) {
  th.pc = target >>> 0;
  return JUMP;
}

/** 分岐先＝語のアドレス＋オフセット×4。32bitで一周しない（T-03）。範囲外は例外7（TODO(T-80)） */
function branchTarget(th, inst) {
  const t = th.wordAddr + inst.offset * 4;
  if (t < 0 || t > 0xFFFFFFFF) throw new CpuException(EXC.FETCH, th.wordAddr);
  return t;
}

/** LIT・PCRELの定数語を読む（命令の並びなのでフェッチと同じ経路） */
function readLit(m, th) {
  const v = m.mem.fetch32(th.litPtr, th.core);
  th.litPtr += 4;
  return v;
}

function extUnimplemented() {
  const e = new CpuException(EXC.UNIMPL);
  e.resumeNext = true; // そのスロットまで実行してから例外18。戻り先は次の語（5.2節）
  return e;
}

function execute(m, th, inst) {
  const ctx = { core: th.core, tid: th.tid, mode: th.mode };
  const { mem } = m;
  let a, b;
  switch (inst.op) {
    case OP.NOP: return NEXT;
    case OP.LIT: th.push(readLit(m, th)); return NEXT;
    case OP.JMP: return jump(th, branchTarget(th, inst));
    case OP.JZ:
      if (th.pop() === 0) return jump(th, branchTarget(th, inst));
      return jump(th, th.nextPc);          // 分岐しなければ次の語へ（語の残りは実行しない）
    case OP.CALL: {
      const t = branchTarget(th, inst);
      th.rpush(th.nextPc);
      return jump(th, t);
    }
    case OP.RET:
      a = th.rpop();
      if (a & 3) throw new CpuException(EXC.ALIGN, a);
      return jump(th, a);
    case OP.EXEC:
      a = th.pop();
      if (a & 3) throw new CpuException(EXC.ALIGN, a);
      th.rpush(th.nextPc);
      return jump(th, a);
    case OP['>R']: th.rpush(th.pop()); return NEXT;
    case OP['R>']: th.push(th.rpop()); return NEXT;
    case OP['R@']: th.push(th.rs[th.rdepth - 1]); return NEXT;
    case OP.DUP: th.push(th.peek(0)); return NEXT;
    case OP.DROP: th.pop(); return NEXT;
    case OP.SWAP: b = th.pop(); a = th.pop(); th.push(b); th.push(a); return NEXT;
    case OP.OVER: th.push(th.peek(1)); return NEXT;
    case OP['+']: b = th.pop(); a = th.pop(); th.push(a + b); return NEXT;
    case OP['-']: b = th.pop(); a = th.pop(); th.push(a - b); return NEXT;
    case OP.AND: b = th.pop(); a = th.pop(); th.push(a & b); return NEXT;
    case OP.OR: b = th.pop(); a = th.pop(); th.push(a | b); return NEXT;
    case OP.XOR: b = th.pop(); a = th.pop(); th.push(a ^ b); return NEXT;
    case OP.LSHIFT: b = th.pop(); a = th.pop(); th.push(a << (b & 31)); return NEXT;
    case OP.RSHIFT: b = th.pop(); a = th.pop(); th.push(a >>> (b & 31)); return NEXT;
    case OP['UM*']: {
      b = th.pop(); a = th.pop();
      const p = BigInt(a) * BigInt(b);
      th.push(Number(p & 0xFFFFFFFFn));
      th.push(Number(p >> 32n));
      return NEXT;
    }
    case OP['=']: b = th.pop(); a = th.pop(); th.push(a === b ? TRUE : 0); return NEXT;
    case OP.SLIT: th.push(inst.imm); return NEXT;
    case OP['<']: b = th.pop(); a = th.pop(); th.push((a | 0) < (b | 0) ? TRUE : 0); return NEXT;
    case OP['U<']: b = th.pop(); a = th.pop(); th.push(a < b ? TRUE : 0); return NEXT;
    case OP['@']: a = th.pop(); th.push(mem.read32(a, ctx)); return NEXT;
    case OP['!']: a = th.pop(); b = th.pop(); mem.write32(a, b, ctx); return NEXT;
    case OP['C@']: a = th.pop(); th.push(mem.read8(a, ctx)); return NEXT;
    case OP['C!']: a = th.pop(); b = th.pop(); mem.write8(a, b, ctx); return NEXT;
    case OP.UA: th.push(th.up | (inst.imm << 2)); return NEXT;
    case OP.SYS: return executeSys(m, th, inst, ctx);
  }
  throw new Error(`内部エラー: 不明な命令 ${inst.op}`);
}

function executeSys(m, th, inst, ctx) {
  const { mem, cfg } = m;
  const s = SYS_OPS[inst.sub];
  if (s.ext) {
    const need = inst.sub === SYS['M*'] ? FEATURE.MULS : FEATURE.DIVIDER;
    if (!(cfg.features & need)) throw extUnimplemented();
  }
  let a, b, c;
  switch (inst.sub) {
    case SYS.TID: th.push(th.tid); return NEXT;
    case SYS.WAIT: case SYS.SIGNAL: case SYS.SENDM: case SYS.RECV: case SYS['SENDM?']:
      throw new Error(`未実装（段階3）: ${s.forth}`);
    case SYS.FENCE: return NEXT; // キャッシュなし・インオーダーなので何もしない（9.2節）
    case SYS.XCHG: {
      a = th.pop(); b = th.pop();
      if (a & 3) throw new CpuException(EXC.ALIGN, a);
      const r = mem.region(a);
      if (r && r.kind === 'local' && r.core !== th.core) throw new CpuException(EXC.REMOTE_XCHG, a);
      const old = mem.read32(a, ctx);
      mem.write32(a, b, ctx);
      th.push(old);
      return NEXT;
    }
    case SYS.PCREL: {
      const at = th.litPtr;
      th.push(at + readLit(m, th)); // オフセット語自身のアドレス＋オフセット
      return NEXT;
    }
    case SYS['UP@']: th.push(th.up); return NEXT;
    case SYS['UP!']:
      a = th.pop();
      if (a & 127) throw new CpuException(EXC.ALIGN, a);
      th.up = a;
      return NEXT;
    case SYS['SP@']: th.push(th.depth); return NEXT;        // 実行する直前の深さ
    case SYS['SP!']: a = th.pop(); th.depth = a | 0; return NEXT;
    case SYS['RP@']: th.push(th.rdepth); return NEXT;
    case SYS['RP!']: a = th.pop(); th.rdepth = a | 0; return NEXT;
    case SYS.SYSCALL: {
      const e = new CpuException(EXC.SYSCALL);
      e.resumeNext = true;
      throw e;
    }
    case SYS.RETI:
      a = th.rpop();
      th.mode = a & 1;
      return jump(th, a & ~3);
    case SYS.HALT:
      th.state = THREAD_STATE.HALT; // 再開はTHREADCTLによるリセットだけ（T-17）
      return NEXT;
    case SYS['CSR@']: th.push(csrRead(m, th, inst.imm)); return NEXT;
    case SYS['CSR!']: csrWrite(th, inst.imm, th.pop()); return NEXT;
    case SYS['M*']: {
      b = th.pop(); a = th.pop();
      const p = BigInt(a | 0) * BigInt(b | 0);
      th.push(Number(BigInt.asUintN(32, p)));
      th.push(Number(BigInt.asUintN(32, p >> 32n)));
      return NEXT;
    }
    case SYS.BRK: throw new CpuException(EXC.BREAK); // 通常はフェッチ時に起きる
    case SYS['U/MOD']:
      b = th.pop(); a = th.pop();
      if (b === 0) { th.push(a); th.push(TRUE); return NEXT; }   // 0除算：余り＝被除数、商＝全ビット1
      th.push(a % b); th.push(Math.floor(a / b));
      return NEXT;
    case SYS['/MOD']:
      b = th.pop() | 0; a = th.pop() | 0;
      if (b === 0) { th.push(a); th.push(TRUE); return NEXT; }
      if (a === -0x80000000 && b === -1) { th.push(0); th.push(a); return NEXT; }
      th.push(a % b); th.push(Math.trunc(a / b));                 // 0方向への切り捨て
      return NEXT;
    case SYS['UM/MOD']: {
      c = th.pop(); b = th.pop(); a = th.pop();                   // ( lo hi u -- rem quot )
      if (b >= c) { th.push(0); th.push(TRUE); return NEXT; }    // 商があふれる（u＝0を含む。T-83）。余りは0（T-21）
      const n = (BigInt(b) << 32n) | BigInt(a);
      th.push(Number(n % BigInt(c)));
      th.push(Number(n / BigInt(c)));
      return NEXT;
    }
  }
  throw new Error(`内部エラー: 不明なSYS ${inst.sub}`);
}

/** CSRの読み出し（8章）。番号の正しさはフェッチ時に検査済み */
export function csrRead(m, th, r) {
  const { cfg } = m;
  switch (r) {
    case CSR.ISAVER: return ISA_VERSION;
    case CSR.FEATURES: return cfg.features;
    case CSR.NCORES: return cfg.ncores;
    case CSR.NTHREADS: return cfg.nthreads;
    case CSR.STACKDEPTH: return cfg.stackDepth;
    case CSR.LOCALSIZE: return cfg.localSize;
    case CSR.RAMSIZE: return cfg.extRamSize;
    case CSR.MBOXDEPTH: return cfg.mboxDepth;
    case CSR.STATUS: return th.mode & 1;
    case CSR.EVPEND: return th.events >>> 0; // TODO(段階3): 状態のビット（メールボックス、UART）を合わせる
    case CSR.VBR: return th.vbr;
    case CSR.ECAUSE: return th.ecause;
    case CSR.EPC: return th.epc;
    case CSR.EIR: return th.eir;
    case CSR.ESLOT: return th.eslot;
    case CSR.EADDR: return th.eaddr;
    case CSR.ESCRATCH0: return th.escratch[0];
    case CSR.ESCRATCH1: return th.escratch[1];
    case CSR.PKREAD: return th.pkread;
    case CSR.PKWRITE: return th.pkwrite;
    case CSR.INSTRET_LO: return th.instret % 2 ** 32;
    case CSR.INSTRET_HI: return Math.floor(th.instret / 2 ** 32);
  }
  throw new Error(`内部エラー: 存在しないCSR ${r}`);
}

function csrWrite(th, r, v) {
  switch (r) {
    case CSR.VBR: th.vbr = v; return;
    case CSR.ESCRATCH0: th.escratch[0] = v; return;
    case CSR.ESCRATCH1: th.escratch[1] = v; return;
    case CSR.PKREAD: th.pkread = v; return;
    case CSR.PKWRITE: th.pkwrite = v; return;
  }
  throw new Error(`内部エラー: 書けないCSR ${r}`);
}
