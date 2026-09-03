'use strict';

/* ------------------------------------------------------------------ */
/*  Instalar como app (PWA)                                            */
/*  O navegador só dispara esse evento se o site puder ser instalado   */
/*  (manifest + service worker, https) e ainda não tiver sido           */
/*  instalado — por isso o botão nasce escondido e só aparece aqui.    */
/*  Não existe em iOS/Safari (lá é "Adicionar à Tela de Início" manual  */
/*  no menu de compartilhar, sem essa API).                            */
/* ------------------------------------------------------------------ */

let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById('installAppBtn');
  if (btn) btn.style.display = '';
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  const btn = document.getElementById('installAppBtn');
  if (btn) btn.style.display = 'none';
});

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const TABS = [
  { id: 'motoristas', label: 'Motoristas Canavieiros', tag: '5x1', dataVar: 'DATA_MOTORISTAS_META', hasGroups: true, hasUnits: true },
  { id: 'lideres_turno', label: 'Líder de Turno', tag: '6x2', dataVar: 'DATA_LIDERES_TURNO', hasGroups: false, hasUnits: true },
  { id: 'lideres_patio', label: 'Líder de Pátio', tag: '6x2', dataVar: 'DATA_LIDERES_PATIO', hasGroups: false, hasUnits: true },
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
  page: 'app',     // 'app' | 'dashboard' | 'efetivos'
  dashUnit: 'todos', // 'todos' | 'MNS' | 'PRA' — filtro de UO no Dashboard
  efetivosUnit: 'MNS', // UO selecionada na aba Motoristas Efetivos
  efetivosSource: 'motoristas', // de qual escala puxar a lista de seleção na aba Efetivos
  bhFiltro: { de: '', ate: '', unidade: '' }, // período (datas ISO) + UO selecionados na aba Ausência
  dashAusenciaFiltro: { de: '', ate: '', turno: '' }, // período + turno do card de Ausências/Afastados no Dashboard
  afastadosFiltro: { de: '', ate: '', unidade: '' }, // filtro (previsão de retorno + UO) na aba Afastados
  role: 'visualizador', // 'adm' | 'visualizador' — 'adm' só depois de entrar com a senha, ver showAdmLoginModal()
};

const datasets = {}; // tabId -> parsed json

/* ------------------------------------------------------------------ */
/*  Edições locais (modo edição)                                       */
/*  Sem backend: as edições ficam salvas só neste navegador            */
/*  (localStorage), não são sincronizadas entre dispositivos.          */
/* ------------------------------------------------------------------ */

const EDIT_STORAGE_KEY = 'escala:edits:v1';

// Só os campos que o app realmente usa — qualquer outra coisa no objeto
// bruto (ex.: os campos "_backup_diaN" que o firebase-sync.js grava no
// mesmo documento como rede de segurança) é ignorada aqui. Usado tanto
// pra montar "edits" quanto, em bootstrapFirebaseSync, pra "limpar" o
// dado que vem do Firestore antes de comparar com o local — senão um
// campo extra que só existe lá faz o app achar que é sempre diferente e
// recarregar sem parar.
function normalizeEditsShape(raw) {
  raw = raw || {};
  return {
    contato: raw.contato || {},
    dias: raw.dias || {},
    equipe: raw.equipe || {},
    moves: raw.moves || {},        // numero equipamento -> grupo de destino
    newEquip: raw.newEquip || {},  // numero equipamento (criado do zero) -> grupo
    newGrupos: raw.newGrupos || [], // grupos criados do zero (podem estar vazios)
    novosColaboradores: raw.novosColaboradores || {}, // tabId -> [{__pk, nome, matricula, grupo, papelNormalizado, lider, telefone}]
    limpo: raw.limpo || {}, // "tabId" ou "tabId|UO" -> true (colaboradores originais da planilha escondidos)
    rotacao: raw.rotacao || {}, // pk -> epochDay âncora (dia de folga) do padrão 5x1/6x2 dessa pessoa
    renumeracoes: raw.renumeracoes || {}, // numero antigo -> numero novo (equipamento renomeado)
    metas: raw.metas || {}, // "tabId|turno|UO" -> meta de vagas (controle de vagas do dashboard)
    driversDb: raw.driversDb || {}, // matrícula (string) -> {nome, unidade} — banco central pra autocompletar nome pela matrícula
    bancoHoras: raw.bancoHoras || [], // [{id, pk, data, nome, matricula, turno, lider, tipo:'BH'|'ATESTADO'}]
  };
}

function loadEdits() {
  try {
    return normalizeEditsShape(JSON.parse(localStorage.getItem(EDIT_STORAGE_KEY) || '{}'));
  } catch {
    return normalizeEditsShape({});
  }
}

const edits = loadEdits();

