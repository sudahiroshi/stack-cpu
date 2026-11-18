// 命令のフェッチと実行（docs/spec.md 3〜5章、7章）。DOMに依存しない。
//
// 1回の番（issue）で1命令を実行する。オペランド用のスロット（SLITの値、SYSのサブ命令番号など）は
// 命令の一部として同じ番で読み、番を使わない（T-81）。埋め草のNOPも1回の番を使う（T-10）。
//
// 語のフェッチは、その語の最初の番で行い、次の判定をする（7.1節）。
//   例外7（フェッチ違反）、4（不正命令、存在しないCSR、読み出し専用のCSRへのCSR!）、5（配置違反）、
//   6（特権違反）、0〜3（スタック深さ）、9（BRK）。同時に起きたときはこの順（T-32）。
//
// 例外（7.3節）：raise が例外の入口の処理をする。戻り先（bit0＝モード）をリターンスタックに積み、
// 特権モードにして VBR＋番号×4 へ移る。入口の処理中にさらに例外が起きたら二重例外（T-31）。
//
// 待機（段階3）：WAIT・RECV・SENDM は、続けられないときスタックを変えずに BLOCK を返し、
// スレッドを待機状態（THREADSTAT 2〜4）にする。起きる条件が成り立ったら、スケジューラが同じ命令をもう一度実行する。
// 時間のかかる操作（外部RAM、他コアのローカルBSRAM、除算器）は th.busyUntil に完了のサイクルを入れ、
// スケジューラはそれまで次の発行を待たせる（THREADSTAT 5）。
import {
  OP, OPS, SYS, SYS_OPS, EXC, CSR, EV, FEATURE, ISA_VERSION, CSR_USER_READABLE_MAX,
} from './isa.js';
import { decodeWord } from './decode.js';
import { CpuException } from './cpu-exception.js';
import { Thread } from './thread.js';
import { THREAD_STATE } from './devices/registers.js';

const TRUE = 0xFFFFFFFF;
const CSR_EXISTS_MAX = 21; // 22・23は予約、24〜31は存在しない → 例外4
const FETCH_PRIORITY = [   // T-32
  EXC.FETCH, EXC.ILLEGAL, EXC.PLACEMENT, EXC.PRIVILEGE,
  EXC.DSTACK_OVER, EXC.DSTACK_UNDER, EXC.RSTACK_OVER, EXC.RSTACK_UNDER, EXC.BREAK,
];

// execute の戻り値
const NEXT = 0;    // 同じ語の次の命令へ
const JUMP = 1;    // 制御が移った（th.pc に次の語のアドレスを入れてある）
const BLOCK = 2;   // 続けられないので待つ（スタックは変えていない。同じ命令をもう一度実行する）

/** 命令のスタック効果（フェッチ時の深さの判定に使う） */
export function stackEffect(inst) {
  if (inst.op === OP.SYS) {
    const s = SYS_OPS[inst.sub];
    return { pop: s.popN ? inst.imm + 2 : s.pop, push: s.push, rpop: s.rpop ?? 0, rpush: s.rpush ?? 0 };
  }
  const o = OPS[inst.op];
  return { pop: o.pop, push: o.push, rpop: o.rpop ?? 0, rpush: o.rpush ?? 0 };
}

/** メモリのアクセスに渡す情報（モードとキーの集合） */
function memCtx(th) {
  return { core: th.core, tid: th.tid, mode: th.mode, pkread: th.pkread, pkwrite: th.pkwrite };
}

/**
 * 例外を起こす（7.3節）。
 * ECAUSE・EPC・EIR・ESLOT・EADDRを記録し、戻り先（語のバイトアドレス、bit0＝現在のモード）を
 * リターンスタックに積んで（レッドゾーンを使ってよい。深さの判定の対象外）、特権モードで VBR＋番号×4 へ移る。
 * 次の場合は二重例外（例外15。T-31）：入口でリターンスタックに積めない、
 * またはベクタ先の語のフェッチ（フェッチ時の判定を含む）で例外になった。スレッドを止める（THREADSTAT 7）。
 * @param {object} info { slot, addr, wordAddr, word, resumeAddr }
 *   resumeAddr：戻り先（再開できる例外は語の先頭、例外8・18は次の語）
 */
