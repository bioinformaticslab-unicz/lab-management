// main.js — LABSCAN Beta v2
// Full Alpine.js app logic: auth, inventory, bookings, admin CRUD, logs.

import { auth, db, googleProvider, APP_ID } from './firebase.js';
import {
    signInWithPopup, signOut as fbSignOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
    collection, onSnapshot, query, orderBy, limit,
    doc, updateDoc, addDoc, setDoc, deleteDoc, serverTimestamp, getDocs
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const ALLOWED_DOMAINS = ['@unicz.it', '@studenti.unicz.it'];
const MAIN_ADMIN_EMAIL = 'vono.niccolo@gmail.com';

function dbCol(...segments) {
    return collection(db, 'artifacts', APP_ID, 'public', 'data', ...segments);
}
function dbDoc(...segments) {
    return doc(db, 'artifacts', APP_ID, 'public', 'data', ...segments);
}
function genPNR() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ════════════════════════════════════════════════════════════
// Alpine.data registration (must happen BEFORE Alpine boots)
// ════════════════════════════════════════════════════════════
document.addEventListener('alpine:init', () => {
    Alpine.data('labApp', () => ({

        // ── AUTH ──────────────────────────────────────────────
        user: null,
        userRole: 'user',
        authLoading: false,
        authError: '',

        // ── NAVIGATION ────────────────────────────────────────
        activeView: 'scanner',
        tabs: [
            { id: 'scanner',   icon: '📷', label: 'Scanner',   roles: ['user','supervisor','co_admin','main_admin'] },
            { id: 'inventory', icon: '📦', label: 'Magazzino',  roles: ['user','supervisor','co_admin','main_admin'] },
            { id: 'bookings',  icon: '📅', label: 'Prenota',    roles: ['user','supervisor','co_admin','main_admin'] },
            { id: 'admin',     icon: '🛠️', label: 'Admin',     roles: ['supervisor','co_admin','main_admin'] },
            { id: 'profile',   icon: '👤', label: 'Profilo',    roles: ['user','supervisor','co_admin','main_admin'] },
        ],
        adminTab: 'inventory',

        // ── DATA ──────────────────────────────────────────────
        inventory: [],
        instruments: [],
        recentMovements: [],
        logs: [],

        // ── FILTERS ───────────────────────────────────────────
        inventorySearch: '',
        inventoryTab: 'all',
        instrumentSearch: '',

        // ── SCANNER ───────────────────────────────────────────
        scanInput: '',
        searchResults: [],

        // ── MODALS ────────────────────────────────────────────
        stockModal:   { open: false, item: null, action: 'add', qty: null, operator: '' },
        bookingModal: { open: false, instrument: null, email: '', userName: '', startDate: '', endDate: '', notes: '', pnr: '' },
        confirming: false,
        saving: false,

        // ── ADMIN FORMS ───────────────────────────────────────
        editingItem: null,
        itemForm: { name:'', id:'', brand:'', category:'', quantity:0, unit:'', threshold:0, location:'', restockEmail:'', image:'' },

        editingInstrument: null,
        instrumentForm: { name:'', id:'', brand:'', location:'', imageUrl:'' },

        // ═══ COMPUTED ═══════════════════════════════════════════
        get isAdmin()      { return ['main_admin','co_admin'].includes(this.userRole); },
        get isSupervisor() { return this.userRole === 'supervisor'; },
        get visibleTabs()  { return this.tabs.filter(t => t.roles.includes(this.userRole)); },

        get filteredInventory() {
            const t = this.inventorySearch.toLowerCase();
            let items = this.inventoryTab === 'reorder' ? this.inventory.filter(i => i.isOrdered) : this.inventory;
            return t ? items.filter(i =>
                i.name?.toLowerCase().includes(t) ||
                i.id?.toLowerCase().includes(t) ||
                i.brand?.toLowerCase().includes(t) ||
                i.category?.toLowerCase().includes(t)
            ) : items;
        },

        get filteredInstruments() {
            const t = this.instrumentSearch.toLowerCase();
            return t ? this.instruments.filter(i =>
                i.name?.toLowerCase().includes(t) ||
                i.id?.toLowerCase().includes(t) ||
                i.brand?.toLowerCase().includes(t)
            ) : this.instruments;
        },

        // ═══ INIT ════════════════════════════════════════════════
        async init() {
            onAuthStateChanged(auth, async (fbUser) => {
                if (fbUser) {
                    const email = fbUser.email || '';
                    const role  = await this.resolveRole(email);
                    const ok    = ALLOWED_DOMAINS.some(d => email.endsWith(d));
                    const priv  = ['main_admin','co_admin','supervisor'].includes(role);
                    if (!ok && !priv && email !== MAIN_ADMIN_EMAIL) {
                        await fbSignOut(auth);
                        this.authError = 'Accesso consentito solo agli indirizzi @unicz.it o @studenti.unicz.it.';
                        return;
                    }
                    this.user     = fbUser;
                    this.userRole = role;
                    // Pre-fill booking form with known user info
                    this.bookingModal.email    = fbUser.email || '';
                    this.bookingModal.userName = fbUser.displayName || '';
                    this.activeView = 'scanner';
                    this.startDataListeners();
                } else {
                    this.user     = null;
                    this.userRole = 'user';
                    this.inventory = []; this.instruments = [];
                }
            });

            this.$watch('activeView', v => {
                if (v === 'scanner') this.$nextTick(() => document.getElementById('scanner-input')?.focus());
            });
            document.addEventListener('keydown', e => {
                if (e.key === 'Escape') { this.stockModal.open = false; this.bookingModal.open = false; }
            });
        },

        // ═══ AUTH ════════════════════════════════════════════════
        async signIn() {
            this.authLoading = true; this.authError = '';
            try { await signInWithPopup(auth, googleProvider); }
            catch (e) {
                this.authError = e.code === 'auth/popup-closed-by-user' ? 'Finestra chiusa. Riprova.' : 'Errore login: ' + e.message;
            } finally { this.authLoading = false; }
        },
        async signOut() { await fbSignOut(auth); },

        async resolveRole(email) {
            if (email === MAIN_ADMIN_EMAIL) return 'main_admin';
            const adminSnap = await getDocs(collection(db, 'artifacts', APP_ID, 'settings', 'admins', 'emails')).catch(() => null);
            if (adminSnap?.docs.find(d => d.id === email || d.data().email === email)) return 'co_admin';
            const supSnap = await getDocs(collection(db, 'artifacts', APP_ID, 'settings', 'supervisors', 'list')).catch(() => null);
            if (supSnap?.docs.find(d => d.id === email || d.data().email === email)) return 'supervisor';
            return 'user';
        },

        // ═══ DATA LISTENERS ═══════════════════════════════════════
        startDataListeners() {
            onSnapshot(query(dbCol('inventory')), snap => {
                this.inventory = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
            });
            onSnapshot(query(dbCol('instruments')), snap => {
                this.instruments = snap.docs.map(d => ({ ...d.data(), type: 'instrument' }));
            });
            onSnapshot(
                query(dbCol('stock_movements'), orderBy('timestamp', 'desc'), limit(20)),
                snap => { this.recentMovements = snap.docs.map(d => ({ ...d.data(), _id: d.id })); }
            );
        },

        async loadLogs() {
            const snap = await getDocs(query(dbCol('logs'), orderBy('timestamp', 'desc'), limit(60))).catch(() => null);
            this.logs = snap ? snap.docs.map(d => ({ ...d.data(), _id: d.id })) : [];
        },

        // ═══ SCANNER ══════════════════════════════════════════════
        handleScan() {
            const t = (this.scanInput || '').trim().toLowerCase();
            if (!t || t.length < 2) { this.searchResults = []; return; }
            const inv = this.inventory.filter(i => i.id?.toLowerCase().includes(t) || i.name?.toLowerCase().includes(t) || i.brand?.toLowerCase().includes(t)).map(i => ({ ...i, type: 'inventory' })).slice(0, 5);
            const ins = this.instruments.filter(i => i.id?.toLowerCase().includes(t) || i.name?.toLowerCase().includes(t) || i.ip?.toLowerCase().includes(t)).slice(0, 5);
            this.searchResults = [...ins, ...inv];
        },
        openItem(r) {
            if (r.type === 'inventory') {
                this.activeView = 'inventory'; this.inventorySearch = r.name; this.searchResults = []; this.scanInput = '';
            } else {
                this.activeView = 'bookings'; this.instrumentSearch = r.name; this.searchResults = []; this.scanInput = '';
            }
        },

        // ═══ STOCK MOVEMENTS ══════════════════════════════════════
        openStockModal(item, action) {
            this.stockModal = { open: true, item, action, qty: null, operator: '' };
            this.$nextTick(() => document.getElementById('stock-modal-qty')?.focus());
        },

        async confirmStockMovement() {
            const { item, action, qty, operator } = this.stockModal;
            if (!qty || qty <= 0 || !operator) return;
            const newQty = action === 'add' ? item.quantity + qty : item.quantity - qty;
            if (newQty < 0) { alert(`Impossibile: disponibili ${item.quantity} ${item.unit}`); return; }
            this.confirming = true;
            try {
                await updateDoc(dbDoc('inventory', item.id), { quantity: newQty });
                await addDoc(dbCol('stock_movements'), { itemId: item.id, itemName: item.name, action, amount: qty, unit: item.unit, operatorName: operator, userEmail: this.user?.email || '', timestamp: serverTimestamp() });
                await addDoc(dbCol('logs'), { category: 'INVENTORY', action: `${action === 'add' ? 'CARICO' : 'SCARICO'}: ${item.name}`, details: `${action === 'add' ? '+' : '-'}${qty} ${item.unit} | Operatore: ${operator}`, userEmail: this.user?.email || '', timestamp: serverTimestamp() });
                if (newQty <= item.threshold && item.restockEmail) this.sendRestockEmail(item, newQty);
                this.stockModal.open = false;
            } catch (e) { console.error(e); alert('Errore nel salvataggio.'); }
            finally { this.confirming = false; }
        },

        async confirmArrival(item) {
            if (!confirm(`Confermi l'arrivo di ${item.orderQuantity} ${item.unit} di "${item.name}"?`)) return;
            const newQty = (item.quantity || 0) + (item.orderQuantity || 0);
            try {
                await updateDoc(dbDoc('inventory', item.id), { quantity: newQty, isOrdered: false, orderQuantity: null, orderBy: null, orderDate: null });
                await addDoc(dbCol('stock_movements'), { itemId: item.id, itemName: item.name, action: 'add', amount: item.orderQuantity, unit: item.unit, operatorName: this.user?.email || '', userEmail: this.user?.email || '', isArrival: true, timestamp: serverTimestamp() });
            } catch (e) { console.error(e); alert('Errore nella conferma arrivo.'); }
        },

        openOrderModal() {
            alert('Funzionalità in arrivo!\n\nPer ora usa la versione principale per aggiungere ordini.');
        },

        // ═══ BOOKINGS ══════════════════════════════════════════════
        openBookingModal(inst) {
            this.bookingModal = {
                open: true, instrument: inst, pnr: '',
                email: this.user?.email || '',
                userName: this.user?.displayName || '',
                startDate: '', endDate: '', notes: ''
            };
        },

        async confirmBooking() {
            const { instrument, email, userName, startDate, endDate, notes } = this.bookingModal;
            if (!email || !userName || !startDate || !endDate) return;
            if (new Date(endDate) <= new Date(startDate)) { alert('La data di fine deve essere successiva alla data di inizio.'); return; }
            this.confirming = true;
            try {
                const pnr = genPNR();
                await addDoc(dbCol('bookings'), {
                    instrumentId: instrument.id,
                    instrumentName: instrument.name,
                    userEmail: email,
                    userName,
                    startDate,
                    endDate,
                    notes: notes || '',
                    pnr,
                    status: 'active',
                    createdAt: serverTimestamp()
                });
                await addDoc(dbCol('logs'), {
                    category: 'BOOKING',
                    action: `Prenotazione: ${instrument.name}`,
                    details: `${userName} · ${startDate} → ${endDate} · PNR: ${pnr}`,
                    userEmail: email,
                    timestamp: serverTimestamp()
                });
                this.bookingModal.pnr = pnr;
            } catch (e) { console.error(e); alert('Errore nella prenotazione. Riprova.'); }
            finally { this.confirming = false; }
        },

        // ═══ ADMIN — INVENTORY CRUD ════════════════════════════════
        editItem(item) {
            this.editingItem = item;
            this.itemForm = {
                name: item.name || '', id: item.id || '', brand: item.brand || '',
                category: item.category || '', quantity: item.quantity || 0,
                unit: item.unit || '', threshold: item.threshold || 0,
                location: item.location || '', restockEmail: item.restockEmail || '',
                image: item.image || ''
            };
            window.scrollTo({ top: 0, behavior: 'smooth' });
        },

        clearItemForm() {
            this.editingItem = null;
            this.itemForm = { name:'', id:'', brand:'', category:'', quantity:0, unit:'', threshold:0, location:'', restockEmail:'', image:'' };
        },

        async saveInventoryItem() {
            const f = this.itemForm;
            if (!f.name || !f.id || !f.unit) return;
            this.saving = true;
            try {
                const data = { name: f.name, brand: f.brand, category: f.category, quantity: f.quantity, unit: f.unit, threshold: f.threshold, location: f.location, restockEmail: f.restockEmail, image: f.image };
                if (this.editingItem) {
                    await updateDoc(dbDoc('inventory', this.editingItem.id), data);
                } else {
                    await setDoc(dbDoc('inventory', f.id), { ...data, id: f.id, isOrdered: false });
                }
                await addDoc(dbCol('logs'), { category: 'ADMIN', action: `${this.editingItem ? 'Modifica' : 'Nuovo'} articolo: ${f.name}`, details: `ID: ${f.id}`, userEmail: this.user?.email || '', timestamp: serverTimestamp() });
                this.clearItemForm();
                alert(this.editingItem ? 'Articolo aggiornato!' : 'Articolo aggiunto!');
            } catch (e) { console.error(e); alert('Errore nel salvataggio.'); }
            finally { this.saving = false; }
        },

        async deleteItem(item) {
            if (!this.isAdmin) return;
            if (!confirm(`Eliminare definitivamente "${item.name}"? Questa azione è irreversibile.`)) return;
            try {
                await deleteDoc(dbDoc('inventory', item.id));
                await addDoc(dbCol('logs'), { category: 'ADMIN', action: `Eliminazione articolo: ${item.name}`, details: `ID: ${item.id}`, userEmail: this.user?.email || '', timestamp: serverTimestamp() });
            } catch (e) { console.error(e); alert('Errore nell\'eliminazione.'); }
        },

        // ═══ ADMIN — INSTRUMENT CRUD ═══════════════════════════════
        editInstrument(inst) {
            this.editingInstrument = inst;
            this.instrumentForm = { name: inst.name || '', id: inst.id || '', brand: inst.brand || '', location: inst.location || '', imageUrl: inst.imageUrl || '' };
            window.scrollTo({ top: 0, behavior: 'smooth' });
        },

        clearInstrumentForm() {
            this.editingInstrument = null;
            this.instrumentForm = { name:'', id:'', brand:'', location:'', imageUrl:'' };
        },

        async saveInstrument() {
            const f = this.instrumentForm;
            if (!f.name || !f.id) return;
            this.saving = true;
            try {
                const data = { name: f.name, brand: f.brand, location: f.location, imageUrl: f.imageUrl };
                if (this.editingInstrument) {
                    await updateDoc(dbDoc('instruments', this.editingInstrument.id), data);
                } else {
                    await setDoc(dbDoc('instruments', f.id), { ...data, id: f.id });
                }
                await addDoc(dbCol('logs'), { category: 'ADMIN', action: `${this.editingInstrument ? 'Modifica' : 'Nuovo'} strumento: ${f.name}`, details: `ID: ${f.id}`, userEmail: this.user?.email || '', timestamp: serverTimestamp() });
                this.clearInstrumentForm();
                alert(this.editingInstrument ? 'Strumento aggiornato!' : 'Strumento aggiunto!');
            } catch (e) { console.error(e); alert('Errore nel salvataggio.'); }
            finally { this.saving = false; }
        },

        // ═══ EMAIL ════════════════════════════════════════════════
        async sendRestockEmail(item, currentQty) {
            if (typeof emailjs === 'undefined') return;
            try {
                await emailjs.send('service_6zh4wqk', 'template_6nayepk', {
                    to_email: item.restockEmail, item_name: item.name, item_id: item.id,
                    current_qty: currentQty, unit: item.unit, threshold: item.threshold,
                    location: item.location || 'N/A'
                }, 'OSVoNoZCEeHUrwaaq');
            } catch (e) { console.warn('[Beta] Email not sent:', e); }
        }

    }));
});
