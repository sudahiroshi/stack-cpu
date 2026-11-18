// シミュレータの画面の入口（docs/ui.md）。DOMを触るのは ui/ だけ。
// 状態と表示用のデータは ui/session.js、HTMLの組み立ては ui/views.js が受け持つ。
import { Session, parseProgram, hex8, EXC_NAMES, DEFAULT_LOAD_ADDR, DEFAULT_DIRECT_UP } from './session.js';
import * as V from './views.js';
import { AsmError } from '../asm/assembler.js';
import { JOY_BIT } from '../sim/devices/registers.js';

const $ = id => document.getElementById(id);

// ---------------------------------------------------------------- 表示の設定（ブラウザに覚えさせる）
const SETTINGS_KEY = 'stack-cpu-ui';
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {}; } catch { return {}; }
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      style: ui.style, view: ui.view, speed: ui.speed, slowRate: ui.slowRate, scale: ui.scale, config: session.config,
    }));
  } catch { /* 保存できなくても動く */ }
}
const saved = loadSettings();

/** @type {import('./views.js').UiState & object} */
const ui = {
  selected: 0,
  pinned: new Set(),
  style: saved.style ?? 'reg',
  view: saved.view ?? 'list',
  speed: saved.speed ?? 'real',
  slowRate: saved.slowRate ?? 10,
  scale: saved.scale ?? 'fit',
  offsets: new Map(),   // 詳細の列ごとの逆アセンブルのずらし（語の数。0なら実行中の語を追う）
  running: false,
  reason: null,
  lagging: false,
  memAddr: DEFAULT_LOAD_ADDR,
  memUnit: 4,
  log: [],
};

let session;
let pendingFile = null;   // 読み込みの画面で選んだファイル { name, data }

// ---------------------------------------------------------------- 起動
async function init() {
  const romSource = await (await fetch('../rom/boot.asm')).text();
  session = new Session(romSource);
  if (saved.config && saved.config !== '9K') session.setConfig(saved.config);
  afterRebuild();
  bindToolbar();
  bindTabs();
  bindPanels();
  bindDevices();
  applySettingsToControls();
  log('ブートROMを組み込みました。「開く…」でプログラムを読み込んでください。');
  render();
}

/** マシンを作り直した後の準備（ログのフック、表示の状態） */
function afterRebuild() {
  const m = session.m;
  const prevHook = m.exceptionHook;
  m.exceptionHook = (th, exc) => {
    prevHook?.(th, exc);
    log(`例外 ${exc} ${EXC_NAMES[exc] ?? ''}（tid ${th.tid.toString(16)}、EPC ${hex8(th.epc)}）`);
  };
  m.uart.onTx = () => { uartDirty = true; };
  m.gpio.joy = joyState;
  ui.offsets.clear();
  ui.reason = null;
  bpDirty = true;
  if (!session.m.findThread(ui.selected)) ui.selected = 0;
  for (const t of [...ui.pinned]) if (!session.m.findThread(t)) ui.pinned.delete(t);
  uartDirty = true;
}

function log(text) {
  ui.log.push(`[${session ? session.m.cycle : 0}] ${text}`);
  if (ui.log.length > 500) ui.log.splice(0, ui.log.length - 500);
  logDirty = true;
}

// ---------------------------------------------------------------- 実行の制御
/** ステップ・実行を始めたときの状態を覚える（変わった箇所の強調用。ui/views.js） */
function snapshot() {
  session.takeSnapshot();
}

function stopWith(r) {
  ui.running = false;
  ui.reason = r;
  ui.lagging = false;
  if (r && r.type !== 'limit' && r.type !== 'step') log(`停止：${V.reasonText(r)}`);
  if (r?.tid !== undefined && r.type !== 'step') ui.selected = r.tid;
  render();
}

function toggleRun() {
  if (ui.running) { stopWith({ type: 'pause' }); return; }
  snapshot();
  ui.running = true;
  ui.reason = null;
  lastFrame = performance.now();
  budget = 0;
  requestAnimationFrame(frame);
  render();
}

