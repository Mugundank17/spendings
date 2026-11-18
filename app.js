'use strict';

const CATEGORIES = [
  { id: 'food', name: 'Food', emoji: '🍔' },
  { id: 'groceries', name: 'Groceries', emoji: '🛒' },
  { id: 'transport', name: 'Transport', emoji: '🚕' },
  { id: 'shopping', name: 'Shopping', emoji: '🛍️' },
  { id: 'bills', name: 'Bills', emoji: '💡' },
  { id: 'rent', name: 'Rent', emoji: '🏠' },
  { id: 'health', name: 'Health', emoji: '💊' },
  { id: 'fun', name: 'Entertainment', emoji: '🎬' },
  { id: 'travel', name: 'Travel', emoji: '✈️' },
  { id: 'other', name: 'Other', emoji: '📦' },
];
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'JPY', 'MYR', 'LKR'];
const STORE_KEY = 'spendings.v1';

const $ = (id) => document.getElementById(id);
const catById = (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------- storage ----------
function defaultCurrency() {
  try {
    const region = (navigator.language || '').split('-')[1];
    const map = { IN: 'INR', US: 'USD', GB: 'GBP', AE: 'AED', SG: 'SGD', AU: 'AUD', CA: 'CAD', JP: 'JPY', MY: 'MYR', LK: 'LKR' };
    return map[region] || 'INR';
  } catch { return 'INR'; }
}
function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY));
    if (raw && Array.isArray(raw.expenses)) return raw;
  } catch {}
  return { expenses: [], budget: 0, currency: defaultCurrency() };
}
let state = load();
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { alert('Could not save: ' + e.message); }
}

// ---------- formatting ----------
function fmt(n) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: state.currency, maximumFractionDigits: 2 }).format(n);
  } catch { return n.toFixed(2); }
}

// ---------- view state ----------
let viewYear = new Date().getFullYear();
let viewMonth = new Date().getMonth(); // 0-11
let editingId = null;
let selectedCat = CATEGORIES[0].id;

function monthKey(y, m) { return `${y}-${String(m + 1).padStart(2, '0')}`; }
function monthExpenses() {
  const key = monthKey(viewYear, viewMonth);
  return state.expenses.filter((e) => e.date.startsWith(key));
}

// ---------- render ----------
function render() {
  const label = new Date(viewYear, viewMonth, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('monthLabel').textContent = label;

  const list = monthExpenses().sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);
  const total = list.reduce((s, e) => s + e.amount, 0);
  $('totalSpent').textContent = fmt(total);
  $('entryCount').textContent = list.length;
  $('todaySpent').textContent = fmt(state.expenses.filter((e) => e.date === todayISO()).reduce((s, e) => s + e.amount, 0));

  const now = new Date();
  const isCurrent = viewYear === now.getFullYear() && viewMonth === now.getMonth();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const daysElapsed = isCurrent ? now.getDate() : daysInMonth;
  $('dailyAvg').textContent = fmt(daysElapsed ? total / daysElapsed : 0);

  // budget
  const row = $('budgetRow');
  if (state.budget > 0) {
    row.hidden = false;
    const pct = total / state.budget;
    const fill = $('budgetFill');
    fill.style.width = Math.min(100, pct * 100) + '%';
    fill.className = 'fill' + (pct >= 1 ? ' over' : pct >= 0.8 ? ' warn' : '');
    const left = state.budget - total;
    let text = left >= 0
      ? `${fmt(left)} left of ${fmt(state.budget)}`
      : `${fmt(-left)} over budget of ${fmt(state.budget)}`;
    if (isCurrent && left > 0) {
      const remainingDays = daysInMonth - now.getDate() + 1;
      text += ` · ${fmt(left / remainingDays)}/day for ${remainingDays} days`;
    }
    $('budgetText').textContent = text;
  } else {
    row.hidden = true;
  }

  // categories
  const byCat = {};
  list.forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + e.amount; });
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const max = cats.length ? cats[0][1] : 0;
  $('categoryList').innerHTML = cats.length
    ? cats.map(([id, amt]) => {
        const c = catById(id);
        const pct = total ? Math.round((amt / total) * 100) : 0;
        return `<div class="cat-row"><span>${c.emoji}</span>
          <div><div class="name">${c.name} <span class="muted small">${pct}%</span></div>
          <div class="mini"><div style="width:${(amt / max) * 100}%"></div></div></div>
          <span class="amt">${fmt(amt)}</span></div>`;
      }).join('')
    : '<p class="muted">Nothing yet.</p>';

  // transactions grouped by day
  const ul = $('txList');
  ul.innerHTML = '';
  let lastDay = null;
  for (const e of list) {
    if (e.date !== lastDay) {
      lastDay = e.date;
      const dayTotal = list.filter((x) => x.date === e.date).reduce((s, x) => s + x.amount, 0);
      const li = document.createElement('li');
      li.className = 'day';
      li.textContent = `${new Date(e.date + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · ${fmt(dayTotal)}`;
      ul.appendChild(li);
    }
    const c = catById(e.category);
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `<span class="emoji">${c.emoji}</span><div><div class="note"></div><div class="sub">${c.name}</div></div><span class="amt">${fmt(e.amount)}</span>`;
    li.querySelector('.note').textContent = e.note || c.name;
    li.addEventListener('click', () => openForm(e));
    ul.appendChild(li);
  }
  $('emptyMsg').hidden = list.length > 0;
}

