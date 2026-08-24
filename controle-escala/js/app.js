'use strict';

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const TABS = [
  { id: 'motoristas', label: 'Motoristas Canavieiros', tag: '5x1', file: 'data/motoristas.json', hasGroups: true, hasUnits: false },
  { id: 'lideres_turno', label: 'Líder de Turno', tag: '6x2', file: 'data/lideres_turno.json', hasGroups: false, hasUnits: false },
  { id: 'lideres_patio', label: 'Líder de Pátio', tag: '6x2', file: 'data/lideres_patio.json', hasGroups: false, hasUnits: false },
  { id: 'master_driver', label: 'Master Driver', tag: '5x1', file: 'data/master_driver.json', hasGroups: false, hasUnits: true },
];

const WEEKDAYS = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];
const PAPEL_PRIORITY = { 'Turno A': 1, 'Turno B': 2, 'Turno C': 3 };
function papelPriority(p) {
  if (p in PAPEL_PRIORITY) return PAPEL_PRIORITY[p];
  if (!p) return 9;
  if (/apoio/i.test(p)) return 4;
  if (/folguista/i.test(p)) return 5;
  return 6;
}

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

const state = {
  activeTab: localStorage.getItem('escala:lastTab') || 'motoristas',
  month: {},      // tabId -> chave do mes selecionado
  unit: {},        // tabId -> 'MNS' | 'PRA'
  search: '',
  grupo: 'todos',
  papel: 'todos',
  collapsed: {},   // tabId -> Set(grupo)
};

const datasets = {}; // tabId -> parsed json

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function normText(s) {
  return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

function monthKeyForRealDate(dataset, date) {
  if (date.getFullYear() !== 2026) return null;
  const numero = date.getMonth() + 1;
  const m = dataset.meses.find((x) => x.numero === numero);
  return m ? m.chave : null;
}

function weekdayLabel(year, monthNumero, day) {
  const d = new Date(year, monthNumero - 1, day);
  return WEEKDAYS[d.getDay()];
}

function isWeekend(year, monthNumero, day) {
  const d = new Date(year, monthNumero - 1, day);
  const wd = d.getDay();
  return wd === 0 || wd === 6;
}

function fmtLongDate(date) {
  const dias = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  const meses = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  return `${dias[date.getDay()]}, ${date.getDate()} de ${meses[date.getMonth()]} de ${date.getFullYear()}`;
}

function countWorkOff(escalaStr) {
  if (!escalaStr) return { w: 0, o: 0 };
  let w = 0, o = 0;
  for (const c of escalaStr) { if (c === 'W') w++; else if (c === 'O') o++; }
  return { w, o };
}

/* ------------------------------------------------------------------ */
/*  Boot                                                                */
/* ------------------------------------------------------------------ */

async function loadDataset(tab) {
  const base = await fetch(tab.file).then((r) => r.json());
  if (base.colaboradoresPorGrupo) {
    // Motoristas' colaboradores are split into one small file per grupo
    // (data/motoristas/*.json) rather than inlined here.
    const entries = Object.entries(base.colaboradoresPorGrupo);
    const dir = tab.file.slice(0, tab.file.lastIndexOf('/') + 1);
    const groupArrays = await Promise.all(entries.map(([, path]) => fetch(dir + path).then((r) => r.json())));
    base.colaboradores = groupArrays.flat();
    delete base.colaboradoresPorGrupo;
  }
  return base;
}

async function boot() {
  renderTabs();
  const results = await Promise.all(TABS.map((t) => loadDataset(t)));
  TABS.forEach((t, i) => { datasets[t.id] = results[i]; });

  const now = new Date();
  TABS.forEach((t) => {
    const d = datasets[t.id];
    state.collapsed[t.id] = new Set();
    state.month[t.id] = monthKeyForRealDate(d, now) || d.meses[0].chave;
    if (t.hasUnits) state.unit[t.id] = d.unidades[0].codigo;
  });

  activateTab(state.activeTab, true);
}

function renderTabs() {
  const nav = document.getElementById('tabs');
  nav.innerHTML = TABS.map((t) => `
    <button class="tab" data-tab="${t.id}">
      ${t.label} <span class="tab-tag">${t.tag}</span>
    </button>
  `).join('');
  nav.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab, false));
  });
}