function persistEdits() {
  localStorage.setItem(EDIT_STORAGE_KEY, JSON.stringify(edits));
  if (window.__firebaseSync && window.__firebaseSync.ready) window.__firebaseSync.pushEdits(edits);
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

// Dia como inteiro contínuo (dias desde a época Unix) — permite comparar
// dias entre meses/anos diferentes sem se preocupar com quantos dias cada
// mês tem.
function epochDay(year, monthNumero, day) {
  return Math.floor(Date.UTC(year, monthNumero - 1, day) / 86400000);
}

function isoDateFor(year, monthNumero, day) {
  return `${year}-${String(monthNumero).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// 5x1 = 5 dias de trabalho + 1 de folga (ciclo de 6); 6x2 = 6 + 2 (ciclo
// de 8) — é o padrão real observado nas planilhas (ex.: "OWWWWWOWWWWWO...").
// ADM 5x2 não é uma rotação pessoal (é o calendário: fim de semana fixo),
// então não entra aqui — ver buildAutoEscala.
function rotationParamsFor(cfg) {
  if (cfg.tag === '5x1') return { workDays: 5, offDays: 1 };
  if (cfg.tag === '6x2') return { workDays: 6, offDays: 2 };
  return null;
}

// Regenera a escala inteira (todos os meses) de uma pessoa a partir de um
// único dia-âncora de folga, repetindo o ciclo de trabalho/folga do tipo
// de escala da aba pra sempre (passado e futuro) — assim o padrão
// continua igual de um mês pro outro, sem "emenda".
function applyRotation(ds, cfg, p, anchorEpoch) {
  const rot = rotationParamsFor(cfg);
  if (!rot) return;
  const cycleLen = rot.workDays + rot.offDays;
  ds.meses.forEach((m) => {
    let s = '';
    for (let d = 1; d <= m.dias; d++) {
      const offset = ((epochDay(ds.ano, m.numero, d) - anchorEpoch) % cycleLen + cycleLen) % cycleLen;
      s += offset < rot.offDays ? 'O' : 'W';
    }
    p.escala[m.chave] = s;
  });
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
      // O padrão de rotação (se essa pessoa tiver um) é a base — os
      // ajustes de dia avulso (dias, abaixo) entram como remendo por cima.
      if (edits.rotacao[pk] !== undefined) applyRotation(ds, cfg, p, edits.rotacao[pk]);
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

// "Limpar dados": esconde os colaboradores originais da planilha (de uma
// aba inteira, ou só de uma UO quando a aba tem UO) pra montar um
// cadastro do zero com "+ Adicionar colaborador", sem inventar/apagar o
// arquivo de origem — reversível a qualquer momento com "Restaurar
// original". unidade é undefined para abas sem UO.
function clearKey(cfg, unidade) {
  return cfg.id + (unidade ? `|${unidade}` : '');
}

function applyClearedFilter(ds, cfg) {
  if (!cfg.hasUnits) {
    if (edits.limpo[clearKey(cfg)]) ds.colaboradores = [];
    return;
  }
  ds.colaboradores = ds.colaboradores.filter((p) => !edits.limpo[clearKey(cfg, p.unidade)]);
}

function clearTabData(ds, cfg) {
  const unidade = cfg.hasUnits ? state.unit[cfg.id] : undefined;
  edits.limpo[clearKey(cfg, unidade)] = true;
  if (edits.novosColaboradores[cfg.id]) {
    edits.novosColaboradores[cfg.id] = edits.novosColaboradores[cfg.id].filter((nc) => cfg.hasUnits && nc.unidade !== unidade);
  }
  persistEdits();
  ds.colaboradores = ds.colaboradores.filter((p) => cfg.hasUnits && p.unidade !== unidade);
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
function moveEquipamentoToGrupo(ds, numero, targetGrupo, unidade) {
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
  let alvo = ds.mestre.find((g) => g.grupo === targetGrupo && (unidade === undefined || g.unidade === unidade));
  if (!alvo) {
    alvo = { grupo: targetGrupo, equipamentos: [], folguistas: {}, unidade };
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
  // Precisa rodar antes de newEquip/moves: esses já foram migrados pro
  // número novo no momento da renomeação (ver renameEquipamento), então o
  // equipamento de origem (que ainda está com o número antigo, vindo puro
  // da planilha) tem que ser renumerado primeiro pra bater com eles.
  Object.keys(edits.renumeracoes).forEach((numeroAntigo) => {
    const novo = edits.renumeracoes[numeroAntigo];
    for (const g of ds.mestre) {
      const eq = g.equipamentos.find((x) => x.numero === numeroAntigo);
      if (eq) { eq.numero = novo; break; }
    }
  });
  edits.newGrupos.forEach(({ nome, unidade }) => {
    if (!ds.mestre.find((g) => g.grupo === nome && g.unidade === unidade)) ds.mestre.push({ grupo: nome, equipamentos: [], folguistas: {}, unidade });
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
  TABS.forEach((t) => { if (datasets[t.id]) applyClearedFilter(datasets[t.id], t); });
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

/* ------------------------------------------------------------------ */
/*  Dashboard — visão geral e controle de vagas por turno/UO           */
/* ------------------------------------------------------------------ */

// adm5x2 fica de fora: não tem turno A/B/C fixo (o "Turno" de lá é texto
// livre digitado na hora de cadastrar, ex. "Comercial"), então não dá pra
// controlar vaga por turno do mesmo jeito que as escalas rotativas.
const DASHBOARD_ROLES = [
  { tabId: 'motoristas', label: 'Motoristas Canavieiros' },
  { tabId: 'lideres_turno', label: 'Líder de Turno' },
  { tabId: 'lideres_patio', label: 'Líder de Pátio' },
  { tabId: 'master_driver', label: 'Master Driver' },
  { tabId: 'adm5x2', label: 'Administrativo', turnos: ['ADM'] }, // 5x2 fixo, sem turno A/B/C — uma linha só por UO
];

function metaKey(tabId, papel, unidade) {
  return `${tabId}|${papel}|${unidade}`;
}

function contagemAtual(tabId, papel, unidade) {
  const ds = datasets[tabId];
  if (!ds) return 0;
  if (papel === 'ADM') return ds.colaboradores.filter((p) => p.unidade === unidade).length;
  return ds.colaboradores.filter((p) => p.unidade === unidade && p.papelNormalizado === papel).length;
}

// Papéis que existem de verdade nos dados dessa aba (Turno A/B/C, mas
// também Folguista/Apoio quando existirem) — em vez de uma lista fixa,
// pra nenhuma categoria real ficar de fora da contagem do Dashboard.
function papeisPresentes(tabId) {
  const ds = datasets[tabId];
  if (!ds) return [];
  const set = new Set();
  ds.colaboradores.forEach((p) => { if (p.papelNormalizado) set.add(p.papelNormalizado); });
  return [...set].sort((a, b) => papelPriority(a) - papelPriority(b));
}

function renderDashboardRoleTable(role) {
  const ds = datasets[role.tabId];
  if (!ds) return '';
  const unidades = (ds.unidades || []).filter((u) => state.dashUnit === 'todos' || u.codigo === state.dashUnit);
  const papeis = role.turnos || papeisPresentes(role.tabId);
  let totalAtual = 0, totalMeta = 0, totalVagas = 0;
  const rows = [];
  unidades.forEach((u) => {
    papeis.forEach((papel) => {
      const atual = contagemAtual(role.tabId, papel, u.codigo);
      const key = metaKey(role.tabId, papel, u.codigo);
      const meta = edits.metas[key] || 0;
      const vagas = Math.max(meta - atual, 0);
      totalAtual += atual; totalMeta += meta; totalVagas += vagas;
      rows.push(`
        <tr>
          <td>${u.label}</td>
          <td>${papel}</td>
          <td class="num">${atual}</td>
          <td class="num">${state.editMode ? `<input type="number" min="0" class="meta-input" data-key="${key}" value="${meta}">` : meta}</td>
          <td class="num vagas ${vagas > 0 ? 'vagas-aberta' : 'vagas-ok'}">${vagas}</td>
        </tr>`);
    });
  });
  if (!rows.length) return `<div class="dash-role"><h3>${role.label}</h3><p class="dash-driverdb-empty">Sem colaboradores cadastrados${state.dashUnit !== 'todos' ? ' nessa UO' : ''}.</p></div>`;
  return `
    <div class="dash-role">
      <h3>${role.label}</h3>
      <div class="table-scroll"><table class="dash-table">
        <thead><tr><th>UO</th><th>Turno</th><th>Atual</th><th>Meta</th><th>Vagas</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
        <tfoot><tr><td colspan="2">Total</td><td class="num">${totalAtual}</td><td class="num">${totalMeta}</td><td class="num">${totalVagas}</td></tr></tfoot>
      </table></div>
    </div>`;
}

// Linha CSV simples (';' como separador, aspas duplas pra escapar) —
// usada só pelo import do banco de motoristas (Nome;Matrícula;UO).
function parseSimpleCsvLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; } }
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ';') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function importDriversDbText(text) {
  const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const lines = clean.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return 0;
  const header = parseSimpleCsvLine(lines[0]).map((h) => h.trim());
  const iNome = header.indexOf('Nome'), iMat = header.indexOf('Matrícula'), iUO = header.indexOf('UO');
  if (iNome === -1 || iMat === -1) return 0;
  let count = 0;
  for (let li = 1; li < lines.length; li++) {
    const cols = parseSimpleCsvLine(lines[li]);
    const nome = (cols[iNome] || '').trim();
    const matricula = (cols[iMat] || '').trim();
    if (!nome || !matricula) continue;
    edits.driversDb[matricula] = { nome, unidade: iUO !== -1 ? (cols[iUO] || '').trim() || null : null };
    count++;
  }
  if (count) persistEdits();
  return count;
}

// Preenche o campo de nome a partir da matrícula digitada, usando o banco
// de motoristas — não mexe no nome se a matrícula não tiver cadastro.
function wireMatriculaLookup(matriculaEl, nomeEl) {
  const lookup = () => {
    const mat = matriculaEl.value !== undefined ? matriculaEl.value.trim() : matriculaEl.textContent.trim();
    const found = mat && edits.driversDb[mat];
    if (!found) return;
    if (nomeEl.value !== undefined) nomeEl.value = found.nome; else nomeEl.textContent = found.nome;
  };
  matriculaEl.addEventListener('blur', lookup);
}

// Só a tabela principal (nome/matrícula/remover) — usada pra atualizar
// depois de marcar/desmarcar um checkbox da lista de seleção sem
// redesenhar a página inteira (o que resetaria a busca/filtro no meio
// do clique, causando comportamento estranho com uma lista de 100+
// itens reaparecendo de repente embaixo do cursor).
// Pra quem foi selecionado a partir de uma escala já existente, acha em
// qual delas essa matrícula está cadastrada hoje (sem precisar guardar
// isso separado, e sem ficar desatualizado se a pessoa mudar de função
// depois). Pra quem foi cadastrado manualmente, usa o cargo escolhido
// no formulário.
function cargoDoEfetivo(matricula, driverEntry) {
  if (driverEntry && driverEntry.cargo) return driverEntry.cargo;
  for (const s of EFETIVOS_SOURCES) {
    const ds = datasets[s.tabId];
    if (ds && ds.colaboradores.some((p) => String(p.matricula) === String(matricula))) return s.label;
  }
  return null;
}

function renderEfetivosTable() {
  // Afastados ficam de fora daqui — têm aba própria (Afastados), separada
  // do cadastro ativo, por pedido.
  const entries = Object.entries(edits.driversDb).filter(([, v]) => v.unidade === state.efetivosUnit && !v.afastado);
  entries.sort((a, b) => a[1].nome.localeCompare(b[1].nome));
  const table = document.querySelector('.efetivos-table tbody');
  if (!table) return;
  table.innerHTML = entries.length ? entries.map(([mat, v]) => `
    <tr>
      <td>${v.nome}</td>
      <td>${mat}</td>
      <td>${cargoDoEfetivo(mat, v) || '—'}</td>
      ${state.editMode ? `<td class="num">
        <button class="icon-btn ef-afastar-btn" data-mat="${mat}" title="Marcar como afastado">🏥 Afastar</button>
        <button class="icon-btn danger ef-remove-btn" data-mat="${mat}" title="Remover">🗑</button>
      </td>` : ''}
    </tr>`).join('') : `<tr><td colspan="${state.editMode ? 4 : 3}"><div class="empty-state">Nenhum motorista cadastrado nessa UO ainda.</div></td></tr>`;
  table.querySelectorAll('.ef-remove-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const nomeRemover = btn.closest('tr').querySelector('td').textContent;
      const ok = await showConfirmModal(`Remover "${nomeRemover}" do cadastro de efetivos?`, { confirmLabel: 'Remover', danger: true });
      if (!ok) return;
      const mat = btn.dataset.mat;
      delete edits.driversDb[mat];
      persistEdits();
      const cb = document.querySelector(`.ef-select-check[data-mat="${CSS.escape(mat)}"]`);
      if (cb) cb.checked = false;
      renderEfetivosTable();
    });
  });
  table.querySelectorAll('.ef-afastar-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const mat = btn.dataset.mat;
      const nome = edits.driversDb[mat] ? edits.driversDb[mat].nome : '';
      const ok = await showConfirmModal(`Marcar "${nome}" como afastado? Ele sai daqui e passa a aparecer na aba Afastados, onde dá pra colocar o motivo e a previsão de retorno.`, { confirmLabel: 'Marcar afastado' });
      if (!ok || !edits.driversDb[mat]) return;
      edits.driversDb[mat].afastado = true;
      persistEdits();
      renderEfetivosTable();
    });
  });
}

// "2026-08-30" (formato do <input type="date">) -> "30/08/2026"
function formatDataBr(isoDate) {
  const [ano, mes, dia] = isoDate.split('-');
  return `${dia}/${mes}/${ano}`;
}

const EFETIVOS_SOURCES = [
  { tabId: 'motoristas', label: 'Motoristas Canavieiros' },
  { tabId: 'lideres_turno', label: 'Líder de Turno' },
  { tabId: 'lideres_patio', label: 'Líder de Pátio' },
  { tabId: 'master_driver', label: 'Master Driver' },
  { tabId: 'adm5x2', label: 'Administrativo' },
];

function renderEfetivos() {
  const app = document.getElementById('app');
  const unidadesRef = (Object.values(datasets).find((d) => d && d.unidades) || {}).unidades || [];
  const sourceCfg = EFETIVOS_SOURCES.find((s) => s.tabId === state.efetivosSource) || EFETIVOS_SOURCES[0];

  const sourcePool = (datasets[sourceCfg.tabId] ? datasets[sourceCfg.tabId].colaboradores : [])
    .filter((p) => p.unidade === state.efetivosUnit)
    .sort((a, b) => a.nome.localeCompare(b.nome));

  app.innerHTML = `
    <div class="panel-head">
      <h2>Motoristas Efetivos</h2>
      <p>Cadastro central de motoristas por matrícula — usado pra preencher o nome sozinho ao digitar a matrícula em qualquer aba.${state.editMode ? '' : ' Ative o modo de edição (✏️ Editar) pra cadastrar, importar ou remover.'}</p>
    </div>
    <div class="unit-switch" id="efetivosUnitSwitch">
      ${unidadesRef.map((u) => `<button class="unit-btn ${state.efetivosUnit === u.codigo ? 'active' : ''}" data-unit="${u.codigo}">${u.label}</button>`).join('')}
    </div>
    ${state.editMode ? `
      <div class="toolbar-tools efetivos-add">
        <div class="field"><input type="text" id="efNome" placeholder="Nome do motorista"></div>
        <div class="field"><input type="text" id="efMatricula" placeholder="Matrícula"></div>
        <div class="field"><select id="efCargo">
          <option value="">Cargo (opcional)</option>
          ${EFETIVOS_SOURCES.map((s) => `<option value="${s.label}">${s.label}</option>`).join('')}
        </select></div>
        <button class="icon-btn primary" id="efAddBtn">+ Adicionar</button>
        <label class="icon-btn" id="driverDbImportLabel">📥 Importar planilha (Nome;Matrícula;UO)<input type="file" accept=".csv,text/csv" id="driverDbImportInput" hidden></label>
      </div>` : ''}
    <div class="table-scroll">
      <table class="dash-table efetivos-table">
        <thead><tr><th>Nome</th><th>Matrícula</th><th>Cargo</th>${state.editMode ? '<th></th>' : ''}</tr></thead>
        <tbody></tbody>
      </table>
    </div>
    ${state.editMode ? `
      <div class="efetivos-select">
        <h3>Selecionar da escala de ${sourceCfg.label}</h3>
        <p>Marque quem é efetivo entre quem já está cadastrado na escala dessa UO — sem precisar digitar nome/matrícula de novo.</p>
        <div class="unit-switch" id="efetivosSourceSwitch">
          ${EFETIVOS_SOURCES.map((s) => `<button class="unit-btn ${state.efetivosSource === s.tabId ? 'active' : ''}" data-source="${s.tabId}">${s.label}</button>`).join('')}
        </div>
        <div class="field"><input type="search" id="efSelectSearch" placeholder="Buscar nome ou matrícula"></div>
        <div class="efetivos-select-list" id="efSelectList">
          ${sourcePool.length ? sourcePool.map((p) => `
            <label class="efetivos-select-row" data-nome="${normText(p.nome)}" data-mat="${p.matricula || ''}">
              <input type="checkbox" class="ef-select-check" data-mat="${p.matricula || ''}" data-nome="${p.nome.replace(/"/g, '&quot;')}" ${p.matricula && edits.driversDb[p.matricula] ? 'checked' : ''} ${!p.matricula ? 'disabled' : ''}>
              <span>${p.nome}${p.matricula ? ` <small>Mat. ${p.matricula}</small>` : ` <small>(sem matrícula — cadastre pelo campo acima)</small>`}</span>
            </label>`).join('') : `<div class="empty-state">Nenhum colaborador cadastrado na escala dessa UO ainda.</div>`}
        </div>
      </div>` : ''}
  `;
  renderEfetivosTable();

  document.getElementById('efetivosUnitSwitch').querySelectorAll('.unit-btn').forEach((btn) => {
    btn.addEventListener('click', () => { state.efetivosUnit = btn.dataset.unit; renderEfetivos(); });
  });
  const sourceSwitch = document.getElementById('efetivosSourceSwitch');
  if (sourceSwitch) sourceSwitch.querySelectorAll('.unit-btn').forEach((btn) => {
    btn.addEventListener('click', () => { state.efetivosSource = btn.dataset.source; renderEfetivos(); });
  });

  if (state.editMode) {
    document.getElementById('efAddBtn').addEventListener('click', () => {
      const nomeInput = document.getElementById('efNome');
      const matInput = document.getElementById('efMatricula');
      const cargoInput = document.getElementById('efCargo');
      const nome = nomeInput.value.trim();
      const matricula = matInput.value.trim();
      if (!nome || !matricula) { alert('Preencha nome e matrícula.'); return; }
      edits.driversDb[matricula] = { nome, unidade: state.efetivosUnit, cargo: cargoInput.value || undefined };
      persistEdits();
      nomeInput.value = '';
      matInput.value = '';
      cargoInput.value = '';
      const cb = document.querySelector(`.ef-select-check[data-mat="${CSS.escape(matricula)}"]`);
      if (cb) cb.checked = true;
      renderEfetivosTable();
    });
    // Um toggle não redesenha a página inteira (só a tabela acima) —
    // senão, com a busca ativa, a lista de 100+ nomes reaparece de
    // repente embaixo do cursor no meio do clique.
    app.querySelectorAll('.ef-select-check').forEach((cb) => {
      cb.addEventListener('change', () => {
        const mat = cb.dataset.mat;
        if (!mat) return;
        if (cb.checked) edits.driversDb[mat] = { nome: cb.dataset.nome, unidade: state.efetivosUnit };
        else delete edits.driversDb[mat];
        persistEdits();
        renderEfetivosTable();
      });
    });
    const selectSearch = document.getElementById('efSelectSearch');
    if (selectSearch) selectSearch.addEventListener('input', (e) => {
      const q = normText(e.target.value.trim());
      document.querySelectorAll('.efetivos-select-row').forEach((row) => {
        row.style.display = (!q || row.dataset.nome.includes(q) || row.dataset.mat.includes(q)) ? '' : 'none';
      });
    });
    const driverImportInput = document.getElementById('driverDbImportInput');
    if (driverImportInput) driverImportInput.addEventListener('change', async () => {
      const file = driverImportInput.files[0];
      if (!file) return;
      const text = await file.text();
      const count = importDriversDbText(text);
      driverImportInput.value = '';
      alert(count ? `${count} motorista(s) cadastrado(s) no banco.` : 'Nenhuma linha válida encontrada (confira se o cabeçalho é Nome;Matrícula;UO).');
      if (count) renderEfetivos();
    });
  }
}

const MESES_NOMES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

// Ano de referência pros filtros de período (Ausência/Afastados/Dashboard)
// — pega de qualquer dataset carregado, já que esses filtros não estão
// presos a uma aba de escala específica.
function anoRefEscalas() {
  return (Object.values(datasets).find((d) => d && d.ano) || {}).ano || new Date().getFullYear();
}

function monthBounds(ano, mesNumero) {
  return { de: isoDateFor(ano, mesNumero, 1), ate: isoDateFor(ano, mesNumero, new Date(ano, mesNumero, 0).getDate()) };
}

// <select> de "mês inteiro" pra preencher De/Até de uma vez, usado nos
// filtros de período de Ausência, Afastados e Dashboard. Fica sincronizado
// sozinho: se De/Até batem exatamente com um mês inteiro ele mostra
// selecionado, senão volta pro placeholder (ex: quando o filtro foi
// digitado a mão ou limpo).
function monthSelectHtml(id, de, ate) {
  const ano = anoRefEscalas();
  let selecionado = '';
  for (let m = 1; m <= 12; m++) {
    const b = monthBounds(ano, m);
    if (b.de === de && b.ate === ate) { selecionado = String(m); break; }
  }
  const opts = MESES_NOMES.map((nome, i) => `<option value="${i + 1}" ${selecionado === String(i + 1) ? 'selected' : ''}>${nome}</option>`).join('');
  return `<select id="${id}" title="Selecionar o mês inteiro"><option value="">Mês…</option>${opts}</select>`;
}

// Wire genérico do <select> de mês: ao escolher, sobrescreve de/ate do
// filtro informado (state[filtroKey]) com o mês inteiro e re-renderiza.
function wireMonthSelect(id, filtroKey, renderFn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', (e) => {
    if (!e.target.value) return;
    const b = monthBounds(anoRefEscalas(), Number(e.target.value));
    state[filtroKey].de = b.de;
    state[filtroKey].ate = b.ate;
    renderFn();
  });
}

// Apontamentos antigos (de antes da UO ser gravada no registro) recuperam
// a UO buscando a pessoa nos dados atuais da escala (por pk ou matrícula)
// — cobre qualquer motorista, não só quem está cadastrado em Efetivos.
// driversDb entra só como último recurso.
function bhUnidade(r) {
  if (r.unidade) return r.unidade;
  for (const cfg of TABS) {
    const ds = datasets[cfg.id];
    if (!ds) continue;
    const p = ds.colaboradores.find((c) =>
      personKey(cfg.id, c) === r.pk ||
      (r.matricula && c.matricula && String(c.matricula) === String(r.matricula))
    );
    if (p && p.unidade) return p.unidade;
  }
  return (edits.driversDb[r.matricula] || {}).unidade || '';
}

function renderBancoHoras() {
  const app = document.getElementById('app');
  const unidadesRef = (Object.values(datasets).find((d) => d && d.unidades) || {}).unidades || [];
  const { de, ate, unidade } = state.bhFiltro;
  const registros = edits.bancoHoras
    .filter((r) => !unidade || bhUnidade(r) === unidade)
    .filter((r) => (!de || r.data >= de) && (!ate || r.data <= ate))
    .sort((a, b) => b.data.localeCompare(a.data));

  app.innerHTML = `
    <div class="panel-head">
      <h2>Ausência</h2>
      <p>Atestados, faltas, DSR e folgas de banco de horas apontados pela escala.${state.editMode ? '' : ' Ative o modo de edição (✏️ Editar) pra remover um apontamento.'}</p>
    </div>
    <div class="unit-switch" id="bhUnitSwitch">
      <button class="unit-btn ${!unidade ? 'active' : ''}" data-unit="">Todas as UO</button>
      ${unidadesRef.map((u) => `<button class="unit-btn ${unidade === u.codigo ? 'active' : ''}" data-unit="${u.codigo}">${u.label}</button>`).join('')}
    </div>
    <div class="toolbar-tools" style="margin-bottom:14px">
      <div class="field"><span style="font-size:12px;color:var(--text-muted);margin-right:4px">De</span><input type="date" id="bhFiltroDe" value="${de}"></div>
      <div class="field"><span style="font-size:12px;color:var(--text-muted);margin-right:4px">Até</span><input type="date" id="bhFiltroAte" value="${ate}"></div>
      <div class="field">${monthSelectHtml('bhFiltroMes', de, ate)}</div>
      ${(de || ate) ? `<button class="icon-btn" id="bhFiltroLimpar">Limpar filtro</button>` : ''}
    </div>
    <div class="table-scroll">
      <table class="dash-table">
        <thead><tr><th>Data</th><th>Nome</th><th>Matrícula</th><th>UO</th><th>Turno</th><th>Líder</th><th>Tipo</th>${state.editMode ? '<th></th>' : ''}</tr></thead>
        <tbody>${registros.length ? registros.map((r) => `
          <tr>
            <td>${formatDataBr(r.data)}</td>
            <td>${r.nome}</td>
            <td>${r.matricula || '—'}</td>
            <td>${bhUnidade(r) || '—'}</td>
            <td>${r.turno || '—'}</td>
            <td>${r.lider || '—'}</td>
            <td><span class="ef-badge ${r.tipo === 'BH' ? 'ef-badge-ativo' : r.tipo === 'DSR' ? 'ef-badge-neutro' : 'ef-badge-afastado'}">${r.tipo === 'BH' ? '🕐 BH' : r.tipo === 'FALTA' ? '🚫 Falta' : r.tipo === 'DSR' ? '🗓️ DSR' : '📋 Atestado'}</span></td>
            ${state.editMode ? `<td class="num"><button class="icon-btn danger ef-remove-btn" data-id="${r.id}" title="Remover">🗑</button></td>` : ''}
          </tr>`).join('') : `<tr><td colspan="${state.editMode ? 8 : 7}"><div class="empty-state">Nenhum atestado ou banco de horas apontado${unidade || de || ate ? ' com esse filtro' : ''}.</div></td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('bhUnitSwitch').querySelectorAll('.unit-btn').forEach((btn) => {
    btn.addEventListener('click', () => { state.bhFiltro.unidade = btn.dataset.unit; renderBancoHoras(); });
  });
  const wireFiltro = (id, key) => {
    document.getElementById(id).addEventListener('change', (e) => {
      state.bhFiltro[key] = e.target.value;
      renderBancoHoras();
    });
  };
  wireFiltro('bhFiltroDe', 'de');
  wireFiltro('bhFiltroAte', 'ate');
  wireMonthSelect('bhFiltroMes', 'bhFiltro', renderBancoHoras);
  const limparBtn = document.getElementById('bhFiltroLimpar');
  if (limparBtn) limparBtn.addEventListener('click', () => { state.bhFiltro.de = ''; state.bhFiltro.ate = ''; renderBancoHoras(); });

  app.querySelectorAll('.ef-remove-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('tr');
      const nome = row.children[1].textContent;
      const ok = await showConfirmModal(`Remover o apontamento de "${nome}"?`, { confirmLabel: 'Remover', danger: true });
      if (!ok) return;
      edits.bancoHoras = edits.bancoHoras.filter((r) => r.id !== btn.dataset.id);
      persistEdits();
      renderBancoHoras();
    });
  });
}

// Separado de Efetivos por pedido — Afastados fica numa aba própria em
// vez de misturado com o resto do cadastro, com filtro de período pela
// previsão de retorno (dataRetorno).
function renderAfastados() {
  const app = document.getElementById('app');
  const unidadesRef = (Object.values(datasets).find((d) => d && d.unidades) || {}).unidades || [];
  const { de, ate, unidade } = state.afastadosFiltro;

  const registros = Object.entries(edits.driversDb)
    .filter(([, v]) => v.afastado)
    .filter(([, v]) => !unidade || v.unidade === unidade)
    .filter(([, v]) => (!de || (v.dataRetorno || '') >= de) && (!ate || (v.dataRetorno || '') <= ate))
    .sort((a, b) => a[1].nome.localeCompare(b[1].nome));

  app.innerHTML = `
    <div class="panel-head">
      <h2>Afastados</h2>
      <p>Motoristas efetivos afastados, separado do cadastro ativo.${state.editMode ? '' : ' Ative o modo de edição (✏️ Editar) pra encerrar um afastamento.'}</p>
    </div>
    <div class="unit-switch" id="afastadosUnitSwitch">
      <button class="unit-btn ${!unidade ? 'active' : ''}" data-unit="">Todas as UO</button>
      ${unidadesRef.map((u) => `<button class="unit-btn ${unidade === u.codigo ? 'active' : ''}" data-unit="${u.codigo}">${u.label}</button>`).join('')}
    </div>
    <div class="toolbar-tools" style="margin-bottom:14px">
      <div class="field"><span style="font-size:12px;color:var(--text-muted);margin-right:4px">Retorno de</span><input type="date" id="afFiltroDe" value="${de}"></div>
      <div class="field"><span style="font-size:12px;color:var(--text-muted);margin-right:4px">até</span><input type="date" id="afFiltroAte" value="${ate}"></div>
      <div class="field">${monthSelectHtml('afFiltroMes', de, ate)}</div>
      ${(de || ate) ? `<button class="icon-btn" id="afFiltroLimpar">Limpar filtro</button>` : ''}
    </div>
    <div class="table-scroll">
      <table class="dash-table">
        <thead><tr><th>Nome</th><th>Matrícula</th><th>Cargo</th><th>UO</th><th>Motivo</th><th>Retorno previsto</th>${state.editMode ? '<th></th>' : ''}</tr></thead>
        <tbody>${registros.length ? registros.map(([mat, v]) => `
          <tr>
            <td>${v.nome}</td>
            <td>${mat}</td>
            <td>${cargoDoEfetivo(mat, v) || '—'}</td>
            <td>${v.unidade || '—'}</td>
            <td>${state.editMode
              ? `<input type="text" class="ef-motivo-input af-motivo-input" data-mat="${mat}" placeholder="Motivo (opcional)" value="${(v.motivo || '').replace(/"/g, '&quot;')}">`
              : (v.motivo || '—')}</td>
            <td>${state.editMode
              ? `<input type="date" class="ef-retorno-input af-retorno-input" data-mat="${mat}" value="${v.dataRetorno || ''}">`
              : (v.dataRetorno ? formatDataBr(v.dataRetorno) : '—')}</td>
            ${state.editMode ? `<td class="num"><button class="icon-btn" data-mat="${mat}" id="af-fim-${mat}" title="Encerrar afastamento">✔ Retornou</button></td>` : ''}
          </tr>`).join('') : `<tr><td colspan="${state.editMode ? 7 : 6}"><div class="empty-state">Nenhum motorista afastado${unidade || de || ate ? ' com esse filtro' : ''} no momento.</div></td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('afastadosUnitSwitch').querySelectorAll('.unit-btn').forEach((btn) => {
    btn.addEventListener('click', () => { state.afastadosFiltro.unidade = btn.dataset.unit; renderAfastados(); });
  });
  const wireFiltro = (id, key) => {
    document.getElementById(id).addEventListener('change', (e) => {
      state.afastadosFiltro[key] = e.target.value;
      renderAfastados();
    });
  };
  wireFiltro('afFiltroDe', 'de');
  wireFiltro('afFiltroAte', 'ate');
  wireMonthSelect('afFiltroMes', 'afastadosFiltro', renderAfastados);
  const limparBtn = document.getElementById('afFiltroLimpar');
  if (limparBtn) limparBtn.addEventListener('click', () => { state.afastadosFiltro.de = ''; state.afastadosFiltro.ate = ''; renderAfastados(); });

  app.querySelectorAll('.af-motivo-input').forEach((input) => {
    input.addEventListener('change', () => {
      const mat = input.dataset.mat;
      if (!edits.driversDb[mat]) return;
      edits.driversDb[mat].motivo = input.value.trim();
      persistEdits();
    });
  });
  app.querySelectorAll('.af-retorno-input').forEach((input) => {
    input.addEventListener('change', () => {
      const mat = input.dataset.mat;
      if (!edits.driversDb[mat]) return;
      edits.driversDb[mat].dataRetorno = input.value;
      persistEdits();
      renderAfastados(); // pode mudar quem passa no filtro de período
    });
  });

  registros.forEach(([mat]) => {
    const btn = document.getElementById(`af-fim-${mat}`);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const nome = edits.driversDb[mat] ? edits.driversDb[mat].nome : '';
      const ok = await showConfirmModal(`Encerrar o afastamento de "${nome}"? Ele volta a aparecer como ativo em Efetivos.`, { confirmLabel: 'Encerrar afastamento' });
      if (!ok || !edits.driversDb[mat]) return;
      edits.driversDb[mat].afastado = false;
      delete edits.driversDb[mat].motivo;
      delete edits.driversDb[mat].dataRetorno;
      persistEdits();
      renderAfastados();
    });
  });
}

