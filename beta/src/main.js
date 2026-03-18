// main.js — LABSCAN Beta v2
// Uses correct Firestore paths matching the stable app.
// Instruments are stored in the 'resources' collection, not 'instruments'.

import { auth, db, googleProvider, APP_ID } from './firebase.js';
import {
    signInWithPopup, signOut as fbSignOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
    collection, onSnapshot, query, orderBy, limit,
    doc, getDoc, updateDoc, addDoc, setDoc, deleteDoc,
    serverTimestamp, getDocs
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const ALLOWED_DOMAINS = ['@unicz.it', '@studenti.unicz.it'];
const MAIN_ADMIN_EMAIL = 'vono.niccolo@gmail.com';

// ─── Firestore path helpers (mirrors stable app exactly) ─────────────────────
function dbCol(...segs) { return collection(db, 'artifacts', APP_ID, 'public', 'data', ...segs); }
function dbDoc(...segs) { return doc(db, 'artifacts', APP_ID, 'public', 'data', ...segs); }
function safeid(id) { return id.replace(/\//g, '_'); }
function genPNR() {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 6 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

// ─── html5-qrcode singleton ───────────────────────────────────────────────────
let qrScanner = null;

// ══════════════════════════════════════════════════════════════════════════════
//  Alpine component registration
// ══════════════════════════════════════════════════════════════════════════════
document.addEventListener('alpine:init', () => {
    Alpine.data('labApp', () => ({

        // ── Auth ──────────────────────────────────────────────────────────────
        user: null,
        userRole: 'user',
        authLoading: false,
        authError: '',

        // ── Navigation ────────────────────────────────────────────────────────
        activeView: 'scanner',
        tabs: [
            { id: 'scanner',   icon: '📷', label: 'Scanner',   roles: ['user','supervisor','co_admin','main_admin'] },
            { id: 'inventory', icon: '📦', label: 'Magazzino',  roles: ['user','supervisor','co_admin','main_admin'] },
            { id: 'strumenti', icon: '🔬', label: 'Strumenti',  roles: ['user','supervisor','co_admin','main_admin'] },
            { id: 'admin',     icon: '🛠️', label: 'Admin',     roles: ['supervisor','co_admin','main_admin'] },
            { id: 'profile',   icon: '👤', label: 'Profilo',    roles: ['user','supervisor','co_admin','main_admin'] },
        ],
        adminTab: 'inventory',

        // ── Data ──────────────────────────────────────────────────────────────
        inventory: [],
        resources: [],      // ← 'resources' collection = strumenti/instruments
        recentMovements: [],
        logs: [],

        // ── Filters ───────────────────────────────────────────────────────────
        inventorySearch: '',
        inventoryTab: 'all',
        resourceSearch: '',

        // ── Scanner ───────────────────────────────────────────────────────────
        scanInput: '',
        searchResults: [],
        cameraActive: false,

        // ── Modals ────────────────────────────────────────────────────────────
        stockModal:   { open: false, item: null, action: 'add', qty: null, operator: '' },
        bookingModal: { open: false, resource: null, email: '', userName: '', startDate: '', endDate: '', notes: '', pnr: '' },
        confirming: false,
        saving: false,

        // ── Admin forms ───────────────────────────────────────────────────────
        editingItem: null,
        itemForm: { name:'', id:'', brand:'', category:'', quantity:0, unit:'', threshold:0, location:'', restockEmail:'', image:'' },

        editingInstrument: null,
        instrumentForm: { name:'', id:'', brand:'', location:'', imageUrl:'', category:'' },

        // ══ COMPUTED ══════════════════════════════════════════════════════════
        get isAdmin()      { return ['main_admin','co_admin'].includes(this.userRole); },
        get isSupervisor() { return this.userRole === 'supervisor'; },
        get visibleTabs()  { return this.tabs.filter(t => t.roles.includes(this.userRole)); },

        get filteredInventory() {
            const t = this.inventorySearch.toLowerCase();
            let items = this.inventoryTab === 'reorder'
                ? this.inventory.filter(i => i.isOrdered)
                : this.inventory;
            return t ? items.filter(i =>
                i.name?.toLowerCase().includes(t) || i.id?.toLowerCase().includes(t) ||
                i.brand?.toLowerCase().includes(t) || i.category?.toLowerCase().includes(t)
            ) : items;
        },

        get filteredResources() {
            const t = this.resourceSearch.toLowerCase();
            return t ? this.resources.filter(r =>
                r.name?.toLowerCase().includes(t) || r.id?.toLowerCase().includes(t) ||
                r.brand?.toLowerCase().includes(t) || r.manufacturer?.toLowerCase().includes(t)
            ) : this.resources;
        },

        // ══ INIT ══════════════════════════════════════════════════════════════
        async init() {
            onAuthStateChanged(auth, async fbUser => {
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
                    this.user      = fbUser;
                    this.userRole  = role;
                    this.bookingModal.email    = fbUser.email || '';
                    this.bookingModal.userName = fbUser.displayName || '';
                    this.startDataListeners();
                } else {
                    this.user      = null;
                    this.userRole  = 'user';
                    this.inventory = [];
                    this.resources = [];
                    this.stopCamera();
                }
            });

            document.addEventListener('keydown', e => {
                if (e.key === 'Escape') {
                    this.stockModal.open = false;
                    this.bookingModal.open = false;
                    this.bookingModal.pnr  = '';
                    this.stopCamera();
                }
            });
        },

        // ── Helpers ───────────────────────────────────────────────────────────
        switchView(id) {
            if (this.activeView !== 'scanner') this.stopCamera();
            this.activeView = id;
            if (id === 'scanner') {
                this.$nextTick(() => document.getElementById('scanner-input')?.focus());
            }
        },

        // ══ AUTH ══════════════════════════════════════════════════════════════
        async signIn() {
            this.authLoading = true; this.authError = '';
            try { await signInWithPopup(auth, googleProvider); }
            catch (e) { this.authError = e.code === 'auth/popup-closed-by-user' ? 'Finestra chiusa. Riprova.' : 'Errore: ' + e.message; }
            finally { this.authLoading = false; }
        },
        async signOut() { this.stopCamera(); await fbSignOut(auth); },

        async resolveRole(email) {
            if (email === MAIN_ADMIN_EMAIL) return 'main_admin';
            const adminSnap = await getDocs(collection(db, 'artifacts', APP_ID, 'settings', 'admins', 'emails')).catch(() => null);
            if (adminSnap?.docs.find(d => d.id === email || d.data().email === email)) return 'co_admin';
            const supSnap = await getDocs(collection(db, 'artifacts', APP_ID, 'settings', 'supervisors', 'list')).catch(() => null);
            if (supSnap?.docs.find(d => d.id === email || d.data().email === email)) return 'supervisor';
            return 'user';
        },

        // ══ DATA LISTENERS ════════════════════════════════════════════════════
        startDataListeners() {
            // Inventory
            onSnapshot(query(dbCol('inventory')), snap => {
                this.inventory = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
            });
            // Resources/Instruments (correct collection name from stable app)
            onSnapshot(query(dbCol('resources')), snap => {
                this.resources = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
            });
            // Recent movements for profile
            onSnapshot(
                query(dbCol('stock_movements'), orderBy('timestamp','desc'), limit(20)),
                snap => { this.recentMovements = snap.docs.map(d => ({ ...d.data(), _id: d.id })); }
            );
        },

        async loadLogs() {
            const snap = await getDocs(query(dbCol('logs'), orderBy('timestamp','desc'), limit(60))).catch(() => null);
            this.logs = snap ? snap.docs.map(d => ({ ...d.data(), _id: d.id })) : [];
        },

        // ══ CAMERA / SCANNER ══════════════════════════════════════════════════
        async toggleCamera() {
            if (this.cameraActive) { this.stopCamera(); return; }
            this.cameraActive = true;
            await this.$nextTick();
            try {
                qrScanner = new Html5Qrcode('qr-reader');
                await qrScanner.start(
                    { facingMode: 'environment' },
                    { fps: 10, qrbox: { width: 220, height: 220 } },
                    (decodedText) => {
                        this.stopCamera();
                        this.processScannedCode(decodedText);
                    },
                    () => {}
                );
            } catch (e) {
                console.warn('Camera error:', e);
                this.cameraActive = false;
                alert('Impossibile accedere alla camera. Verifica i permessi del browser.');
            }
        },

        stopCamera() {
            if (qrScanner) {
                qrScanner.stop().catch(() => {}).finally(() => { qrScanner = null; });
            }
            this.cameraActive = false;
        },

        handleManualScan() {
            const code = this.scanInput.trim();
            if (code) this.processScannedCode(code);
        },

        handleSearchInput() {
            const t = (this.scanInput || '').trim().toLowerCase();
            if (!t || t.length < 2) { this.searchResults = []; return; }

            const invRes = this.inventory.filter(i =>
                i.id?.toLowerCase().includes(t) ||
                i.name?.toLowerCase().includes(t) ||
                i.brand?.toLowerCase().includes(t)
            ).slice(0, 4).map(i => ({ ...i, type: 'inventory' }));

            const resRes = this.resources.filter(r =>
                r.id?.toLowerCase().includes(t) ||
                r.name?.toLowerCase().includes(t) ||
                r.brand?.toLowerCase().includes(t) ||
                r.manufacturer?.toLowerCase().includes(t)
            ).slice(0, 4).map(r => ({ ...r, type: 'resource' }));

            this.searchResults = [...resRes, ...invRes];
        },

        async processScannedCode(code) {
            // Strip ?r= params from QR URLs (matches stable app logic)
            if (code.includes('?r=')) {
                try {
                    const url = new URL(code);
                    const r = new URLSearchParams(url.search).get('r');
                    if (r) code = r;
                } catch (e) {}
            }

            const safeCode = safeid(code);
            this.scanInput = code;

            // 1. Check resources (instruments) first
            const resSnap = await getDoc(dbDoc('resources', safeCode));
            if (resSnap.exists()) {
                this.scanInput = '';
                this.searchResults = [];
                this.openBookingModal({ ...resSnap.data(), id: safeCode });
                return;
            }

            // 2. Check inventory
            const invSnap = await getDoc(dbDoc('inventory', safeCode));
            if (invSnap.exists()) {
                this.scanInput = '';
                this.searchResults = [];
                this.switchView('inventory');
                this.inventorySearch = invSnap.data().name || code;
                return;
            }

            // 3. Unknown
            this.searchResults = [];
            alert(`Codice "${code}" non trovato nel sistema.`);
        },

        openItem(r) {
            this.scanInput = '';
            this.searchResults = [];
            if (r.type === 'resource') {
                this.openBookingModal(r);
            } else {
                this.switchView('inventory');
                this.inventorySearch = r.name;
            }
        },

        // ══ STOCK MOVEMENTS ═══════════════════════════════════════════════════
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
                await addDoc(dbCol('stock_movements'), {
                    itemId: item.id, itemName: item.name, action,
                    amount: qty, unit: item.unit,
                    operatorName: operator, userEmail: this.user?.email || '',
                    timestamp: serverTimestamp()
                });
                await addDoc(dbCol('logs'), {
                    category: 'INVENTORY',
                    action: `${action === 'add' ? 'CARICO' : 'SCARICO'}: ${item.name}`,
                    details: `${action === 'add' ? '+' : '-'}${qty} ${item.unit} | Op: ${operator}`,
                    userEmail: this.user?.email || '',
                    timestamp: serverTimestamp()
                });
                if (newQty <= item.threshold && item.restockEmail) this.sendRestockEmail(item, newQty);
                this.stockModal.open = false;
            } catch (e) { console.error(e); alert('Errore nel salvataggio.'); }
            finally { this.confirming = false; }
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
            } catch (e) { console.error(e); alert('Errore.'); }
        },

        // ══ BOOKINGS ══════════════════════════════════════════════════════════
        openBookingModal(resource) {
            this.bookingModal = {
                open: true,
                resource,
                pnr: '',
                email: this.user?.email || '',
                userName: this.user?.displayName || '',
                startDate: '', endDate: '', notes: ''
            };
        },

        async confirmBooking() {
            const { resource, email, userName, startDate, endDate, notes } = this.bookingModal;
            if (!email || !userName || !startDate || !endDate) return;
            if (new Date(endDate) <= new Date(startDate)) {
                alert('La data di fine deve essere successiva alla data di inizio.');
                return;
            }
            this.confirming = true;
            try {
                const pnr = genPNR();
                // Uses 'resourceId' field to match stable app schema exactly
                await addDoc(dbCol('bookings'), {
                    resourceId: resource.id,
                    resourceName: resource.name,
                    email,
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
                    action: `Prenotazione: ${resource.name}`,
                    details: `${userName} · ${new Date(startDate).toLocaleString('it-IT')} → ${new Date(endDate).toLocaleString('it-IT')} · PNR: ${pnr}`,
                    userEmail: email,
                    timestamp: serverTimestamp()
                });
                this.bookingModal.pnr = pnr;
            } catch (e) { console.error(e); alert('Errore nella prenotazione.'); }
            finally { this.confirming = false; }
        },

        // ══ ADMIN — INVENTORY CRUD ════════════════════════════════════════════
        editItem(item) {
            this.editingItem = item;
            this.itemForm = { name:item.name||'', id:item.id||'', brand:item.brand||'', category:item.category||'', quantity:item.quantity||0, unit:item.unit||'', threshold:item.threshold||0, location:item.location||'', restockEmail:item.restockEmail||'', image:item.image||'' };
            window.scrollTo({ top:0, behavior:'smooth' });
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
                const data = { name:f.name, brand:f.brand, category:f.category, quantity:f.quantity, unit:f.unit, threshold:f.threshold, location:f.location, restockEmail:f.restockEmail, image:f.image };
                if (this.editingItem) {
                    await updateDoc(dbDoc('inventory', this.editingItem.id), data);
                } else {
                    await setDoc(dbDoc('inventory', safeid(f.id)), { ...data, id: safeid(f.id), isOrdered: false });
                }
                await addDoc(dbCol('logs'), { category:'ADMIN', action:`${this.editingItem ? 'Modifica' : 'Nuovo'} articolo: ${f.name}`, details:`ID: ${f.id}`, userEmail:this.user?.email||'', timestamp:serverTimestamp() });
                this.clearItemForm();
            } catch (e) { console.error(e); alert('Errore nel salvataggio.'); }
            finally { this.saving = false; }
        },

        async deleteItem(item) {
            if (!this.isAdmin) return;
            if (!confirm(`Eliminare definitivamente "${item.name}"?\nQuesta azione è irreversibile.`)) return;
            try {
                await deleteDoc(dbDoc('inventory', item.id));
                await addDoc(dbCol('logs'), { category:'ADMIN', action:`Eliminazione: ${item.name}`, details:`ID: ${item.id}`, userEmail:this.user?.email||'', timestamp:serverTimestamp() });
            } catch (e) { console.error(e); alert('Errore eliminazione.'); }
        },

        // ══ ADMIN — INSTRUMENT CRUD ═══════════════════════════════════════════
        editInstrument(res) {
            this.editingInstrument = res;
            this.instrumentForm = { name:res.name||'', id:res.id||'', brand:res.brand||'', location:res.location||'', imageUrl:res.imageUrl||'', category:res.category||'' };
            window.scrollTo({ top:0, behavior:'smooth' });
        },

        clearInstrumentForm() {
            this.editingInstrument = null;
            this.instrumentForm = { name:'', id:'', brand:'', location:'', imageUrl:'', category:'' };
        },

        async saveInstrument() {
            const f = this.instrumentForm;
            if (!f.name || !f.id) return;
            this.saving = true;
            try {
                const data = { name:f.name, brand:f.brand, location:f.location, imageUrl:f.imageUrl, category:f.category };
                if (this.editingInstrument) {
                    await updateDoc(dbDoc('resources', this.editingInstrument.id), data);
                } else {
                    await setDoc(dbDoc('resources', safeid(f.id)), { ...data, id:safeid(f.id) });
                }
                await addDoc(dbCol('logs'), { category:'ADMIN', action:`${this.editingInstrument ? 'Modifica' : 'Nuovo'} strumento: ${f.name}`, details:`ID: ${f.id}`, userEmail:this.user?.email||'', timestamp:serverTimestamp() });
                this.clearInstrumentForm();
            } catch (e) { console.error(e); alert('Errore salvataggio.'); }
            finally { this.saving = false; }
        },

        // ══ EMAIL ══════════════════════════════════════════════════════════════
        async sendRestockEmail(item, currentQty) {
            if (typeof emailjs === 'undefined') return;
            try {
                await emailjs.send('service_6zh4wqk', 'template_6nayepk', {
                    to_email: item.restockEmail, item_name: item.name, item_id: item.id,
                    current_qty: currentQty, unit: item.unit, threshold: item.threshold,
                    location: item.location || 'N/A'
                }, 'OSVoNoZCEeHUrwaaq');
            } catch (e) { console.warn('[Beta] Email non inviata:', e); }
        }

    }));
});