function step(kind) {
  if (ui.running) return;
  snapshot();
  const d = session.dbg;
  const tid = ui.selected;
  const r = kind === 'inst' ? d.stepInstruction(tid)
    : kind === 'word' ? d.stepWord(tid)
      : kind === 'over' ? d.stepOver(tid)
        : d.stepCycle();
  ui.offsets.delete(tid);
  stopWith(r);
}

let lastFrame = 0;
let budget = 0;
const FRAME_MS = 14;     // 1フレームで実行に使う時間の上限

function frame(now) {
  if (!ui.running) return;
  const dt = Math.min(100, now - lastFrame);
  lastFrame = now;
  const d = session.dbg;
  const t0 = performance.now();
  let r = null;
  if (ui.speed === 'real') {
    budget += dt * session.m.cfg.clockMHz * 1000;   // 仮想時間＝実時間
    let target = Math.floor(budget);
    while (target > 0) {
      const before = session.m.cycle;
      r = d.run({ maxCycles: Math.min(target, 50_000) });
      const done = session.m.cycle - before;
      budget -= done;
      target -= done;
      if (r.type !== 'limit') break;
      if (performance.now() - t0 > FRAME_MS) break;
      if (done === 0) break;   // 進まなければ（念のため）抜ける
    }
    ui.lagging = budget > session.m.cfg.clockMHz * 1000 * 50;   // 50ms以上遅れている
    if (ui.lagging) budget = 0;
  } else if (ui.speed === 'max') {
    // 時間の上限に加えて回数の上限も付ける（時計が進まない環境でも1フレームで終わるように）
    let n = 0;
    do { r = d.run({ maxCycles: 50_000 }); } while (r.type === 'limit' && performance.now() - t0 < FRAME_MS && ++n < 400);
  } else {
    budget += (dt / 1000) * ui.slowRate;
    const k = Math.floor(budget);
    if (k > 0) {
      budget -= k;
      snapshot();   // ゆっくりのときは、直前に実行した命令で変わった箇所を強調する
      r = d.run({ maxIssues: k, maxCycles: 10_000_000 });
    }
  }
  if (r && r.type !== 'limit') { stopWith(r); return; }
  render();
  requestAnimationFrame(frame);
}

function rebuildAndRender() {
  ui.running = false;
  session.rebuild();
  afterRebuild();
  render();
}

// ---------------------------------------------------------------- 読み込み
function openLoadDialog(file) {
  pendingFile = file;
  const ext = file.name.toLowerCase().split('.').pop();
  const isAsm = ext === 'asm' || ext === 's';
  $('ld-name').textContent = file.name;
  $('ld-kind').textContent = isAsm ? 'アセンブリ' : ext === 'bin' ? 'バイナリ' : '$readmemh';
  $('ld-addr-row').hidden = isAsm;
  $('ld-asm-note').hidden = !isAsm;
  $('ld-addr').value = hex8(session.program?.addr ?? DEFAULT_LOAD_ADDR);
  $('ld-up').value = hex8(DEFAULT_DIRECT_UP);
  showLoadMessage('');
  updateUpRow();
  $('load-dialog').showModal();
}

function showLoadMessage(text, error = false) {
  const el = $('ld-msg');
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle('error', error);
}

function updateUpRow() {
  $('ld-up-row').hidden = document.querySelector('input[name="boot"]:checked').value !== 'direct';
}

function confirmLoad(ev) {
  ev.preventDefault();
  const boot = document.querySelector('input[name="boot"]:checked').value;
  const addr = Session.parseAddress($('ld-addr').value);
  const up = Session.parseAddress($('ld-up').value);
  if (addr === null || (boot === 'direct' && up === null)) { showLoadMessage('番地は16進で入力してください', true); return; }
  let program;
  try {
    program = parseProgram(pendingFile.name, pendingFile.data, { addr });
  } catch (e) {
    const text = e instanceof AsmError ? e.errors.map(x => `${x.line}行: ${x.message}`).join('\n') : e.message;
    showLoadMessage(text, true);
    return;
  }
  if (boot === 'boot' && program.addr !== DEFAULT_LOAD_ADDR) {
    showLoadMessage(`ブートROMから起動するときは 00100000 に置きます（いまは ${hex8(program.addr)}）`, true);
    return;
  }
  ui.running = false;
  session.load(program, { boot, up });
  afterRebuild();
  $('load-dialog').close();
  log(`${program.name} を ${hex8(program.addr)} に読み込みました（${program.bytes.length}バイト、${boot === 'boot' ? 'ブートROMから起動' : 'tid 0 で直接実行'}）`);
  for (const w of program.warnings) log(`警告：${w}`);
  render();
}

