// main.js — LABSCAN Beta
// Alpine.js reactive application logic. Replaces manual DOM manipulation.

import { auth, db, googleProvider, APP_ID } from './firebase.js';
import {
    signInWithPopup, signOut as fbSignOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
    collection, onSnapshot, query, orderBy,
    doc, updateDoc, addDoc, serverTimestamp, getDoc, getDocs, where
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const ALLOWED_DOMAINS = ['@unicz.it', '@studenti.unicz.it'];
const MAIN_ADMIN_EMAIL = 'vono.niccolo@gmail.com';

function dbCol(...segments) {
    return collection(db, 'artifacts', APP_ID, 'public', 'data', ...segments);
}
function dbDoc(...segments) {
    return doc(db, 'artifacts', APP_ID, 'public', 'data', ...segments);
}

window.labApp = function () {
    return {
        // --- AUTH STATE ---
        user: null,
        userRole: 'user', // user, supervisor, main_admin, co_admin
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
        get isAdmin() { return ['main_admin', 'co_admin'].includes(this.userRole); },
        get isSupervisor() { return this.userRole === 'supervisor'; },

        get visibleTabs() {
            return this.tabs.filter(t => t.roles.includes(this.userRole));
        },

        get filteredInventory() {
            const term = this.inventorySearch.toLowerCase();
            let items = this.inventory;

            if (this.inventoryTab === 'reorder') {
                items = items.filter(i => i.isOrdered);
            }

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
                    const role = await this.resolveRole(email);

                    // Domain gate for regular users
                    const isAllowedDomain = ALLOWED_DOMAINS.some(d => email.endsWith(d));
                    const isPrivileged = ['main_admin', 'co_admin', 'supervisor'].includes(role);

                    if (!isAllowedDomain && !isPrivileged && email !== MAIN_ADMIN_EMAIL) {
                        await fbSignOut(auth);
                        this.authError = 'Accesso consentito solo agli indirizzi @unicz.it o @studenti.unicz.it.';
                        return;
                    }

                    this.user = fbUser;
                    this.userRole = role;
                    this.activeView = 'scanner'; // land on scanner after login
                    this.startDataListeners();
                } else {
                    this.user = null;
                    this.userRole = 'user';
                    this.inventory = [];
                    this.allInstruments = [];
                }
            });

            // Auto-focus scanner input on 'scanner' view
            this.$watch('activeView', (v) => {
                if (v === 'scanner') this.$nextTick(() => document.getElementById('scanner-input')?.focus());
            });

            // ESC to close modals
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') this.stockModal.open = false;
            });
        },

        // ========= AUTH =========
        async signIn() {
            this.authLoading = true;
            this.authError = '';
            try {
                await signInWithPopup(auth, googleProvider);
            } catch (err) {
                this.authError = err.code === 'auth/popup-closed-by-user'
                    ? 'Finestra di accesso chiusa. Riprova.'
                    : 'Errore durante il login: ' + err.message;
            } finally {
                this.authLoading = false;
            }
        },

        async signOut() {
            await fbSignOut(auth);
        },

        async resolveRole(email) {
            if (email === MAIN_ADMIN_EMAIL) return 'main_admin';

            // Check co-admins
            const adminsRef = collection(db, 'artifacts', APP_ID, 'settings', 'admins', 'emails');
            const adminsSnap = await getDocs(adminsRef).catch(() => null);
            if (adminsSnap) {
                const found = adminsSnap.docs.find(d => d.id === email || d.data().email === email);
                if (found) return 'co_admin';
            }

            // Check supervisors
            const supRef = collection(db, 'artifacts', APP_ID, 'settings', 'supervisors', 'list');
            const supSnap = await getDocs(supRef).catch(() => null);
            if (supSnap) {
                const found = supSnap.docs.find(d => d.id === email || d.data().email === email);
                if (found) return 'supervisor';
            }

            return 'user';
        },

        // ========= DATA LISTENERS =========
        startDataListeners() {
            // Inventory
            onSnapshot(query(dbCol('inventory')), (snap) => {
                this.inventory = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
            });

            // Instruments (for smart search)
            onSnapshot(query(dbCol('instruments')), (snap) => {
                this.allInstruments = snap.docs.map(d => ({ ...d.data(), type: 'instrument' }));
            });
        },

        // ========= SCANNER =========
        handleScan() {
            const term = (this.scanInput || '').trim().toLowerCase();
            if (!term || term.length < 2) { this.searchResults = []; return; }

            const invResults = this.inventory
                .filter(i =>
                    i.id?.toLowerCase().includes(term) ||
                    i.name?.toLowerCase().includes(term) ||
                    i.brand?.toLowerCase().includes(term)
                )
                .map(i => ({ ...i, type: 'inventory' }))
                .slice(0, 5);

            const instResults = this.allInstruments
                .filter(i =>
                    i.id?.toLowerCase().includes(term) ||
                    i.name?.toLowerCase().includes(term) ||
                    i.ip?.toLowerCase().includes(term)
                )
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
                // For instruments, navigate to detail (simplified)
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

            const newQty = action === 'add'
                ? item.quantity + qty
                : item.quantity - qty;

            if (newQty < 0) {
                alert(`Impossibile: quantità disponibile è ${item.quantity} ${item.unit}`);
                return;
            }

            try {
                const itemRef = dbDoc('inventory', item.id);
                await updateDoc(itemRef, { quantity: newQty });

                // Log movement
                await addDoc(dbCol('stock_movements'), {
                    itemId: item.id,
                    itemName: item.name,
                    action,
                    amount: qty,
                    unit: item.unit,
                    operatorName: operator,
                    userEmail: this.user?.email || '',
                    timestamp: serverTimestamp()
                });

                // Log action
                await addDoc(dbCol('logs'), {
                    category: 'INVENTORY',
                    action: `${action === 'add' ? 'CARICO' : 'SCARICO'}: ${item.name}`,
                    details: `${action === 'add' ? '+' : '-'}${qty} ${item.unit} | Operatore: ${operator}`,
                    userEmail: this.user?.email || '',
                    timestamp: serverTimestamp()
                });

                // Check low stock
                if (newQty <= item.threshold && item.restockEmail) {
                    this.sendRestockEmail(item, newQty);
                }

                this.stockModal.open = false;
            } catch (err) {
                console.error(err);
                alert('Errore nel salvataggio. Riprova.');
            }
        },

        async confirmArrival(item) {
            if (!confirm(`Confermi l'arrivo di ${item.orderQuantity} ${item.unit} di "${item.name}"?`)) return;
            const newQty = (item.quantity || 0) + (item.orderQuantity || 0);
            const op = this.user?.email || 'Utente';

            try {
                await updateDoc(dbDoc('inventory', item.id), {
                    quantity: newQty,
                    isOrdered: false,
                    orderQuantity: null,
                    orderBy: null,
                    orderDate: null
                });

                await addDoc(dbCol('stock_movements'), {
                    itemId: item.id,
                    itemName: item.name,
                    action: 'add',
                    amount: item.orderQuantity,
                    unit: item.unit,
                    operatorName: op,
                    userEmail: this.user?.email || '',
                    isArrival: true,
                    timestamp: serverTimestamp()
                });
            } catch (err) {
                console.error(err);
                alert('Errore nella conferma arrivo. Riprova.');
            }
        },

        openOrderModal(item) {
            // Simplified — redirect to main app for order management in beta
            if (item) {
                alert(`Funzionalità in arrivo nella Beta!\n\nPer ora usa la versione principale per aggiungere ordini.`);
            } else {
                alert(`Funzionalità in arrivo nella Beta!\n\nPer ora usa la versione principale per aggiungere ordini.`);
            }
        },

        // ========= EMAIL =========
        async sendRestockEmail(item, currentQty) {
            // Uses EmailJS installed globally on the page if available
            if (typeof emailjs === 'undefined') return;
            try {
                await emailjs.send('service_6zh4wqk', 'template_6nayepk', {
                    to_email: item.restockEmail,
                    item_name: item.name,
                    item_id: item.id,
                    current_qty: currentQty,
                    unit: item.unit,
                    threshold: item.threshold,
                    location: item.location || 'N/A'
                }, 'OSVoNoZCEeHUrwaaq');
                console.log('[LABSCAN Beta] Restock email sent for:', item.name);
            } catch (e) {
                console.warn('[LABSCAN Beta] Email not sent:', e);
            }
        }
    };
};
