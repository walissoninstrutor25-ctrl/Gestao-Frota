'use strict';

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const TABS = [
  { id: 'motoristas', label: 'Motoristas Canavieiros', tag: '5x1', dataVar: 'DATA_MOTORISTAS_META', hasGroups: true, hasUnits: false },
  { id: 'lideres_turno', label: 'Líder de Turno', tag: '6x2', dataVar: 'DATA_LIDERES_TURNO', hasGroups: false, hasUnits: false },
  { id: 'lideres_patio', label: 'Líder de Pátio', tag: '6x2', dataVar: 'DATA_LIDERES_PATIO', hasGroups: false, hasUnits: false },
  { id: 'master_driver', label: 'Master Driver', tag: '5x1', dataVar: 'DATA_MASTER_DRIVER', hasGroups: false, hasUnits: true },
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
  view: {},        // tabId -> 'escala' | 'equipe'
  search: '',
  grupo: 'todos',
  papel: 'todos',
  collapsed: {},   // tabId -> Set(grupo)
  editMode: false,
};

const datasets = {}; // tabId -> parsed json

/* ------------------------------------------------------------------ */
/*  Edições locais (modo edição)                                       */
/*  Sem backend: as edições ficam salvas só neste navegador            */
/*  (localStorage), não são sincronizadas entre dispositivos.          */
/* ------------------------------------------------------------------ */

const EDIT_STORAGE_KEY = 'escala:edits:v1';

function loadEdits() {
  try {
    const raw = JSON.parse(localStorage.getItem(EDIT_STORAGE_KEY) || '{}');
    return { contato: raw.contato || {}, dias: raw.dias || {}, equipe: raw.equipe || {} };
  } catch {
    return { contato: {}, dias: {}, equipe: {} };
  }
}

const edits = loadEdits();

function persistEdits() {
  localStorage.setItem(EDIT_STORAGE_KEY, JSON.stringify(edits));
  updateResetBtnVisibility();
}

function hasAnyEdits() {
  return Object.keys(edits.contato).length > 0 || Object.keys(edits.dias).length > 0 || Object.keys(edits.equipe).length > 0;
}

function updateResetBtnVisibility() {
  const btn = document.getElementById('resetEditsBtn');
  if (btn) btn.style.display = hasAnyEdits() ? '' : 'none';
}

function computeOriginalKey(cfgId, nome, grupo) {
  return `${cfgId}|${normText(nome)}|${grupo || ''}`;
}

// Returns the person's stable identity key. Computed once from the pristine
// (pre-edit) nome+grupo and cached on the object as __pk, so renaming
// someone mid-session doesn't change which localStorage entry their edits
// are saved under.
function personKey(cfgId, p) {
  return p.__pk || computeOriginalKey(cfgId, p.nome, p.grupo);
}

function applyStoredEditsToDatasets() {
  TABS.forEach((cfg) => {
    const ds = datasets[cfg.id];
    if (!ds) return;
    ds.colaboradores.forEach((p) => {
      p.__pk = computeOriginalKey(cfg.id, p.nome, p.grupo);
      const pk = p.__pk;
      const contato = edits.contato[pk];
      if (contato) Object.assign(p, contato);
      const dias = edits.dias[pk];
      if (dias) {
        Object.keys(dias).forEach((monthKey) => {
          if (!p.escala[monthKey]) return;
          const chars = p.escala[monthKey].split('');
          Object.keys(dias[monthKey]).forEach((dayIdx) => { chars[dayIdx] = dias[monthKey][dayIdx]; });
          p.escala[monthKey] = chars.join('');
        });
      }
    });
  });
}

function equipeEditGet(path, field, fallback) {
  const e = edits.equipe[path];
  return e && field in e ? e[field] : fallback;
}

function equipeEditSet(path, field, value) {
  edits.equipe[path] = { ...edits.equipe[path], [field]: value };
  persistEdits();
}

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