// ---------- form ----------
function renderChips() {
  $('catPicker').innerHTML = '';
  for (const c of CATEGORIES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (c.id === selectedCat ? ' on' : '');
    b.textContent = `${c.emoji} ${c.name}`;
    b.addEventListener('click', () => { selectedCat = c.id; renderChips(); });
    $('catPicker').appendChild(b);
  }
}
function openForm(expense) {
  editingId = expense ? expense.id : null;
  $('formTitle').textContent = expense ? 'Edit expense' : 'Add expense';
  $('amountInput').value = expense ? expense.amount : '';
  $('noteInput').value = expense ? expense.note : '';
  $('dateInput').value = expense ? expense.date : todayISO();
  selectedCat = expense ? expense.category : selectedCat;
  $('deleteBtn').hidden = !expense;
  renderChips();
  $('addDialog').showModal();
  setTimeout(() => $('amountInput').focus(), 50);
}
$('addBtn').addEventListener('click', () => openForm(null));
$('cancelBtn').addEventListener('click', () => $('addDialog').close());
$('deleteBtn').addEventListener('click', () => {
  if (!confirm('Delete this expense?')) return;
  state.expenses = state.expenses.filter((e) => e.id !== editingId);
  save(); $('addDialog').close(); render();
});
$('addForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const amount = parseFloat($('amountInput').value);
  if (!(amount > 0)) { $('amountInput').focus(); return; }
  const data = {
    amount: Math.round(amount * 100) / 100,
    category: selectedCat,
    note: $('noteInput').value.trim(),
    date: $('dateInput').value || todayISO(),
  };
  if (editingId) {
    Object.assign(state.expenses.find((e) => e.id === editingId), data);
  } else {
    state.expenses.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), created: Date.now(), ...data });
  }
  save();
  $('addDialog').close();
  const [y, m] = data.date.split('-').map(Number);
  viewYear = y; viewMonth = m - 1;
  render();
});

// ---------- navigation ----------
window.showMonth = (y, m) => { viewYear = y; viewMonth = m; render(); };
$('prevMonth').addEventListener('click', () => { viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } render(); });
$('nextMonth').addEventListener('click', () => { viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } render(); });

// ---------- settings ----------
$('currencyInput').innerHTML = [...new Set([state.currency, ...CURRENCIES])].map((c) => `<option>${c}</option>`).join('');
$('currencyInput').value = state.currency;
$('currencyInput').addEventListener('change', (e) => { state.currency = e.target.value; save(); render(); });
$('budgetInput').value = state.budget || '';
$('budgetInput').addEventListener('change', (e) => { state.budget = Math.max(0, parseFloat(e.target.value) || 0); save(); render(); });

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('exportCsv').addEventListener('click', () => {
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const rows = [['date', 'amount', 'currency', 'category', 'note']]
    .concat([...state.expenses].sort((a, b) => a.date.localeCompare(b.date))
      .map((e) => [e.date, e.amount, state.currency, catById(e.category).name, e.note]));
  download(`spendings-${todayISO()}.csv`, rows.map((r) => r.map(esc).join(',')).join('\n'), 'text/csv');
});
$('exportJson').addEventListener('click', () => download(`spendings-backup-${todayISO()}.json`, JSON.stringify(state, null, 2), 'application/json'));
$('importJson').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.expenses)) throw new Error('Not a Spendings backup file');
    if (!confirm(`Restore ${data.expenses.length} expenses? This replaces what's on this device.`)) return;
    state = { expenses: data.expenses, budget: data.budget || 0, currency: data.currency || state.currency };
    save();
    $('budgetInput').value = state.budget || '';
    $('currencyInput').value = state.currency;
    render();
  } catch (err) { alert('Restore failed: ' + err.message); }
  e.target.value = '';
});

// ---------- offline ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

render();
