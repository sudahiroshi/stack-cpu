// アセンブラ。DOMに依存しない（ブラウザとNode.jsの両方で動く）。
//
// 仕様：docs/spec.md 3章（命令語の形式・オペランド・分岐・配置）、13.2節（アセンブラの規則）、13.3節（ニーモニック）。
//
// 処理の流れ
//   1. 行を解析して「項目」の列を作る（マクロはここで展開する）
//      項目：label / org / data / inst
//   2. 配置（layout）：命令をスロットに詰め、語・定数語・データの番地を決める
//      分岐が届かない場合は、その分岐を「次の語のslot0へ移す」集合に加えて配置をやり直す（単調に増えるので必ず収束）
//   3. 出力：語を符号化し、定数語（LIT・PCREL）とデータを書き込む。最後に全語を decodeWord で自己検査する
//
// 詰め込みの規則
//   - ラベルは必ず新しい語の先頭（4バイト境界）に置く。ただし直後が DC.B のラベルは境界に揃えない
//   - SLIT/UA/SYS は2スロット、CSR@/CSR!/SENDM/SENDM? は3スロット。入りきらなければ次の語へ
//   - 分岐（JMP/JZ/CALL）は語の残りをオフセットに使い、そこで語を閉じる
//   - EXEC・SYSCALL・拡張命令・SP!・RP!・RET・RETI の後ろは NOP で埋めて語を閉じる
//   - slot0〜5が埋まったとき、次の命令が slot6 に置ける命令（NOP、RET、+、DUP）なら slot6 に置く（options.useSlot6）
//   - LIT・PCREL の定数語は、命令語の直後に使う順で並べる
import { OP, OPS, SYS, SYS_OPS, SLOT6_OPS, NUM_SLOTS, CSR, slotShift } from '../sim/isa.js';
import { decodeWord } from '../sim/decode.js';
import { buildMnemonicTable } from './mnemonics.js';
import { disassembleWord } from './disasm.js';

const MNEMONICS = buildMnemonicTable();
const CSR_MAX = Math.max(...Object.values(CSR).filter(v => v !== CSR.PTBASE && v !== CSR.ASID));
const SENDM_MAX = 4;

/** アセンブルの誤り（複数をまとめて報告する） */
export class AsmError extends Error {
  constructor(errors) {
    super(errors.map(e => (e.line ? `${e.line}行: ` : '') + e.message).join('\n'));
    this.name = 'AsmError';
    this.errors = errors;
  }
}

class LineError extends Error {}

const align4 = v => ((v + 3) & ~3) >>> 0;
const fitsSigned = (v, bits) => v >= -(2 ** (bits - 1)) && v < 2 ** (bits - 1);
const toU32 = v => ((v % 2 ** 32) + 2 ** 32) % 2 ** 32;
const hex8 = v => (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

// ---------------------------------------------------------------- 式

const IDENT = /^[A-Za-z_.][\w.]*$/;

function tokenizeExpr(text) {
  const toks = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    let m;
    const rest = text.slice(i);
    if ((m = rest.match(/^\$([0-9A-Fa-f]+)/))) { toks.push({ t: 'num', v: parseInt(m[1], 16) }); i += m[0].length; continue; }
    if ((m = rest.match(/^[0-9]+/))) {
      if (/^[0-9]+[A-Za-z_]/.test(rest)) throw new LineError(`数値の書き方が不正: ${rest}`);
      toks.push({ t: 'num', v: parseInt(m[0], 10) }); i += m[0].length; continue;
    }
    if ((m = rest.match(/^[A-Za-z_.][\w.]*/))) { toks.push({ t: 'sym', v: m[0] }); i += m[0].length; continue; }
    if ('+-*/()'.includes(c)) { toks.push({ t: c }); i++; continue; }
    throw new LineError(`式に使えない文字: ${c}`);
  }
  return toks;
}

