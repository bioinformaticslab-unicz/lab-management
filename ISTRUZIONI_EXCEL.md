# 📊 Guida alla Compilazione del Template Excel (Magazzino)

Questa guida spiega come compilare correttamente il file Excel per l'importazione massiva di articoli nel magazzino di **UniScan**.
---

## 📝 Descrizione delle Colonne

| Colonna | Obbligatoria | Descrizione | Esempio |
| :--- | :---: | :--- | :--- |
| **ID** | ✅ | Il codice a barre o un identificativo unico. | `800123456789` o `REAG-001` |
| **Nome** | ✅ | Il nome completo dell'articolo. | `Etanolo 96%` |
| **Marchio** | ❌ | La marca o il produttore dell'articolo. | `Sigma-Aldrich` |
| **Categoria**| ✅  | La categoria merceologica (es. Reagenti, Vetreria, DPI). | `Reagenti` |
| **Unita** | ✅  | L'unità di misura base. Usa `pz`, `ml`, `mg` o `pacco`. | `pz` |
| **Capacità_Formato** | ✅ | Il volume o peso del singolo pezzo/flacone. | `500 ml` o `1 kg` |
| **Data_Scadenza** | ❌ | Data di scadenza del prodotto nel formato `AAAA-MM-GG`. | `2026-12-31` |
| **Quantita** | ✅  | Il numero totale di pezzi (o flaconi) attualmente in stock. | `12` |
| **Pezzi_Pacco** | ✅  | Se l'unità è "pacco", quanti pezzi contiene ogni confezione. | `50` |
| **Soglia** | ❌ | La quantità minima sotto la quale ricevere un alert. | `2` |
| **Posizione** | ✅ | Dove è conservato l'articolo nel laboratorio. | `Armadio Infiammabili A` |
| **Immagine** | ❌ | Un link (URL) diretto a una foto del prodotto online. | `https://esempio.it/foto.jpg` |
| **Email_Riordino** | ❌ | L'email a cui inviare l'alert di scorta bassa. | `lab-manager@unicz.it` |

---

## ⚠️ Regole Importanti

1. **Non Modificare le Intestazioni**: La prima riga del file Excel (ID, Nome, ecc.) deve rimanere esattamente così come scaricata dal template.
2. **Nomi e ID**: L'ID e il Nome sono i campi fondamentali. Se carichi un file con un ID già esistente nel sistema, i dati di quell'articolo verranno **aggiornati** con i nuovi valori.
3. **Numeri**: Nelle colonne **Quantità** e **Soglia** inserisci solo numeri (senza scritte come "pezzi" o "litri").
4. **Separatore Decimale**: Se necessario, usa il punto (`.`) per i numeri decimali (es. `1.5`).
5. **Colonne da non compilare**: Non compilare la colonna Pezzi_Pacco se l'unità (Unità) di misura non è "pacco".
6. **Data Scadenza**: Inserire la data nel formato **AAAA-MM-GG** (es. `2026-12-31`). Se il prodotto è scaduto, apparirà in **rosso** nella lista del magazzino.
7. Se necessario inserire l'immagine di un prodotto, cercalo su Google e con il tasto destro cliccare su "Copia indirizzo immagine" e incollalo nella colonna **Immagine**.

---

> [!TIP]
> Puoi usare lo stesso file Excel per fare modifiche massive a molti articoli contemporaneamente: basta esportare i dati esistenti, modificarli su Excel e ricaricarli!
