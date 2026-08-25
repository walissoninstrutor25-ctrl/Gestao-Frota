'use strict';

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const TABS = [
  { id: 'motoristas', label: 'Motoristas Canavieiros', tag: '5x1', dataVar: 'DATA_MOTORISTAS_META', hasGroups: true, hasUnits: false },
  { id: 'lideres_turno', label: 'Líder de Turno', tag: '6x2', dataVar: 'DATA_LIDERES_TURNO', hasGroups: false, hasUnits: false },
  { id: 'lideres_patio', label: 'Líder de Pátio', tag: '6x2', dataVar: 'DATA_LIDERES_PATIO', hasGroups: false, hasUnits: false },
  { id: 'master_driver', label: 'Master Driver', tag: '5x1', dataVar: 'DATA_MASTER_DRIVER', hasGroups: false, hasUnits: true },
  { id: 'adm5x2', label: 'Administrativo', tag: 'adm5x2', dataVar: 'DATA_ADM5X2', hasGroups: false, hasUnits: true },
];

// Tipos de escala disponíveis no filtro do topo.
const ESCALA_TYPES = [
  { id: '5x1', label: '5x1' },
  { id: '6x2', label: '6x2' },
  { id: 'adm5x2', label: 'ADM 5x2' },
];
function escalaTypeLabel(tag) {
  return (ESCALA_TYPES.find((t) => t.id === tag) || {}).label || tag;
}

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
  tipoEscala: null, // definido em boot(), ver initTipoEscala()
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
    return {
      contato: raw.contato || {},
      dias: raw.dias || {},
      equipe: raw.equipe || {},
      moves: raw.moves || {},        // numero equipamento -> grupo de destino
      newEquip: raw.newEquip || {},  // numero equipamento (criado do zero) -> grupo
      newGrupos: raw.newGrupos || [], // grupos criados do zero (podem estar vazios)
      novosColaboradores: raw.novosColaboradores || {}, // tabId -> [{__pk, nome, matricula, grupo, papelNormalizado, lider, telefone}]
    };
  } catch {
    return { contato: {}, dias: {}, equipe: {}, moves: {}, newEquip: {}, newGrupos: [], novosColaboradores: {} };
  }
}

const edits = loadEdits();

function persistEdits() {
  localStorage.setItem(EDIT_STORAGE_KEY, JSON.stringify(edits));
  updateResetBtnVisibility();
}

function hasAnyEdits() {
  return Object.keys(edits.contato).length > 0 || Object.keys(edits.dias).length > 0 || Object.keys(edits.equipe).length > 0
    || Object.keys(edits.moves).length > 0 || Object.keys(edits.newEquip).length > 0 || edits.newGrupos.length > 0
    || Object.values(edits.novosColaboradores).some((arr) => arr.length > 0);
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
    materializeNovosColaboradores(ds, cfg);
    ds.colaboradores.forEach((p) => {
      // Uma pessoa criada do zero (ver materializeNovosColaboradores) já
      // chega com __pk definido — preservado aqui, não recalculado, para
      // continuar batendo com a chave usada em edits.contato/edits.dias.
      p.__pk = p.__pk || computeOriginalKey(cfg.id, p.nome, p.grupo);
      const pk = p.__pk;
      const contato = edits.contato[pk];
      if (contato) Object.assign(p, contato);
      const dias = edits.dias[pk];
      if (dias) {
        Object.keys(dias).forEach((monthKey) => {
          if (!p.escala[monthKey]) {
            const meta = ds.meses.find((m) => m.chave === monthKey);
            if (!meta) return;
            p.escala[monthKey] = 'O'.repeat(meta.dias); // mês sem dados na planilha: começa como "tudo folga" até editar
          }
          const chars = p.escala[monthKey].split('');
          Object.keys(dias[monthKey]).forEach((dayIdx) => { chars[dayIdx] = dias[monthKey][dayIdx]; });
          p.escala[monthKey] = chars.join('');
        });
      }
    });
  });
}