function renderLimpoWarnings() {
  if (!state.editMode) return '';
  const items = [];
  TABS.forEach((cfg) => {
    const ds = datasets[cfg.id];
    if (!ds) return;
    if (cfg.hasUnits) {
      (ds.unidades || []).forEach((u) => {
        if (edits.limpo[clearKey(cfg, u.codigo)]) items.push({ tabId: cfg.id, unidade: u.codigo, label: `${cfg.label} · UO ${u.codigo}` });
      });
    } else if (edits.limpo[clearKey(cfg)]) {
      items.push({ tabId: cfg.id, unidade: '', label: cfg.label });
    }
  });
  if (!items.length) return '';
  return `
    <div class="dash-warn">
      <h3>⚠ Dados limpos aguardando restaurar</h3>
      <p>Essas abas/UO tiveram "Limpar dados" usado nelas e continuam escondendo os dados originais da planilha até alguém restaurar.</p>
      <ul>
        ${items.map((it) => `<li>${it.label} <button class="icon-btn dash-warn-restore" data-tab="${it.tabId}" data-unidade="${it.unidade}">↺ Restaurar</button></li>`).join('')}
      </ul>
    </div>`;
}

// Card de composição das ausências (Atestado/BH/Falta em % do período) +
// Afastados, com filtro de período próprio — respeita a UO selecionada
// no Dashboard, mas tem seu próprio De/Até (independente do mês da
// escala, já que ausências são eventos, não uma visão mês a mês).
function dashboardAusenciasHtml() {
  const { de, ate, turno } = state.dashAusenciaFiltro;
  const porUnidade = edits.bancoHoras.filter((r) => state.dashUnit === 'todos' || bhUnidade(r) === state.dashUnit);
  const turnosRef = [...new Set(porUnidade.map((r) => r.turno).filter(Boolean))].sort();
  const ausencias = porUnidade.filter((r) =>
    (!de || r.data >= de) && (!ate || r.data <= ate) && (!turno || r.turno === turno)
  );
  const porTipo = { ATESTADO: 0, BH: 0, DSR: 0, FALTA: 0 };
  ausencias.forEach((r) => { if (porTipo[r.tipo] !== undefined) porTipo[r.tipo]++; });
  const total = ausencias.length;
  const pct = (n) => total ? Math.round((n / total) * 100) : 0;

  const afastadosCount = Object.values(edits.driversDb).filter((v) =>
    v.afastado &&
    (state.dashUnit === 'todos' || v.unidade === state.dashUnit) &&
    (!de || (v.dataRetorno || '') >= de) && (!ate || (v.dataRetorno || '') <= ate)
  ).length;

  const meters = [
    { label: '📋 Atestado', n: porTipo.ATESTADO, cls: 'meter-atestado' },
    { label: '🕐 Banco de horas', n: porTipo.BH, cls: 'meter-bh' },
    { label: '🗓️ DSR', n: porTipo.DSR, cls: 'meter-dsr' },
    { label: '🚫 Falta', n: porTipo.FALTA, cls: 'meter-falta' },
  ];

  return `
    <div class="ausencias-card">
      <div class="ausencias-head">
        <h3>Ausências no período</h3>
        <div class="ausencias-filtro">
          <div class="field"><span class="ausencias-filtro-label">De</span><input type="date" id="dashAusDe" value="${de}"></div>
          <div class="field"><span class="ausencias-filtro-label">Até</span><input type="date" id="dashAusAte" value="${ate}"></div>
          <div class="field">${monthSelectHtml('dashAusMes', de, ate)}</div>
          <div class="field"><select id="dashAusTurno"><option value="">Todos os turnos</option>${turnosRef.map((t) => `<option value="${t}" ${turno === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
          ${(de || ate || turno) ? `<button class="icon-btn" id="dashAusLimpar">Limpar</button>` : ''}
        </div>
      </div>
      ${total ? `
        <div class="ausencia-meters">
          ${meters.map((m) => `
            <div class="ausencia-meter">
              <div class="ausencia-meter-head"><span>${m.label}</span><b>${pct(m.n)}% <small>(${m.n})</small></b></div>
              <div class="ausencia-meter-track"><div class="ausencia-meter-fill ${m.cls}" style="width:${pct(m.n)}%"></div></div>
            </div>`).join('')}
        </div>
      ` : `<p class="ts-detalhe-vazio" style="margin:4px 0 0">Nenhuma ausência registrada${de || ate || turno ? ' com esse filtro' : ''}.</p>`}
      <div class="ausencias-afastados">
        <span class="ausencias-afastados-label">🏥 Afastados${de || ate ? ' com retorno previsto nesse período' : ' no momento'}</span>
        <b>${afastadosCount}</b>
      </div>
    </div>`;
}

function renderDashboard() {
  const app = document.getElementById('app');
  let totalGeral = 0;
  const porTipo = {};
  TABS.forEach((cfg) => {
    const ds = datasets[cfg.id];
    if (!ds) return;
    const count = state.dashUnit === 'todos' ? ds.colaboradores.length : ds.colaboradores.filter((p) => p.unidade === state.dashUnit).length;
    totalGeral += count;
    porTipo[cfg.tag] = (porTipo[cfg.tag] || 0) + count;
  });

  const unidadesRef = (Object.values(datasets).find((d) => d && d.unidades) || {}).unidades || [];

  app.innerHTML = `
    <div class="panel-head">
      <h2>Dashboard</h2>
      <p>Visão geral de todas as escalas e controle de vagas por turno e UO.${state.editMode ? ' Modo de edição ativo: os campos "Meta" abaixo são editáveis.' : ''}</p>
    </div>
    <div class="cards">
      <div class="card accent"><b>${totalGeral}</b><span>Colaboradores no total</span></div>
      ${Object.entries(porTipo).map(([tag, n]) => `<div class="card"><b>${n}</b><span>${escalaTypeLabel(tag)}</span></div>`).join('')}
    </div>
    <div class="unit-switch" id="dashUnitSwitch">
      <button class="unit-btn ${state.dashUnit === 'todos' ? 'active' : ''}" data-unit="todos">Todas as UO</button>
      ${unidadesRef.map((u) => `<button class="unit-btn ${state.dashUnit === u.codigo ? 'active' : ''}" data-unit="${u.codigo}">${u.label}</button>`).join('')}
    </div>
    ${dashboardAusenciasHtml()}
    ${renderLimpoWarnings()}
    <div class="dash-roles">${DASHBOARD_ROLES.map(renderDashboardRoleTable).join('')}</div>
  `;

  document.getElementById('dashUnitSwitch').querySelectorAll('.unit-btn').forEach((btn) => {
    btn.addEventListener('click', () => { state.dashUnit = btn.dataset.unit; renderDashboard(); });
  });
  const wireAusFiltro = (id, key) => {
    const elFiltro = document.getElementById(id);
    if (elFiltro) elFiltro.addEventListener('change', (e) => { state.dashAusenciaFiltro[key] = e.target.value; renderDashboard(); });
  };
  wireAusFiltro('dashAusDe', 'de');
  wireAusFiltro('dashAusAte', 'ate');
  wireMonthSelect('dashAusMes', 'dashAusenciaFiltro', renderDashboard);
  const dashAusTurnoEl = document.getElementById('dashAusTurno');
  if (dashAusTurnoEl) dashAusTurnoEl.addEventListener('change', (e) => { state.dashAusenciaFiltro.turno = e.target.value; renderDashboard(); });
  const dashAusLimparBtn = document.getElementById('dashAusLimpar');
  if (dashAusLimparBtn) dashAusLimparBtn.addEventListener('click', () => { state.dashAusenciaFiltro = { de: '', ate: '', turno: '' }; renderDashboard(); });

  if (state.editMode) {
    app.querySelectorAll('.meta-input').forEach((input) => {
      input.addEventListener('change', () => {
        edits.metas[input.dataset.key] = Math.max(0, parseInt(input.value, 10) || 0);
        persistEdits();
        renderDashboard();
      });
    });
    app.querySelectorAll('.dash-warn-restore').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await showConfirmModal(`Isso traz de volta os colaboradores originais de "${btn.parentElement.textContent.trim().replace('↺ Restaurar', '').trim()}".`, { confirmLabel: 'Restaurar', danger: false });
        if (!ok) return;
        delete edits.limpo[clearKey({ id: btn.dataset.tab }, btn.dataset.unidade || undefined)];
        persistEdits();
        location.reload();
      });
    });
  }
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
        ${!isEquipe && cfg.hasGroups ? renderGrupoSelect(ds, cfg) : ''}
        ${isEquipe ? '' : renderPapelSelect(ds, cfg)}
        ${!isEquipe && cfg.hasGroups ? `<button class="icon-btn" id="toggleGroups">Recolher grupos</button>` : ''}
        ${mestre ? `<button class="icon-btn" id="equipeBtn">${isEquipe ? '📅 Ver escala' : '👥 Ver equipe'}</button>` : ''}
        ${!isEquipe && state.editMode ? `<button class="icon-btn" id="addColaboradorBtn">+ Adicionar colaborador</button>` : ''}
        ${!isEquipe && state.editMode ? `<button class="danger-mini-btn" id="clearDataBtn" title="Apaga todos os colaboradores${cfg.hasUnits ? ' da UO ' + state.unit[cfg.id] : ''} — ação drástica, dá pra restaurar depois">limpar dados${cfg.hasUnits ? ' (UO ' + state.unit[cfg.id] + ')' : ''}</button>` : ''}
        ${!isEquipe && state.editMode && edits.limpo[clearKey(cfg, cfg.hasUnits ? state.unit[cfg.id] : undefined)] ? `<button class="icon-btn" id="restoreClearedBtn">↺ Restaurar dados originais${cfg.hasUnits ? ' (UO ' + state.unit[cfg.id] + ')' : ''}</button>` : ''}
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
      if (cfg.id === 'motoristas') wireEquipeStructure(viewBody, ds, cfg);
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

    document.getElementById('searchBox').addEventListener('input', (e) => { state.search = e.target.value; renderCards(ds, cfg, monthMeta); renderGrid(ds, cfg, monthMeta); renderTodayStrip(ds, cfg, monthMeta); });
    const grupoSel = document.getElementById('grupoSelect');
    if (grupoSel) grupoSel.addEventListener('change', (e) => { state.grupo = e.target.value; renderCards(ds, cfg, monthMeta); renderGrid(ds, cfg, monthMeta); renderTodayStrip(ds, cfg, monthMeta); });
    const papelSel = document.getElementById('papelSelect');
    if (papelSel) papelSel.addEventListener('change', (e) => { state.papel = e.target.value; renderCards(ds, cfg, monthMeta); renderGrid(ds, cfg, monthMeta); renderTodayStrip(ds, cfg, monthMeta); });
    const toggleBtn = document.getElementById('toggleGroups');
    if (toggleBtn) toggleBtn.addEventListener('click', () => {
      let pool = ds.colaboradores;
      if (cfg.hasUnits) pool = pool.filter((p) => p.unidade === state.unit[cfg.id]);
      const allGroups = [...new Set(pool.map((p) => p.grupo))];
      const collapsed = state.collapsed[cfg.id];
      const collapseAll = collapsed.size < allGroups.length;
      collapsed.clear();
      if (collapseAll) allGroups.forEach((g) => collapsed.add(g));
      toggleBtn.textContent = collapseAll ? 'Expandir grupos' : 'Recolher grupos';
      renderGrid(ds, cfg, monthMeta);
    });
  }

  document.getElementById('printBtn').addEventListener('click', () => window.print());
  const addColaboradorBtn = document.getElementById('addColaboradorBtn');
  if (addColaboradorBtn) addColaboradorBtn.addEventListener('click', () => openModal(null, monthMeta, cfg, ds, true));
  const clearBtn = document.getElementById('clearDataBtn');
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    const escopo = cfg.hasUnits ? `da UO ${state.unit[cfg.id]}` : 'desta aba';
    const ok = await showConfirmModal(`Isso apaga TODOS os colaboradores ${escopo} (inclusive os da planilha original) pra você cadastrar outros do zero. Dá pra restaurar depois pelo botão "↺ Restaurar dados originais" que aparece aqui do lado.`, { confirmLabel: 'Limpar dados', danger: true });
    if (!ok) return;
    clearTabData(ds, cfg);
    renderPanel();
  });
  const restoreBtn = document.getElementById('restoreClearedBtn');
  if (restoreBtn) restoreBtn.addEventListener('click', async () => {
    const escopo = cfg.hasUnits ? `da UO ${state.unit[cfg.id]}` : 'desta aba';
    const ok = await showConfirmModal(`Isso traz de volta os colaboradores originais da planilha ${escopo} que tinham sido apagados em "Limpar dados". Colaboradores cadastrados manualmente depois disso continuam.`, { confirmLabel: 'Restaurar', danger: false });
    if (!ok) return;
    const unidade = cfg.hasUnits ? state.unit[cfg.id] : undefined;
    delete edits.limpo[clearKey(cfg, unidade)];
    persistEdits();
    location.reload();
  });
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
  if (Array.isArray(ds.mestre)) {
    // Grupos de equipamentos (Motoristas): cada grupo carrega sua própria
    // UO — mostra só os da UO selecionada. Continua um array (mesmo
    // vazio) pra manter o botão "Ver equipe" visível e permitir cadastrar
    // do zero (+ Adicionar grupo/equipamento) numa UO que ainda não tem
    // nada, em vez de emprestar dados de outra UO.
    return cfg.hasUnits ? ds.mestre.filter((g) => g.unidade === state.unit[cfg.id]) : ds.mestre;
  }
  // objeto dividido por UO (ex.: master_driver.mestre = {MNS:{...}, PRA:{...}})
  if (cfg.hasUnits && Object.prototype.hasOwnProperty.call(ds.mestre, state.unit[cfg.id])) {
    return ds.mestre[state.unit[cfg.id]] || null;
  }
  // objeto único, com sua própria UO (ex.: Líder de Turno/Pátio, cuja
  // planilha só cobre o lado MNS) — só aparece na UO a que pertence, pra
  // não mostrar o mesmo conteúdo como se fosse de outra UO.
  if (cfg.hasUnits && ds.mestre.unidade) {
    return ds.mestre.unidade === state.unit[cfg.id] ? ds.mestre : null;
  }
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

function renderGrupoSelect(ds, cfg) {
  let pool = ds.colaboradores;
  if (cfg.hasUnits) pool = pool.filter((p) => p.unidade === state.unit[cfg.id]);
  const grupos = [...new Set(pool.map((p) => p.grupo))].sort();
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
      <div class="table-scroll"><table class="equipe-table">
        <thead><tr><th>Turno</th><th>Titular</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
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
        ${state.editMode
          ? `<span class="nome equip-numero-edit" data-equip="${e.numero}" title="Clique para editar o número">🚚 Equip. ${e.numero} ✎</span>`
          : `<span class="nome">🚚 Equip. ${e.numero}</span>`}
        ${e.status ? `<span class="equipe-mat">${e.status}</span>` : ''}
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
      <div class="table-scroll"><table class="equipe-table">
        <thead><tr><th>Equipamento</th><th>Turno A</th><th>Turno B</th><th>Turno C</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
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
    if (!visiveis.length) {
      const msg = state.editMode
        ? 'Nenhum grupo cadastrado ainda para esta UO. Use "+ Adicionar novo grupo" abaixo pra começar.'
        : 'Nenhuma equipe cadastrada ainda para esta UO. Ative o modo de edição (✏️ Editar, no topo) pra cadastrar.';
      return `<div class="equipe-wrap">
        ${state.editMode ? `<button class="icon-btn" id="addGrupoBtn">+ Adicionar novo grupo</button>` : ''}
        <div class="empty-state">${msg}</div>
      </div>`;
    }
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
  // Digitou a matrícula de alguém já cadastrado no banco de motoristas?
  // Preenche o nome sozinho (mesma ideia do cadastro de colaborador).
  container.querySelectorAll('[data-edit-field="matricula"]').forEach((matEl) => {
    const nomeEl = container.querySelector(`[data-edit-path="${CSS.escape(matEl.dataset.editPath)}"][data-edit-field="nome"]`);
    if (nomeEl) matEl.addEventListener('blur', () => {
      const found = edits.driversDb[matEl.textContent.trim()];
      if (!found) return;
      nomeEl.textContent = found.nome;
      equipeEditSet(nomeEl.dataset.editPath, 'nome', found.nome);
    });
  });
}

// Controles de estrutura da Equipe (só motoristas): mover equipamento de
// grupo, adicionar equipamento novo, adicionar grupo novo do zero.
// Troca o número de um equipamento (ex.: corrigir digitação, trocar o
// veículo). Migra as edições já salvas (nome/matrícula por turno, grupo
// de destino se foi movido, grupo se foi criado do zero) pra chave do
// número novo, senão elas ficariam "perdidas" presas no número antigo.
function renameEquipamento(ds, numeroAntigo, numeroNovo) {
  for (const g of ds.mestre) {
    const eq = g.equipamentos.find((x) => x.numero === numeroAntigo);
    if (eq) { eq.numero = numeroNovo; break; }
  }
  ['A', 'B', 'C'].forEach((t) => {
    const antigo = `motoristas|equip|${numeroAntigo}|${t}`;
    const novo = `motoristas|equip|${numeroNovo}|${t}`;
    if (edits.equipe[antigo]) { edits.equipe[novo] = edits.equipe[antigo]; delete edits.equipe[antigo]; }
  });
  if (edits.newEquip[numeroAntigo] !== undefined) { edits.newEquip[numeroNovo] = edits.newEquip[numeroAntigo]; delete edits.newEquip[numeroAntigo]; }
  if (edits.moves[numeroAntigo] !== undefined) { edits.moves[numeroNovo] = edits.moves[numeroAntigo]; delete edits.moves[numeroAntigo]; }
  edits.renumeracoes[numeroAntigo] = numeroNovo;
  persistEdits();
}

function wireEquipeStructure(container, ds, cfg) {
  const unidade = state.unit[cfg.id];

  container.querySelectorAll('.equip-numero-edit').forEach((el) => {
    el.addEventListener('click', () => {
      const numeroAntigo = el.dataset.equip;
      const numeroNovo = (prompt('Novo número para este equipamento:', numeroAntigo) || '').trim();
      if (!numeroNovo || numeroNovo === numeroAntigo) return;
      if (equipamentoExiste(ds, numeroNovo)) { alert(`Já existe um equipamento ${numeroNovo} cadastrado.`); return; }
      renameEquipamento(ds, numeroAntigo, numeroNovo);
      renderPanel();
    });
  });

  container.querySelectorAll('.equip-move-select').forEach((sel) => {
    const original = sel.value;
    sel.addEventListener('change', () => {
      const numero = sel.dataset.equip;
      let target = sel.value;
      if (target === '__novo__') {
        target = (prompt('Nome do novo grupo (ex.: GRUPO 09):') || '').trim().toUpperCase();
        if (!target) { sel.value = original; return; }
        const jaExiste = edits.newGrupos.some((g) => g.nome === target && g.unidade === unidade) || ds.mestre.some((g) => g.grupo === target && g.unidade === unidade);
        if (!jaExiste) edits.newGrupos.push({ nome: target, unidade });
      }
      edits.moves[numero] = target;
      persistEdits();
      moveEquipamentoToGrupo(ds, numero, target, unidade);
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
    if (ds.mestre.some((g) => g.grupo === nome && g.unidade === unidade)) { alert(`O grupo "${nome}" já existe nesta UO.`); return; }
    edits.newGrupos.push({ nome, unidade });
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
  const dataIso = isoDateFor(ds.ano, monthMeta.numero, day);
  const pool = visiblePeople();

  // Agrupado por papel (Turno A/B/C, Folguista, Apoio, etc. — o que
  // existir nessa escala) em vez de só Trabalhando/Folga geral. Dentro de
  // cada grupo, separa quem tá de folga normal de quem tem atestado/BH/
  // falta apontado hoje, pra abrir tudo detalhado ao clicar (ver
  // showTurnoDetalheModal).
  const grupos = new Map();
  pool.forEach((p) => {
    const papel = p.papelNormalizado || '—';
    if (!grupos.has(papel)) grupos.set(papel, { trabalhando: [], folga: [], bh: [], dsr: [], falta: [], atestado: [] });
    const g = grupos.get(papel);
    const sched = p.escala[curKey];
    const status = sched ? sched[day - 1] : undefined;
    if (status === 'W') { g.trabalhando.push(p); return; }
    if (status !== 'O') return;
    const pk = personKey(cfg.id, p);
    const registro = edits.bancoHoras.find((r) => r.pk === pk && r.data === dataIso);
    if (registro && registro.tipo === 'BH') g.bh.push(p);
    else if (registro && registro.tipo === 'DSR') g.dsr.push(p);
    else if (registro && registro.tipo === 'FALTA') g.falta.push(p);
    else if (registro && registro.tipo === 'ATESTADO') g.atestado.push(p);
    else g.folga.push(p);
  });
  const papeis = [...grupos.keys()].sort((a, b) => papelPriority(a) - papelPriority(b));

  const filtroLabel = [cfg.hasUnits ? 'UO ' + state.unit[cfg.id] : '', state.papel !== 'todos' ? state.papel : '', state.grupo !== 'todos' ? state.grupo : ''].filter(Boolean).join(' · ');
  el.innerHTML = `
    <div class="today-strip">
      <div class="ts-date">Hoje · ${fmtLongDate(now)}
        <small>${cfg.label}${filtroLabel ? ' · ' + filtroLabel : ''}</small>
      </div>
      <div class="ts-stats">
        ${papeis.map((papel, i) => `<button class="ts-stat" data-papel-idx="${i}" type="button"><b>${grupos.get(papel).trabalhando.length}</b><span>${papel}</span></button>`).join('')}
      </div>
    </div>
  `;
  el.querySelectorAll('.ts-stat').forEach((btn) => {
    const papel = papeis[Number(btn.dataset.papelIdx)];
    btn.addEventListener('click', () => showTurnoDetalheModal(papel, grupos.get(papel)));
  });
}

// Detalhe completo de um turno/papel ao clicar no quadro Hoje — quantos
// e quem em cada situação do dia (não só trabalhando/folga: também
// banco de horas, falta e atestado apontados).
function showTurnoDetalheModal(papel, grupo) {
  const backdrop = document.getElementById('modalBackdrop');
  const secoes = [
    { label: 'Trabalhando', lista: grupo.trabalhando },
    { label: 'De folga', lista: grupo.folga },
    { label: 'Banco de horas', lista: grupo.bh },
    { label: 'DSR', lista: grupo.dsr },
    { label: 'Falta', lista: grupo.falta },
    { label: 'Atestado', lista: grupo.atestado },
  ];
  const total = secoes.reduce((n, s) => n + s.lista.length, 0);
  const finish = () => { backdrop.classList.remove('open'); backdrop.innerHTML = ''; };
  backdrop.innerHTML = `
    <div class="modal people-list-modal turno-detalhe-modal">
      <div class="modal-head">
        <h3>${papel}</h3>
        <span>${total} colaborador${total === 1 ? '' : 'es'} hoje</span>
        <button class="modal-close" id="turnoDetalheCloseBtn">✕</button>
      </div>
      <div class="modal-body">
        ${secoes.map((s) => `
          <div class="ts-detalhe-secao">
            <h4>${s.label} <span class="count">${s.lista.length}</span></h4>
            ${s.lista.length ? `
              <table class="dash-table"><tbody>${[...s.lista].sort((a, b) => a.nome.localeCompare(b.nome)).map((p) => `<tr><td>${p.nome}</td><td>${p.matricula || '—'}</td></tr>`).join('')}</tbody></table>
            ` : `<p class="ts-detalhe-vazio">Ninguém nessa categoria.</p>`}
          </div>`).join('')}
      </div>
    </div>`;
  backdrop.classList.add('open');
  document.getElementById('turnoDetalheCloseBtn').addEventListener('click', finish);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(); }, { once: true });
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

  // "pk|data" -> tipo, pra mostrar AT/BH no lugar do "F" genérico nos
  // dias que têm apontamento (ver personRowHtml).
  const bhLookup = new Map();
  edits.bancoHoras.forEach((r) => bhLookup.set(`${r.pk}|${r.data}`, r.tipo));

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
      if (!isCollapsed) groupPeople.forEach((p) => { bodyHtml += personRowHtml(p, days, monthMeta, ds, todayDay, cfg, bhLookup); });
    });
  } else {
    const sorted = [...people].sort((a, b) => papelPriority(a.papelNormalizado) - papelPriority(b.papelNormalizado));
    sorted.forEach((p) => { bodyHtml += personRowHtml(p, days, monthMeta, ds, todayDay, cfg, bhLookup); });
  }

  wrap.innerHTML = `
    <table class="escala">
      <thead>
        <tr>
          <th class="col-nome">Colaborador</th>
          <th class="col-info">${cfg.id === 'adm5x2' ? 'Cargo' : 'Turno'}</th>
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
      if (e.target.closest('.day-cell')) return;
      openModal(ds.colaboradores.find((p) => p.__key === row.dataset.key), monthMeta, cfg, ds);
    });
  });
  wrap.querySelectorAll('.day-cell').forEach((cell) => {
    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = cell.closest('.person-row');
      const p = ds.colaboradores.find((x) => x.__key === row.dataset.key);
      const day = parseInt(cell.dataset.day, 10);
      if (state.editMode) toggleDayStatus(p, cfg, ds, monthMeta, day, cell);
      else markAtOuBhSemEdicao(p, cfg, ds, monthMeta, day, cell);
    });
  });
}