async function readFile(file) {
  const isText = /\.(asm|s|hex|mem)$/i.test(file.name);
  const data = isText ? await file.text() : new Uint8Array(await file.arrayBuffer());
  openLoadDialog({ name: file.name, data });
}

// ---------------------------------------------------------------- 操作の結び付け
function bindToolbar() {
  $('btn-open').onclick = () => $('file-input').click();
  $('file-input').onchange = e => { const f = e.target.files[0]; if (f) readFile(f); e.target.value = ''; };
  $('load-form').addEventListener('submit', e => { if (e.submitter?.value === 'ok') confirmLoad(e); });
  document.querySelectorAll('input[name="boot"]').forEach(r => { r.onchange = updateUpRow; });
  $('sel-config').onchange = e => { ui.running = false; session.setConfig(e.target.value); afterRebuild(); saveSettings(); render(); };
  $('btn-reset').onclick = () => { rebuildAndRender(); log('リセットしました'); };
  $('btn-run').onclick = toggleRun;
  $('btn-step-inst').onclick = () => step('inst');
  $('btn-step-word').onclick = () => step('word');
  $('btn-step-over').onclick = () => step('over');
  $('btn-step-cycle').onclick = () => step('cycle');
  $('sel-speed').onchange = e => { ui.speed = e.target.value; budget = 0; applySettingsToControls(); saveSettings(); };
  $('slow-rate').onchange = e => { ui.slowRate = Math.max(1, Math.min(1000, Number(e.target.value) || 10)); saveSettings(); };
  $('sel-style').onchange = e => { ui.style = e.target.value; saveSettings(); render(); };
  $('sel-thread').onchange = e => selectThread(Number(e.target.value));
  $('btn-view-list').onclick = () => { ui.view = 'list'; saveSettings(); applySettingsToControls(); render(); };
  $('btn-view-grid').onclick = () => { ui.view = 'grid'; saveSettings(); applySettingsToControls(); render(); };
  window.addEventListener('keydown', e => {
    if (e.target.closest?.('input, select, textarea, dialog, #uart, #screen')) return;
    if (e.key === 'F5') { e.preventDefault(); toggleRun(); }
    else if (e.key === 'F10') { e.preventDefault(); step('inst'); }
    else if (e.key === 'F11') { e.preventDefault(); step('over'); }
  });
}

function applySettingsToControls() {
  $('sel-style').value = ui.style;
  $('sel-speed').value = ui.speed;
  $('slow-rate').value = ui.slowRate;
  $('slow-rate-label').hidden = ui.speed !== 'slow';
  $('sel-scale').value = ui.scale;
  $('sel-config').value = session.config;
  $('btn-view-list').classList.toggle('on', ui.view === 'list');
  $('btn-view-grid').classList.toggle('on', ui.view === 'grid');
  $('pane-list').hidden = ui.view === 'grid';   // 格子のときは一覧も含めて中央を格子にする
  document.querySelector('.layout').classList.toggle('grid-mode', ui.view === 'grid');
  $('details').hidden = ui.view !== 'list';
  $('grid').hidden = ui.view !== 'grid';
  applyScale();
}

function bindTabs() {
  document.querySelectorAll('.tabs').forEach(tabs => {
    tabs.querySelectorAll('nav button').forEach(btn => {
      btn.onclick = () => {
        tabs.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b === btn));
        tabs.querySelectorAll('.tab-body').forEach(b => { b.hidden = b.dataset.tab !== btn.dataset.tab; });
        bpDirty = true;
        render();
      };
    });
  });
}