// Escala automática para uma pessoa nova: em 'adm5x2' já cai certo (5x2 é
// um padrão fixo de calendário — fim de semana é folga), nos outros tipos
// (rotações 5x1/6x2) não dá pra adivinhar o turno de folga de alguém
// recém-criado, então começa tudo como trabalho e a pessoa marca as folgas
// clicando nos dias (modo de edição).
function buildAutoEscala(ds, cfg) {
  const escala = {};
  ds.meses.forEach((m) => {
    if (cfg.tag === 'adm5x2') {
      let s = '';
      for (let d = 1; d <= m.dias; d++) {
        const wd = new Date(ds.ano, m.numero - 1, d).getDay();
        s += (wd === 0 || wd === 6) ? 'O' : 'W';
      }
      escala[m.chave] = s;
    } else {
      escala[m.chave] = 'W'.repeat(m.dias);
    }
  });
  return escala;
}

function materializeNovosColaboradores(ds, cfg) {
  (edits.novosColaboradores[cfg.id] || []).forEach((nc) => {
    if (ds.colaboradores.some((p) => p.__pk === nc.__pk)) return;
    ds.colaboradores.push({ ...nc, escala: buildAutoEscala(ds, cfg) });
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

// Reatribuição de equipamentos entre grupos (só existe para 'motoristas' —
// é a única aba onde a equipe é organizada em grupos de equipamentos).
// Um equipamento vira do grupo em que está para o grupo de destino,
// criando o grupo de destino se ainda não existir. numero é global e
// único entre grupos (garantido no momento de criar/mover), então não
// precisa saber o grupo de origem para achar o equipamento.
function moveEquipamentoToGrupo(ds, numero, targetGrupo) {
  let equip = null;
  for (const g of ds.mestre) {
    const idx = g.equipamentos.findIndex((e) => e.numero === numero);
    if (idx !== -1) {
      if (g.grupo === targetGrupo) return false;
      equip = g.equipamentos.splice(idx, 1)[0];
      break;
    }
  }
  if (!equip) return false;
  let alvo = ds.mestre.find((g) => g.grupo === targetGrupo);
  if (!alvo) {
    alvo = { grupo: targetGrupo, equipamentos: [], folguistas: {} };
    ds.mestre.push(alvo);
  }
  alvo.equipamentos.push(equip);
  return true;
}

function equipamentoExiste(ds, numero) {
  return ds.mestre.some((g) => g.equipamentos.some((e) => e.numero === numero));
}

function ordenarMestre(ds) {
  ds.mestre.sort((a, b) => a.grupo.localeCompare(b.grupo, 'pt-BR', { numeric: true }));
}

// Reconstrói, sobre os dados originais da planilha, os grupos/equipamentos
// criados do zero e as trocas de grupo feitas em modo de edição — chamado
// uma vez no boot, antes de renderizar.
function applyStoredMestreOps(ds) {
  edits.newGrupos.forEach((nome) => {
    if (!ds.mestre.find((g) => g.grupo === nome)) ds.mestre.push({ grupo: nome, equipamentos: [], folguistas: {} });
  });
  Object.keys(edits.newEquip).forEach((numero) => {
    if (equipamentoExiste(ds, numero)) return;
    const grupo = edits.newEquip[numero];
    let g = ds.mestre.find((x) => x.grupo === grupo);
    if (!g) { g = { grupo, equipamentos: [], folguistas: {} }; ds.mestre.push(g); }
    g.equipamentos.push({ numero, turnos: {} });
  });
  Object.keys(edits.moves).forEach((numero) => moveEquipamentoToGrupo(ds, numero, edits.moves[numero]));
  ordenarMestre(ds);
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
  // Sem valor salvo, o tipo inicial acompanha a última aba aberta (em vez
  // de sempre cair em '5x1'), pra essa mudança não "esconder" a aba que a
  // pessoa já estava usando.
  state.tipoEscala = localStorage.getItem('escala:tipoEscala') || (TABS.find((t) => t.id === state.activeTab) || {}).tag || '5x1';

  const results = TABS.map((t) => loadDataset(t));
  TABS.forEach((t, i) => { datasets[t.id] = results[i]; });
  applyStoredEditsToDatasets();
  if (datasets.motoristas && datasets.motoristas.mestre) applyStoredMestreOps(datasets.motoristas);

  const now = new Date();
  TABS.forEach((t) => {
    const d = datasets[t.id];
    state.collapsed[t.id] = new Set();
    state.month[t.id] = monthKeyForRealDate(d, now) || d.meses[0].chave;
    if (t.hasUnits) state.unit[t.id] = d.unidades[0].codigo;
    state.view[t.id] = 'escala';
  });

  renderTypeSwitch();
  renderTabsForType();
}

function tabsForType(tipo) {
  return TABS.filter((t) => t.tag === tipo);
}

function renderTypeSwitch() {
  const el = document.getElementById('escalaTypeSwitch');
  el.innerHTML = ESCALA_TYPES.map((t) => `
    <button class="type-btn ${state.tipoEscala === t.id ? 'active' : ''}" data-type="${t.id}">${t.label}</button>
  `).join('');
  el.querySelectorAll('.type-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.type === state.tipoEscala) return;
      state.tipoEscala = btn.dataset.type;
      localStorage.setItem('escala:tipoEscala', state.tipoEscala);
      renderTypeSwitch();
      renderTabsForType();
    });
  });
}

