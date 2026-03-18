// main.js — LABSCAN Beta v2
// Fuzzy search (Fuse.js), overlap-checked bookings, EmailJS, integer stock steps.

import { auth, db, googleProvider, APP_ID } from './firebase.js';
import {
    signInWithPopup, signOut as fbSignOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
    collection, onSnapshot, query, where, orderBy, limit,
    doc, getDoc, getDocs, updateDoc, addDoc, setDoc, deleteDoc,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const ALLOWED_DOMAINS = ['@unicz.it', '@studenti.unicz.it'];
const MAIN_ADMIN_EMAIL = 'vono.niccolo@gmail.com';

// EmailJS config (matches stable app)
const EMAILJS_PUBLIC_KEY = 'OSVoNoZCEeHUrwaaq';
const EMAILJS_SERVICE_ID = 'service_6zh4wqk';
const EMAILJS_RESTOCK_TEMPLATE = 'template_6nayepk';
const EMAILJS_BOOKING_TEMPLATE = 'template_hvc2lnt';

function dbCol(...s) { return collection(db, 'artifacts', APP_ID, 'public', 'data', ...s); }
function dbDoc(...s) { return doc(db, 'artifacts', APP_ID, 'public', 'data', ...s); }
function safeid(id) { return (id || '').replace(/\//g, '_'); }
function genPNR() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }

// Toast helper (shows temporary notification)
function toast(msg, color = 'emerald') {
    const el = document.createElement('div');
    el.className = `fixed top-5 right-5 bg-${color}-600 text-white px-5 py-3 rounded-2xl shadow-2xl z-[300] text-xs font-bold transition-all animate-[fadeIn_.25s_ease-out]`;
    el.innerHTML = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(-10px)'; setTimeout(() => el.remove(), 300); }, 3000);
}

let qrScanner = null;
let fuseResources = null;
let fuseInventory = null;

document.addEventListener('alpine:init', () => {
    Alpine.data('labApp', () => ({

        // Auth
        user: null, userRole: 'user', authLoading: false, authError: '',

        // Navigation
        activeView: 'scanner',
        tabs: [
            { id: 'scanner',   icon: '📷', label: 'Scanner',    roles: ['user','supervisor','co_admin','main_admin'] },
            { id: 'inventory', icon: '📦', label: 'Magazzino',   roles: ['user','supervisor','co_admin','main_admin'] },
            { id: 'strumenti', icon: '🔬', label: 'Strumenti',   roles: ['user','supervisor','co_admin','main_admin'] },
            { id: 'admin',     icon: '🛠️', label: 'Admin',      roles: ['supervisor','co_admin','main_admin'] },
            { id: 'profile',   icon: '👤', label: 'Profilo',     roles: ['user','supervisor','co_admin','main_admin'] },
        ],
        adminTab: 'inventory',

        // Data
        inventory: [], resources: [], recentMovements: [], logs: [],

        // Filters
        inventorySearch: '', inventoryTab: 'all', resourceSearch: '',

        // Scanner
        scanInput: '', searchResults: [], cameraActive: false,

        // Modals
        stockModal:   { open: false, item: null, action: 'add', qty: 1, operator: '' },
        bookingModal: { open: false, resource: null, email: '', userName: '', startDate: '', endDate: '', notes: '', pnr: '', bookings: [], loadingBookings: false },
        confirming: false, saving: false,

        // Admin forms
        editingItem: null,
        itemForm: { name:'',id:'',brand:'',category:'',quantity:0,unit:'pz',threshold:0,location:'',restockEmail:'',image:'' },
        editingInstrument: null,
        instrumentForm: { name:'',id:'',brand:'',location:'',imageUrl:'',category:'' },

        // Computed
        get isAdmin()      { return ['main_admin','co_admin'].includes(this.userRole); },
        get isSupervisor() { return this.userRole === 'supervisor'; },
        get visibleTabs()  { return this.tabs.filter(t => t.roles.includes(this.userRole)); },

        get filteredInventory() {
            const t = this.inventorySearch.toLowerCase();
            let items = this.inventoryTab === 'reorder' ? this.inventory.filter(i => i.isOrdered) : this.inventory;
            if (!t) return items;
            if (typeof Fuse !== 'undefined' && fuseInventory) {
                return fuseInventory.search(t).map(r => r.item);
            }
            return items.filter(i => i.name?.toLowerCase().includes(t) || i.id?.toLowerCase().includes(t) || i.brand?.toLowerCase().includes(t) || i.category?.toLowerCase().includes(t));
        },

        get filteredResources() {
            const t = this.resourceSearch.toLowerCase();
            if (!t) return this.resources;
            if (typeof Fuse !== 'undefined' && fuseResources) {
                return fuseResources.search(t).map(r => r.item);
            }
            return this.resources.filter(r => r.name?.toLowerCase().includes(t) || r.id?.toLowerCase().includes(t));
        },

        // INIT
        async init() {
            // Init EmailJS
            try { if (typeof emailjs !== 'undefined') emailjs.init(EMAILJS_PUBLIC_KEY); } catch(e) {}

            onAuthStateChanged(auth, async fbUser => {
                if (fbUser) {
                    const email = fbUser.email || '';
                    const role  = await this.resolveRole(email);
                    const ok = ALLOWED_DOMAINS.some(d => email.endsWith(d));
                    const priv = ['main_admin','co_admin','supervisor'].includes(role);
                    if (!ok && !priv && email !== MAIN_ADMIN_EMAIL) {
                        await fbSignOut(auth);
                        this.authError = 'Accesso consentito solo a @unicz.it o @studenti.unicz.it.';
                        return;
                    }
                    this.user = fbUser;
                    this.userRole = role;
                    this.bookingModal.email = fbUser.email || '';
                    this.bookingModal.userName = fbUser.displayName || '';
                    this.startDataListeners();
                } else {
                    this.user = null; this.userRole = 'user';
                    this.inventory = []; this.resources = [];
                    this.stopCamera();
                }
            });

            document.addEventListener('keydown', e => {
                if (e.key === 'Escape') { this.stockModal.open = false; this.bookingModal.open = false; }
            });
        },

        switchView(id) {
            if (this.activeView === 'scanner' && id !== 'scanner') this.stopCamera();
            this.activeView = id;
            if (id === 'scanner') this.$nextTick(() => document.getElementById('scanner-input')?.focus());
        },

        // AUTH
        async signIn() {
            this.authLoading = true; this.authError = '';
            try { await signInWithPopup(auth, googleProvider); }
            catch (e) { this.authError = e.code === 'auth/popup-closed-by-user' ? 'Finestra chiusa.' : 'Errore: ' + e.message; }
            finally { this.authLoading = false; }
        },
        async signOut() { this.stopCamera(); await fbSignOut(auth); },

        async resolveRole(email) {
            if (email === MAIN_ADMIN_EMAIL) return 'main_admin';
            const aSnap = await getDocs(collection(db,'artifacts',APP_ID,'settings','admins','emails')).catch(()=>null);
            if (aSnap?.docs.find(d => d.id === email || d.data().email === email)) return 'co_admin';
            const sSnap = await getDocs(collection(db,'artifacts',APP_ID,'settings','supervisors','list')).catch(()=>null);
            if (sSnap?.docs.find(d => d.id === email || d.data().email === email)) return 'supervisor';
            return 'user';
        },

        // DATA LISTENERS
        startDataListeners() {
            onSnapshot(query(dbCol('inventory')), snap => {
                this.inventory = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
                this.rebuildFuseIndexes();
            });
            onSnapshot(query(dbCol('resources')), snap => {
                this.resources = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
                this.rebuildFuseIndexes();
            });
            onSnapshot(query(dbCol('stock_movements'), orderBy('timestamp','desc'), limit(20)), snap => {
                this.recentMovements = snap.docs.map(d => ({ ...d.data(), _id: d.id }));
            });
        },

        rebuildFuseIndexes() {
            if (typeof Fuse === 'undefined') return;
            const opts = { threshold: 0.35, keys: ['name','id','brand','category','manufacturer','location'] };
            fuseInventory = new Fuse(this.inventory, opts);
            fuseResources = new Fuse(this.resources, opts);
        },

        async loadLogs() {
            const snap = await getDocs(query(dbCol('logs'), orderBy('timestamp','desc'), limit(60))).catch(()=>null);
            this.logs = snap ? snap.docs.map(d => ({...d.data(), _id: d.id})) : [];
        },

        // CAMERA / SCANNER
        async toggleCamera() {
            if (this.cameraActive) { this.stopCamera(); return; }
            this.cameraActive = true;
            await this.$nextTick();
            try {
                qrScanner = new Html5Qrcode('qr-reader');
                await qrScanner.start({ facingMode:'environment' }, { fps:10, qrbox:{width:220,height:220} },
                    (decoded) => { this.stopCamera(); this.processScannedCode(decoded); }, ()=>{});
            } catch(e) { this.cameraActive = false; alert('Camera non disponibile.'); }
        },
        stopCamera() {
            if (qrScanner) { qrScanner.stop().catch(()=>{}).finally(()=>{ qrScanner = null; }); }
            this.cameraActive = false;
        },

        handleManualScan() {
            const code = this.scanInput.trim();
            if (code) this.processScannedCode(code);
        },

        handleSearchInput() {
            const t = (this.scanInput||'').trim().toLowerCase();
            if (!t || t.length < 2) { this.searchResults = []; return; }

            // Fuzzy search via Fuse.js if available
            if (typeof Fuse !== 'undefined' && fuseResources && fuseInventory) {
                const res = fuseResources.search(t).slice(0,4).map(r => ({...r.item, type:'resource'}));
                const inv = fuseInventory.search(t).slice(0,4).map(r => ({...r.item, type:'inventory'}));
                this.searchResults = [...res, ...inv];
            } else {
                const inv = this.inventory.filter(i => i.id?.toLowerCase().includes(t) || i.name?.toLowerCase().includes(t)).slice(0,4).map(i=>({...i,type:'inventory'}));
                const res = this.resources.filter(r => r.id?.toLowerCase().includes(t) || r.name?.toLowerCase().includes(t)).slice(0,4).map(r=>({...r,type:'resource'}));
                this.searchResults = [...res, ...inv];
            }
        },

        async processScannedCode(code) {
            if (code.includes('?r=')) {
                try { const r = new URLSearchParams(new URL(code).search).get('r'); if (r) code = r; } catch(e) {}
            }
            const safe = safeid(code);
            this.scanInput = code;

            const resSnap = await getDoc(dbDoc('resources', safe));
            if (resSnap.exists()) { this.scanInput=''; this.searchResults=[]; this.openBookingModal({...resSnap.data(),id:safe}); return; }

            const invSnap = await getDoc(dbDoc('inventory', safe));
            if (invSnap.exists()) { this.scanInput=''; this.searchResults=[]; this.switchView('inventory'); this.inventorySearch = invSnap.data().name||code; return; }

            this.searchResults = [];
            if (this.isAdmin || this.isSupervisor) {
                if (confirm(`"${code}" non trovato.\n\nCreare come articolo di MAGAZZINO?\n(OK = Magazzino, Annulla = Strumento)`)) {
                    this.switchView('admin'); this.adminTab='inventory'; this.itemForm.id = code;
                } else {
                    this.switchView('admin'); this.adminTab='instruments'; this.instrumentForm.id = code;
                }
            } else { alert('Codice non riconosciuto.'); }
        },

        openItem(r) {
            this.scanInput=''; this.searchResults=[];
            if (r.type === 'resource') this.openBookingModal(r);
            else { this.switchView('inventory'); this.inventorySearch = r.name; }
        },

        // STOCK MOVEMENTS (integer steps)
        openStockModal(item, action) {
            this.stockModal = { open: true, item, action, qty: 1, operator: '' };
            this.$nextTick(() => document.getElementById('stock-modal-qty')?.focus());
        },

        async confirmStockMovement() {
            const { item, action, qty, operator } = this.stockModal;
            if (!qty || qty <= 0 || !operator) return;
            const newQty = action === 'add' ? item.quantity + qty : item.quantity - qty;
            if (newQty < 0) { alert(`Quantità insufficiente! Disponibili: ${item.quantity} ${item.unit}`); return; }
            this.confirming = true;
            try {
                await updateDoc(dbDoc('inventory', item.id), { quantity: newQty });
                await addDoc(dbCol('stock_movements'), { itemId:item.id, itemName:item.name, action, amount:qty, unit:item.unit, operatorName:operator, userEmail:this.user?.email||'', user:this.user?.uid||'', timestamp:serverTimestamp() });
                await addDoc(dbCol('logs'), { category:'INVENTORY', action:`${action==='add' ? 'CARICO':'SCARICO'}: ${item.name}`, details:`${action==='add'?'+':'-'}${qty} ${item.unit} | Op: ${operator}`, userEmail:this.user?.email||'', timestamp:serverTimestamp() });
                toast(`${action==='add' ? '📦 Caricati' : '📤 Scaricati'} ${qty} ${item.unit} di ${item.name}`);
                this.stockModal.open = false;

                // Check low stock and send email
                this.checkAndSendRestockEmail({ ...item, quantity: newQty });

            } catch(e) { console.error(e); alert('Errore: ' + e.message); }
            finally { this.confirming = false; }
        },

        async checkAndSendRestockEmail(itemData) {
            if (itemData.quantity > (itemData.threshold || 0)) return;
            if (itemData.restockEmail && typeof emailjs !== 'undefined') {
                toast(`📧 Invio email scorte basse (${itemData.name})...`, 'indigo');
                try {
                    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_RESTOCK_TEMPLATE, {
                        to_email: itemData.restockEmail,
                        product_name: itemData.name,
                        current_qty: itemData.quantity,
                        threshold: itemData.threshold,
                        unit: itemData.unit === 'pacco' ? 'pacchi' : (itemData.unit || 'pz'),
                        from_name: 'LABSCAN Lab'
                    });
                    toast(`✅ Email inviata per ${itemData.name}!`, 'green');
                    await addDoc(dbCol('logs'), { category:'EMAIL', action:`Restock alert: ${itemData.name}`, details:`Email a ${itemData.restockEmail}, qty: ${itemData.quantity}`, userEmail:this.user?.email||'', timestamp:serverTimestamp() });
                } catch(e) {
                    console.warn('Email failed:', e);
                    await addDoc(dbCol('logs'), { category:'ERROR', action:`Email failed: ${itemData.name}`, details:e.text||String(e), userEmail:this.user?.email||'', timestamp:serverTimestamp() });
                }
            } else if (itemData.quantity <= (itemData.threshold||0)) {
                toast(`⚠️ Scorte basse: ${itemData.name} (nessuna email configurata)`, 'amber');
            }
        },

        async confirmArrival(item) {
            if (!confirm(`Confermi l'arrivo di ${item.orderQuantity} ${item.unit} di "${item.name}"?`)) return;
            const newQty = (item.quantity||0) + (item.orderQuantity||0);
            try {
                await updateDoc(dbDoc('inventory', item.id), { quantity:newQty, isOrdered:false, orderQuantity:null, orderBy:null, orderDate:null });
                await addDoc(dbCol('stock_movements'), { itemId:item.id, itemName:item.name, action:'add', amount:item.orderQuantity, unit:item.unit, operatorName:this.user?.email||'', userEmail:this.user?.email||'', isArrival:true, timestamp:serverTimestamp() });
                toast(`✅ Arrivo confermato: +${item.orderQuantity} ${item.unit} di ${item.name}`);
            } catch(e) { console.error(e); alert('Errore.'); }
        },

        // BOOKINGS (mirrors stable app: overlap check, PNR, bookedBy, confirmation email)
        async openBookingModal(resource) {
            this.bookingModal = {
                open: true, resource, pnr: '',
                email: this.user?.email||'', userName: this.user?.displayName||'',
                startDate: '', endDate: '', notes: '',
                bookings: [], loadingBookings: true
            };
            // Load existing bookings for this resource
            try {
                const snap = await getDocs(query(dbCol('bookings'), where('resourceId','==',resource.id)));
                const now = new Date();
                this.bookingModal.bookings = snap.docs.map(d=>({id:d.id,...d.data()})).filter(b => new Date(b.endDate) >= now).sort((a,b) => new Date(a.startDate)-new Date(b.startDate));
            } catch(e) { console.warn(e); }
            this.bookingModal.loadingBookings = false;
        },

        async confirmBooking() {
            const { resource, email, userName, startDate, endDate, notes } = this.bookingModal;
            if (!email || !userName || !startDate || !endDate) { alert('Compila tutti i campi obbligatori.'); return; }
            if (new Date(startDate) >= new Date(endDate)) { alert("L'ora di fine deve essere dopo l'inizio."); return; }

            // Overlap check (same logic as stable app)
            const hasOverlap = await this.checkBookingOverlap(resource.id, startDate, endDate, null);
            if (hasOverlap) { alert('⚠️ Orario non disponibile! C\'è già una prenotazione in questo intervallo.'); return; }

            this.confirming = true;
            try {
                const pnr = genPNR();
                const resourceName = resource.name || resource.id;
                await addDoc(dbCol('bookings'), {
                    resourceId: resource.id,
                    resourceName,
                    userName, email,
                    startDate, endDate,
                    notes: notes || '',
                    pnr,
                    bookedBy: this.user?.uid || '',
                    createdAt: serverTimestamp()
                });
                await addDoc(dbCol('logs'), { category:'BOOKING', action:`Prenotazione: ${resourceName}`, details:`${userName} · ${new Date(startDate).toLocaleString('it-IT')} → ${new Date(endDate).toLocaleString('it-IT')} · PNR: ${pnr}`, userEmail:email, timestamp:serverTimestamp() });
                this.bookingModal.pnr = pnr;
                toast(`📅 Prenotazione confermata! PNR: ${pnr}`);

                // Send booking confirmation email
                if (email && typeof emailjs !== 'undefined') {
                    try {
                        const appUrl = window.location.href.split('?')[0];
                        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_BOOKING_TEMPLATE, {
                            to_email: email, user_name: userName, instrument_name: resourceName,
                            start_date: new Date(startDate).toLocaleString('it-IT', { dateStyle:'full', timeStyle:'short' }),
                            end_date: new Date(endDate).toLocaleString('it-IT', { dateStyle:'full', timeStyle:'short' }),
                            pnr, app_url: appUrl, from_name: 'LABSCAN Lab'
                        });
                    } catch(e) { console.warn('Booking email failed:', e); }
                }
            } catch(e) { console.error(e); alert('Errore: ' + (e.message || e)); }
            finally { this.confirming = false; }
        },

        async checkBookingOverlap(resourceId, startStr, endStr, excludeId) {
            const snap = await getDocs(query(dbCol('bookings'), where('resourceId','==',resourceId)));
            const ns = new Date(startStr), ne = new Date(endStr);
            return snap.docs.some(d => {
                if (d.id === excludeId) return false;
                const b = d.data();
                return ns < new Date(b.endDate) && ne > new Date(b.startDate);
            });
        },

        // ADMIN — INVENTORY CRUD
        editItem(item) {
            this.editingItem = item;
            this.itemForm = { name:item.name||'', id:item.id||'', brand:item.brand||'', category:item.category||'', quantity:item.quantity||0, unit:item.unit||'pz', threshold:item.threshold||0, location:item.location||'', restockEmail:item.restockEmail||'', image:item.image||'' };
            window.scrollTo({top:0,behavior:'smooth'});
        },
        clearItemForm() { this.editingItem = null; this.itemForm = { name:'',id:'',brand:'',category:'',quantity:0,unit:'pz',threshold:0,location:'',restockEmail:'',image:'' }; },

        async saveInventoryItem() {
            const f = this.itemForm;
            if (!f.name || !f.id || !f.unit) return;
            this.saving = true;
            try {
                const data = { name:f.name, brand:f.brand, category:f.category, quantity:f.quantity, unit:f.unit, threshold:f.threshold, location:f.location, restockEmail:f.restockEmail, image:f.image };
                if (this.editingItem) { await updateDoc(dbDoc('inventory', this.editingItem.id), data); }
                else { await setDoc(dbDoc('inventory', safeid(f.id)), {...data, id:safeid(f.id), isOrdered:false}); }
                await addDoc(dbCol('logs'), { category:'ADMIN', action:`${this.editingItem?'Modifica':'Nuovo'} articolo: ${f.name}`, details:`ID: ${f.id}`, userEmail:this.user?.email||'', timestamp:serverTimestamp() });
                toast(this.editingItem ? '✅ Articolo aggiornato' : '✅ Articolo aggiunto');
                this.clearItemForm();
            } catch(e) { console.error(e); alert('Errore.'); }
            finally { this.saving = false; }
        },

        async deleteItem(item) {
            if (!confirm(`Eliminare "${item.name}"? Irreversibile.`)) return;
            try {
                await deleteDoc(dbDoc('inventory', item.id));
                await addDoc(dbCol('logs'), { category:'ADMIN', action:`Eliminazione: ${item.name}`, details:`ID: ${item.id}`, userEmail:this.user?.email||'', timestamp:serverTimestamp() });
                toast('🗑️ Articolo eliminato', 'red');
            } catch(e) { console.error(e); alert('Errore.'); }
        },

        // ADMIN — INSTRUMENT CRUD
        editInstrument(res) {
            this.editingInstrument = res;
            this.instrumentForm = { name:res.name||'',id:res.id||'',brand:res.brand||'',location:res.location||'',imageUrl:res.imageUrl||'',category:res.category||'' };
            window.scrollTo({top:0,behavior:'smooth'});
        },
        clearInstrumentForm() { this.editingInstrument = null; this.instrumentForm = { name:'',id:'',brand:'',location:'',imageUrl:'',category:'' }; },

        async saveInstrument() {
            const f = this.instrumentForm;
            if (!f.name || !f.id) return;
            this.saving = true;
            try {
                const data = { name:f.name, brand:f.brand, location:f.location, imageUrl:f.imageUrl, category:f.category };
                if (this.editingInstrument) { await updateDoc(dbDoc('resources', this.editingInstrument.id), data); }
                else { await setDoc(dbDoc('resources', safeid(f.id)), {...data, id:safeid(f.id)}); }
                await addDoc(dbCol('logs'), { category:'ADMIN', action:`${this.editingInstrument?'Modifica':'Nuovo'} strumento: ${f.name}`, details:`ID: ${f.id}`, userEmail:this.user?.email||'', timestamp:serverTimestamp() });
                toast(this.editingInstrument ? '✅ Strumento aggiornato' : '✅ Strumento aggiunto');
                this.clearInstrumentForm();
            } catch(e) { console.error(e); alert('Errore.'); }
            finally { this.saving = false; }
        },

    }));
});