// Pede a senha de BH e, se certa, marca o dia como Atestado/Banco de
// horas e loga o apontamento. Usado tanto pelo fluxo normal (dentro do
// modo de edição) quanto pelo fluxo avulso (fora do modo de edição, só
// com a senha — ver markAtOuBhSemEdicao).
async function marcarAtOuBh(p, cfg, ds, monthMeta, day, cellEl, tipo) {
  const senhaOk = await promptBhPassword();
  if (!senhaOk) return false;

  const monthKey = monthMeta.chave;
  const chars = (p.escala[monthKey] || 'O'.repeat(monthMeta.dias)).split('');
  const idx = day - 1;
  if (idx < 0 || idx >= chars.length) return false;
  const pk = personKey(cfg.id, p);
  const dataIso = isoDateFor(ds.ano, monthMeta.numero, day);

  chars[idx] = 'O';
  p.escala[monthKey] = chars.join('');
  edits.dias[pk] = edits.dias[pk] || {};
  edits.dias[pk][monthKey] = edits.dias[pk][monthKey] || {};
  edits.dias[pk][monthKey][idx] = 'O';
  const tipoLabel = tipo === 'bh' ? 'BH' : tipo === 'falta' ? 'FALTA' : tipo === 'dsr' ? 'DSR' : 'ATESTADO';
  const classeSufixo = tipo === 'bh' ? 'bh' : tipo === 'falta' ? 'falta' : tipo === 'dsr' ? 'dsr' : 'at';
  edits.bancoHoras = edits.bancoHoras.filter((r) => !(r.pk === pk && r.data === dataIso));
  edits.bancoHoras.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    pk, data: dataIso,
    nome: p.nome, matricula: p.matricula || null,
    turno: p.papelNormalizado || null, lider: p.lider || null,
    unidade: p.unidade || null,
    tipo: tipoLabel,
  });
  persistEdits();
  cellEl.classList.remove('work', 'off', 'nodata', 'atbh', 'atbh-at', 'atbh-bh', 'atbh-falta', 'atbh-dsr');
  cellEl.classList.add('off', 'atbh', `atbh-${classeSufixo}`);
  renderCards(ds, cfg, monthMeta);
  renderTodayStrip(ds, cfg, monthMeta);
  return true;
}