/** 式を構文木にする。演算子は + - * /（0方向に切り捨て）と単項の + -、括弧 */
export function parseExpr(text) {
  const toks = tokenizeExpr(text);
  if (toks.length === 0) throw new LineError('式がない');
  let p = 0;
  const peek = () => toks[p]?.t;
  const primary = () => {
    const tk = toks[p++];
    if (!tk) throw new LineError(`式が途中で終わっている: ${text}`);
    if (tk.t === 'num') return { t: 'num', v: tk.v };
    if (tk.t === 'sym') return { t: 'sym', name: tk.v };
    if (tk.t === '(') {
      const e = additive();
      if (toks[p++]?.t !== ')') throw new LineError(`括弧が閉じていない: ${text}`);
      return e;
    }
    if (tk.t === '-' || tk.t === '+') return { t: 'un', op: tk.t, a: primary() };
    throw new LineError(`式が不正: ${text}`);
  };
  const term = () => {
    let a = primary();
    while (peek() === '*' || peek() === '/') a = { t: 'bin', op: toks[p++].t, a, b: primary() };
    return a;
  };
  const additive = () => {
    let a = term();
    while (peek() === '+' || peek() === '-') a = { t: 'bin', op: toks[p++].t, a, b: term() };
    return a;
  };
  const e = additive();
  if (p !== toks.length) throw new LineError(`式が不正: ${text}`);
  return e;
}

/**
 * 構文木を評価する。resolve(name) → { value, rel }
 * rel はラベル（番地）に由来する値かどうか（LITでモジュール内の番地を埋め込んでいないかの検査に使う）
 */
function evalAst(e, resolve) {
  switch (e.t) {
    case 'num': return { value: e.v, rel: false };
    case 'sym': return resolve(e.name);
    case 'un': {
      const a = evalAst(e.a, resolve);
      return { value: e.op === '-' ? -a.value : a.value, rel: a.rel };
    }
    case 'bin': {
      const a = evalAst(e.a, resolve);
      const b = evalAst(e.b, resolve);
      let v;
      switch (e.op) {
        case '+': v = a.value + b.value; break;
        case '-': v = a.value - b.value; break;
        case '*': v = a.value * b.value; break;
        case '/':
          if (b.value === 0) throw new LineError('0で割っている');
          v = Math.trunc(a.value / b.value); break;
      }
      return { value: v, rel: a.rel || b.rel };
    }
  }
  throw new Error('内部エラー: 不明な式');
}

// ---------------------------------------------------------------- 行の解析

/** ; 以降のコメントを取り除く（文字列の中の ; は残す） */
function stripComment(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inStr = !inStr;
    else if (line[i] === ';' && !inStr) return line.slice(0, i);
  }
  return line;
}

/** カンマで区切る（文字列と括弧の中のカンマは区切らない） */
function splitOperands(text) {
  const out = [];
  let depth = 0, inStr = false, cur = '';
  for (const c of text) {
    if (c === '"') inStr = !inStr;
    if (!inStr) {
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    }
    cur += c;
  }
  if (inStr) throw new LineError('文字列が閉じていない');
  if (cur.trim() !== '' || out.length > 0) out.push(cur.trim());
  return out;
}

const REGISTER_SUFFIX = ['T', 'N', 'U', 'SP', 'RP'];

/**
 * 1行を文に分解する。
 * @returns {{ label?: string, equ?: {name, expr}, mnem?: string, operand?: string }}
 */
function parseLine(raw) {
  let text = stripComment(raw).trim();
  const st = {};
  let m = text.match(/^([A-Za-z_.][\w.]*):(.*)$/);
  if (m) { st.label = m[1]; text = m[2].trim(); }
  if (text === '') return st;

  // NAME EQU expr  /  NAME: EQU expr
  m = text.match(/^([A-Za-z_.][\w.]*)\s+EQU\s+(.+)$/i);
  if (m && !st.label) { st.equ = { name: m[1], expr: parseExpr(m[2]) }; return st; }
  m = text.match(/^EQU\s+(.+)$/i);
  if (m) {
    if (!st.label) throw new LineError('EQUに名前がない');
    st.equ = { name: st.label, expr: parseExpr(m[1]) };
    delete st.label;
    return st;
  }

  m = text.match(/^(\S+)\s*(.*)$/);
  let mnem = m[1].toUpperCase();
  let operand = m[2].trim();
  // PUSH T、POP U などの2語の名前
  const m2 = operand.match(/^([A-Za-z]+)(?![\w.])\s*(.*)$/);
  if (m2 && REGISTER_SUFFIX.includes(m2[1].toUpperCase()) && MNEMONICS.has(`${mnem} ${m2[1].toUpperCase()}`)) {
    mnem = `${mnem} ${m2[1].toUpperCase()}`;
    operand = m2[2].trim();
  }
  st.mnem = mnem;
  st.operand = operand;
  return st;
}