function selectThread(tid) {
  ui.selected = tid;
  render();
}

function bindPanels() {
  // 一覧・詳細・格子は、実行中は描画のたびに作り直すので、click（押した要素と離した要素が同じときだけ起きる）は
  // 取りこぼす。押した瞬間に起きる pointerdown で受ける。
  const onPress = (el, fn) => el.addEventListener('pointerdown', e => { if (e.button === 0) fn(e); });
  onPress($('thread-list'), e => {
    const pin = e.target.closest('[data-act="pin"]');
    if (pin) {
      const tid = Number(pin.dataset.tid);
      if (ui.pinned.has(tid)) ui.pinned.delete(tid);
      else if (ui.pinned.size < 3) ui.pinned.add(tid);
      else log('固定できる列は最大4列（選んでいるスレッド＋3）です');
      render();
      return;
    }
    const row = e.target.closest('tr[data-tid]');
    if (row) selectThread(Number(row.dataset.tid));
  });
  onPress($('details'), e => {
    const act = e.target.closest('[data-act]');
    if (act?.dataset.act === 'bp') { session.dbg.toggleBreakpoint(Number(act.dataset.addr)); bpDirty = true; render(); return; }
    if (act?.dataset.act === 'follow') { ui.offsets.delete(Number(act.dataset.tid)); render(); return; }
    if (act?.dataset.act === 'unpin') { ui.pinned.delete(Number(act.dataset.tid)); render(); return; }
    const col = e.target.closest('.col[data-tid]');
    if (col && Number(col.dataset.tid) !== ui.selected) selectThread(Number(col.dataset.tid));
  });
  $('details').addEventListener('wheel', e => {
    const dis = e.target.closest('.disasm[data-tid]');
    if (!dis) return;
    e.preventDefault();
    const tid = Number(dis.dataset.tid);
    ui.offsets.set(tid, (ui.offsets.get(tid) ?? 0) + Math.sign(e.deltaY) * 2);
    render();
  }, { passive: false });
  onPress($('grid'), e => {
    const card = e.target.closest('.card[data-tid]');
    if (!card) return;
    ui.selected = Number(card.dataset.tid);
    ui.view = 'list';
    saveSettings();
    applySettingsToControls();
    render();
  });
  // メールボックスのタブ：「届いたら止める」（表示を作り直しても取りこぼさないよう、押した瞬間に受ける）
  onPress($('mbox'), e => {
    const btn = e.target.closest('[data-act="mail-break"]');
    if (!btn) return;
    session.dbg.toggleMailBreak(Number(btn.dataset.tid));
    bpDirty = true;
    render();
  });
  $('mem-addr').onchange = e => {
    const a = Session.parseAddress(e.target.value);
    if (a !== null) ui.memAddr = a;
    e.target.value = hex8(ui.memAddr);
    render();
  };
  $('mem-unit').onchange = e => { ui.memUnit = Number(e.target.value); render(); };
  $('bp').onclick = e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const addrOf = el => Number(el.closest('[data-addr]').dataset.addr);
    if (act === 'bp-del') session.breakpoints.delete(addrOf(e.target));
    else if (act === 'watch-del') session.watches.delete(addrOf(e.target));
    else if (act === 'bp-add' || act === 'watch-add') {
      const input = $(act === 'bp-add' ? 'bp-new' : 'watch-new');
      const a = Session.parseAddress(input.value);
      if (a === null) { input.select(); return; }
      if (act === 'bp-add') session.breakpoints.add((a & ~3) >>> 0); else session.watches.add((a & ~3) >>> 0);
    } else return;
    bpDirty = true;
    render();
  };
  $('bp').onchange = e => {
    if (e.target.dataset.act === 'mail') {
      const tid = Number(e.target.dataset.tid);
      if (e.target.checked) session.mailBreaks.add(tid); else session.mailBreaks.delete(tid);
      render();
      return;
    }
    if (e.target.dataset.act !== 'exc') return;
    const n = Number(e.target.dataset.exc);
    if (e.target.checked) session.exceptionBreaks.add(n); else session.exceptionBreaks.delete(n);
  };
}