// Fora do modo de edição (inclusive pra quem não entrou como ADM), um
// clique num dia de trabalho só oferece Atestado/Banco de horas — não a
// folga normal, que continua exigindo edição de verdade. A senha de BH
// (separada da de ADM) é a única trava aqui.
async function markAtOuBhSemEdicao(p, cfg, ds, monthMeta, day, cellEl) {
  const monthKey = monthMeta.chave;
  const chars = (p.escala[monthKey] || 'O'.repeat(monthMeta.dias)).split('');
  const idx = day - 1;
  if (idx < 0 || idx >= chars.length || chars[idx] !== 'W') return; // já de folga, nada a fazer por aqui
  const tipo = await showFolgaTypeModal(true);
  if (!tipo) return;
  if (tipo === 'atestado') { await marcarAtestadoComPeriodo(p, cfg, ds, monthMeta, day); return; }
  await marcarAtOuBh(p, cfg, ds, monthMeta, day, cellEl, tipo);
}

async function toggleDayStatus(p, cfg, ds, monthMeta, day, cellEl) {
  const monthKey = monthMeta.chave;
  // Mês sem dados na planilha de origem (ex.: Dezembro do Master Driver)
  // começa em branco — o primeiro clique inicializa o mês como "tudo
  // folga" e então marca só o dia clicado, em vez de não fazer nada.
  const chars = (p.escala[monthKey] || 'O'.repeat(monthMeta.dias)).split('');
  const idx = day - 1;
  if (idx < 0 || idx >= chars.length) return;
  const next = chars[idx] === 'W' ? 'O' : 'W';
  const pk = personKey(cfg.id, p);
  const dataIso = isoDateFor(ds.ano, monthMeta.numero, day);

  if (next === 'W') {
    // Voltou a trabalhar num dia que tinha registro de atestado/BH —
    // limpa esse registro pra não ficar um apontamento órfão.
    const antes = edits.bancoHoras.length;
    edits.bancoHoras = edits.bancoHoras.filter((r) => !(r.pk === pk && r.data === dataIso));
    if (edits.bancoHoras.length !== antes) persistEdits();
  } else {
    const tipo = await showFolgaTypeModal();
    if (!tipo) return; // cancelado
    if (tipo === 'atestado') {
      await marcarAtestadoComPeriodo(p, cfg, ds, monthMeta, day);
      return;
    }
    if (tipo === 'bh' || tipo === 'falta' || tipo === 'dsr') {
      await marcarAtOuBh(p, cfg, ds, monthMeta, day, cellEl, tipo);
      return;
    }
    // tipo === 'folgar' -> segue o fluxo normal abaixo (com a pergunta de
    // repetir o padrão de rotação, quando aplicável).
  }

  const rot = rotationParamsFor(cfg);
  if (next === 'O' && rot) {
    const aplicar = await showConfirmModal(
      `Marcar este dia como folga e repetir o padrão ${cfg.tag} (${rot.workDays} dias de trabalho + ${rot.offDays} de folga) a partir dele, preenchendo sozinho o resto do calendário deste colaborador em todos os meses?\n\n` +
      `Isso substitui a escala inteira dele (mantém só o líder/telefone/etc.).`,
      { confirmLabel: 'Aplicar padrão', cancelLabel: 'Só este dia' }
    );
    if (aplicar) {
      const anchorEpoch = epochDay(ds.ano, monthMeta.numero, day);
      applyRotation(ds, cfg, p, anchorEpoch);
      edits.rotacao[pk] = anchorEpoch;
      delete edits.dias[pk]; // um novo padrão substitui remendos avulsos antigos
      persistEdits();
      renderGrid(ds, cfg, monthMeta);
      renderCards(ds, cfg, monthMeta);
      renderTodayStrip(ds, cfg, monthMeta);
      return;
    }
  }

  chars[idx] = next;
  p.escala[monthKey] = chars.join('');
  edits.dias[pk] = edits.dias[pk] || {};
  edits.dias[pk][monthKey] = edits.dias[pk][monthKey] || {};
  edits.dias[pk][monthKey][idx] = next;
  persistEdits();

  cellEl.classList.remove('work', 'off', 'nodata', 'atbh', 'atbh-at', 'atbh-bh', 'atbh-falta', 'atbh-dsr');
  cellEl.classList.add(next === 'W' ? 'work' : 'off');
  renderCards(ds, cfg, monthMeta);
  renderTodayStrip(ds, cfg, monthMeta);
}

