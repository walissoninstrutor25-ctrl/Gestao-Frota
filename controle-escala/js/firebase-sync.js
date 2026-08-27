// Sincronização em tempo real via Firebase Firestore. Módulo separado do
// js/app.js (que continua um script clássico, sem build step) — aqui só
// prepara window.__firebaseSync com o que o app.js precisa (persistEdits
// empurra pra cá, e um listener chama de volta quando outra pessoa edita
// em outro aparelho). Se o Firebase não carregar por qualquer motivo
// (sem internet, CDN bloqueado, projeto mal configurado), o app continua
// funcionando normalmente só com o localStorage local, como antes.

const firebaseConfig = {
  apiKey: "AIzaSyDD6U2abR2tL0oqgcvUuNWtRYVKcpE6t0w",
  authDomain: "controle-escala-509d8.firebaseapp.com",
  projectId: "controle-escala-509d8",
  storageBucket: "controle-escala-509d8.firebasestorage.app",
  messagingSenderId: "348557307264",
  appId: "1:348557307264:web:5e911b355c4c7e9cb36565",
};

const SDK_VERSION = "10.13.2";
const DOC_PATH = ["escala", "edits"]; // coleção "escala", documento "edits"
const CONNECT_TIMEOUT_MS = 12000;

function setStatus(text, cls) {
  const el = document.getElementById("syncStatus");
  if (el) { el.textContent = text; el.className = "sync-status " + cls; }
}

// Guarda o último erro pra mostrar num popup ao clicar no indicador —
// assim dá pra ver o motivo real sem precisar abrir o F12/Console, que
// nem todo mundo sabe achar.
window.__firebaseDebug = { lastError: null, projectId: firebaseConfig.projectId };
function logError(label, err) {
  const msg = err && err.message ? err.message : String(err);
  window.__firebaseDebug.lastError = `${label}: ${msg}`;
  window.__firebaseDebug.lastErrorAt = new Date().toLocaleTimeString("pt-BR");
  console.error("Firebase:", label, err);
}

// Comparação que ignora a ordem das chaves. O Firestore não garante
// devolver um objeto com as propriedades na mesma ordem em que foram
// gravadas — um JSON.stringify() direto podia achar "diferença" onde não
// tinha, e isso fazia a página recarregar sem parar (nunca chegava a
// mostrar Online).
function stableStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

function fail(err) {
  if (err) logError("conectar", err);
  setStatus("🔴 Offline", "sync-offline");
  window.__firebaseSync = { ready: false, stableStringify };
  window.dispatchEvent(new Event("firebase-sync-ready"));
}

// Qualquer chamada individual ao Firestore (não só o carregamento do SDK)
// também pode travar numa rede ruim — isso corta a espera pra não deixar
// nada pendurado indefinidamente.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("tempo esgotado")), ms)),
  ]);
}

async function connect() {
  const [appMod, firestoreMod] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-firestore.js`),
  ]);
  const { initializeApp } = appMod;
  const { getFirestore, doc, setDoc, getDoc, onSnapshot } = firestoreMod;

  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);
  const ref = doc(db, ...DOC_PATH);

  let lastPushedJson = null; // pra não reagir a um snapshot que é eco da própria escrita

  window.__firebaseSync = {
    ready: true,
    stableStringify,
    // Quando o app.js descobre que os dados remotos já batem com os
    // locais (nada novo pra puxar nem empurrar), ele precisa "marcar"
    // esse estado como já sincronizado antes de assinar onRemoteChange
    // — senão o primeiro aviso do onSnapshot (que só confirma os dados
    // que já tínhamos) não tem com o que comparar, é tratado como uma
    // mudança nova de outro aparelho, e recarrega a página à toa.
    markSynced(edits) {
      lastPushedJson = stableStringify(edits);
    },
    async fetchInitial() {
      try {
        const snap = await withTimeout(getDoc(ref), 8000);
        return snap.exists() ? snap.data() : null;
      } catch (err) {
        logError("buscar dados iniciais", err);
        return null;
      }
    },
    async pushEdits(edits) {
      lastPushedJson = stableStringify(edits);
      try {
        await withTimeout(setDoc(ref, JSON.parse(JSON.stringify(edits))), 8000);
      } catch (err) {
        logError("salvar (mudança fica só local até reconectar)", err);
      }
    },
    onRemoteChange(callback) {
      onSnapshot(ref, (snap) => {
        setStatus(snap.metadata.fromCache ? "🔴 Offline" : "🟢 Online", snap.metadata.fromCache ? "sync-offline" : "sync-online");
        if (!snap.exists()) return;
        const data = snap.data();
        if (stableStringify(data) === lastPushedJson) return; // eco da própria escrita, já aplicado localmente
        callback(data);
      }, (err) => {
        logError("conexão em tempo real caiu", err);
        setStatus("🔴 Offline", "sync-offline");
      });
    },
  };
  window.dispatchEvent(new Event("firebase-sync-ready"));
}

// Trava de segurança: qualquer travamento inesperado na conexão (rede
// lenta, CDN bloqueado, SDK com problema) cai pra offline depois de um
// tempo em vez de deixar o indicador preso em "Conectando…" pra sempre.
let settled = false;
setStatus("🟡 Conectando…", "sync-connecting");
connect().then(() => { settled = true; }).catch((err) => { settled = true; fail(err); });
setTimeout(() => { if (!settled) { settled = true; fail(new Error("tempo esgotado ao conectar")); } }, CONNECT_TIMEOUT_MS);

// Segunda trava, mais folgada: mesmo que connect() e as chamadas internas
// (que já têm seus próprios limites) se comportem de um jeito imprevisto
// numa rede real, o texto visível nunca fica preso em "Conectando…" além
// desse prazo. Só corrige o texto — não mexe em window.__firebaseSync,
// porque se connect() já tiver terminado (ready:true) o push/fetch podem
// muito bem estar funcionando mesmo sem a primeira confirmação do
// onSnapshot ainda ter chegado, e desligar isso seria pior que só um
// indicador desatualizado.
setTimeout(() => {
  const el = document.getElementById("syncStatus");
  if (el && el.textContent.includes("Conectando")) {
    if (!window.__firebaseDebug.lastError) window.__firebaseDebug.lastError = "indicador ficou preso em Conectando além de 25s (sem erro específico capturado)";
    el.textContent = "🔴 Offline";
    el.className = "sync-status sync-offline";
  }
}, 25000);
