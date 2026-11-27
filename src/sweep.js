// A small floating Mind Sweep: tick off, add and edit Progress Pad Mind Sweep items.
// Same login and database as the Progress Pad website, so both stay in step.
// In Chrome and Edge it opens as an always-on-top window (Document Picture-in-Picture);
// elsewhere it opens /sweep.html in a small popup window.
import { supabase } from './cloud.js';

const REFRESH_MS = 15000;
const SIZE = { width: 340, height: 520 };
const dayOf = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CSS = `
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#0c0c0f;color:#fff;font-family:Dosis,system-ui,sans-serif;font-weight:500}
.sw{display:flex;flex-direction:column;gap:12px;height:100%;padding:16px}
.sw header{display:flex;align-items:baseline;justify-content:space-between}
.sw h1{margin:0;font:600 15px Poppins,system-ui,sans-serif}
.sw .n{font-size:13px;color:#8e8e93}
.sw form{display:flex;align-items:center;gap:8px;height:44px;padding:0 14px;border-radius:22px;background:#18181c;border:1px solid #2c2c30}
.sw form:focus-within{border-color:#25DD5F}
.sw form span{color:#8e8e93;font-size:20px;line-height:1}
.sw input{flex:1;min-width:0;background:none;border:0;outline:none;color:#fff;font:inherit;font-size:16px}
.sw input::placeholder{color:#6b6b70}
.sw .list{flex:1;min-height:0;overflow-y:auto}
.sw ul{list-style:none;margin:0;padding:0}
.sw li{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #232326}
.sw li:last-child{border-bottom:0}
.sw .ck{flex:0 0 22px;width:22px;height:22px;border-radius:7px;border:1.5px solid #4a4a50;background:none;display:grid;place-items:center;cursor:pointer;padding:0}
.sw .ck.on{background:#25DD5F;border-color:#25DD5F}
.sw .ck svg{display:none}.sw .ck.on svg{display:block}
.sw .t{flex:1;min-width:0;background:none;border:0;padding:0;text-align:left;color:#fff;font:inherit;font-size:16px;cursor:text;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw .on+.t{color:#6b6b70;text-decoration:line-through}
.sw .ed{flex:1;height:32px;padding:0 8px;border-radius:8px;background:#18181c;border:1px solid #25DD5F}
.sw .d{font-size:12px;color:#6b6b70;flex:0 0 auto}
.sw .fold{margin-top:12px;background:none;border:0;padding:0;color:#8e8e93;font:inherit;font-size:13px;cursor:pointer}
.sw .empty{text-align:center;color:#8e8e93;font-size:14px;padding:24px 0}
.sw .err{color:#ff6b6b;font-size:13px;margin:0}
`;
const TICK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#0c0c0f" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

