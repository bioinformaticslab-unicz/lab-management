# LABSCAN Beta ⚗️

> **Questa è la versione di test (Beta v2) di LABSCAN Lab.**  
> Non modifica l'app principale (`../index.html`). È completamente isolata in questa cartella.

## Tecnologie Usate

| Strumento | Motivo |
|-----------|--------|
| **Alpine.js** | Sostituisce la manipolazione manuale del DOM (`getElementById`). Rende l'HTML reattivo tramite `x-show`, `x-data`, `x-model`. |
| **Firebase v10 (Modular SDK)** | Importato via URL ESM, nessuna installazione richiesta. |
| **Tailwind CSS CDN** | Stesse utility class ma compilate on-demand. |
| **ES Modules** | Il codice è ora diviso in file separati (`src/firebase.js`, `src/main.js`) senza bisogno di npm o build step. |

## Struttura File

```
lab-management/
├── index.html              ← App PRINCIPALE (non toccare)
├── firestore.rules         ← Regole di sicurezza Firebase (da applicare)
└── beta/
    ├── index.html          ← Interfaccia Beta (Alpine.js)
    └── src/
        ├── firebase.js     ← Configurazione Firebase modularizzata
        └── main.js         ← Logica reattiva dell'app (Alpine.js)
```

---

## 🚀 Come Testare su GitHub Pages

Poiché il progetto è già deployato tramite GitHub Pages (repository `lab-management`), la Beta sarà accessibile automaticamente come sotto-cartella.

### Passo 1 — Fai la commit dei nuovi file

```bash
cd /Users/niccolovono/lab-management
git add beta/ firestore.rules
git commit -m "feat: add LABSCAN Beta v2 (Alpine.js + modular Firebase)"
git push
```

### Passo 2 — Accedi all'URL Beta

Dopo qualche minuto che GitHub Pages rigenerava la build, la Beta sarà disponibile a:

```
https://[tuo-username].github.io/lab-management/beta/
```

> **Esempio:** se l'app principale è `https://niccolovono.github.io/lab-management/` allora la beta è su `https://niccolovono.github.io/lab-management/beta/`

---

## 🔒 Come Applicare le Firestore Security Rules

> ⚠️ **Attenzione**: questo passaggio blinda il database. Eseguilo solo quando sei pronto. Sono backward-compatible con l'app principale perché leggono le stesse collezioni.

1. Vai su [Firebase Console](https://console.firebase.google.com/) → seleziona il progetto `unisca-lab`
2. Clicca su **Firestore Database** nel menu a sinistra
3. Vai nella tab **Regole** (Rules)
4. **Sostituisci** il contenuto con quello del file `firestore.rules`
5. Clicca **Pubblica**

Le regole impediranno a chiunque senza `@unicz.it` o `@studenti.unicz.it` di leggere dati, e bloccheranno la scrittura per chi non è almeno un utente autenticato.

---

## 🆚 Differenze con la Versione Principale

| Feature | App Principale | Beta v2 |
|---------|---------------|---------|
| Architettura | Monolite (3700 righe) | Modulare (più file) |
| Reattività UI | Manuale (`getElementById`) | Alpine.js (`x-show`, `x-model`) |
| Firebase SDK | CDN globale | ES Modules (tree-shakeable) |
| Build step | Nessuno | Nessuno (zero-config) |
| Admin Dashboard | ✅ Completa | 🔄 In costruzione |
| Scanner + Magazzino | ✅ Completa | ✅ Portato |
| Prenotazioni | ✅ Completa | 🔄 In costruzione |

---

## 📝 Note

- Il link "← Torna alla versione stabile" nella pagina Admin della Beta riporta all'`index.html` principale.
- Il badge **⚗️ BETA v2** in basso a destra identifica visivamente la versione.