// ---------------------------------------------------------------- デバイス（画面、ジョイパッド、UART）
let joyState = 0;
let bpDirty = true;
let uartDirty = true;
let logDirty = true;
let uartShown = 0;
const JOY_BUTTONS = [
  ['上', JOY_BIT.UP, 'ArrowUp'], ['下', JOY_BIT.DOWN, 'ArrowDown'], ['左', JOY_BIT.LEFT, 'ArrowLeft'], ['右', JOY_BIT.RIGHT, 'ArrowRight'],
  ['A', JOY_BIT.A, 'z'], ['B', JOY_BIT.B, 'x'], ['SELECT', JOY_BIT.SELECT, 'Shift'], ['START', JOY_BIT.START, 'Enter'],
];

function setJoy(bit, down) {
  joyState = down ? joyState | (1 << bit) : joyState & ~(1 << bit);
  session.m.gpio.joy = joyState;
  document.querySelectorAll('#joypad button').forEach(b => b.classList.toggle('down', !!(joyState & (1 << Number(b.dataset.bit)))));
}

function bindDevices() {
  $('joypad').innerHTML = JOY_BUTTONS.map(([label, bit]) => `<button data-bit="${bit}">${label}</button>`).join('');
  $('joypad').querySelectorAll('button').forEach(b => {
    const bit = Number(b.dataset.bit);
    b.onpointerdown = () => setJoy(bit, true);
    b.onpointerup = b.onpointerleave = () => setJoy(bit, false);
  });
  const canvas = $('screen');
  const keyBit = e => JOY_BUTTONS.find(([, , key]) => key.toLowerCase() === e.key.toLowerCase())?.[1];
  canvas.addEventListener('keydown', e => { const bit = keyBit(e); if (bit !== undefined) { e.preventDefault(); setJoy(bit, true); } });
  canvas.addEventListener('keyup', e => { const bit = keyBit(e); if (bit !== undefined) { e.preventDefault(); setJoy(bit, false); } });
  canvas.addEventListener('blur', () => { joyState = 0; session.m.gpio.joy = 0; setJoy(0, false); });
  $('sel-scale').onchange = e => { ui.scale = e.target.value; applyScale(); saveSettings(); };
  const uart = $('uart');
  uart.addEventListener('keydown', e => {
    let code = null;
    if (e.key.length === 1) code = e.key.charCodeAt(0);
    else if (e.key === 'Enter') code = 13;
    else if (e.key === 'Backspace') code = 8;
    else if (e.key === 'Escape') code = 27;
    else if (e.key === 'Tab') code = 9;
    if (code === null || code > 0xff) return;
    e.preventDefault();
    session.m.uart.receive([code]);
  });
  $('btn-uart-clear').onclick = () => { uartShown = session.m.uart.output.length; uart.textContent = ''; };
}

function applyScale() {
  const c = $('screen');
  if (ui.scale === 'fit') { c.style.width = '100%'; c.style.height = 'auto'; }
  else { c.style.width = `${640 * Number(ui.scale)}px`; c.style.height = `${480 * Number(ui.scale)}px`; }
}

let imageData = null;
function drawScreen() {
  const c = $('screen');
  const ctx = c.getContext('2d');
  imageData ??= ctx.createImageData(640, 480);
  session.m.video.renderRGBA(imageData.data);
  ctx.putImageData(imageData, 0, 0);
}

// ---------------------------------------------------------------- 描画
const visible = (group, tab) => !document.querySelector(`.tabs[data-tabs="${group}"] .tab-body[data-tab="${tab}"]`).hidden;

/** 中身が変わったときだけ書き換える（変わらない部分の選択・ホバー・スクロールを保つ） */
const htmlCache = new WeakMap();
function setHTML(el, html) {
  if (htmlCache.get(el) === html) return;
  htmlCache.set(el, html);
  el.innerHTML = html;
}