function renderTabsForType() {
  const nav = document.getElementById('tabs');
  const visible = tabsForType(state.tipoEscala);

  if (!visible.length) {
    nav.innerHTML = '';
    document.getElementById('app').innerHTML = `
      <div class="empty-state">
        Ainda não há uma planilha de Escala ADM 5x2 cadastrada.
        <br><small style="display:block;margin-top:8px;opacity:.7">Assim que a planilha oficial desse tipo for enviada (mesmo padrão das outras: abas NOMES e MESTRE + uma aba por mês, com a cor de preenchimento da célula indicando trabalho ou folga), essa opção passa a mostrar os dados aqui.</small>
      </div>`;
    return;
  }

  nav.innerHTML = visible.map((t) => `
    <button class="tab" data-tab="${t.id}">
      ${t.label} <span class="tab-tag">${escalaTypeLabel(t.tag)}</span>
    </button>
  `).join('');
  nav.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab, false));
  });

  const activeStillVisible = visible.some((t) => t.id === state.activeTab);
  activateTab(activeStillVisible ? state.activeTab : visible[0].id, true);
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

// Exporta exatamente o que está filtrado/visível na tela (busca, grupo,
// turno e — quando a aba tem UO — a UO selecionada), então pra baixar só
// os dados de uma UO basta selecioná-la antes de exportar.
function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportCsv(ds, cfg) {
  const people = visiblePeople();
  const headers = ['Nome', 'Matrícula', 'Grupo', 'Turno', 'Líder', 'Telefone'];
  if (cfg.hasUnits) headers.push('UO');
  const rows = people.map((p) => {
    const row = [p.nome, p.matricula ?? '', p.grupo ?? '', p.papelNormalizado ?? '', p.lider ?? '', p.telefone ?? ''];
    if (cfg.hasUnits) row.push(p.unidade ?? '');
    return row;
  });
  const csv = '﻿' + [headers, ...rows].map((r) => r.map(csvEscape).join(';')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const unitSuffix = cfg.hasUnits ? `_UO${state.unit[cfg.id]}` : '';
  const a = document.createElement('a');
  a.href = url;
  a.download = `escala_${cfg.id}${unitSuffix}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
        ${!isEquipe && state.editMode ? `<button class="icon-btn" id="addColaboradorBtn">+ Adicionar colaborador</button>` : ''}
        ${!isEquipe ? `<button class="icon-btn" id="exportCsvBtn">⬇ Exportar CSV</button>` : ''}
        <button class="icon-btn" id="printBtn">🖨 Imprimir</button>
      </div>
    </div>
    <div id="viewBody"></div>
  `;

  renderMonthPills(ds, cfg, monthMeta);

  if (isEquipe) {
    const viewBody = document.getElementById('viewBody');
    viewBody.innerHTML = renderEquipeHtml(ds, cfg, mestre);
    if (state.editMode) {
      wireEquipeEdits(viewBody);
      if (cfg.id === 'motoristas') wireEquipeStructure(viewBody, ds);
    }
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
  const exportBtn = document.getElementById('exportCsvBtn');
  if (exportBtn) exportBtn.addEventListener('click', () => exportCsv(ds, cfg));
  const addColaboradorBtn = document.getElementById('addColaboradorBtn');
  if (addColaboradorBtn) addColaboradorBtn.addEventListener('click', () => openModal(null, monthMeta, cfg, ds, true));
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

// Verdadeiro só quando já existem colaboradores na aba mas nenhum tem
// dados pra esse mês (ex.: Dezembro do Master Driver, cuja aba de origem
// veio com o conteúdo errado). Numa aba recém-criada e ainda vazia (ex.:
// ADM 5x2 sem ninguém cadastrado) isso não deve disparar — por isso o
// `length > 0` antes do every().
function monthHasNoData(ds, mesChave) {
  return ds.colaboradores.length > 0 && ds.colaboradores.every((p) => !p.escala[mesChave]);
}

function renderUnitSwitch(ds, cfg) {
  const dez = ds.meses.find((m) => m.numero === 12);
  const dezBlank = dez && monthHasNoData(ds, dez.chave);
  return `
    <div class="unit-switch" id="unitSwitch">
      ${ds.unidades.map((u) => `
        <button class="unit-btn ${state.unit[cfg.id] === u.codigo ? 'active' : ''}" data-unit="${u.codigo}">
          <span class="uo-code">UO ${u.uo}</span>${u.codigo}
        </button>`).join('')}
    </div>
    ${dezBlank ? `<div class="unit-note" style="display:block">⚠ Dezembro está com os dias em branco — a planilha de origem trazia, nesse mês, os dados de outra escala (Líder de Turno/Pátio) por engano. ${state.editMode ? 'Clique nos dias do calendário abaixo para preencher manualmente.' : 'Ative o modo de edição (✏️ Editar no topo) pra preencher os dias manualmente, ou envie a planilha corrigida.'}</div>` : ''}
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

function equipeGrupoHtml(g, allGrupos) {
  const moveSelect = (numero) => `
    <select class="equip-move-select" data-equip="${numero}" title="Mover para outro grupo">
      ${allGrupos.map((gn) => `<option value="${gn}" ${gn === g.grupo ? 'selected' : ''}>${gn}</option>`).join('')}
      <option value="__novo__">+ Novo grupo…</option>
    </select>`;
  const rows = g.equipamentos.map((e) => `
    <tr>
      <td class="col-nome">
        <span class="nome">Equip. ${e.numero}</span>${e.status ? `<span class="equipe-mat">${e.status}</span>` : ''}
        ${state.editMode ? moveSelect(e.numero) : ''}
      </td>
      <td>${equipePessoaHtml(e.turnos.A, `motoristas|equip|${e.numero}|A`)}</td>
      <td>${equipePessoaHtml(e.turnos.B, `motoristas|equip|${e.numero}|B`)}</td>
      <td>${equipePessoaHtml(e.turnos.C, `motoristas|equip|${e.numero}|C`)}</td>
    </tr>`).join('');
  const temFolguistas = state.editMode || ['A', 'B', 'C'].some((t) => g.folguistas[t]);
  const folguistaBase = `motoristas|grupo|${g.grupo}`;
  return `
    <div class="equipe-grupo" data-grupo="${g.grupo}">
      <h3>${g.grupo}</h3>
      <table class="equipe-table">
        <thead><tr><th>Equipamento</th><th>Turno A</th><th>Turno B</th><th>Turno C</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${!g.equipamentos.length ? '<p class="equipe-vazio-msg">Nenhum equipamento neste grupo ainda.</p>' : ''}
      ${state.editMode ? `<button class="icon-btn equip-add-btn" data-grupo="${g.grupo}">+ Adicionar equipamento</button>` : ''}
      ${temFolguistas ? `
        <div class="equipe-folguistas">
          ${['A', 'B', 'C'].map((t) => (g.folguistas[t] || state.editMode) ? `<div class="equipe-folguista"><b>Folguista ${t}</b> ${equipePessoaText(g.folguistas[t], `${folguistaBase}|folguista|${t}`)}</div>` : '').join('')}
        </div>` : ''}
    </div>`;
}

function renderEquipeHtml(ds, cfg, mestre) {
  if (cfg.id === 'motoristas') {
    const visiveis = state.editMode ? mestre : mestre.filter((g) => g.equipamentos.length || Object.keys(g.folguistas).length);
    const allGrupos = mestre.map((g) => g.grupo);
    return `<div class="equipe-wrap">
      ${state.editMode ? `<button class="icon-btn" id="addGrupoBtn">+ Adicionar novo grupo</button>` : ''}
      ${visiveis.map((g) => equipeGrupoHtml(g, allGrupos)).join('')}
    </div>`;
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

// Controles de estrutura da Equipe (só motoristas): mover equipamento de
// grupo, adicionar equipamento novo, adicionar grupo novo do zero.
function wireEquipeStructure(container, ds) {
  container.querySelectorAll('.equip-move-select').forEach((sel) => {
    const original = sel.value;
    sel.addEventListener('change', () => {
      const numero = sel.dataset.equip;
      let target = sel.value;
      if (target === '__novo__') {
        target = (prompt('Nome do novo grupo (ex.: GRUPO 09):') || '').trim().toUpperCase();
        if (!target) { sel.value = original; return; }
        if (!edits.newGrupos.includes(target) && !ds.mestre.some((g) => g.grupo === target)) edits.newGrupos.push(target);
      }
      edits.moves[numero] = target;
      persistEdits();
      moveEquipamentoToGrupo(ds, numero, target);
      ordenarMestre(ds);
      renderPanel();
    });
  });

  container.querySelectorAll('.equip-add-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const grupo = btn.dataset.grupo;
      const numero = (prompt('Número do equipamento (veículo) a adicionar:') || '').trim();
      if (!numero) return;
      if (equipamentoExiste(ds, numero)) { alert(`Já existe um equipamento ${numero} cadastrado.`); return; }
      edits.newEquip[numero] = grupo;
      persistEdits();
      applyStoredMestreOps(ds);
      renderPanel();
    });
  });

  const addGrupoBtn = document.getElementById('addGrupoBtn');
  if (addGrupoBtn) addGrupoBtn.addEventListener('click', () => {
    const nome = (prompt('Nome do novo grupo (ex.: GRUPO 09):') || '').trim().toUpperCase();
    if (!nome) return;
    if (ds.mestre.some((g) => g.grupo === nome)) { alert(`O grupo "${nome}" já existe.`); return; }
    edits.newGrupos.push(nome);
    persistEdits();
    applyStoredMestreOps(ds);
    renderPanel();
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
    <div class="card"><b>${escalaTypeLabel(cfg.tag)}</b><span>Padrão de escala</span></div>
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
      openModal(ds.colaboradores.find((p) => p.__key === row.dataset.key), monthMeta, cfg, ds);
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
  // Mês sem dados na planilha de origem (ex.: Dezembro do Master Driver)
  // começa em branco — o primeiro clique inicializa o mês como "tudo
  // folga" e então marca só o dia clicado, em vez de não fazer nada.
  const chars = (p.escala[monthKey] || 'O'.repeat(monthMeta.dias)).split('');
  const idx = day - 1;
  if (idx < 0 || idx >= chars.length) return;
  const next = chars[idx] === 'W' ? 'O' : 'W';
  chars[idx] = next;
  p.escala[monthKey] = chars.join('');

  const pk = personKey(cfg.id, p);
  edits.dias[pk] = edits.dias[pk] || {};
  edits.dias[pk][monthKey] = edits.dias[pk][monthKey] || {};
  edits.dias[pk][monthKey][idx] = next;
  persistEdits();

  cellEl.classList.remove('work', 'off', 'nodata');
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

function openModal(p, monthMeta, cfg, ds, isNew) {
  if (!p && !isNew) return;
  if (isNew) p = { nome: '', matricula: null, grupo: '', papelNormalizado: '', lider: null, telefone: null, escala: {} };
  const { w, o } = countWorkOff(p.escala[monthMeta.chave]);
  const backdrop = document.getElementById('modalBackdrop');

  if (state.editMode && cfg) {
    const grupos = ds ? [...new Set(ds.colaboradores.map((x) => x.grupo).filter(Boolean))] : [];
    const papeis = ds ? [...new Set(ds.colaboradores.map((x) => x.papelNormalizado).filter(Boolean))] : [];
    backdrop.innerHTML = `
      <div class="modal">
        <div class="modal-head">
          <button class="modal-close" id="modalClose">✕</button>
          <h3>${isNew ? 'Adicionar colaborador' : 'Editar colaborador'}</h3>
          <span>${cfg.hasUnits ? (ds.unidades.find((u) => u.codigo === state.unit[cfg.id]) || {}).label || '' : `${p.grupo || ''}${p.grupo && p.papelNormalizado ? ' · ' : ''}${p.papelNormalizado || ''}`}</span>
        </div>
        <div class="modal-body">
          <div class="modal-row edit"><span class="k">Nome</span><input class="modal-input" id="editNome" value="${p.nome || ''}"></div>
          <div class="modal-row edit"><span class="k">Matrícula</span><input class="modal-input" id="editMatricula" value="${p.matricula || ''}"></div>
          <div class="modal-row edit"><span class="k">Turno</span><input class="modal-input" id="editTurno" list="turnoOptions" value="${p.papelNormalizado || ''}"></div>
          <datalist id="turnoOptions">${papeis.map((v) => `<option value="${v}">`).join('')}</datalist>
          <div class="modal-row edit"><span class="k">Grupo</span><input class="modal-input" id="editGrupo" list="grupoOptions" value="${p.grupo || ''}"></div>
          <datalist id="grupoOptions">${grupos.map((v) => `<option value="${v}">`).join('')}</datalist>
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
      const values = {
        nome: document.getElementById('editNome').value.trim(),
        matricula: as_int_or_null(document.getElementById('editMatricula').value.trim()),
        papelNormalizado: document.getElementById('editTurno').value.trim() || null,
        grupo: document.getElementById('editGrupo').value.trim() || null,
        lider: document.getElementById('editLider').value.trim() || null,
        telefone: document.getElementById('editTelefone').value.trim() || null,
      };
      if (isNew) {
        if (!values.nome) { alert('Informe o nome do colaborador.'); return; }
        if (cfg.hasUnits) values.unidade = state.unit[cfg.id];
        const novo = { ...values, __pk: `${cfg.id}|novo|${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, escala: buildAutoEscala(ds, cfg) };
        ds.colaboradores.push(novo);
        edits.novosColaboradores[cfg.id] = edits.novosColaboradores[cfg.id] || [];
        edits.novosColaboradores[cfg.id].push({ __pk: novo.__pk, nome: novo.nome, matricula: novo.matricula, papelNormalizado: novo.papelNormalizado, grupo: novo.grupo, lider: novo.lider, telefone: novo.telefone, unidade: novo.unidade });
        persistEdits();
      } else {
        values.nome = values.nome || p.nome;
        const pk = personKey(cfg.id, p);
        Object.assign(p, values);
        edits.contato[pk] = { ...edits.contato[pk], ...values };
        persistEdits();
      }
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