export function mountSweep(doc, win) {
  const fonts = doc.createElement('link');
  fonts.rel = 'stylesheet';
  fonts.href = 'https://fonts.googleapis.com/css2?family=Dosis:wght@400;500;600&family=Poppins:wght@600&display=swap';
  const style = doc.createElement('style'); style.textContent = CSS;
  doc.head.append(fonts, style);
  doc.title = 'Mind Sweep';
  const root = doc.createElement('div'); root.className = 'sw'; doc.body.append(root);

  let items = [], uid = null, editing = null, showDone = false, error = '', pending = 0, loaded = false;
  const today = () => dayOf();

  async function load() {
    if (pending) return;
    if (!uid) { const { data } = await supabase.auth.getUser(); uid = data.user?.id || null; }
    if (!uid) { error = 'Sign in to MemoPad first, then pop out again.'; loaded = true; render(); return; }
    const { data, error: e } = await supabase.from('mind_sweep_items')
      .select('id,title,status,on_date,sort_order,created_at').eq('user_id', uid)
      .or(`status.eq.todo,and(status.eq.achieved,on_date.eq.${today()})`).limit(300);
    if (e) { error = 'Could not load your Mind Sweep.'; render(); return; }
    if (pending) return;
    items = data || []; loaded = true; error = ''; render();
  }
  async function save(fn, undo, msg) {
    pending++; error = '';
    try { const { error: e } = await fn(); if (e) throw e; }
    catch { undo(); error = msg; }
    finally { pending--; render(); }
  }

  function sorted(list) {
    const t = today();
    return list.slice().sort((a, b) => ((a.on_date === t ? 0 : 1) - (b.on_date === t ? 0 : 1)) || a.on_date.localeCompare(b.on_date)
      || (a.sort_order - b.sort_order) || String(a.created_at).localeCompare(String(b.created_at)));
  }
  function dateLabel(d) {
    if (d === today()) return '';
    const [y, m, x] = d.split('-').map(Number);
    return new Date(y, m - 1, x).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function row(it) {
    const on = it.status === 'achieved';
    const label = editing === it.id
      ? `<input class="ed" data-ed="${it.id}" value="${esc(it.title)}" aria-label="Edit item">`
      : `<button class="t" data-edit="${it.id}" title="Tap to edit">${esc(it.title)}</button><span class="d">${dateLabel(it.on_date)}</span>`;
    return `<li><button class="ck${on ? ' on' : ''}" data-ck="${it.id}" aria-label="${on ? 'Mark as not done' : 'Tick off'}">${TICK}</button>${label}</li>`;
  }
  function render() {
    const open = sorted(items.filter(i => i.status !== 'achieved'));
    const done = sorted(items.filter(i => i.status === 'achieved' && i.on_date === today()));
    const hadFocus = doc.activeElement?.id === 'swAdd', draft = doc.getElementById('swAdd')?.value || '';
    root.innerHTML = `
      <header><h1>Mind Sweep</h1><span class="n">${loaded ? open.length + ' open' : ''}</span></header>
      <form id="swForm"><span>+</span><input id="swAdd" placeholder="Add a thought…" aria-label="Add to Mind Sweep" autocomplete="off"></form>
      ${error ? `<p class="err" role="status">${esc(error)}</p>` : ''}
      <div class="list">
        ${!loaded ? '<p class="empty">Loading…</p>' : open.length ? `<ul>${open.map(row).join('')}</ul>` : '<p class="empty">All clear. Nice work.</p>'}
        ${done.length ? `<button class="fold" id="swFold">${done.length} done today ${showDone ? '▴' : '▾'}</button>${showDone ? `<ul>${done.map(row).join('')}</ul>` : ''}` : ''}
      </div>`;
    const add = doc.getElementById('swAdd'); add.value = draft; if (hadFocus) add.focus();
    const ed = root.querySelector('[data-ed]'); if (ed) { ed.focus(); ed.setSelectionRange(ed.value.length, ed.value.length); }
  }

  function toggle(id) {
    const it = items.find(i => i.id === id); if (!it) return;
    const prev = it.status; it.status = prev === 'achieved' ? 'todo' : 'achieved'; render();
    save(() => supabase.from('mind_sweep_items').update({ status: it.status, updated_at: new Date().toISOString() }).eq('id', id).eq('user_id', uid),
      () => { it.status = prev; }, 'Could not save that tick. Try again.');
  }
  function add(title) {
    title = title.trim().slice(0, 500); if (!title || !uid) return;
    const t = today(), mine = items.filter(i => i.on_date === t);
    const sort_order = mine.length ? Math.min(...mine.map(i => i.sort_order)) - 1 : 1;
    const temp = { id: 'tmp' + Date.now(), title, status: 'todo', on_date: t, sort_order, created_at: new Date().toISOString() };
    items.push(temp); doc.getElementById('swAdd').value = ''; render();
    save(async () => {
      const r = await supabase.from('mind_sweep_items').insert({ user_id: uid, on_date: t, title, status: 'todo', sort_order }).select('id,title,status,on_date,sort_order,created_at').single();
      if (!r.error) Object.assign(temp, r.data);
      return r;
    }, () => { items = items.filter(i => i !== temp); doc.getElementById('swAdd').value = title; }, 'Could not add that. Try again.');
  }
  function finishEdit(input, keep) {
    const id = input.dataset.ed, it = items.find(i => i.id === id); editing = null;
    const title = input.value.trim().slice(0, 500);
    if (!it || !keep || !title || title === it.title) { render(); return; }
    const prev = it.title; it.title = title; render();
    save(() => supabase.from('mind_sweep_items').update({ title, updated_at: new Date().toISOString() }).eq('id', id).eq('user_id', uid),
      () => { it.title = prev; }, 'Could not save that change. Try again.');
  }

  root.addEventListener('submit', e => { e.preventDefault(); add(doc.getElementById('swAdd').value); });
  root.addEventListener('click', e => {
    const ck = e.target.closest('[data-ck]'); if (ck) { toggle(ck.dataset.ck); return; }
    const t = e.target.closest('[data-edit]'); if (t) { editing = t.dataset.edit; render(); return; }
    if (e.target.closest('#swFold')) { showDone = !showDone; render(); }
  });
  root.addEventListener('keydown', e => {
    const ed = e.target.closest('[data-ed]'); if (!ed) return;
    if (e.key === 'Enter') { e.preventDefault(); finishEdit(ed, true); }
    else if (e.key === 'Escape') finishEdit(ed, false);
  });
  root.addEventListener('focusout', e => { const ed = e.target.closest?.('[data-ed]'); if (ed && editing === ed.dataset.ed) finishEdit(ed, true); });

  render(); load();
  const timer = win.setInterval(() => { if (doc.visibilityState === 'visible' && !editing) load(); }, REFRESH_MS);
  win.addEventListener('focus', () => { if (!editing) load(); });
  win.addEventListener('pagehide', () => win.clearInterval(timer), { once: true });
}

let pip = null;
export async function popOutSweep() {
  if (pip && !pip.closed) { pip.focus(); return; }
  const api = window.documentPictureInPicture;
  if (api) {
    try {
      pip = await api.requestWindow(SIZE);
      mountSweep(pip.document, pip);
      pip.addEventListener('pagehide', () => { pip = null; }, { once: true });
      return;
    } catch { /* fall back to a popup window */ }
  }
  window.open('/sweep.html', 'mp-mind-sweep', `popup,width=${SIZE.width},height=${SIZE.height}`);
}