export function raise(m, th, exc, { slot = 0, addr = 0, wordAddr, word = 0, resumeAddr }) {
  th.ecause = exc;
  th.epc = wordAddr >>> 0;
  th.eir = word >>> 0;
  th.eslot = slot;
  th.eaddr = addr >>> 0;
  const ret = (resumeAddr ?? wordAddr) >>> 0;
  th.lastException = { exc, epc: th.epc, eir: th.eir, eslot: slot, eaddr: th.eaddr, resumeAddr: ret, mode: th.mode };
  th.dec = null;

  // リターンスタックの物理的な段数（容量＋レッドゾーン3段）を使い切っている、または深さが負（RP!で設定）なら積めない（T-89）
  const cannotPush = th.rdepth < 0 || th.rdepth >= th.rs.length;
  if (th.inEntry || cannotPush) {
    th.ecause = EXC.DOUBLE;
    th.lastException = { ...th.lastException, exc: EXC.DOUBLE, cause: exc };
    th.state = THREAD_STATE.DOUBLE_FAULT;
    th.inEntry = false;
    m.emit({ type: 'exception', tid: th.tid, ...th.lastException });
    m.exceptionHook?.(th, th.lastException.exc);
    return;
  }
  th.rs[th.rdepth++] = ((ret & ~3) | (th.mode & 1)) >>> 0;
  th.mode = 1;
  th.pc = (th.vbr + exc * 4) >>> 0;
  th.inEntry = true;    // ベクタ先の語のフェッチが終わるまで
  th.depthSet = false;  // ハンドラの最初の語では、始める時点の深さを判定しない（T-90）
  m.emit({ type: 'exception', tid: th.tid, ...th.lastException });
  m.exceptionHook?.(th, th.lastException.exc);
}

/**
 * 語をフェッチしてデコードし、フェッチ時の判定をする。
 * @returns {boolean} 実行を続けられれば true（例外を起こしたら false）
 */
