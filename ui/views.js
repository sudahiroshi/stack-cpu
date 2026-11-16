// 各パネルのHTMLを作る（docs/ui.md 4章・8章）。DOMは触らず、文字列を返すだけ（Node.jsでもテストできる）。
import { hex8, hex, STATE_NAMES, EXC_NAMES } from './session.js';

/** HTMLの特別な文字を置き換える */
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const tidText = tid => hex(tid, 2);

/**
 * 画面の表示の状態（ui/main.js が持つ）
 * @typedef {{ selected: number, pinned: Set<number>, style: 'reg'|'forth', offsets: Map<number, number> }} UiState
 *
 * 変わった箇所の強調：Session.takeSnapshot（ステップ・実行を始めたとき）の状態と比べ、変わった値に class="chg" を付ける。
 */

/** 変わっていれば ' chg'（class に足す） */
const chg = changed => (changed ? ' chg' : '');

/** スレッドの一覧（docs/ui.md 4.1節） */
export function threadListHTML(s, ui) {
  const rows = [];
  const multiCore = s.m.cfg.ncores > 1;
  for (const core of s.m.cores) {
    if (multiCore) rows.push(`<tr class="core"><td colspan="7">コア${core.id}</td></tr>`);
    for (const th of core.threads) {
      const t = s.threadSummary(th);
      const p = s.prev.get(t.tid)?.summary;
      const cls = ['row', t.tid === ui.selected ? 'selected' : ''].join(' ');
      const pinned = ui.pinned.has(t.tid);
      rows.push(`<tr class="${cls}" data-tid="${t.tid}">
        <td><button class="pin ${pinned ? 'on' : ''}" data-act="pin" data-tid="${t.tid}" title="詳細の列に固定">${pinned ? '★' : '☆'}</button></td>
        <td class="mono">${tidText(t.tid)}</td>
        <td class="${chg(p && p.state !== t.state).trim()}"><span class="st st-${t.state}" title="${t.mode}モード">${esc(t.stateName)}</span>${t.mode === '一般' ? '<span class="umode" title="一般モード">U</span>' : ''}</td>
        <td class="mono">${hex8(t.pc)}:${t.slot}</td>
        <td class="mono${chg(p && p.depth !== t.depth)}">${t.depth}</td>
        <td class="mono${chg(p && p.rdepth !== t.rdepth)}">${t.rdepth}</td>
        <td class="mono${chg(p && p.T !== t.T)}">${t.T === null ? '—' : hex8(t.T)}</td>
      </tr>`);
    }
  }
  return `<table class="thread-table">
    <thead><tr><th></th><th>tid</th><th>状態</th><th>PC:スロット</th><th title="データスタックの深さ">D</th><th title="リターンスタックの深さ">R</th><th>T</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>`;
}

/** 逆アセンブルの行（詳細の列と格子で共通） */
function disasmRowsHTML(rows) {
  return rows.map(r => {
    const label = r.label ? `<div class="dlabel">${esc(r.label)}:</div>` : '';
    const cls = ['drow', r.kind, r.current ? 'cur' : '', r.bp ? 'bp' : ''].join(' ');
    let ins;
    if (r.kind === 'inst') {
      ins = r.parts.map(p => `<span class="${p.current ? 'now' : ''}">${esc(p.text)}</span>`).join('');
      if (r.source?.length) ins += `<span class="dsrc">; ${esc(r.source.join(' / '))}</span>`;
    } else if (r.kind === 'lit') {
      ins = '<span>（定数語）</span>';
    } else if (r.kind === 'data') {
      ins = `<span>（データ）</span>${r.source?.length ? `<span class="dsrc">; ${esc(r.source.join(' / '))}</span>` : ''}`;
    } else {
      ins = '<span>—</span>';
    }
    const hexText = r.word === null ? '--------' : hex8(r.word);
    const tip = [r.parts.map(p => p.text).join('  '), r.source?.join(' / ')].filter(Boolean).join('\n');
    return `${label}<div class="${cls}" data-addr="${r.addr}" title="${esc(tip)}"><span class="gut" data-act="bp" data-addr="${r.addr}" title="ブレークポイント"></span><span class="addr">${hex8(r.addr)}</span><span class="hex">${hexText}</span><span class="ins">${ins}</span></div>`;
  }).join('');
}

/** スタック（上がT。直前のステップから変わった値を強調。リターンスタックのレッドゾーンは色を変える） */
function stackHTML(title, items, cap, prev, redFrom = Infinity) {
  const depth = items.length;
  const pct = Math.min(100, Math.round((depth / cap) * 100));
  const names = ['T', 'N'];
  let body = '';
  for (let i = depth - 1; i >= 0; i--) {
    const fromTop = depth - 1 - i;
    const changed = prev && prev[i] !== items[i];
    const cls = ['sitem', changed ? 'changed' : '', i >= redFrom ? 'red' : ''].join(' ');
    body += `<div class="${cls}"><span class="k">${names[fromTop] ?? fromTop + 1}</span><span class="v">${hex8(items[i])}</span></div>`;
  }
  if (!depth) body = '<div class="sempty">（空）</div>';
  return `<div class="stack"><h3><span>${title}</span><span>${depth}/${cap}</span></h3>
    <div class="bar ${depth > cap ? 'full' : ''}"><i style="width:${pct}%"></i></div><div class="sitems">${body}</div></div>`;
}