let __keyCounter = 0;
function personRowHtml(p, days, monthMeta, ds, todayDay, cfg, bhLookup) {
  if (!p.__key) p.__key = `k${__keyCounter++}`;
  const sched = p.escala[monthMeta.chave];
  const pk = cfg ? personKey(cfg.id, p) : null;
  const cells = days.map((d, i) => {
    const status = sched ? sched[i] : undefined;
    const wk = isWeekend(ds.ano, monthMeta.numero, d);
    const isToday = d === todayDay;
    let cls = 'nodata';
    if (status === 'W') cls = 'work'; else if (status === 'O') cls = 'off';
    const tipo = (status === 'O' && pk && bhLookup) ? bhLookup.get(`${pk}|${isoDateFor(ds.ano, monthMeta.numero, d)}`) : null;
    const atbhCls = tipo === 'BH' ? 'atbh atbh-bh' : tipo === 'FALTA' ? 'atbh atbh-falta' : tipo === 'DSR' ? 'atbh atbh-dsr' : tipo === 'ATESTADO' ? 'atbh atbh-at' : '';
    return `<td class="day-cell ${cls} ${atbhCls} ${wk ? 'weekend' : ''} ${isToday ? 'today-col' : ''}" data-day="${d}"><span class="dot"></span></td>`;
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
          <div class="modal-row edit"><span class="k">${cfg.id === 'adm5x2' ? 'Cargo' : 'Turno'}</span><input class="modal-input" id="editTurno" list="turnoOptions" value="${p.papelNormalizado || ''}"></div>
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
    if (isNew) wireMatriculaLookup(document.getElementById('editMatricula'), document.getElementById('editNome'));
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

// Confirmação com a cara do app (em vez do confirm() cru do navegador,
// que mostra o domínio do site e não combina com o resto do visual).
function showConfirmModal(message, opts) {
  opts = opts || {};
  const confirmLabel = opts.confirmLabel || 'Confirmar';
  const cancelLabel = opts.cancelLabel || 'Cancelar';
  const danger = !!opts.danger;
  return new Promise((resolve) => {
    const backdrop = document.getElementById('modalBackdrop');
    backdrop.innerHTML = `
      <div class="modal confirm-modal">
        <div class="modal-body">
          <p class="confirm-msg">${String(message).replace(/\n/g, '<br>')}</p>
        </div>
        <div class="modal-actions">
          <button class="icon-btn" id="confirmCancelBtn">${cancelLabel}</button>
          <button class="icon-btn primary ${danger ? 'danger' : ''}" id="confirmOkBtn">${confirmLabel}</button>
        </div>
      </div>
    `;
    backdrop.classList.add('open');
    const finish = (result) => { backdrop.classList.remove('open'); backdrop.innerHTML = ''; resolve(result); };
    document.getElementById('confirmCancelBtn').addEventListener('click', () => finish(false));
    document.getElementById('confirmOkBtn').addEventListener('click', () => finish(true));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(false); }, { once: true });
  });
}

// Sem senha nenhuma pra só visualizar — o site abre direto em modo
// visualizador. A senha só existe pra virar ADM (edita, apaga, etc.).
// Fica salvo no navegador até alguém clicar em "Sair".
const ADM_PASSWORD = 'lots112233';
const ROLE_STORAGE_KEY = 'escala:role';

function showAdmLoginModal() {
  return new Promise((resolve) => {
    const backdrop = document.getElementById('modalBackdrop');
    const finish = (result) => { backdrop.classList.remove('open'); backdrop.innerHTML = ''; resolve(result); };
    const render = (errorMsg) => {
      backdrop.innerHTML = `
        <div class="modal confirm-modal">
          <div class="modal-body">
            <p class="confirm-msg">Digite a senha de administrador:</p>
            <input type="password" class="modal-input" id="loginPwInput" autocomplete="off">
            ${errorMsg ? `<p class="pw-error">${errorMsg}</p>` : ''}
          </div>
          <div class="modal-actions">
            <button class="icon-btn" id="loginCancelBtn">Cancelar</button>
            <button class="icon-btn primary" id="loginBtn">Entrar</button>
          </div>
        </div>`;
      backdrop.classList.add('open');
      const input = document.getElementById('loginPwInput');
      input.focus();
      const trySubmit = () => {
        if (input.value !== ADM_PASSWORD) { render('Senha incorreta. Tente de novo.'); return; }
        finish(true);
      };
      document.getElementById('loginCancelBtn').addEventListener('click', () => finish(false));
      document.getElementById('loginBtn').addEventListener('click', trySubmit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); trySubmit(); } });
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(false); }, { once: true });
    };
    render(null);
  });
}