function loadDataset(tab) {
  const base = window[tab.dataVar];
  if (!base) throw new Error(`Dados não encontrados: window.${tab.dataVar}. Confira se todos os <script> de data/ estão carregando antes de js/app.js.`);
  if (base.colaboradoresPorGrupoVar) {
    // Motoristas' colaboradores are split into one small file per grupo
    // (data/motoristas/*.js, each setting its own window.DATA_MOTORISTAS_*)
    // rather than inlined here.
    base.colaboradores = Object.values(base.colaboradoresPorGrupoVar).flatMap((varname) => {
      const arr = window[varname];
      if (!arr) throw new Error(`Dados não encontrados: window.${varname}`);
      return arr;
    });
    delete base.colaboradoresPorGrupoVar;
  }
  return base;
}

function boot() {
  renderTabs();
  const results = TABS.map((t) => loadDataset(t));
  TABS.forEach((t, i) => { datasets[t.id] = results[i]; });
  applyStoredEditsToDatasets();

  const now = new Date();
  TABS.forEach((t) => {
    const d = datasets[t.id];
    state.collapsed[t.id] = new Set();
    state.month[t.id] = monthKeyForRealDate(d, now) || d.meses[0].chave;
    if (t.hasUnits) state.unit[t.id] = d.unidades[0].codigo;
    state.view[t.id] = 'escala';
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
  state.view[tabId] = 'escala';
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

  const mestre = currentMestre(ds, cfg);
  const isEquipe = state.view[cfg.id] === 'equipe' && mestre;

  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="panel-head">
      <h2>${ds.titulo}</h2>
      <p>${cfg.hasGroups ? 'Organizado por grupo e turno.' : 'Organizado por turno.'} Dados extraídos da planilha oficial. <span class="print-only-meta">Mês: ${monthMeta.nome} de ${ds.ano}.</span></p>
    </div>
    ${cfg.hasUnits ? renderUnitSwitch(ds, cfg) : ''}
    <div class="toolbar">
      <div class="months" id="months"></div>
      <div class="toolbar-tools">
        ${isEquipe ? '' : `<div class="field"><input type="search" id="searchBox" placeholder="Buscar nome ou matrícula" value="${state.search}"></div>`}
        ${!isEquipe && cfg.hasGroups ? renderGrupoSelect(ds) : ''}
        ${isEquipe ? '' : renderPapelSelect(ds, cfg)}
        ${!isEquipe && cfg.hasGroups ? `<button class="icon-btn" id="toggleGroups">Recolher grupos</button>` : ''}
        ${mestre ? `<button class="icon-btn" id="equipeBtn">${isEquipe ? '📅 Ver escala' : '👥 Ver equipe'}</button>` : ''}
        <button class="icon-btn" id="printBtn">🖨 Imprimir</button>
      </div>
    </div>
    <div id="viewBody"></div>
  `;

  renderMonthPills(ds, cfg, monthMeta);

  if (isEquipe) {
    const viewBody = document.getElementById('viewBody');
    viewBody.innerHTML = renderEquipeHtml(ds, cfg, mestre);
    if (state.editMode) wireEquipeEdits(viewBody);
  } else {
    document.getElementById('viewBody').innerHTML = `
      <div id="todayStrip"></div>
      <div class="cards" id="cards"></div>
      <div class="legend">
        <span class="sw"><i class="work"></i> Trabalha</span>
        <span class="sw"><i class="off"></i> Folga</span>
        <span class="sw"><i class="today-mark"></i> Hoje</span>
      </div>
      <div class="grid-wrap" id="gridWrap"></div>
    `;
    renderTodayStrip(ds, cfg, monthMeta);
    renderCards(ds, cfg, monthMeta);
    renderGrid(ds, cfg, monthMeta);

    document.getElementById('searchBox').addEventListener('input', (e) => { state.search = e.target.value; renderCards(ds, cfg, monthMeta); renderGrid(ds, cfg, monthMeta); });
    const grupoSel = document.getElementById('grupoSelect');
    if (grupoSel) grupoSel.addEventListener('change', (e) => { state.grupo = e.target.value; renderCards(ds, cfg, monthMeta); renderGrid(ds, cfg, monthMeta); });
    const papelSel = document.getElementById('papelSelect');
    if (papelSel) papelSel.addEventListener('change', (e) => { state.papel = e.target.value; renderCards(ds, cfg, monthMeta); renderGrid(ds, cfg, monthMeta); });
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
  }

  document.getElementById('printBtn').addEventListener('click', () => window.print());
  const equipeBtn = document.getElementById('equipeBtn');
  if (equipeBtn) equipeBtn.addEventListener('click', () => {
    state.view[cfg.id] = isEquipe ? 'escala' : 'equipe';
    renderPanel();
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

function currentMestre(ds, cfg) {
  if (!ds.mestre) return null;
  if (cfg.hasUnits) return ds.mestre[state.unit[cfg.id]] || null;
  if (Array.isArray(ds.mestre)) return ds.mestre.length ? ds.mestre : null;
  return ds.mestre;
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

/* ------------------------------------------------------------------ */
/*  Equipe (MESTRE) view — quem é titular/folguista/apoio de cada vaga */
/* ------------------------------------------------------------------ */

function equipePessoaHtml(p, path) {
  const nome = path ? equipeEditGet(path, 'nome', p ? p.nome : null) : (p ? p.nome : null);
  const matricula = path ? equipeEditGet(path, 'matricula', p ? p.matricula : null) : (p ? p.matricula : null);
  if (state.editMode && path) {
    return `<span class="equipe-nome" contenteditable="true" data-edit-path="${path}" data-edit-field="nome">${nome || ''}</span><span class="equipe-mat">Mat. <span contenteditable="true" data-edit-path="${path}" data-edit-field="matricula">${matricula || ''}</span></span>`;
  }
  if (!nome && !matricula) return '<span class="equipe-vazio">—</span>';
  return `<span class="equipe-nome">${nome || '—'}</span>${matricula ? `<span class="equipe-mat">Mat. ${matricula}</span>` : ''}`;
}

function equipePessoaText(p, path) {
  const nome = path ? equipeEditGet(path, 'nome', p ? p.nome : null) : (p ? p.nome : null);
  const matricula = path ? equipeEditGet(path, 'matricula', p ? p.matricula : null) : (p ? p.matricula : null);
  if (state.editMode && path) {
    return `<span contenteditable="true" data-edit-path="${path}" data-edit-field="nome">${nome || ''}</span> (Mat. <span contenteditable="true" data-edit-path="${path}" data-edit-field="matricula">${matricula || ''}</span>)`;
  }
  if (!nome && !matricula) return '—';
  return `${nome || '—'}${matricula ? ` (Mat. ${matricula})` : ''}`;
}

function equipeTurnosHtml(titulo, basePath, turnos, folguistaPath, folguista, apoio) {
  const rows = ['A', 'B', 'C'].map((t) => `
    <tr><td class="col-info"><span class="papel">Turno ${t}</span></td><td>${equipePessoaHtml(turnos && turnos[t], `${basePath}|turno|${t}`)}</td></tr>
  `).join('');
  const showFolguistas = folguistaPath || (apoio && apoio.length);
  return `
    <div class="equipe-grupo">
      <h3>${titulo}</h3>
      <table class="equipe-table">
        <thead><tr><th>Turno</th><th>Titular</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${showFolguistas ? `
        <div class="equipe-folguistas">
          ${folguistaPath ? `<div class="equipe-folguista"><b>Folguista</b> ${equipePessoaText(folguista, folguistaPath)}</div>` : ''}
          ${(apoio || []).map((a) => `<div class="equipe-folguista"><b>Apoio ${a.turno}</b> ${equipePessoaText(a, `${basePath}|apoio|${a.turno}`)}</div>`).join('')}
        </div>` : ''}
    </div>`;
}

function equipeGrupoHtml(g) {
  const basePath = `motoristas|${g.grupo}`;
  const rows = g.equipamentos.map((e) => `
    <tr>
      <td class="col-nome"><span class="nome">Equip. ${e.numero}</span>${e.status ? `<span class="equipe-mat">${e.status}</span>` : ''}</td>
      <td>${equipePessoaHtml(e.turnos.A, `${basePath}|equip|${e.numero}|A`)}</td>
      <td>${equipePessoaHtml(e.turnos.B, `${basePath}|equip|${e.numero}|B`)}</td>
      <td>${equipePessoaHtml(e.turnos.C, `${basePath}|equip|${e.numero}|C`)}</td>
    </tr>`).join('');
  const temFolguistas = state.editMode || ['A', 'B', 'C'].some((t) => g.folguistas[t]);
  return `
    <div class="equipe-grupo">
      <h3>${g.grupo}</h3>
      <table class="equipe-table">
        <thead><tr><th>Equipamento</th><th>Turno A</th><th>Turno B</th><th>Turno C</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${temFolguistas ? `
        <div class="equipe-folguistas">
          ${['A', 'B', 'C'].map((t) => (g.folguistas[t] || state.editMode) ? `<div class="equipe-folguista"><b>Folguista ${t}</b> ${equipePessoaText(g.folguistas[t], `${basePath}|folguista|${t}`)}</div>` : '').join('')}
        </div>` : ''}
    </div>`;
}

function renderEquipeHtml(ds, cfg, mestre) {
  if (cfg.id === 'motoristas') {
    return `<div class="equipe-wrap">${mestre.map((g) => equipeGrupoHtml(g)).join('')}</div>`;
  }
  if (cfg.id === 'master_driver') {
    const basePath = `master_driver|${state.unit[cfg.id]}`;
    return `<div class="equipe-wrap">${equipeTurnosHtml(mestre.titulo, basePath, mestre.turnos, null, null, [])}</div>`;
  }
  const basePath = cfg.id;
  return `<div class="equipe-wrap">${equipeTurnosHtml(ds.titulo, basePath, mestre.turnos, `${basePath}|folguista`, mestre.folguista, mestre.apoio)}</div>`;
}

function wireEquipeEdits(container) {
  container.querySelectorAll('[data-edit-path]').forEach((el) => {
    el.addEventListener('blur', () => {
      equipeEditSet(el.dataset.editPath, el.dataset.editField, el.textContent.trim());
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    });
  });
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
    el.innerHTML = `<div class="today-strip out-of-range"><div class="ts-date">Fora do período coberto pela escala<small>${fmtLongDate(now)}</small></div></div>`;
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
    row.addEventListener('click', (e) => {
      if (state.editMode && e.target.closest('.day-cell')) return;
      openModal(ds.colaboradores.find((p) => p.__key === row.dataset.key), monthMeta, cfg);
    });
  });
  if (state.editMode) {
    wrap.querySelectorAll('.day-cell').forEach((cell) => {
      cell.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = cell.closest('.person-row');
        const p = ds.colaboradores.find((x) => x.__key === row.dataset.key);
        toggleDayStatus(p, cfg, ds, monthMeta, parseInt(cell.dataset.day, 10), cell);
      });
    });
  }
}

function toggleDayStatus(p, cfg, ds, monthMeta, day, cellEl) {
  const monthKey = monthMeta.chave;
  const chars = (p.escala[monthKey] || '').split('');
  const idx = day - 1;
  if (!chars[idx]) return;
  const next = chars[idx] === 'W' ? 'O' : 'W';
  chars[idx] = next;
  p.escala[monthKey] = chars.join('');

  const pk = personKey(cfg.id, p);
  edits.dias[pk] = edits.dias[pk] || {};
  edits.dias[pk][monthKey] = edits.dias[pk][monthKey] || {};
  edits.dias[pk][monthKey][idx] = next;
  persistEdits();

  cellEl.classList.remove('work', 'off');
  cellEl.classList.add(next === 'W' ? 'work' : 'off');
  renderCards(ds, cfg, monthMeta);
  renderTodayStrip(ds, cfg, monthMeta);
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
    return `<td class="day-cell ${cls} ${wk ? 'weekend' : ''} ${isToday ? 'today-col' : ''}" data-day="${d}"><span class="dot"></span></td>`;
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

function openModal(p, monthMeta, cfg) {
  if (!p) return;
  const { w, o } = countWorkOff(p.escala[monthMeta.chave]);
  const backdrop = document.getElementById('modalBackdrop');

  if (state.editMode && cfg) {
    backdrop.innerHTML = `
      <div class="modal">
        <div class="modal-head">
          <button class="modal-close" id="modalClose">✕</button>
          <h3>Editar colaborador</h3>
          <span>${p.grupo || ''}${p.grupo && p.papelNormalizado ? ' · ' : ''}${p.papelNormalizado || ''}</span>
        </div>
        <div class="modal-body">
          <div class="modal-row edit"><span class="k">Nome</span><input class="modal-input" id="editNome" value="${p.nome || ''}"></div>
          <div class="modal-row edit"><span class="k">Matrícula</span><input class="modal-input" id="editMatricula" value="${p.matricula || ''}"></div>
          <div class="modal-row edit"><span class="k">Líder</span><input class="modal-input" id="editLider" value="${p.lider || ''}"></div>
          <div class="modal-row edit"><span class="k">Telefone</span><input class="modal-input" id="editTelefone" value="${p.telefone || ''}"></div>
        </div>
        <div class="modal-actions">
          <button class="icon-btn" id="modalCancel">Cancelar</button>
          <button class="icon-btn primary" id="modalSave">Salvar</button>
        </div>
      </div>
    `;
    backdrop.classList.add('open');
    const close = () => closeModal();
    document.getElementById('modalClose').addEventListener('click', close);
    document.getElementById('modalCancel').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.getElementById('modalSave').addEventListener('click', () => {
      const pk = personKey(cfg.id, p);
      const values = {
        nome: document.getElementById('editNome').value.trim() || p.nome,
        matricula: as_int_or_null(document.getElementById('editMatricula').value.trim()),
        lider: document.getElementById('editLider').value.trim() || null,
        telefone: document.getElementById('editTelefone').value.trim() || null,
      };
      Object.assign(p, values);
      edits.contato[pk] = { ...edits.contato[pk], ...values };
      persistEdits();
      close();
      renderPanel();
    });
    return;
  }

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

function as_int_or_null(s) {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? s : n;
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
  try {
    boot();
  } catch (err) {
    document.getElementById('app').innerHTML = `
      <div class="empty-state">
        Não foi possível carregar os dados da escala.<br>
        <small style="display:block;margin-top:8px;opacity:.7">${err.message}</small>
      </div>`;
    console.error(err);
  }
  tickClock();
  setInterval(tickClock, 30000);
  document.getElementById('year').textContent = new Date().getFullYear();
  if (location.protocol !== 'file:' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  updateResetBtnVisibility();
  document.getElementById('editModeBtn').addEventListener('click', () => {
    state.editMode = !state.editMode;
    const btn = document.getElementById('editModeBtn');
    btn.textContent = state.editMode ? '✅ Concluir edição' : '✏️ Editar';
    document.body.classList.toggle('edit-mode', state.editMode);
    if (datasets[state.activeTab]) renderPanel();
  });
  document.getElementById('resetEditsBtn').addEventListener('click', () => {
    if (!confirm('Isso vai apagar todas as edições salvas neste navegador e voltar aos dados originais da planilha. Continuar?')) return;
    localStorage.removeItem(EDIT_STORAGE_KEY);
    location.reload();
  });
});
