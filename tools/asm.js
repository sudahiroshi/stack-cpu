#!/usr/bin/env node
// アセンブラのコマンドライン
// 使い方: node tools/asm.js input.asm [-o output.bin] [--hex output.hex] [--list output.lst]
//                                     [--origin addr] [--forth] [--no-slot6]
//   出力の指定がなければリスティングを標準出力に出す。
import { readFileSync, writeFileSync } from 'node:fs';
import { assemble, toReadmemh, AsmError } from '../asm/assembler.js';

const USAGE = '使い方: node tools/asm.js input.asm [-o output.bin] [--hex output.hex] [--list output.lst] [--origin addr] [--forth] [--no-slot6]';
const args = process.argv.slice(2);
const withValue = new Set(['-o', '--hex', '--list', '--origin']);
const opts = {};
let input;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (withValue.has(a)) {
    if (i + 1 >= args.length) { console.error(`${a} に値がない\n${USAGE}`); process.exit(1); }
    opts[a] = args[++i];
  } else if (a === '--forth' || a === '--no-slot6') {
    opts[a] = true;
  } else if (a.startsWith('-')) {
    console.error(`不明なオプション: ${a}\n${USAGE}`); process.exit(1);
  } else {
    input = a;
  }
}
if (!input) { console.error(USAGE); process.exit(1); }

const parseNum = s => (s.startsWith('$') ? parseInt(s.slice(1), 16) : Number(s));
let result;
try {
  result = assemble(readFileSync(input, 'utf8'), {
    origin: opts['--origin'] !== undefined ? parseNum(opts['--origin']) : undefined,
    style: opts['--forth'] ? 'forth' : 'reg',
    useSlot6: !opts['--no-slot6'],
  });
} catch (e) {
  if (e instanceof AsmError) {
    for (const x of e.errors) console.error(`${input}:${x.line ?? 0}: エラー: ${x.message}`);
    process.exit(1);
  }
  throw e;
}
for (const w of result.warnings) console.error(`${input}: 警告: ${w}`);

if (opts['-o']) writeFileSync(opts['-o'], result.bytes);
if (opts['--hex']) writeFileSync(opts['--hex'], toReadmemh(result.words));
if (opts['--list']) writeFileSync(opts['--list'], result.listing);
if (!opts['-o'] && !opts['--hex'] && !opts['--list']) process.stdout.write(result.listing);
else console.error(`${input}: ${result.bytes.length}バイト（開始番地 $${result.origin.toString(16).toUpperCase()}）`);