// Ao marcar um dia como folga, pergunta o motivo — folga normal segue o
// fluxo de sempre (inclusive a pergunta de repetir o padrão de rotação);
// atestado/banco de horas pulam isso (são exceções pontuais, não um novo
// padrão) e vão parar na aba Banco de Horas.
function showFolgaTypeModal(somenteAtBh) {
  return new Promise((resolve) => {
    const backdrop = document.getElementById('modalBackdrop');
    backdrop.innerHTML = `
      <div class="modal confirm-modal">
        <div class="modal-body">
          <p class="confirm-msg">Marcar esse dia como:</p>
        </div>
        <div class="modal-actions" style="flex-wrap:wrap">
          <button class="icon-btn" id="folgaTypeCancel">Cancelar</button>
          <button class="icon-btn" id="folgaTypeAtestado">📋 Atestado</button>
          <button class="icon-btn" id="folgaTypeBh">🕐 Banco de horas</button>
          <button class="icon-btn" id="folgaTypeDsr">🗓️ DSR</button>
          <button class="icon-btn danger" id="folgaTypeFalta">🚫 Falta</button>
          ${somenteAtBh ? '' : '<button class="icon-btn primary" id="folgaTypeFolgar">Folga normal</button>'}
        </div>
      </div>`;
    backdrop.classList.add('open');
    const finish = (result) => { backdrop.classList.remove('open'); backdrop.innerHTML = ''; resolve(result); };
    document.getElementById('folgaTypeCancel').addEventListener('click', () => finish(null));
    if (!somenteAtBh) document.getElementById('folgaTypeFolgar').addEventListener('click', () => finish('folgar'));
    document.getElementById('folgaTypeAtestado').addEventListener('click', () => finish('atestado'));
    document.getElementById('folgaTypeBh').addEventListener('click', () => finish('bh'));
    document.getElementById('folgaTypeDsr').addEventListener('click', () => finish('dsr'));
    document.getElementById('folgaTypeFalta').addEventListener('click', () => finish('falta'));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(null); }, { once: true });
  });
}

// Segunda senha, separada da senha de ADM — apontar atestado/banco de
// horas mexe com algo que vira registro pra RH/folha, então pede uma
// confirmação a mais mesmo já estando em modo de edição.
const BH_PASSWORD = '112233';
function promptBhPassword() {
  return new Promise((resolve) => {
    const backdrop = document.getElementById('modalBackdrop');
    const finish = (result) => { backdrop.classList.remove('open'); backdrop.innerHTML = ''; resolve(result); };
    const render = (errorMsg) => {
      backdrop.innerHTML = `
        <div class="modal confirm-modal">
          <div class="modal-body">
            <p class="confirm-msg">Digite a senha para apontar Atestado/Banco de horas:</p>
            <input type="password" class="modal-input" id="bhPwInput" autocomplete="off">
            ${errorMsg ? `<p class="pw-error">${errorMsg}</p>` : ''}
          </div>
          <div class="modal-actions">
            <button class="icon-btn" id="bhPwCancel">Cancelar</button>
            <button class="icon-btn primary" id="bhPwOk">Confirmar</button>
          </div>
        </div>`;
      backdrop.classList.add('open');
      const input = document.getElementById('bhPwInput');
      input.focus();
      const trySubmit = () => {
        if (input.value !== BH_PASSWORD) { render('Senha incorreta. Tente de novo.'); return; }
        finish(true);
      };
      document.getElementById('bhPwCancel').addEventListener('click', () => finish(false));
      document.getElementById('bhPwOk').addEventListener('click', trySubmit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); trySubmit(); } });
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(false); }, { once: true });
    };
    render(null);
  });
}

// Atestado costuma cobrir vários dias seguidos — em vez de marcar um por
// um, pergunta o período (início/fim, os dois já vêm preenchidos com o
// dia que foi clicado) e aplicaAtestadoNoPeriodo marca todos de uma vez,
// mesmo cruzando meses.
function promptDateRange(defaultIso) {
  return new Promise((resolve) => {
    const backdrop = document.getElementById('modalBackdrop');
    const finish = (result) => { backdrop.classList.remove('open'); backdrop.innerHTML = ''; resolve(result); };
    const render = (errorMsg) => {
      backdrop.innerHTML = `
        <div class="modal confirm-modal">
          <div class="modal-body">
            <p class="confirm-msg">Atestado de qual período?</p>
            <div class="toolbar-tools" style="margin-top:8px">
              <div class="field"><span style="font-size:12px;color:var(--text-muted);margin-right:4px">Início</span><input type="date" id="atestadoDe" value="${defaultIso}"></div>
              <div class="field"><span style="font-size:12px;color:var(--text-muted);margin-right:4px">Fim</span><input type="date" id="atestadoAte" value="${defaultIso}"></div>
            </div>
            ${errorMsg ? `<p class="pw-error">${errorMsg}</p>` : ''}
          </div>
          <div class="modal-actions">
            <button class="icon-btn" id="atestadoPeriodoCancel">Cancelar</button>
            <button class="icon-btn primary" id="atestadoPeriodoOk">Confirmar</button>
          </div>
        </div>`;
      backdrop.classList.add('open');
      document.getElementById('atestadoPeriodoCancel').addEventListener('click', () => finish(null));
      document.getElementById('atestadoPeriodoOk').addEventListener('click', () => {
        const inicio = document.getElementById('atestadoDe').value;
        const fim = document.getElementById('atestadoAte').value;
        if (!inicio || !fim) { render('Preencha as duas datas.'); return; }
        finish(inicio <= fim ? { inicio, fim } : { inicio: fim, fim: inicio });
      });
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(null); }, { once: true });
    };
    render(null);
  });
}