// ---------------------------------------------------------------- 項目の生成

/** 即値スロット（出力時に評価して範囲を検査する） */
const immSlot = (expr, min, max, what, signed = false) => ({ expr, min, max, what, signed });

function plainOp(op) {
  const it = { kind: 'inst', slots: [op] };
  if (OPS[op].last) it.last = true;
  if (OPS[op].endsWord) it.ends = true;
  const s6 = SLOT6_OPS.indexOf(op);
  if (s6 >= 0) it.slot6 = s6;
  return it;
}

function sysOp(sub, immExpr) {
  const s = SYS_OPS[sub];
  const it = { kind: 'inst', slots: [OP.SYS, sub] };
  if (s.imm) {
    if (!immExpr) throw new LineError(`${s.forth} には即値が必要`);
    if (sub === SYS['CSR@'] || sub === SYS['CSR!']) it.slots.push(immSlot(immExpr, 0, CSR_MAX, 'CSRの番号'));
    else it.slots.push(immSlot(immExpr, 0, SENDM_MAX, '送る語数n'));
  }
  if (s.last) it.last = true;
  if (s.endsWord) it.ends = true;
  return it;
}

const litOp = expr => ({ kind: 'inst', slots: [OP.LIT], lit: { expr, pcrel: false } });
const pcrelOp = expr => ({ kind: 'inst', slots: [OP.SYS, SYS.PCREL], lit: { expr, pcrel: true } });
const slitOp = expr => ({ kind: 'inst', slots: [OP.SLIT, immSlot(expr, -16, 15, 'SLITの値', true)] });
const uaOp = expr => ({ kind: 'inst', slots: [OP.UA, immSlot(expr, 0, 31, 'UAの番号')] });
const branchOp = (op, expr) => ({ kind: 'inst', branch: { op, expr } });

/** '#expr' または 'expr' の # を取る */
function stripHash(s, required, mnem) {
  if (s.startsWith('#')) return s.slice(1).trim();
  if (required) throw new LineError(`${mnem} の即値には # が必要: ${s}`);
  return s;
}

function needOperand(mnem, operand) {
  if (operand === '') throw new LineError(`${mnem} にはオペランドが必要`);
}
function noOperand(mnem, operand) {
  if (operand !== '') throw new LineError(`${mnem} にはオペランドを書かない: ${operand}`);
}

/**
 * 命令・マクロの文を項目の列に展開する。
 * @param {(ast) => boolean} isSmallConst  式がラベルを含まず−16〜+15に収まるか（ADD #n の選択に使う）
 */
