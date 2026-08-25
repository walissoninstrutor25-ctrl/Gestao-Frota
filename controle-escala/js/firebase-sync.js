// Sincronização em tempo real via Firebase Firestore. Módulo separado do
// js/app.js (que continua um script clássico, sem build step) — aqui só
// prepara window.__firebaseSync com o que o app.js precisa (persistEdits
// empurra pra cá, e um listener chama de volta quando outra pessoa edita
// em outro aparelho). Se o Firebase não carregar por qualquer motivo
// (sem internet, CDN bloqueado, projeto mal configurado), o app continua
// funcionando normalmente só com o localStorage local, como antes.

const firebaseConfig = {
  apiKey: "AIzaSyAjEcv-Kwscr-5PiZ0Alla3XxACgSdDm9Q",
  authDomain: "controle-de-escala-operacional.firebaseapp.com",
  projectId: "controle-de-escala-operacional",
  storageBucket: "controle-de-escala-operacional.firebasestorage.app",
  messagingSenderId: "86487653924",
  appId: "1:86487653924:web:61bc1eceaef840884442b1",
};

const SDK_VERSION = "10.13.2";
const DOC_PATH = ["escala", "edits"]; // coleção "escala", documento "edits"
const CONNECT_TIMEOUT_MS = 12000;

function setStatus(text, cls) {
  const el = document.getElementById("syncStatus");
  if (el) { el.textContent = text; el.className = "sync-status " + cls; }
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
  if (err) console.error("Firebase:", err);
  setStatus("🔴 Offline", "sync-offline");
  window.__firebaseSync = { ready: false, stableStringify };
  window.dispatchEvent(new Event("firebase-sync-ready"));
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
    async fetchInitial() {
      try {
        const snap = await getDoc(ref);
        return snap.exists() ? snap.data() : null;
      } catch (err) {
        console.error("Firebase: falha ao buscar dados iniciais", err);
        return null;
      }
    },
    async pushEdits(edits) {
      lastPushedJson = stableStringify(edits);
      try {
        await setDoc(ref, JSON.parse(JSON.stringify(edits)));
      } catch (err) {
        console.error("Firebase: falha ao salvar (mudança fica só local até reconectar)", err);
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
        console.error("Firebase: conexão em tempo real caiu", err);
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