/** 実行中の語の番地（詳細と格子の中央） */
const currentWord = th => (th.dec ? th.wordAddr : th.pc) >>> 0;

/** 詳細の列（docs/ui.md 4.1節） */
export function detailColumnHTML(s, th, ui, { lines = ui.lines ?? 22 } = {}) {
  const t = s.threadSummary(th);
  const off = ui.offsets.get(th.tid) ?? 0;
  const before = Math.floor(lines / 3);
  const rows = s.disasmWindow(currentWord(th) + off * 4, { before, after: lines - before - 1, style: ui.style, th });
  const prev = s.prev.get(th.tid);
  const evpend = s.m.pendingEvents(th) >>> 0;
  const last = th.lastException;
  const mb = th.mbox.length;
  const canClose = ui.pinned.has(th.tid) && th.tid !== ui.selected;
  return `<div class="col ${th.tid === ui.selected ? 'selected' : ''}" data-tid="${th.tid}">
    <div class="col-head"><b class="mono">tid ${tidText(th.tid)}</b><span class="st st-${t.state}">${esc(t.stateName)}</span><span>${t.mode}</span>
      <span class="grow"></span>
      ${off ? `<button data-act="follow" data-tid="${th.tid}" title="実行中の語に戻る">追う</button>` : ''}
      ${canClose ? `<button data-act="unpin" data-tid="${th.tid}" title="列を閉じる">×</button>` : ''}</div>
    <div class="disasm" data-tid="${th.tid}">${disasmRowsHTML(rows)}</div>
    <div class="stacks">
      ${stackHTML('データスタック', th.dataStack(), th.dcap, prev?.ds)}
      ${stackHTML('リターンスタック', th.returnStack(), th.rcap, prev?.rs, th.rcap)}
    </div>
    <div class="info">
      <span class="k">UP</span><span class="v${chg(prev && prev.up !== th.up >>> 0)}">${hex8(th.up)}</span>
      <span class="k">EVPEND</span><span class="v${chg(prev && prev.evpend !== evpend)}">${hex8(evpend)}</span>
      <span class="k">メールボックス</span><span class="v${chg(prev && prev.mbox.length !== mb)}">${mb}語</span>
      <span class="k">命令数</span><span class="v">${th.instret}</span>
      <span class="k">最後の例外</span><span class="v${chg(prev && prev.lastException !== last)}" style="grid-column: span 3">${last ? `${last.exc} ${esc(EXC_NAMES[last.exc] ?? '')}（EPC ${hex8(last.epc)}、EADDR ${hex8(last.eaddr)}）` : '—'}</span>
    </div>
  </div>`;
}

/** 詳細の列をすべて（選んでいるスレッドが先頭、続いて固定したスレッド） */
export function detailsHTML(s, ui) {
  const tids = [ui.selected, ...[...ui.pinned].filter(t => t !== ui.selected)].slice(0, 4);
  return tids.map(tid => s.m.findThread(tid)).filter(Boolean).map(th => detailColumnHTML(s, th, ui)).join('');
}

/** 全スレッドの格子（docs/ui.md 4.2節） */
export function gridHTML(s, ui) {
  const parts = [];
  for (const core of s.m.cores) {
    if (s.m.cfg.ncores > 1) parts.push(`<h3>コア${core.id}</h3>`);
    for (const th of core.threads) {
      const t = s.threadSummary(th);
      const rows = s.disasmWindow(currentWord(th), { before: 0, after: 3, style: ui.style, th });
      const dis = rows.map(r => {
        const text = r.kind === 'inst' ? r.parts.map(p => p.text).join('  ') : (r.kind === 'lit' ? '（定数語）' : '');
        return `<div class="${r.current ? 'cur' : ''}">${hex(r.addr & 0xffff, 4)} ${esc(text)}</div>`;
      }).join('');
      const ds = th.dataStack();
      const top = ds.slice(-4).reverse().map(hex8).join(' ') || '（空）';
      const pct = Math.min(100, Math.round((ds.length / th.dcap) * 100));
      parts.push(`<div class="card ${t.tid === ui.selected ? 'selected' : ''}" data-tid="${t.tid}">
        <div class="ch"><b class="mono">tid ${tidText(t.tid)}</b><span class="st st-${t.state}">${esc(t.stateName)}</span></div>
        <div class="mono hint">${hex8(t.pc)}:${t.slot}  D ${t.depth}/${t.dcap}  R ${t.rdepth}/${t.rcap}</div>
        <div class="cd">${dis}</div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="cs">${top}</div>
      </div>`);
    }
  }
  return parts.join('');
}

