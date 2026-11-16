// 画面のHTMLの組み立て（ui/views.js、DOM非依存）のテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Session, parseProgram } from '../ui/session.js';
import * as V from '../ui/views.js';

const ROM_SRC = readFileSync(new URL('../rom/boot.asm', import.meta.url), 'utf8');
const ui = () => ({ selected: 0, pinned: new Set([1]), style: 'reg', offsets: new Map() });

test('esc', () => assert.equal(V.esc('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;'));

test('スレッドの一覧：9Kは8行、20Kはコアの見出しと16行', () => {
  const s = new Session(ROM_SRC);
  let html = V.threadListHTML(s, ui());
  assert.equal((html.match(/<tr class="row/g) ?? []).length, 8);
  assert.match(html, /リセット直後/);
  s.setConfig('20K');
  html = V.threadListHTML(s, ui());
  assert.equal((html.match(/<tr class="row/g) ?? []).length, 16);
  assert.match(html, /コア1/);
});

test('詳細の列：選んだスレッドと固定したスレッド。逆アセンブル・スタック・情報', () => {
  const s = new Session(ROM_SRC);
  s.load(parseProgram('t.asm', 'start: PUSHQ #5\nPUSHQ #6\nl: BRA l'), { boot: 'direct' });
  s.takeSnapshot();
  s.dbg.run({ maxCycles: 200 });              // 最後の BRA l で回り続ける
  const u = ui();
  const html = V.detailsHTML(s, u);
  assert.equal((html.match(/class="col /g) ?? []).length, 2);
  assert.match(html, /tid 00/);
  assert.match(html, /tid 01/);
  assert.match(html, /class="dlabel">l:/);
  assert.match(html, /00000006/);
  assert.match(html, /sitem changed/);        // 5・6 は増えた
  assert.match(html, /<span class="k">UP<\/span><span class="v">/);   // UPは変わらない
  // スレッドの一覧：tid 0 の D と T が変わった
  assert.match(V.threadListHTML(s, u), /<td class="mono chg">2<\/td>\s*<td class="mono">0<\/td>\s*<td class="mono chg">00000006<\/td>/);
  assert.match(html, /データスタック/);
});

test('格子：全スレッドの枠', () => {
  const s = new Session(ROM_SRC);
  assert.equal((V.gridHTML(s, ui()).match(/class="card/g) ?? []).length, 8);
});

test('CSR・メールボックス・メモリ・BP・止まった理由', () => {
  const s = new Session(ROM_SRC);
  const th = s.m.thread(0);
  assert.match(V.csrHTML(s, th), /VBR/);
  assert.match(V.mboxHTML(s, th), /（空）/);
  assert.match(V.memoryHTML(s, 0xFFFF0000, 4), /FFFF0000/);
  s.breakpoints.add(0xFFFF0000);
  s.exceptionBreaks.add(11);
  const bp = V.bpHTML(s);
  assert.match(bp, /reset/);
  assert.match(bp, /data-exc="11" checked/);
  assert.equal(V.reasonText({ type: 'breakpoint', addr: 0x100000, tid: 1 }), 'ブレークポイント 00100000（tid 01）');
});

test('変わった箇所の強調：メモリ（書き込んだ語・バイト）、CSR、スレッドの一覧', () => {
  const s = new Session(ROM_SRC);
  s.load(parseProgram('t.asm', [
    'start: PUSH #$12345678', 'ST $00104000', 'PUSHQ #7', 'PUSH #$00104009', 'STB', 'l: BRA l',
  ].join('\n')), { boot: 'direct' });
  let html = V.memoryHTML(s, 0x00104000, 4);
  assert.doesNotMatch(html, /class="chg"/);              // まだ何も書いていない
  s.takeSnapshot();
  s.dbg.run({ maxCycles: 2000 });            // 最後の BRA l で回り続ける
  assert.equal(s.isWritten(0x00104000), true);
  assert.equal(s.isWritten(0x00104008, 4), true);       // 語の中の1バイトでも書けば、語として強調
  assert.equal(s.isWritten(0x00104009, 1), true);
  assert.equal(s.isWritten(0x00104008, 1), false);
  assert.equal(s.isWritten(0x00104004), false);
  html = V.memoryHTML(s, 0x00104000, 4);
  assert.match(html, /<td class="chg">12345678<\/td><td class="">00000000<\/td><td class="chg">00000700<\/td>/);
  assert.match(V.memoryHTML(s, 0x00104000, 1), /<td class="">00<\/td><td class="chg">07<\/td>/);
  // CSR：命令数（INSTRET）は変わる。VBRは変わらない
  const csr = V.csrHTML(s, s.m.thread(0));
  assert.match(csr, /INSTRET_LO<\/td><td class="mono chg">/);
  assert.match(csr, /VBR<\/td><td class="mono">/);
  // 覚え直すと、強調は消える
  s.takeSnapshot();
  assert.doesNotMatch(V.memoryHTML(s, 0x00104000, 4), /class="chg"/);
  assert.doesNotMatch(V.csrHTML(s, s.m.thread(0)), /chg/);
});

test('変わった箇所の強調：書き込みのブレークポイントと両立する', () => {
  const s = new Session(ROM_SRC);
  s.load(parseProgram('t.asm', 'start: PUSHQ #1\nST $00104000\nl: BRA l'), { boot: 'direct' });
  s.watches.add(0x00104000);
  s.takeSnapshot();
  const r = s.dbg.run({ maxCycles: 1000 });
  assert.equal(r.type, 'watch');
  assert.equal(s.isWritten(0x00104000), true);
});

test('変わった箇所の強調：メールボックスに届いた語', () => {
  const s = new Session(ROM_SRC);
  const th = s.m.thread(1);
  th.mbox.push(0x00000001, 0xAA);           // ヘッダ（1語）＋本文
  s.takeSnapshot();
  assert.equal(s.mailboxArrived(th), 0);
  th.mbox.shift(); th.mbox.shift();         // 取り出して
  th.mbox.push(0x00000000);                 // 新しいヘッダ（0語）が届く
  assert.equal(s.mailboxArrived(th), 1);
  const html = V.mboxHTML(s, th);
  assert.match(html, /<tr class="chg"><td class="mono">00000000/);
  th.mbox.push(0x00000000);
  assert.equal(s.mailboxArrived(th), 2);
  s.takeSnapshot();
  assert.doesNotMatch(V.mboxHTML(s, th), /class="chg"/);
});