function activateTab(tabId, isBoot) {
  state.activeTab = tabId;
  localStorage.setItem('escala:lastTab', tabId);
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabId));
  state.search = '';
  state.grupo = 'todos';
  state.papel = 'todos';
  if (!isBoot) renderPanel();
  else if (datasets[tabId]) renderPanel();
}

/* ------------------------------------------------------------------ */
/*  Panel render                                                       */
/* ------------------------------------------------------------------ */

function currentTabConfig() { return TABS.find((t) => t.id === state.activeTab); }
function currentDataset() { return datasets[state.activeTab]; }

function visiblePeople() {
  const cfg = currentTabConfig();
  const ds = currentDataset();
  let people = ds.colaboradores;
  if (cfg.hasUnits) {
    const unit = state.unit[cfg.id];
    people = people.filter((p) => p.unidade === unit);
  }
  if (state.grupo !== 'todos') people = people.filter((p) => p.grupo === state.grupo);
  if (state.papel !== 'todos') people = people.filter((p) => p.papelNormalizado === state.papel);
  if (state.search.trim()) {
    const q = normText(state.search.trim());
    people = people.filter((p) => normText(p.nome).includes(q) || String(p.matricula || '').includes(q));
  }
  return people;
}

function renderPanel() {
  const cfg = currentTabConfig();
  const ds = currentDataset();
  const monthKey = state.month[cfg.id];
  const monthMeta = ds.meses.find((m) => m.chave === monthKey) || ds.meses[0];

  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="panel-head">
      <h2>${ds.titulo}</h2>
      <p>${cfg.hasGroups ? 'Organizado por grupo e turno.' : 'Organizado por turno.'} Dados da Safra 2026, extraídos da planilha oficial. <span class="print-only-meta">Mês: ${monthMeta.nome} de ${ds.ano}.</span></p>
    </div>
    ${cfg.hasUnits ? renderUnitSwitch(ds, cfg) : ''}
    <div class="toolbar">
      <div class="months" id="months"></div>
      <div class="toolbar-tools">
        <div class="field"><input type="search" id="searchBox" placeholder="Buscar nome ou matrícula" value="${state.search}"></div>
        ${cfg.hasGroups ? renderGrupoSelect(ds) : ''}
        ${renderPapelSelect(ds, cfg)}
        ${cfg.hasGroups ? `<button class="icon-btn" id="toggleGroups">Recolher grupos</button>` : ''}
        <button class="icon-btn" id="printBtn">🖨 Imprimir</button>
      </div>
    </div>
    <div id="todayStrip"></div>
    <div class="cards" id="cards"></div>
    <div class="legend">
      <span class="sw"><i class="work"></i> Trabalha</span>
      <span class="sw"><i class="off"></i> Folga</span>
      <span class="sw"><i class="today-mark"></i> Hoje</span>
    </div>
    <div class="grid-wrap" id="gridWrap"></div>
  `;

  renderMonthPills(ds, cfg, monthMeta);
  renderTodayStrip(ds, cfg, monthMeta);
  renderCards(ds, cfg, monthMeta);
  renderGrid(ds, cfg, monthMeta);

  document.getElementById('searchBox').addEventListener('input', (e) => { state.search = e.target.value; renderCards(ds, cfg, monthMeta); renderGrid(ds, cfg, monthMeta); });
  const grupoSel = document.getElementById('grupoSelect');
  if (grupoSel) grupoSel.addEventListener('change', (e) => { state.grupo = e.target.value; renderCards(ds, cfg, monthMeta); renderGrid(ds, cfg, monthMeta); });
  const papelSel = document.getElementById('papelSelect');
  if (papelSel) papelSel.addEventListener('change', (e) => { state.papel = e.target.value; renderCards(ds, cfg, monthMeta); renderGrid(ds, cfg, monthMeta); });
  document.getElementById('printBtn').addEventListener('click', () => window.print());
  const toggleBtn = document.getElementById('toggleGroups');
  if (toggleBtn) toggleBtn.addEventListener('click', () => {
    const allGroups = [...new Set(ds.colaboradores.map((p) => p.grupo))];
    const collapsed = state.collapsed[cfg.id];
    const collapseAll = collapsed.size < allGroups.length;
    collapsed.clear();
    if (collapseAll) allGroups.forEach((g) => collapsed.add(g));
    toggleBtn.textContent = collapseAll ? 'Expandir grupos' : 'Recolher grupos';
    renderGrid(ds, cfg, monthMeta);
  });
  const unitSwitch = document.getElementById('unitSwitch');
  if (unitSwitch) unitSwitch.querySelectorAll('.unit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.unit[cfg.id] = btn.dataset.unit;
      state.grupo = 'todos';
      state.papel = 'todos';
      renderPanel();
    });
  });
}

function renderUnitSwitch(ds, cfg) {
  const missingDec = ds.meses.every((m) => m.numero !== 12);
  return `
    <div class="unit-switch" id="unitSwitch">
      ${ds.unidades.map((u) => `
        <button class="unit-btn ${state.unit[cfg.id] === u.codigo ? 'active' : ''}" data-unit="${u.codigo}">
          <span class="uo-code">UO ${u.uo}</span>${u.codigo}
        </button>`).join('')}
    </div>
    ${missingDec ? `<div class="unit-note" style="display:block">⚠ Dezembro não está disponível para o Master Driver — a planilha de origem trazia, nessa aba, os dados de Líder de Turno/Pátio por engano. Assim que a planilha for corrigida, o mês pode ser adicionado.</div>` : ''}
  `;
}

function renderGrupoSelect(ds) {
  const grupos = [...new Set(ds.colaboradores.map((p) => p.grupo))].sort();
  return `<div class="field"><select id="grupoSelect">
    <option value="todos">Todos os grupos</option>
    ${grupos.map((g) => `<option value="${g}" ${state.grupo === g ? 'selected' : ''}>${g}</option>`).join('')}
  </select></div>`;
}

function renderPapelSelect(ds, cfg) {
  let pool = ds.colaboradores;
  if (cfg.hasUnits) pool = pool.filter((p) => p.unidade === state.unit[cfg.id]);
  const papeis = [...new Set(pool.map((p) => p.papelNormalizado).filter(Boolean))].sort((a, b) => papelPriority(a) - papelPriority(b));
  return `<div class="field"><select id="papelSelect">
    <option value="todos">Todos os turnos</option>
    ${papeis.map((p) => `<option value="${p}" ${state.papel === p ? 'selected' : ''}>${p}</option>`).join('')}
  </select></div>`;
}

function renderMonthPills(ds, cfg, monthMeta) {
  const now = new Date();
  const curKey = monthKeyForRealDate(ds, now);
  const el = document.getElementById('months');
  el.innerHTML = ds.meses.map((m) => `
    <button class="month-btn ${m.chave === monthMeta.chave ? 'active' : ''} ${m.chave === curKey ? 'is-current' : ''}" data-month="${m.chave}" title="${m.nome} de ${ds.ano} — ${m.dias} dias">
      ${m.nome.slice(0, 3).toUpperCase()}
    </button>
  `).join('');
  el.querySelectorAll('.month-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.month[cfg.id] = btn.dataset.month;
      renderPanel();
    });
  });
}

function renderTodayStrip(ds, cfg, monthMeta) {
  const now = new Date();
  const el = document.getElementById('todayStrip');
  const curKey = monthKeyForRealDate(ds, now);
  if (!curKey) {
    el.innerHTML = `<div class="today-strip out-of-range"><div class="ts-date">Fora do período da safra 2026<small>${fmtLongDate(now)}</small></div></div>`;
    return;
  }
  const day = now.getDate();
  const pool = cfg.hasUnits ? ds.colaboradores.filter((p) => p.unidade === state.unit[cfg.id]) : ds.colaboradores;
  let work = 0, off = 0, nodata = 0;
  const workingNames = [];
  pool.forEach((p) => {
    const sched = p.escala[curKey];
    const status = sched ? sched[day - 1] : undefined;
    if (status === 'W') { work++; workingNames.push(p.nome.split(' ')[0]); }
    else if (status === 'O') off++;
    else nodata++;
  });
  const showNames = pool.length <= 12 && workingNames.length;
  el.innerHTML = `
    <div class="today-strip">
      <div class="ts-date">Hoje · ${fmtLongDate(now)}
        ${showNames ? `<small>Trabalhando: ${workingNames.join(', ')}</small>` : `<small>${cfg.label}${cfg.hasUnits ? ' · UO ' + state.unit[cfg.id] : ''}</small>`}
      </div>
      <div class="ts-stats">
        <div class="ts-stat"><b>${work}</b><span>Trabalhando</span></div>
        <div class="ts-stat"><b>${off}</b><span>De folga</span></div>
      </div>
    </div>
  `;
}

function renderCards(ds, cfg, monthMeta) {
  const people = visiblePeople();
  const el = document.getElementById('cards');
  let totalW = 0, totalO = 0;
  people.forEach((p) => {
    const { w, o } = countWorkOff(p.escala[monthMeta.chave]);
    totalW += w; totalO += o;
  });
  const avgW = people.length ? (totalW / people.length).toFixed(1) : '0';
  el.innerHTML = `
    <div class="card accent"><b>${people.length}</b><span>Colaboradores</span></div>
    <div class="card"><b>${monthMeta.dias}</b><span>Dias em ${monthMeta.nome}</span></div>
    <div class="card"><b>${avgW}</b><span>Média dias trabalhados</span></div>
    <div class="card"><b>${cfg.tag}</b><span>Padrão de escala</span></div>
  `;
}

/* ------------------------------------------------------------------ */
/*  Grid                                                                */
/* ------------------------------------------------------------------ */

function renderGrid(ds, cfg, monthMeta) {
  const people = visiblePeople();
  const wrap = document.getElementById('gridWrap');
  if (!people.length) {
    wrap.innerHTML = `<div class="empty-state">Nenhum colaborador encontrado com os filtros atuais.</div>`;
    return;
  }

  const now = new Date();
  const curKey = monthKeyForRealDate(ds, now);
  const todayDay = curKey === monthMeta.chave ? now.getDate() : null;

  const days = [];
  for (let d = 1; d <= monthMeta.dias; d++) days.push(d);

  const headCells = days.map((d) => {
    const wk = isWeekend(ds.ano, monthMeta.numero, d);
    const isToday = d === todayDay;
    return `<th class="day-col ${wk ? 'weekend' : ''} ${isToday ? 'today-col' : ''}">
      <span class="dnum">${String(d).padStart(2, '0')}</span>
      <span class="dwk">${weekdayLabel(ds.ano, monthMeta.numero, d)}</span>
    </th>`;
  }).join('');

  let bodyHtml = '';
  if (cfg.hasGroups) {
    const groups = [...new Set(people.map((p) => p.grupo))].sort();
    const collapsed = state.collapsed[cfg.id];
    groups.forEach((g) => {
      const groupPeople = people.filter((p) => p.grupo === g).sort((a, b) => papelPriority(a.papelNormalizado) - papelPriority(b.papelNormalizado));
      const isCollapsed = collapsed.has(g);
      bodyHtml += `<tr class="group-row" data-grupo="${g}"><td colspan="${2 + days.length}">${isCollapsed ? '▸' : '▾'} ${g} <span class="count">${groupPeople.length} colaborador${groupPeople.length === 1 ? '' : 'es'}</span></td></tr>`;
      if (!isCollapsed) groupPeople.forEach((p) => { bodyHtml += personRowHtml(p, days, monthMeta, ds, todayDay); });
    });
  } else {
    const sorted = [...people].sort((a, b) => papelPriority(a.papelNormalizado) - papelPriority(b.papelNormalizado));
    sorted.forEach((p) => { bodyHtml += personRowHtml(p, days, monthMeta, ds, todayDay); });
  }

  wrap.innerHTML = `
    <table class="escala">
      <thead>
        <tr>
          <th class="col-nome">Colaborador</th>
          <th class="col-info">Turno</th>
          ${headCells}
        </tr>
      </thead>
      <tbody>${bodyHtml}</tbody>
    </table>
  `;

  wrap.querySelectorAll('.group-row').forEach((row) => {
    row.addEventListener('click', () => {
      const g = row.dataset.grupo;
      const collapsed = state.collapsed[cfg.id];
      if (collapsed.has(g)) collapsed.delete(g); else collapsed.add(g);
      renderGrid(ds, cfg, monthMeta);
    });
  });
  wrap.querySelectorAll('.person-row').forEach((row) => {
    row.addEventListener('click', () => openModal(ds.colaboradores.find((p) => p.__key === row.dataset.key), monthMeta));
  });
}

let __keyCounter = 0;
function personRowHtml(p, days, monthMeta, ds, todayDay) {
  if (!p.__key) p.__key = `k${__keyCounter++}`;
  const sched = p.escala[monthMeta.chave];
  const cells = days.map((d, i) => {
    const status = sched ? sched[i] : undefined;
    const wk = isWeekend(ds.ano, monthMeta.numero, d);
    const isToday = d === todayDay;
    let cls = 'nodata';
    if (status === 'W') cls = 'work'; else if (status === 'O') cls = 'off';
    return `<td class="day-cell ${cls} ${wk ? 'weekend' : ''} ${isToday ? 'today-col' : ''}"><span class="dot"></span></td>`;
  }).join('');
  return `<tr class="person-row" data-key="${p.__key}">
    <td class="col-nome"><span class="nome">${p.nome}</span>${p.matricula ? `<span class="mat">Mat. ${p.matricula}</span>` : ''}</td>
    <td class="col-info"><span class="papel">${p.papelNormalizado || '—'}</span></td>
    ${cells}
  </tr>`;
}

/* ------------------------------------------------------------------ */
/*  Person modal                                                       */
/* ------------------------------------------------------------------ */

function openModal(p, monthMeta) {
  if (!p) return;
  const { w, o } = countWorkOff(p.escala[monthMeta.chave]);
  const backdrop = document.getElementById('modalBackdrop');
  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <button class="modal-close" id="modalClose">✕</button>
        <h3>${p.nome}</h3>
        <span>${p.grupo || ''}${p.grupo && p.papelNormalizado ? ' · ' : ''}${p.papelNormalizado || ''}</span>
      </div>
      <div class="modal-stats">
        <div><b>${w}</b><span>Trabalha</span></div>
        <div><b>${o}</b><span>Folga</span></div>
        <div><b>${monthMeta.nome.slice(0,3).toUpperCase()}</b><span>${monthMeta.dias} dias</span></div>
      </div>
      <div class="modal-body">
        ${p.matricula ? `<div class="modal-row"><span class="k">Matrícula</span><span class="v">${p.matricula}</span></div>` : ''}
        ${p.lider ? `<div class="modal-row"><span class="k">Líder</span><span class="v">${p.lider}</span></div>` : ''}
        ${p.telefone ? `<div class="modal-row"><span class="k">Telefone</span><span class="v">${p.telefone}</span></div>` : ''}
        ${p.unidade ? `<div class="modal-row"><span class="k">Unidade</span><span class="v">${p.unidade}</span></div>` : ''}
        ${!p.matricula && !p.lider && !p.telefone ? `<div class="modal-row"><span class="k">Observação</span><span class="v" style="text-align:left">Dados de contato não constavam na planilha de origem para este colaborador.</span></div>` : ''}
      </div>
    </div>
  `;
  backdrop.classList.add('open');
  document.getElementById('modalClose').addEventListener('click', closeModal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
}
function closeModal() { document.getElementById('modalBackdrop').classList.remove('open'); }

/* ------------------------------------------------------------------ */

function tickClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  const now = new Date();
  el.innerHTML = `<strong>${fmtLongDate(now)}</strong>${now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

document.addEventListener('DOMContentLoaded', () => {
  boot();
  tickClock();
  setInterval(tickClock, 30000);
  document.getElementById('year').textContent = new Date().getFullYear();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