function expandInstruction(mnem, operand, isSmallConst) {
  const ops = operand === '' ? [] : splitOperands(operand);
  const one = () => {
    needOperand(mnem, operand);
    if (ops.length !== 1) throw new LineError(`${mnem} のオペランドは1つ: ${operand}`);
    return ops[0];
  };
  const two = () => {
    if (ops.length !== 2) return null;
    return ops;
  };

  switch (mnem) {
    // ---- 定数 ----
    case 'LIT': return [litOp(parseExpr(stripHash(one(), false)))];
    case 'PUSH': return [litOp(parseExpr(stripHash(one(), true, mnem)))];
    case 'SLIT': return [slitOp(parseExpr(stripHash(one(), false)))];
    case 'PUSHQ': return [slitOp(parseExpr(stripHash(one(), true, mnem)))];
    case 'UA': return [uaOp(parseExpr(stripHash(one(), false)))];
    case 'PCREL': return [pcrelOp(parseExpr(one()))];
    case 'LEA': {
      const p = two();
      if (p && p[1].toUpperCase() === 'U') return [uaOp(parseExpr(p[0]))];
      if (p && p[1].toUpperCase() === 'PC') return [pcrelOp(parseExpr(p[0]))];
      throw new LineError(`LEA の書式は LEA n,U か LEA label,PC: ${operand}`);
    }

    // ---- 分岐 ----
    case 'JMP': case 'BRA': return [branchOp(OP.JMP, parseExpr(one()))];
    case 'JZ': case 'BZ': return [branchOp(OP.JZ, parseExpr(one()))];
    case 'CALL': case 'BSR': return [branchOp(OP.CALL, parseExpr(one()))];
    case 'JSR':
      if (operand.replace(/\s/g, '').toUpperCase() !== '(T)') throw new LineError(`JSR の書式は JSR (T): ${operand}`);
      return [plainOp(OP.EXEC)];

    // ---- 即値つきのSYS ----
    case 'CSR@': return [sysOp(SYS['CSR@'], parseExpr(stripHash(one(), false)))];
    case 'MFC': return [sysOp(SYS['CSR@'], parseExpr(one()))];
    case 'CSR!': return [sysOp(SYS['CSR!'], parseExpr(stripHash(one(), false)))];
    case 'MTC': return [sysOp(SYS['CSR!'], parseExpr(one()))];
    case 'SENDM': return [sysOp(SYS.SENDM, parseExpr(stripHash(one(), false)))];
    case 'SEND': return [sysOp(SYS.SENDM, parseExpr(one()))];
    case 'SENDM?': return [sysOp(SYS['SENDM?'], parseExpr(stripHash(one(), false)))];
    case 'TRYSEND': return [sysOp(SYS['SENDM?'], parseExpr(one()))];

    // ---- マクロ（13.3節） ----
    case 'LD': case 'ST': {
      if (ops.length === 0) break; // オペランドなしは普通の LD / ST
      const memOp = plainOp(mnem === 'LD' ? OP['@'] : OP['!']);
      const p = two();
      if (p && p[1].toUpperCase() === 'U') return [uaOp(parseExpr(p[0])), memOp];
      if (p && p[1].toUpperCase() === 'PC') {
        if (mnem === 'ST') throw new LineError('ST label,PC というマクロはない（13.3節）');
        return [pcrelOp(parseExpr(p[0])), memOp];
      }
      if (ops.length !== 1) throw new LineError(`${mnem} の書式が不正: ${operand}`);
      return [litOp(parseExpr(ops[0])), memOp];
    }
    case 'ADD': {
      if (ops.length === 0) break;
      const e = parseExpr(stripHash(one(), true, mnem));
      return [isSmallConst(e) ? slitOp(e) : litOp(e), plainOp(OP['+'])];
    }
    case 'CMP':
      noOperand(mnem, operand);
      return [plainOp(OP['-'])];
    case 'BNZ':
      return [slitOp({ t: 'num', v: 0 }), plainOp(OP['=']), branchOp(OP.JZ, parseExpr(one()))];
  }

  const entry = MNEMONICS.get(mnem);
  if (!entry) throw new LineError(`不明な命令: ${mnem}`);
  noOperand(mnem, operand);
  if (entry.kind === 'op') {
    const o = OPS[entry.code];
    if (o.operand) throw new LineError(`${mnem} にはオペランドが必要`);
    return [plainOp(entry.code)];
  }
  const s = SYS_OPS[entry.code];
  if (s.imm || s.operand) throw new LineError(`${mnem} にはオペランドが必要`);
  return [sysOp(entry.code)];
}

function parseDataItems(operand, unit) {
  const items = splitOperands(operand);
  if (items.length === 0) throw new LineError('データがない');
  const out = [];
  let size = 0;
  for (const s of items) {
    if (s.startsWith('"')) {
      if (unit !== 1) throw new LineError('文字列は DC.B にだけ書ける');
      if (!s.endsWith('"') || s.length < 2) throw new LineError(`文字列が不正: ${s}`);
      const str = s.slice(1, -1);
      const bytes = [];
      for (const ch of str) {
        const c = ch.codePointAt(0);
        if (c > 0x7e || c < 0x20) throw new LineError(`文字列にASCII以外の文字がある: ${ch}`);
        bytes.push(c);
      }
      out.push({ bytes });
      size += bytes.length;
    } else {
      out.push({ expr: parseExpr(s) });
      size += unit;
    }
  }
  return { values: out, size };
}

// ---------------------------------------------------------------- 本体

/**
 * @param {string} source アセンブリのソース
 * @param {{ origin?: number, useSlot6?: boolean, style?: 'reg'|'forth' }} [options]
 *   origin: ORGがないときの開始番地（既定0）
 *   useSlot6: slot6にNOP以外（RET、+、DUP）を詰めるか（既定true）
 *   style: リスティングの逆アセンブル表記（既定 'reg'）
 * @returns {{ bytes: Uint8Array, words: number[], origin: number, symbols: Map<string, number>,
 *             listing: string, warnings: string[] }}
 * @throws {AsmError}
 */