function fetch(m, th) {
  const addr = th.pc;
  let word;
  try {
    word = m.mem.fetch32(addr, memCtx(th));
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
  th.inEntry = false; // ベクタ先の語のフェッチが終わった
  th.depthSet = false;
  return true;
}

/**
 * スタック深さの判定（6.2.1節、7.1節）。語の命令の増減を累積し、途中の最大・最小で判定する。
 * slot6も含める（T-01）。SP!・RP!で範囲外の深さになっていれば、ここで例外になる（T-13）。
 */
function depthFaults(th, insts) {
  const found = new Map();
  const note = (exc, slot) => { if (!found.has(exc)) found.set(exc, { exc, slot }); };
  let d = th.depth, r = th.rdepth;
  // 語を始める時点の深さは、SP!・RP!で設定した直後の語だけ判定する（T-13）。
  // 例外の入口がレッドゾーンに積んだぶんは判定しない（ハンドラが動けるように。T-90）
  if (th.depthSet) {
    if (d > th.dcap) note(EXC.DSTACK_OVER, 0);
    if (d < 0) note(EXC.DSTACK_UNDER, 0);
    if (r > th.rcap) note(EXC.RSTACK_OVER, 0);
    if (r < 0) note(EXC.RSTACK_UNDER, 0);
  }
  for (const inst of insts) {
    const e = stackEffect(inst);
    // あふれは、その命令で深さが増えて容量を超えたとき。アンダーフローは、その命令が取り出すときに足りないとき。
    // （レッドゾーンにいるハンドラや、SP!で範囲外にした後のハンドラが、深さを増やさない命令を実行できるように。T-90）
    d -= e.pop; if (e.pop > 0 && d < 0) note(EXC.DSTACK_UNDER, inst.slot);
    d += e.push; if (e.push > e.pop && d > th.dcap) note(EXC.DSTACK_OVER, inst.slot);
    r -= e.rpop; if (e.rpop > 0 && r < 0) note(EXC.RSTACK_UNDER, inst.slot);
    r += e.rpush; if (e.rpush > e.rpop && r > th.rcap) note(EXC.RSTACK_OVER, inst.slot);
  }
  return [...found.values()];
}

/**
 * 1回の番：必要ならフェッチし、1命令を実行する。
 * @returns {boolean} 命令を実行し終えたか（待機・例外なら false）
 */
export function issue(m, th) {
  if (!th.dec && !fetch(m, th)) return false;
  const inst = th.dec.insts[th.idx];
  const gen = th.generation;
  let r;
  try {
    r = execute(m, th, inst);
    if (th.generation !== gen) return false; // THREADCTLで自分自身をリセットした
  } catch (e) {
    if (!(e instanceof CpuException)) throw e;
    raise(m, th, e.exc, {
      slot: inst.slot, addr: e.addr, wordAddr: th.wordAddr, word: th.word,
      resumeAddr: e.resumeNext ? th.nextPc : th.wordAddr,
    });
    return false;
  }
  if (r === BLOCK) {
    if (m.listeners.size) m.emit({ type: 'block', tid: th.tid, cycle: m.cycle, state: th.state, wordAddr: th.wordAddr, slot: inst.slot });
    return false;
  }
  th.instret++;
  if (m.listeners.size) {
    m.emit({
      type: 'exec', tid: th.tid, cycle: m.cycle, wordAddr: th.wordAddr, slot: inst.slot, inst,
      depth: th.depth, T: th.depth > 0 ? th.peek(0) : undefined, N: th.depth > 1 ? th.peek(1) : undefined,
      rdepth: th.rdepth,
    });
  }
  if (r === JUMP) { th.dec = null; return true; }
  th.idx++;
  if (th.idx >= th.dec.insts.length) {
    th.pc = th.nextPc;
    th.dec = null;
  }
  return true;
}

/** データのアクセスにかかる時間を記録する（T-25） */
function busy(m, th, addr) {
  th.busyUntil = Math.max(th.busyUntil, m.cycle + m.mem.latency(addr, th.core));
}

/** 除算器を使う（1コアに1個。使用中なら空くまで待ち、発行した順に使う。T-24） */
function useDivider(m, th) {
  const core = m.cores[th.core];
  const start = Math.max(m.cycle, core.dividerFreeAt);
  core.dividerFreeAt = start + m.cfg.dividerCycles;
  th.busyUntil = Math.max(th.busyUntil, core.dividerFreeAt);
}

// ---------------------------------------------------------------- 実行

function jump(th, target) {
  th.pc = target >>> 0;
  return JUMP;
}

/** 分岐先＝語のアドレス＋オフセット×4。32bitで一周しない（T-03）。範囲外は例外7（T-80） */
function branchTarget(th, inst) {
  const t = th.wordAddr + inst.offset * 4;
  if (t < 0 || t > 0xFFFFFFFF) throw new CpuException(EXC.FETCH, th.wordAddr);
  return t;
}

/** LIT・PCRELの定数語を読む（命令の並びなのでフェッチと同じ経路） */
function readLit(m, th) {
  const v = m.mem.fetch32(th.litPtr, memCtx(th));
  th.litPtr += 4;
  return v;
}

function extUnimplemented() {
  const e = new CpuException(EXC.UNIMPL);
  e.resumeNext = true; // そのスロットまで実行してから例外18。戻り先は次の語（5.2節）
  return e;
}

function execute(m, th, inst) {
  const ctx = memCtx(th);
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
    case OP['@']: a = th.pop(); th.push(mem.read32(a, ctx)); busy(m, th, a); return NEXT;
    case OP['!']: a = th.pop(); b = th.pop(); mem.write32(a, b, ctx); busy(m, th, a); return NEXT;
    case OP['C@']: a = th.pop(); th.push(mem.read8(a, ctx)); busy(m, th, a); return NEXT;
    case OP['C!']: a = th.pop(); b = th.pop(); mem.write8(a, b, ctx); busy(m, th, a); return NEXT;
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
    case SYS.WAIT: {
      // ( mask -- bits )：立っているビットを返し、ラッチ式のビットを消す（6.4節）
      const bits = m.pendingEvents(th) & th.peek(0);
      if (!bits) { th.state = THREAD_STATE.WAIT; return BLOCK; } // mask＝0なら永久に待つ（T-26）
      th.pop();
      th.events &= ~bits;
      th.push(bits);
      return NEXT;
    }
    case SYS.SIGNAL: {
      // ( tid -- )：相手のイベントビット1を立てる。tid＝−1で全スレッド（自分を含む。T-27）
      a = th.pop();
      if (a === TRUE) {
        for (const t of m.threads) t.events |= 1 << EV.SIGNAL;
      } else {
        const t = m.findThread(a);
        if (!t) throw new CpuException(EXC.BAD_TID);
        t.events |= 1 << EV.SIGNAL;
      }
      return NEXT;
    }
    case SYS.SENDM: case SYS['SENDM?']: {
      // ( x1 … xn tag tid -- ) / ( x1 … xn tag tid -- flag )（10.2節）
      const n = inst.imm;
      const target = m.findThread(th.peek(0));
      if (!target) throw new CpuException(EXC.BAD_TID);
      const trying = inst.sub === SYS['SENDM?'];
      if (!canSend(m, th, target, n, trying)) {
        if (trying) {                          // 送らずに偽。成否にかかわらず引数を消費する
          for (let k = 0; k < n + 2; k++) th.pop();
          th.push(0);
          return NEXT;
        }
        if (!target.sendQueue.includes(th.tid)) target.sendQueue.push(th.tid);
        th.state = THREAD_STATE.SEND;
        return BLOCK;
      }
      const qi = target.sendQueue.indexOf(th.tid);
      if (qi >= 0) target.sendQueue.splice(qi, 1);
      th.pop();                                // tid
      const tag = th.pop() & 0xFFFF;            // 下位16bitを使う（T-86）
      const data = [];
      for (let k = 0; k < n; k++) data.unshift(th.pop());
      // ヘッダ：送信元tid（31〜24）、tag（23〜8）、予備0（7〜4）、n（3〜0）（10.3節）
      const header = ((th.tid << 24) | (tag << 8) | n) >>> 0;
      target.mbox.push(header, ...data);
      m.mailHook?.(target, header, th);
      if (trying) th.push(TRUE);
      return NEXT;
    }
    case SYS.RECV:
      if (th.mbox.length === 0) { th.state = THREAD_STATE.RECV; return BLOCK; }
      th.push(th.mbox.shift());
      return NEXT;
    case SYS.FENCE: return NEXT; // キャッシュなし・インオーダーなので何もしない（9.2節）
    case SYS.XCHG: {
      a = th.pop(); b = th.pop();
      if (a & 3) throw new CpuException(EXC.ALIGN, a);
      const r = mem.region(a);
      if (r && r.kind === 'local' && r.core !== th.core) throw new CpuException(EXC.REMOTE_XCHG, a);
      const old = mem.read32(a, ctx);
      mem.write32(a, b, ctx);
      busy(m, th, a);
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
    case SYS['SP!']: a = th.pop(); th.depth = a | 0; th.depthSet = true; return NEXT;
    case SYS['RP@']: th.push(th.rdepth); return NEXT;
    case SYS['RP!']: a = th.pop(); th.rdepth = a | 0; th.depthSet = true; return NEXT;
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
      useDivider(m, th);
      b = th.pop(); a = th.pop();
      if (b === 0) { th.push(a); th.push(TRUE); return NEXT; }   // 0除算：余り＝被除数、商＝全ビット1
      th.push(a % b); th.push(Math.floor(a / b));
      return NEXT;
    case SYS['/MOD']:
      useDivider(m, th);
      b = th.pop() | 0; a = th.pop() | 0;
      if (b === 0) { th.push(a); th.push(TRUE); return NEXT; }
      if (a === -0x80000000 && b === -1) { th.push(0); th.push(a); return NEXT; }
      th.push(a % b); th.push(Math.trunc(a / b));                 // 0方向への切り捨て
      return NEXT;
    case SYS['UM/MOD']: {
      useDivider(m, th);
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

/**
 * SENDM・SENDM?で、いま送れるか（10.2節）。
 * 相手のFIFOにn＋1語の空きがあり、先に待っているスレッドがいないこと（待ち始めた順に送る。T-28）。
 * SENDMで待っているスレッドは、自分が待ち行列の先頭なら送れる。SENDM?は待ち行列に入らないので、
 * 誰かが待っていれば送れない（T-85）。
 */
export function canSend(m, th, target, n, trying) {
  if (target.mbox.length + n + 1 > m.cfg.mboxDepth) return false;
  if (target.sendQueue.length === 0) return true;
  return !trying && target.sendQueue[0] === th.tid;
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
    case CSR.EVPEND: return m.pendingEvents(th);
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