/** CSR（選んだスレッド） */
export function csrHTML(s, th) {
  const prev = s.prev.get(th.tid)?.csr;
  const rows = s.csrList(th).map((c, i) => {
    const ch = chg(prev && prev[i] !== c.value);
    return `<tr><td class="mono">${c.n}</td><td>${c.name}</td><td class="mono${ch}">${hex8(c.value)}</td><td class="mono hint${ch}">${c.value}</td></tr>`;
  }).join('');
  return `<p class="hint">tid ${tidText(th.tid)}</p><table><thead><tr><th>番号</th><th>名前</th><th>値</th><th>10進</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** メールボックス（選んだスレッド） */
export function mboxHTML(s, th) {
  const v = s.mailboxView(th);
  const p = s.prev.get(th.tid);
  const firstNew = v.items.length - s.mailboxArrived(th);   // これ以後が、覚えてから届いた語
  const rows = v.items.map((i, k) => {
    const cls = chg(k >= firstNew).trim();
    return i.header
      ? `<tr class="${cls}"><td class="mono">${hex8(i.word)}</td><td>ヘッダ：送信元 tid ${tidText(i.src)}、tag ${hex(i.tag, 4)}、${i.n}語</td></tr>`
      : `<tr class="${cls}"><td class="mono">${hex8(i.word)}</td><td class="hint">本文</td></tr>`;
  }).join('');
  const waitChanged = p && p.waiting.join() !== v.waiting.join();
  return `<p class="hint">tid ${tidText(th.tid)} の受信FIFO（<span class="${chg(p && p.mbox.length !== th.mbox.length).trim()}">${th.mbox.length}</span>/${s.m.cfg.mboxDepth}語）</p>
    ${rows ? `<table><tbody>${rows}</tbody></table>` : '<p class="hint">（空）</p>'}
    <p class="hint">このスレッドへの送信を待っているスレッド：<span class="${chg(waitChanged).trim()}">${v.waiting.length ? v.waiting.map(tidText).join('、') : 'なし'}</span></p>`;
}

/** メモリのダンプ */
export function memoryHTML(s, addr, unit) {
  const rows = s.memoryRows(addr, { rows: 16, perRow: unit === 4 ? 4 : 16, unit });
  const cell = v => (v === null ? (unit === 4 ? '--------' : '--') : unit === 4 ? hex8(v) : hex(v, 2));
  const body = rows.map(r => {
    const label = s.labelAt.get(r.addr);
    const cells = r.values.map((v, k) => {
      const a = (r.addr + k * unit) >>> 0;
      return `<td class="${chg(v !== null && s.isWritten(a, unit)).trim()}">${cell(v)}</td>`;
    }).join('');
    return `<tr><td class="a">${hex8(r.addr)}</td>${cells}<td class="hint">${label ? esc(label) : ''}</td></tr>`;
  }).join('');
  return `<table class="memtable"><tbody>${body}</tbody></table>`;
}

/** ブレークポイントの一覧と設定（docs/ui.md 7章） */
export function bpHTML(s) {
  const addrRows = [...s.breakpoints].sort((a, b) => a - b).map(a =>
    `<div class="row"><span class="mono">${hex8(a)}</span><span class="hint">${esc(s.labelAt.get(a) ?? '')}</span><button data-act="bp-del" data-addr="${a}">削除</button></div>`).join('') || '<p class="hint">（なし。逆アセンブルの行の左端をクリックしても置けます）</p>';
  const watchRows = [...s.watches].sort((a, b) => a - b).map(a =>
    `<div class="row"><span class="mono">${hex8(a)}</span><button data-act="watch-del" data-addr="${a}">削除</button></div>`).join('') || '<p class="hint">（なし）</p>';
  const exc = EXC_NAMES.map((name, n) =>
    `<label><input type="checkbox" data-act="exc" data-exc="${n}" ${s.exceptionBreaks.has(n) ? 'checked' : ''}> ${n} ${esc(name)}</label>`).join('');
  return `<div class="bp-section"><h2>命令語の番地（全スレッド）</h2>${addrRows}
      <div class="row"><input id="bp-new" placeholder="番地（16進）" size="10"><button data-act="bp-add">追加</button></div></div>
    <div class="bp-section"><h2>メモリへの書き込み（4バイト単位）</h2>${watchRows}
      <div class="row"><input id="watch-new" placeholder="番地（16進）" size="10"><button data-act="watch-add">追加</button></div></div>
    <div class="bp-section"><h2>例外が起きたら止める</h2><div class="exc-grid">${exc}</div></div>`;
}

/** 止まった理由の文 */
export function reasonText(r) {
  if (!r) return '';
  switch (r.type) {
    case 'breakpoint': return `ブレークポイント ${hex8(r.addr)}（tid ${tidText(r.tid)}）`;
    case 'exception': return `例外 ${r.exc} ${EXC_NAMES[r.exc] ?? ''}（tid ${tidText(r.tid)}）`;
    case 'watch': return `書き込み ${hex8(r.writeAddr)}（${r.size}バイト、tid ${tidText(r.tid)}）`;
    case 'step': return 'ステップの終わり';
    case 'stopped': return 'すべてのスレッドが停止';
    case 'timeout': return `ステップが終わりません（tid ${tidText(r.tid)} が進まない）`;
    case 'limit': return '';
  }
  return r.type;
}

export { STATE_NAMES };
