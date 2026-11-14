// 画面のHTMLの組み立て（ui/views.js、DOM非依存）のテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Session, parseProgram } from '../ui/session.js';
import * as V from '../ui/views.js';

const ROM_SRC = readFileSync(new URL('../rom/boot.asm', import.meta.url), 'utf8');
const ui = () => ({ selected: 0, pinned: new Set([1]), style: 'reg', offsets: new Map(), prev: new Map() });

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
  s.dbg.stepWord(0);
  const u = ui();
  u.prev.set(0, { ds: [5], rs: [] });
  const html = V.detailsHTML(s, u);
  assert.equal((html.match(/class="col /g) ?? []).length, 2);
  assert.match(html, /tid 00/);
  assert.match(html, /tid 01/);
  assert.match(html, /class="dlabel">l:/);
  assert.match(html, /00000006/);
  assert.match(html, /sitem changed/);        // 6 は増えた
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