// Marca Atestado em todo mundo os dias do período (inclusive), mesmo
// cruzando meses — cada dia vira um registro próprio em
// edits.bancoHoras (mesmo formato de sempre), só que aplicado de uma
// vez em vez de exigir um clique por dia. Não mexe em cellEl (o
// período pode sair do mês/pessoa visível agora) — re-renderiza o
// painel inteiro no final.
function aplicarAtestadoNoPeriodo(p, cfg, ds, inicioIso, fimIso) {
  const pk = personKey(cfg.id, p);
  const [y1, m1, d1] = inicioIso.split('-').map(Number);
  const [y2, m2, d2] = fimIso.split('-').map(Number);
  let cursor = epochDay(y1, m1, d1);
  const fimEpoch = epochDay(y2, m2, d2);
  let marcados = 0;
  for (; cursor <= fimEpoch; cursor++) {
    const dt = new Date(cursor * 86400000);
    const ano = dt.getUTCFullYear();
    const mesNumero = dt.getUTCMonth() + 1;
    const dia = dt.getUTCDate();
    if (ano !== ds.ano) continue; // fora do ano coberto por essa escala
    const monthMeta = ds.meses.find((m) => m.numero === mesNumero);
    if (!monthMeta) continue;
    const idx = dia - 1;
    if (idx < 0 || idx >= monthMeta.dias) continue;
    const monthKey = monthMeta.chave;
    const dataIso = isoDateFor(ano, mesNumero, dia);

    const chars = (p.escala[monthKey] || 'O'.repeat(monthMeta.dias)).split('');
    chars[idx] = 'O';
    p.escala[monthKey] = chars.join('');
    edits.dias[pk] = edits.dias[pk] || {};
    edits.dias[pk][monthKey] = edits.dias[pk][monthKey] || {};
    edits.dias[pk][monthKey][idx] = 'O';
    edits.bancoHoras = edits.bancoHoras.filter((r) => !(r.pk === pk && r.data === dataIso));
    edits.bancoHoras.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${dia}`,
      pk, data: dataIso,
      nome: p.nome, matricula: p.matricula || null,
      turno: p.papelNormalizado || null, lider: p.lider || null,
      unidade: p.unidade || null,
      tipo: 'ATESTADO',
    });
    marcados++;
  }
  if (marcados) persistEdits();
  return marcados;
}

// Pede a senha e o período, e marca Atestado em todos os dias de uma
// vez (ver aplicarAtestadoNoPeriodo) — o dia clicado entra como início
// e fim padrão do período, ajustável antes de confirmar.
async function marcarAtestadoComPeriodo(p, cfg, ds, monthMeta, day) {
  const senhaOk = await promptBhPassword();
  if (!senhaOk) return false;
  const dataClicada = isoDateFor(ds.ano, monthMeta.numero, day);
  const periodo = await promptDateRange(dataClicada);
  if (!periodo) return false;
  const marcados = aplicarAtestadoNoPeriodo(p, cfg, ds, periodo.inicio, periodo.fim);
  if (marcados) renderPanel();
  return marcados > 0;
}

/* ------------------------------------------------------------------ */

function tickClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  const now = new Date();
  el.innerHTML = `<strong>${fmtLongDate(now)}</strong><span class="clock-time">${now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>`;
}

function startApp() {
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
    navigator.serviceWorker.register('sw.js').then((reg) => {
      // App instalado (PWA) quase nunca é "fechado de verdade" — só fica
      // em segundo plano e volta ao ser reaberto, sem uma navegação nova.
      // O navegador só checa se tem sw.js diferente numa navegação nova,
      // então sem isto um app instalado podia nunca perceber que existe
      // uma versão mais nova, ficando preso indefinidamente na antiga.
      // Isto força essa checagem sempre que o app volta a ficar visível.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
    // sw.js já ativa sozinho a cada deploy (skipWaiting + clients.claim),
    // mas sem isto a aba só passa a ser controlada pela versão nova no
    // PRÓXIMO carregamento manual — quem já estava com a página aberta
    // ficava preso na versão antiga até fechar e abrir de novo por conta
    // própria. Recarrega uma vez, sozinho, assim que o novo SW assume
    // (só quando já existia uma versão anterior rodando — na primeira
    // visita de todas não tem nada "velho" pra atualizar).
    let refreshedForNewWorker = false;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshedForNewWorker) return;
      refreshedForNewWorker = true;
      if (hadController) location.reload();
    });
  }

  function switchPage(page) {
    state.page = state.page === page ? 'app' : page;
    const isDash = state.page === 'dashboard';
    const isEf = state.page === 'efetivos';
    const isBh = state.page === 'bancohoras';
    const isAf = state.page === 'afastados';
    const isSpecialPage = isDash || isEf || isBh || isAf;
    document.getElementById('escalaTypeSwitch').style.display = isSpecialPage ? 'none' : '';
    document.getElementById('tabs').style.display = isSpecialPage ? 'none' : '';
    document.getElementById('dashboardBtn').textContent = isDash ? '📅 Ver escalas' : '📊 Dashboard';
    document.getElementById('efetivosBtn').textContent = isEf ? '📅 Ver escalas' : '🪪 Efetivos';
    document.getElementById('bancoHorasBtn').textContent = isBh ? '📅 Ver escalas' : '🕐 Ausência';
    document.getElementById('afastadosBtn').textContent = isAf ? '📅 Ver escalas' : '🏥 Afastados';
    if (isDash) renderDashboard();
    else if (isEf) renderEfetivos();
    else if (isBh) renderBancoHoras();
    else if (isAf) renderAfastados();
    else if (datasets[state.activeTab]) renderPanel();
  }

  // Visualizador (padrão, sem senha) nunca vê o botão de editar — sem
  // ele, state.editMode nunca vira true, e todo o resto do app já
  // esconde as ferramentas de edição com base nesse mesmo estado (não
  // precisa repetir a checagem em cada botão individualmente).
  const editBtn = document.getElementById('editModeBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const admLoginBtn = document.getElementById('admLoginBtn');
  function applyRoleUI() {
    const isAdm = state.role === 'adm';
    editBtn.style.display = isAdm ? '' : 'none';
    logoutBtn.style.display = isAdm ? '' : 'none';
    admLoginBtn.style.display = isAdm ? 'none' : '';
  }
  applyRoleUI();
  editBtn.addEventListener('click', () => {
    state.editMode = !state.editMode;
    editBtn.textContent = state.editMode ? '✅ Concluir edição' : '✏️ Editar';
    document.body.classList.toggle('edit-mode', state.editMode);
    if (state.page === 'dashboard') renderDashboard();
    else if (state.page === 'efetivos') renderEfetivos();
    else if (state.page === 'bancohoras') renderBancoHoras();
    else if (state.page === 'afastados') renderAfastados();
    else if (datasets[state.activeTab]) renderPanel();
  });
  logoutBtn.addEventListener('click', () => {
    localStorage.removeItem(ROLE_STORAGE_KEY);
    location.reload();
  });
  admLoginBtn.addEventListener('click', async () => {
    const ok = await showAdmLoginModal();
    if (!ok) return;
    state.role = 'adm';
    localStorage.setItem(ROLE_STORAGE_KEY, 'adm');
    applyRoleUI();
  });
  document.getElementById('dashboardBtn').addEventListener('click', () => switchPage('dashboard'));
  document.getElementById('efetivosBtn').addEventListener('click', () => switchPage('efetivos'));
  document.getElementById('bancoHorasBtn').addEventListener('click', () => switchPage('bancohoras'));
  document.getElementById('afastadosBtn').addEventListener('click', () => switchPage('afastados'));
  // Clicar no indicador de sincronização mostra o motivo real de tá
  // Online/Offline — sem precisar abrir o F12/Console do navegador,
  // que a maioria das pessoas não sabe achar.
  document.getElementById('syncStatus').addEventListener('click', () => {
    const backdrop = document.getElementById('modalBackdrop');
    const statusEl = document.getElementById('syncStatus');
    const dbg = window.__firebaseDebug || {};
    const sync = window.__firebaseSync || {};
    backdrop.innerHTML = `
      <div class="modal confirm-modal">
        <div class="modal-body">
          <p class="confirm-msg" style="text-align:left">
            <b>Versão do app:</b> ${dbg.build || '—'}<br>
            <b>Status atual:</b> ${statusEl.textContent}<br>
            <b>Projeto:</b> ${dbg.projectId || '—'}<br>
            <b>Conectado (ready):</b> ${sync.ready ? 'sim' : 'não'}<br>
            <b>Último erro:</b> ${dbg.lastError || 'nenhum registrado'}${dbg.lastErrorAt ? ' (' + dbg.lastErrorAt + ')' : ''}<br>
            <b>Recarregou por sync nesta aba:</b> ${sessionStorage.getItem('escala:syncReloadCount') || '0'}
          </p>
          <p class="confirm-msg" style="margin-top:10px;font-size:12px;color:var(--text-muted)">Manda um print dessa tela pro suporte se estiver com problema de sincronização.</p>
        </div>
        <div class="modal-actions">
          <button class="icon-btn primary" id="syncDebugClose">Fechar</button>
        </div>
      </div>`;
    backdrop.classList.add('open');
    const close = () => { backdrop.classList.remove('open'); backdrop.innerHTML = ''; };
    document.getElementById('syncDebugClose').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); }, { once: true });
  });
  document.getElementById('installAppBtn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    document.getElementById('installAppBtn').style.display = 'none';
  });
}

// Depois do primeiro desenho (com o que já tava salvo neste navegador),
// confere se o Firebase tem uma versão mais nova (de outro aparelho) —
// se tiver, recarrega já com ela. Dali em diante, qualquer edição de
// qualquer pessoa conectada recarrega a página sozinha pra todo mundo
// ficar vendo a mesma coisa (sem precisar apertar F5).
// Conta quantas vezes essa aba recarregou por causa de dado remoto
// diferente — se esse número subir rápido, é sinal de loop (mesma classe
// de bug já vista antes nesse projeto: um "eco" da própria escrita sendo
// lido como mudança nova). Fica visível na telinha de diagnóstico em vez
// de depender de alguém notar um flash na tela.
function reloadForRemoteSync(remoteData) {
  const key = 'escala:syncReloadCount';
  const count = (parseInt(sessionStorage.getItem(key) || '0', 10) || 0) + 1;
  sessionStorage.setItem(key, String(count));
  localStorage.setItem(EDIT_STORAGE_KEY, JSON.stringify(remoteData));
  location.reload();
}

function bootstrapFirebaseSync() {
  const onReady = async () => {
    if (!window.__firebaseSync || !window.__firebaseSync.ready) return;
    const stable = window.__firebaseSync.stableStringify;
    const remoteRaw = await window.__firebaseSync.fetchInitial();
    // Normaliza pro mesmo formato de loadEdits() antes de comparar — o
    // Firestore pode devolver campos que o "edits" local nunca tem (ex.:
    // a cópia de segurança que firebase-sync.js grava no mesmo
    // documento), e sem isso a comparação nunca bate, recarregando a
    // página sem parar à toa.
    const remote = remoteRaw ? normalizeEditsShape(remoteRaw) : null;
    if (remote) {
      if (stable(remote) !== stable(edits)) {
        reloadForRemoteSync(remote);
        return;
      }
      // já está tudo igual — marca como sincronizado antes de assinar
      // onRemoteChange, senão a primeira confirmação do onSnapshot (que
      // só repete esses mesmos dados) é lida como mudança nova e recarrega
      // a página à toa.
      window.__firebaseSync.markSynced(edits);
      // fetchInitial() acabou de confirmar uma leitura real do Firestore
      // — dá pra mostrar Online aqui em vez de esperar a primeira
      // confirmação do listener em tempo real (onRemoteChange/onSnapshot),
      // que numa rede de celular mais lenta pode demorar bem mais que uma
      // leitura comum e deixava o indicador preso em "Conectando…" à toa.
      // (fetchInitial() devolve null tanto quando não existe documento
      // ainda quanto quando a busca falhou, então esse aviso só entra
      // aqui, no caminho em que a leitura comprovadamente funcionou.)
      if (window.__firebaseSync.markOnline) window.__firebaseSync.markOnline();
    } else {
      // nada salvo ainda no Firebase (primeira vez) — sobe o que já
      // existe localmente pra virar o ponto de partida compartilhado
      window.__firebaseSync.pushEdits(edits);
    }
    window.__firebaseSync.onRemoteChange((remoteData) => {
      reloadForRemoteSync(normalizeEditsShape(remoteData));
    });
  };
  if (window.__firebaseSync) onReady();
  else window.addEventListener('firebase-sync-ready', onReady, { once: true });
}

document.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem(ROLE_STORAGE_KEY) === 'adm') state.role = 'adm';
  startApp();
  bootstrapFirebaseSync();
});