function render() {
  const m = session.m;
  // ツールバーと状態
  $('btn-run').textContent = ui.running ? '■ 停止' : '▶ 実行';
  $('btn-run').classList.toggle('primary', !ui.running);
  for (const id of ['btn-step-inst', 'btn-step-word', 'btn-step-over', 'btn-step-cycle']) $(id).disabled = ui.running;
  $('st-program').textContent = session.program
    ? `${session.program.name}（${session.config}、${session.program.boot === 'boot' ? 'ブートROMから' : '直接実行'}）`
    : `（プログラムなし、${session.config}）`;
  $('st-cycle').textContent = m.cycle.toLocaleString();
  $('st-time').textContent = m.microseconds.toLocaleString();
  $('st-lag').hidden = !(ui.running && ui.lagging);
  // 動けるスレッドがなく、UARTの受信を待っているだけなら「入力待ち」
  $('st-reason').textContent = ui.running
    ? (m.running ? '実行中…' : '入力を待っています（UART）')
    : (ui.reason?.type === 'pause' ? '一時停止' : V.reasonText(ui.reason));

  // スレッド
  const sel = $('sel-thread');
  setHTML(sel, V.threadOptionsHTML(session, ui));
  if (document.activeElement !== sel) sel.value = String(ui.selected);
  setHTML($('thread-list'), V.threadListHTML(session, ui));
  ui.lines = Math.max(10, Math.min(60, Math.floor((window.innerHeight - 380) / 18)));   // 逆アセンブルの行数
  if (ui.view === 'list') setHTML($('details'), V.detailsHTML(session, ui));
  else setHTML($('grid'), V.gridHTML(session, ui));

  // 右のタブ
  if (visible('right', 'screen')) drawScreen();
  if (uartDirty || visible('right', 'uart')) {
    const out = m.uart.output;
    const el = $('uart');
    if (out.length < uartShown) uartShown = 0;
    if (out.length > uartShown) {
      el.textContent += String.fromCharCode(...out.slice(uartShown)).replace(/\r\n?/g, '\n');
      uartShown = out.length;
      el.scrollTop = el.scrollHeight;
    }
    if (out.length === 0 && el.textContent) el.textContent = '';
    uartDirty = false;
  }

  // 下のタブ
  const th = m.findThread(ui.selected) ?? m.thread(0);
  if (visible('bottom', 'memory')) setHTML($('memory'), V.memoryHTML(session, ui.memAddr, ui.memUnit));
  if (visible('bottom', 'csr')) setHTML($('csr'), V.csrHTML(session, th));
  if (visible('bottom', 'mbox')) setHTML($('mbox'), V.mboxHTML(session, th));
  // BPタブは、設定が変わったときとタブを開いたときだけ描き直す（入力中の欄を消さないように）
  if (visible('bottom', 'bp') && bpDirty && !$('bp').contains(document.activeElement)) {
    $('bp').innerHTML = V.bpHTML(session);
    bpDirty = false;
  }
  if (logDirty && visible('bottom', 'log')) {
    $('log').textContent = ui.log.join('\n');
    $('log').scrollTop = $('log').scrollHeight;
    logDirty = false;
  }
}

// ブラウザのコンソールから操作するための口（デバッグの補助）
//   stackcpu.loadText('a.asm', 'start: HALT', { boot: 'direct' })  プログラムを文字列から読み込む
window.stackcpu = {
  get session() { return session; },
  ui,
  render,
  toggleRun,
  step,
  /** 読み込みの画面を開く（ファイルを選んだのと同じ。data は文字列か Uint8Array） */
  openFile(name, data) { openLoadDialog({ name, data }); },
  loadText(name, text, { boot = 'boot', addr, up = DEFAULT_DIRECT_UP } = {}) {
    const program = parseProgram(name, text, { addr });
    ui.running = false;
    session.load(program, { boot, up });
    afterRebuild();
    render();
    return program;
  },
};

init().catch(e => {
  document.body.insertAdjacentHTML('afterbegin', `<pre class="msg error">起動に失敗しました：${V.esc(e.stack ?? e.message)}</pre>`);
  console.error(e);
});
