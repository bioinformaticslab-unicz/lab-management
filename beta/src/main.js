// main.js — LABSCAN Beta
// Alpine.js reactive application logic using the alpine:init registration pattern.

import { auth, db, googleProvider, APP_ID } from './firebase.js';
import {
    signInWithPopup, signOut as fbSignOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
    collection, onSnapshot, query,
    doc, updateDoc, addDoc, serverTimestamp, getDocs
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const ALLOWED_DOMAINS = ['@unicz.it', '@studenti.unicz.it'];
const MAIN_ADMIN_EMAIL = 'vono.niccolo@gmail.com';

function dbCol(...segments) {
    return collection(db, 'artifacts', APP_ID, 'public', 'data', ...segments);
}
function dbDoc(...segments) {
    return doc(db, 'artifacts', APP_ID, 'public', 'data', ...segments);
}

// Register with Alpine BEFORE it boots.
// Both <script type="module"> and Alpine's <script defer> are deferred, but
// document order guarantees this module runs first (it appears first in HTML).
// The 'alpine:init' event fires just before Alpine initializes its components.
document.addEventListener('alpine:init', () => {
    Alpine.data('labApp', () => ({

        // --- AUTH STATE ---
        user: null,
        userRole: 'user',
        authLoading: false,
        authError: '',

        // --- VIEW STATE ---
        activeView: 'scanner',
        tabs: [
            { id: 'scanner',   label: '📷 Scanner',   roles: ['user', 'supervisor', 'co_admin', 'main_admin'] },
            { id: 'inventory', label: '📦 Magazzino',  roles: ['user', 'supervisor', 'co_admin', 'main_admin'] },
            { id: 'admin',     label: '🛠️ Admin',     roles: ['supervisor', 'co_admin', 'main_admin'] },
            { id: 'profile',   label: '👤 Profilo',   roles: ['user', 'supervisor', 'co_admin', 'main_admin'] },
        ],

        // --- SCANNER ---
        scanInput: '',
        searchResults: [],
        allInstruments: [],

        // --- INVENTORY ---
        inventory: [],
        inventorySearch: '',
        inventoryTab: 'all',

        // --- STOCK MODAL ---
        stockModal: { open: false, item: null, action: 'add', qty: null, operator: '' },

        // ========= COMPUTED =========
        get isAdmin()     { return ['main_admin', 'co_admin'].includes(this.userRole); },
        get isSupervisor(){ return this.userRole === 'supervisor'; },

        get visibleTabs() {
            return this.tabs.filter(t => t.roles.includes(this.userRole));
        },

        get filteredInventory() {
            const term = this.inventorySearch.toLowerCase();
            let items = this.inventory;
            if (this.inventoryTab === 'reorder') items = items.filter(i => i.isOrdered);
            if (!term) return items;
            return items.filter(i =>
                i.name?.toLowerCase().includes(term) ||
                i.id?.toLowerCase().includes(term) ||
                i.brand?.toLowerCase().includes(term) ||
                i.category?.toLowerCase().includes(term)
            );
        },

        // ========= INIT =========
        async init() {
            onAuthStateChanged(auth, async (fbUser) => {
                if (fbUser) {
                    const email = fbUser.email || '';
                    const role  = await this.resolveRole(email);
                    const isAllowedDomain = ALLOWED_DOMAINS.some(d => email.endsWith(d));
                    const isPrivileged    = ['main_admin', 'co_admin', 'supervisor'].includes(role);

                    if (!isAllowedDomain && !isPrivileged && email !== MAIN_ADMIN_EMAIL) {
                        await fbSignOut(auth);
                        this.authError = 'Accesso consentito solo agli indirizzi @unicz.it o @studenti.unicz.it.';
                        return;
                    }
                    this.user     = fbUser;
                    this.userRole = role;
                    this.activeView = 'scanner';
                    this.startDataListeners();
                } else {
                    this.user     = null;
                    this.userRole = 'user';
                    this.inventory = [];
                    this.allInstruments = [];
                }
            });

            this.$watch('activeView', v => {
                if (v === 'scanner') this.$nextTick(() => document.getElementById('scanner-input')?.focus());
            });

            document.addEventListener('keydown', e => {
                if (e.key === 'Escape') this.stockModal.open = false;
            });
        },

        // ========= AUTH =========
        async signIn() {
            this.authLoading = true;
            this.authError   = '';
            try {
                await signInWithPopup(auth, googleProvider);
            } catch (err) {
                this.authError = err.code === 'auth/popup-closed-by-user'
                    ? 'Finestra chiusa. Riprova.'
                    : 'Errore login: ' + err.message;
            } finally {
                this.authLoading = false;
            }
        },

        async signOut() { await fbSignOut(auth); },

        async resolveRole(email) {
            if (email === MAIN_ADMIN_EMAIL) return 'main_admin';

            const adminsSnap = await getDocs(collection(db, 'artifacts', APP_ID, 'settings', 'admins', 'emails')).catch(() => null);
            if (adminsSnap?.docs.find(d => d.id === email || d.data().email === email)) return 'co_admin';

            const supSnap = await getDocs(collection(db, 'artifacts', APP_ID, 'settings', 'supervisors', 'list')).catch(() => null);
            if (supSnap?.docs.find(d => d.id === email || d.data().email === email)) return 'supervisor';

            return 'user';
        },

        // ========= DATA LISTENERS =========
        startDataListeners() {
            onSnapshot(query(dbCol('inventory')), snap => {
                this.inventory = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
            });
            onSnapshot(query(dbCol('instruments')), snap => {
                this.allInstruments = snap.docs.map(d => ({ ...d.data(), type: 'instrument' }));
            });
        },

        // ========= SCANNER =========
        handleScan() {
            const term = (this.scanInput || '').trim().toLowerCase();
            if (!term || term.length < 2) { this.searchResults = []; return; }

            const invResults = this.inventory
                .filter(i => i.id?.toLowerCase().includes(term) || i.name?.toLowerCase().includes(term) || i.brand?.toLowerCase().includes(term))
                .map(i => ({ ...i, type: 'inventory' })).slice(0, 5);

            const instResults = this.allInstruments
                .filter(i => i.id?.toLowerCase().includes(term) || i.name?.toLowerCase().includes(term) || i.ip?.toLowerCase().includes(term))
                .slice(0, 5);

            this.searchResults = [...instResults, ...invResults];
        },

        openItem(result) {
            if (result.type === 'inventory') {
                this.activeView = 'inventory';
                this.inventorySearch = result.name;
                this.searchResults = [];
                this.scanInput = '';
            } else {
                this.scanInput = '';
                this.searchResults = [];
                alert(`Strumento: ${result.name} (${result.id})\n\nDettaglio prenotazioni disponibile sull'app principale.`);
            }
        },

        // ========= STOCK MOVEMENTS =========
        openStockModal(item, action) {
            this.stockModal = { open: true, item, action, qty: null, operator: '' };
            this.$nextTick(() => document.getElementById('stock-modal-qty')?.focus());
        },

        async confirmStockMovement() {
            const { item, action, qty, operator } = this.stockModal;
            if (!qty || qty <= 0 || !operator) return;

            const newQty = action === 'add' ? item.quantity + qty : item.quantity - qty;
            if (newQty < 0) { alert(`Impossibile: disponibili ${item.quantity} ${item.unit}`); return; }

            try {
                await updateDoc(dbDoc('inventory', item.id), { quantity: newQty });
                await addDoc(dbCol('stock_movements'), {
                    itemId: item.id, itemName: item.name, action,
                    amount: qty, unit: item.unit,
                    operatorName: operator, userEmail: this.user?.email || '',
                    timestamp: serverTimestamp()
                });
                await addDoc(dbCol('logs'), {
                    category: 'INVENTORY',
                    action: `${action === 'add' ? 'CARICO' : 'SCARICO'}: ${item.name}`,
                    details: `${action === 'add' ? '+' : '-'}${qty} ${item.unit} | Operatore: ${operator}`,
                    userEmail: this.user?.email || '', timestamp: serverTimestamp()
                });
                if (newQty <= item.threshold && item.restockEmail) this.sendRestockEmail(item, newQty);
                this.stockModal.open = false;
            } catch (err) {
                console.error(err);
                alert('Errore nel salvataggio. Riprova.');
            }
        },

        async confirmArrival(item) {
            if (!confirm(`Confermi l'arrivo di ${item.orderQuantity} ${item.unit} di "${item.name}"?`)) return;
            const newQty = (item.quantity || 0) + (item.orderQuantity || 0);
            try {
                await updateDoc(dbDoc('inventory', item.id), {
                    quantity: newQty, isOrdered: false,
                    orderQuantity: null, orderBy: null, orderDate: null
                });
                await addDoc(dbCol('stock_movements'), {
                    itemId: item.id, itemName: item.name, action: 'add',
                    amount: item.orderQuantity, unit: item.unit,
                    operatorName: this.user?.email || '', userEmail: this.user?.email || '',
                    isArrival: true, timestamp: serverTimestamp()
                });
            } catch (err) {
                console.error(err);
                alert('Errore nella conferma arrivo.');
            }
        },

        openOrderModal() {
            alert('Funzionalità in arrivo nella Beta!\n\nPer ora usa la versione principale per aggiungere ordini.');
        },

        async sendRestockEmail(item, currentQty) {
            if (typeof emailjs === 'undefined') return;
            try {
                await emailjs.send('service_6zh4wqk', 'template_6nayepk', {
                    to_email: item.restockEmail, item_name: item.name, item_id: item.id,
                    current_qty: currentQty, unit: item.unit,
                    threshold: item.threshold, location: item.location || 'N/A'
                }, 'OSVoNoZCEeHUrwaaq');
            } catch (e) { console.warn('[LABSCAN Beta] Email not sent:', e); }
        }

    }));
});