export function assemble(source, options = {}) {
  const useSlot6 = options.useSlot6 ?? true;
  const errors = [];
  const errKeys = new Set();
  const err = (line, message) => {
    const k = `${line}:${message}`;
    if (!errKeys.has(k)) { errKeys.add(k); errors.push({ line, message }); }
  };
  const warnings = [];
  const warn = msg => { if (!warnings.includes(msg)) warnings.push(msg); };
  const lines = source.split(/\r?\n/);

  // ---- 1. 解析 ----
  const stmts = [];
  lines.forEach((raw, idx) => {
    try {
      const st = parseLine(raw);
      st.line = idx + 1;
      stmts.push(st);
    } catch (e) {
      if (!(e instanceof LineError)) throw e;
      err(idx + 1, e.message);
    }
  });

  const equs = new Map();       // name → { expr, line }
  const labelNames = new Set();
  for (const st of stmts) {
    for (const name of [st.label, st.equ?.name]) {
      if (!name) continue;
      if (equs.has(name) || labelNames.has(name)) err(st.line, `名前が重複: ${name}`);
    }
    if (st.label) labelNames.add(st.label);
    if (st.equ) equs.set(st.equ.name, { expr: st.equ.expr, line: st.line });
  }

  // 名前の解決。labels は配置のたびに差し替える
  let labels = new Map();
  const resolving = new Set();
  const resolve = name => {
    if (labels.has(name)) return { value: labels.get(name), rel: true };
    const q = equs.get(name);
    if (q) {
      if (resolving.has(name)) throw new LineError(`EQUが循環している: ${name}`);
      resolving.add(name);
      try { return evalAst(q.expr, resolve); } finally { resolving.delete(name); }
    }
    if (labelNames.has(name)) throw new LineError(`ラベルの番地が未確定: ${name}`);
    throw new LineError(`未定義の名前: ${name}`);
  };
  const evaluate = ast => evalAst(ast, resolve);
  // ラベルを使わずに値が決まるか（ORG、ADD #n の選択）
  const evalConst = ast => {
    const saved = labels;
    labels = new Map();
    try {
      const r = evaluate(ast);
      if (r.rel) throw new LineError('ここではラベルを使えない');
      return r.value;
    } finally { labels = saved; }
  };
  const isSmallConst = ast => {
    try { const v = evalConst(ast); return v >= -16 && v <= 15; } catch { return false; }
  };

  const items = [];
  for (const st of stmts) {
    try {
      if (st.label) items.push({ kind: 'label', name: st.label, line: st.line });
      if (!st.mnem) continue;
      const { mnem, operand } = st;
      if (mnem === 'ORG') {
        needOperand(mnem, operand);
        items.push({ kind: 'org', addr: toU32(evalConst(parseExpr(operand))), line: st.line });
      } else if (mnem === 'DC.B' || mnem === 'DC.L') {
        needOperand(mnem, operand);
        const unit = mnem === 'DC.B' ? 1 : 4;
        const { values, size } = parseDataItems(operand, unit);
        items.push({ kind: 'data', unit, values, size, align: unit === 4, line: st.line });
      } else if (mnem === 'EQU') {
        throw new LineError('EQUに名前がない');
      } else {
        for (const it of expandInstruction(mnem, operand, isSmallConst)) {
          it.line = st.line;
          items.push(it);
        }
      }
    } catch (e) {
      if (!(e instanceof LineError)) throw e;
      err(st.line, e.message);
    }
  }
  // ラベルの境界：直後の項目が DC.B なら揃えない
  items.forEach((it, i) => {
    if (it.kind !== 'label') return;
    let j = i + 1;
    while (items[j]?.kind === 'label') j++;
    const next = items[j];
    it.align = !(next && next.kind === 'data' && next.unit === 1);
  });
  items.forEach((it, i) => { it.id = i; });

  if (errors.length) throw new AsmError(errors);

  // ---- 2. 配置 ----
  const origin = toU32(options.origin ?? 0);
  const forced = new Set();   // 次の語のslot0へ移す分岐（項目のid）
  let L;
  for (let iter = 0; ; iter++) {
    if (iter > items.length + 2) throw new Error('内部エラー: 分岐の配置が収束しない');
    L = layout(items, forced, origin, useSlot6, err);
    labels = L.labels;
    let changed = false;
    for (const w of L.words) {
      if (!w.branch) continue;
      const b = w.branch;
      let target;
      try { target = evaluate(b.expr).value; } catch (e) {
        if (!(e instanceof LineError)) throw e;
        err(b.line, e.message);
        continue;
      }
      // 分岐先の計算は32bitで一周しない（T-03）。番地どうしの実際の差を使う
      const diff = toU32(target) - w.addr;
      if (diff % 4 !== 0) { err(b.line, `分岐先が4バイト境界にない: ${hex8(toU32(target))}`); continue; }
      const offset = diff / 4;
      b.offset = offset;
      if (!fitsSigned(offset, slotShift(b.slot))) {
        if (b.slot === 0) { err(b.line, '分岐先が遠すぎて届かない'); continue; }
        forced.add(b.id);
        changed = true;
      }
    }
    if (errors.length) throw new AsmError(errors);
    if (!changed) break;
  }

  // ---- 3. 出力 ----
  const size = align4(L.end - L.start);
  const bytes = new Uint8Array(size);
  const put32 = (addr, v) => {
    const o = addr - L.start;
    v = toU32(v);
    bytes[o] = v & 0xff; bytes[o + 1] = (v >>> 8) & 0xff; bytes[o + 2] = (v >>> 16) & 0xff; bytes[o + 3] = v >>> 24;
  };
  const evalAt = (line, ast) => {
    try { return evaluate(ast); } catch (e) {
      if (!(e instanceof LineError)) throw e;
      err(line, e.message);
      return { value: 0, rel: false };
    }
  };

  for (const w of L.words) {
    let word = 0;
    w.slots.forEach((s, i) => {
      let v = s.v;
      if (typeof v === 'object') {
        const r = evalAt(s.line, v.expr).value;
        if (r < v.min || r > v.max) err(s.line, `${v.what}が範囲外（${v.min}〜${v.max}）: ${r}`);
        v = r & 0x1f;
      }
      word |= v << slotShift(i);
    });
    word |= w.slot6;
    if (w.branch) {
      const bits = slotShift(w.branch.slot);
      word |= (w.branch.op << bits) | (w.branch.offset & ((1 << bits) - 1));
    }
    w.word = toU32(word);
    put32(w.addr, w.word);
    w.litValues = w.lits.map((lit, k) => {
      const litAddr = w.addr + 4 * (k + 1);
      const r = evalAt(lit.line, lit.expr);
      let v;
      if (lit.pcrel) {
        v = toU32(r.value - litAddr);
      } else {
        if (r.value < -(2 ** 31) || r.value >= 2 ** 32) err(lit.line, `定数が32bitに収まらない: ${r.value}`);
        if (r.rel) warn(`${lit.line}行: モジュール内の番地をLITで埋め込んでいる（PCRELを使う。13.2節）`);
        v = toU32(r.value);
      }
      put32(litAddr, v);
      return v;
    });
  }
  for (const d of L.datas) {
    let a = d.addr - L.start;
    for (const val of d.item.values) {
      if (val.bytes) { bytes.set(val.bytes, a); a += val.bytes.length; continue; }
      const v = evalAt(d.item.line, val.expr).value;
      if (d.item.unit === 1) {
        if (v < -128 || v > 255) err(d.item.line, `DC.B の値が8bitに収まらない: ${v}`);
        bytes[a++] = v & 0xff;
      } else {
        if (v < -(2 ** 31) || v >= 2 ** 32) err(d.item.line, `DC.L の値が32bitに収まらない: ${v}`);
        put32(L.start + a, v);
        a += 4;
      }
    }
  }
  if (errors.length) throw new AsmError(errors);

  // 自己検査：すべての命令語が配置の規則を満たし、定数語の数が合っていること
  for (const w of L.words) {
    const dec = decodeWord(w.word);
    if (dec.fault || dec.litCount !== w.lits.length) {
      throw new Error(`内部エラー: ${hex8(w.addr)} の命令語 ${hex8(w.word)} が不正（${JSON.stringify(dec.fault)}、定数語${dec.litCount}/${w.lits.length}）`);
    }
  }

  const words = [];
  for (let o = 0; o < size; o += 4) {
    words.push((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0);
  }
  const symbols = new Map(labels);
  for (const [name, q] of equs) symbols.set(name, toU32(evalAt(q.line, { t: 'sym', name }).value));
  if (errors.length) throw new AsmError(errors);

  return {
    bytes, words, origin: L.start, symbols, warnings,
    listing: makeListing(L, lines, bytes, options.style ?? 'reg'),
  };
}

/** 配置：語・定数語・データの番地を決める */
function layout(items, forced, origin, useSlot6, err) {
  const labels = new Map();
  const words = [];
  const datas = [];
  let pc = origin;
  let start = null;
  let cur = null;

  const mark = () => { if (start === null) start = pc; };
  const open = () => {
    if (cur) return;
    pc = align4(pc);
    mark();
    cur = { addr: pc, slots: [], slot6: 0, lits: [], branch: null, lines: [] };
  };
  const flush = () => {
    if (!cur) return;
    pc = cur.addr + 4 * (1 + cur.lits.length);
    words.push(cur);
    cur = null;
  };
  const addLine = line => { if (!cur.lines.includes(line)) cur.lines.push(line); };

  for (const it of items) {
    switch (it.kind) {
      case 'label':
        flush();
        if (it.align) pc = align4(pc);
        labels.set(it.name, pc);
        break;
      case 'org':
        flush();
        if (start !== null && it.addr < pc) err(it.line, `ORGで番地が戻っている（重なり）: ${hex8(it.addr)}`);
        pc = it.addr;
        break;
      case 'data':
        flush();
        if (it.align) pc = align4(pc);
        mark();
        datas.push({ addr: pc, item: it });
        pc += it.size;
        break;
      case 'inst':
        if (it.branch) {
          open();
          if (cur.slots.length >= NUM_SLOTS || (forced.has(it.id) && cur.slots.length > 0)) { flush(); open(); }
          cur.branch = { slot: cur.slots.length, op: it.branch.op, expr: it.branch.expr, id: it.id, line: it.line };
          addLine(it.line);
          flush();
          break;
        }
        if (useSlot6 && cur && cur.slots.length === NUM_SLOTS && it.slot6 !== undefined) {
          cur.slot6 = it.slot6;
          addLine(it.line);
          flush();
          break;
        }
        open();
        if (cur.slots.length + it.slots.length > NUM_SLOTS) { flush(); open(); }
        for (const s of it.slots) cur.slots.push({ v: s, line: it.line });
        if (it.lit) cur.lits.push({ ...it.lit, line: it.line });
        addLine(it.line);
        if (it.last || it.ends) flush();
        break;
    }
  }
  flush();
  if (start === null) start = pc;
  return { labels, words, datas, start, end: Math.max(pc, start) };
}

/** リスティング：番地、内容、逆アセンブル、ソース */
function makeListing(L, lines, bytes, style) {
  const rows = [];
  for (const w of L.words) {
    const d = disassembleWord(w.word, { style, addr: w.addr, lits: w.litValues });
    rows.push({ addr: w.addr, text: `${hex8(w.addr)}  ${hex8(w.word)}  ${d.text}`, lines: w.lines });
    w.litValues.forEach((v, k) => rows.push({ addr: w.addr + 4 * (k + 1), text: `${hex8(w.addr + 4 * (k + 1))}  ${hex8(v)}    （定数語）`, lines: [] }));
  }
  for (const d of L.datas) {
    const o = d.addr - L.start;
    const shown = Array.from(bytes.subarray(o, o + Math.min(d.item.size, 8)), b => b.toString(16).toUpperCase().padStart(2, '0'));
    const more = d.item.size > 8 ? ' …' : '';
    rows.push({ addr: d.addr, text: `${hex8(d.addr)}  ${shown.join(' ')}${more}  （${d.item.unit === 1 ? 'DC.B' : 'DC.L'} ${d.item.size}バイト）`, lines: [d.item.line] });
  }
  rows.sort((a, b) => a.addr - b.addr);
  const out = [];
  for (const r of rows) {
    out.push(r.text);
    for (const ln of r.lines) out.push(`                    ${String(ln).padStart(4)}| ${lines[ln - 1].trim()}`);
  }
  return out.join('\n') + '\n';
}

/** 32bit語の配列を $readmemh 形式のテキストにする */
export function toReadmemh(words) {
  return words.map(w => (w >>> 0).toString(16).padStart(8, '0')).join('\n') + '\n';
}
