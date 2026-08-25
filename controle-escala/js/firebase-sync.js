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

function setStatus(text, cls) {
  const el = document.getElementById("syncStatus");
  if (el) { el.textContent = text; el.className = "sync-status " + cls; }
}

async function init() {
  setStatus("🟡 Conectando…", "sync-connecting");
  let firestoreMod, appMod;
  try {
    [appMod, firestoreMod] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-firestore.js`),
    ]);
  } catch (err) {
    console.error("Firebase: falha ao carregar o SDK (sem internet ou CDN bloqueado)", err);
    setStatus("🔴 Offline", "sync-offline");
    window.__firebaseSync = { ready: false };
    window.dispatchEvent(new Event("firebase-sync-ready"));
    return;
  }

  const { initializeApp } = appMod;
  const { getFirestore, doc, setDoc, getDoc, onSnapshot, enableIndexedDbPersistence } = firestoreMod;

  let app, db, ref;
  try {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    ref = doc(db, ...DOC_PATH);
    try { await enableIndexedDbPersistence(db); } catch { /* cache offline é bônus, não bloqueia nada se falhar */ }
  } catch (err) {
    console.error("Firebase: falha ao inicializar", err);
    setStatus("🔴 Offline", "sync-offline");
    window.__firebaseSync = { ready: false };
    window.dispatchEvent(new Event("firebase-sync-ready"));
    return;
  }

  let lastPushedJson = null; // pra não reagir a um snapshot que é eco da própria escrita

  window.__firebaseSync = {
    ready: true,
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
      const json = JSON.stringify(edits);
      lastPushedJson = json;
      try {
        await setDoc(ref, JSON.parse(json));
      } catch (err) {
        console.error("Firebase: falha ao salvar (mudança fica só local até reconectar)", err);
      }
    },
    onRemoteChange(callback) {
      onSnapshot(ref, (snap) => {
        setStatus(snap.metadata.fromCache ? "🔴 Offline" : "🟢 Online", snap.metadata.fromCache ? "sync-offline" : "sync-online");
        if (!snap.exists()) return;
        const data = snap.data();
        if (JSON.stringify(data) === lastPushedJson) return; // eco da própria escrita, já aplicado localmente
        callback(data);
      }, (err) => {
        console.error("Firebase: conexão em tempo real caiu", err);
        setStatus("🔴 Offline", "sync-offline");
      });
    },
  };
  window.dispatchEvent(new Event("firebase-sync-ready"));
}

init();
