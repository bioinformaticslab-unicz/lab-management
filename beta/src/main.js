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
        user: null, userRole: 'user', authLoading: true, authError: '',

        // Navigation
        activeView: 'scanner',
        tabs: [
            { id: 'scanner',   icon: 'scan-line',       label: 'Scanner',    roles: ['user','supervisor','co_admin','main_admin'] },
            { id: 'inventory', icon: 'package',         label: 'Magazzino',   roles: ['user','supervisor','co_admin','main_admin'] },
            { id: 'strumenti', icon: 'microscope',      label: 'Strumenti',   roles: ['user','supervisor','co_admin','main_admin'] },
            { id: 'admin',     icon: 'layout-dashboard',label: 'Admin',      roles: ['supervisor','co_admin','main_admin'] },
            { id: 'profile',   icon: 'user',            label: 'Profilo',     roles: ['user','supervisor','co_admin','main_admin'] },
        ],
        adminTab: 'dashboard',

        // Data
        inventory: [], resources: [], recentMovements: [], logs: [],

        // Filters
        inventorySearch: '', inventoryTab: 'all', resourceSearch: '',

        // Scanner
        scanInput: '', searchResults: [], cameraActive: false,
        isBatchMode: false, batchItems: [], batchOperator: '', batchAction: 'remove',

        // Admin Configs
        labelsType: 'inventory', selectedLabels: [],
        coAdmins: [], supervisorsList: [], maintenanceMode: false,
        newCoAdminEmail: '', newSupervisorEmail: '',

        // Modals
        stockModal:   { open: false, item: null, action: 'add', qty: 1, operator: '' },
        bookingModal: { open: false, resource: null, email: '', userName: '', startDate: '', endDate: '', notes: '', pnr: '', bookings: [], loadingBookings: false },
        confirming: false, saving: false,

        // Admin forms
        editingItem: null,
        itemForm: { name:'',id:'',brand:'',category:'',quantity:0,unit:'pz',threshold:0,location:'',restockEmail:'',image:'' },
        editingInstrument: null,
        instrumentForm: { name:'',id:'',brand:'',location:'',imageUrl:'',category:'' },

        allBookings: [], // For admin dashboard

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
                this.authLoading = false;
            });

            document.addEventListener('keydown', e => {
                if (e.key === 'Escape') { this.stockModal.open = false; this.bookingModal.open = false; }
            });
        },

        switchView(id) {
            if (this.activeView === 'scanner' && id !== 'scanner') this.stopCamera();
            this.activeView = id;
            if (id === 'scanner') this.$nextTick(() => document.getElementById('scanner-input')?.focus());
            this.$nextTick(() => { if (typeof lucide !== 'undefined') lucide.createIcons(); });
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
            onSnapshot(query(dbCol('bookings')), snap => {
                this.allBookings = snap.docs.map(d => ({ ...d.data(), id: d.id }));
            });
            onSnapshot(query(dbCol('stock_movements'), orderBy('timestamp','desc'), limit(20)), snap => {
                this.recentMovements = snap.docs.map(d => ({ ...d.data(), _id: d.id }));
            });
            
            // Roles lists
            onSnapshot(collection(db,'artifacts',APP_ID,'settings','admins','emails'), snap => {
                this.coAdmins = snap.docs.map(d => d.id).filter(e => e !== MAIN_ADMIN_EMAIL);
            });
            onSnapshot(collection(db,'artifacts',APP_ID,'settings','supervisors','list'), snap => {
                this.supervisorsList = snap.docs.map(d => d.id);
            });
        },

        getBookingStatus(book) {
            const now = new Date();
            const start = new Date(book.startDate);
            const end = new Date(book.endDate);
            if (now >= start && now <= end) return 'active';
            const diffHours = (start - now) / (1000 * 60 * 60);
            if (diffHours > 0 && diffHours <= 24) return 'upcoming';
            if (diffHours > 24) return 'future';
            return 'past';
        },

        rebuildFuseIndexes() {
            if (typeof Fuse === 'undefined') return;
            const opts = { threshold: 0.35, keys: ['name','id','brand','category','manufacturer','location'] };
            fuseInventory = new Fuse(this.inventory, opts);
            fuseResources = new Fuse(this.resources, opts);
        },

        async loadLogs() {
            const snap = await getDocs(query(dbCol('logs'), orderBy('timestamp','desc'), limit(100))).catch(()=>null);
            this.logs = snap ? snap.docs.map(d => ({...d.data(), _id: d.id})) : [];
        },

        exportLogs() {
            if (!this.logs.length) return;
            const text = this.logs.map(l => `[${l.timestamp?.seconds ? new Date(l.timestamp.seconds*1000).toLocaleString('it-IT') : 'N/A'}] [${l.category||'SYSTEM'}] [${l.userEmail||'N/A'}] ${l.action} - ${l.details}`).join('\n');
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `labscan-logs-${new Date().toISOString().slice(0,10)}.txt`;
            a.click(); URL.revokeObjectURL(url);
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
            if (invSnap.exists()) { 
                this.scanInput=''; this.searchResults=[]; 
                const data = { ...invSnap.data(), id: safe };
                
                if (this.isBatchMode) {
                    const ex = this.batchItems.find(i => i.id === safe);
                    if (ex) ex.qty++; else this.batchItems.push({...data, qty: 1});
                    toast(`Aggiunto al carrello: ${data.name}`);
                    if (this.cameraActive) {
                        try { await qrScanner.resume(); } catch(e){} // Quick resume if possible
                    }
                    return;
                }
                
                this.switchView('inventory'); 
                this.inventorySearch = data.name||code; 
                return; 
            }

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

        removeBatchItem(idx) { this.batchItems.splice(idx, 1); },

        async confirmBatch() {
            if (!this.batchItems.length || !this.batchOperator) return;
            this.confirming = true;
            let success = 0, errors = 0;
            const op = this.batchOperator.trim();
            const action = this.batchAction;

            for (const item of this.batchItems) {
                if (!item.qty || item.qty <= 0) continue;
                const newQty = action === 'add' ? item.quantity + item.qty : item.quantity - item.qty;
                if (newQty < 0) { errors++; continue; }
                
                try {
                    await updateDoc(dbDoc('inventory', item.id), { quantity: newQty });
                    await addDoc(dbCol('stock_movements'), { itemId:item.id, itemName:item.name, action, amount:item.qty, unit:item.unit, operatorName:op, userEmail:this.user?.email||'', user:this.user?.uid||'', timestamp:serverTimestamp() });
                    await addDoc(dbCol('logs'), { category:'INVENTORY', action:`BATCH ${action==='add' ? 'CARICO':'SCARICO'}: ${item.name}`, details:`${action==='add'?'+':'-'}${item.qty} ${item.unit} | Op: ${op}`, userEmail:this.user?.email||'', timestamp:serverTimestamp() });
                    this.checkAndSendRestockEmail({ ...item, quantity: newQty });
                    success++;
                } catch(e) { errors++; }
            }

            this.confirming = false;
            toast(errors > 0 ? `${success} salvati, ${errors} falliti.` : `Batch completato! (${success} articoli)`, errors > 0 ? 'amber' : 'emerald');
            if (errors === 0) { this.batchItems = []; this.batchOperator = ''; this.isBatchMode = false; }
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
                toast(`${action==='add' ? 'Caricati' : 'Scaricati'} ${qty} ${item.unit} di ${item.name}`);
                this.stockModal.open = false;

                // Check low stock and send email
                this.checkAndSendRestockEmail({ ...item, quantity: newQty });

            } catch(e) { console.error(e); alert('Errore: ' + e.message); }
            finally { this.confirming = false; }
        },

        async checkAndSendRestockEmail(itemData) {
            if (itemData.quantity > (itemData.threshold || 0)) return;
            if (itemData.restockEmail && typeof emailjs !== 'undefined') {
                toast(`Invio email scorte basse (${itemData.name})...`, 'indigo');
                try {
                    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_RESTOCK_TEMPLATE, {
                        to_email: itemData.restockEmail,
                        product_name: itemData.name,
                        current_qty: itemData.quantity,
                        threshold: itemData.threshold,
                        unit: itemData.unit === 'pacco' ? 'pacchi' : (itemData.unit || 'pz'),
                        from_name: 'LABSCAN Lab'
                    });
                    toast(`Email inviata per ${itemData.name}!`, 'emerald');
                    await addDoc(dbCol('logs'), { category:'EMAIL', action:`Restock alert: ${itemData.name}`, details:`Email a ${itemData.restockEmail}, qty: ${itemData.quantity}`, userEmail:this.user?.email||'', timestamp:serverTimestamp() });
                } catch(e) {
                    console.warn('Email failed:', e);
                    await addDoc(dbCol('logs'), { category:'ERROR', action:`Email failed: ${itemData.name}`, details:e.text||String(e), userEmail:this.user?.email||'', timestamp:serverTimestamp() });
                }
            } else if (itemData.quantity <= (itemData.threshold||0)) {
                toast(`Scorte basse: ${itemData.name} (nessuna email configurata)`, 'amber');
            }
        },

        async confirmArrival(item) {
            if (!confirm(`Confermi l'arrivo di ${item.orderQuantity} ${item.unit} di "${item.name}"?`)) return;
            const newQty = (item.quantity||0) + (item.orderQuantity||0);
            try {
                await updateDoc(dbDoc('inventory', item.id), { quantity:newQty, isOrdered:false, orderQuantity:null, orderBy:null, orderDate:null });
                await addDoc(dbCol('stock_movements'), { itemId:item.id, itemName:item.name, action:'add', amount:item.orderQuantity, unit:item.unit, operatorName:this.user?.email||'', userEmail:this.user?.email||'', isArrival:true, timestamp:serverTimestamp() });
                toast(`Arrivo confermato: +${item.orderQuantity} ${item.unit} di ${item.name}`);
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
            if (hasOverlap) { alert('Orario non disponibile! C\'è già una prenotazione in questo intervallo.'); return; }

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
                toast(`Prenotazione confermata! PNR: ${pnr}`);

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
                toast(this.editingItem ? 'Articolo aggiornato' : 'Articolo aggiunto');
                this.clearItemForm();
            } catch(e) { console.error(e); alert('Errore.'); }
            finally { this.saving = false; }
        },

        async deleteItem(item) {
            if (!confirm(`Eliminare "${item.name}"? Irreversibile.`)) return;
            try {
                await deleteDoc(dbDoc('inventory', item.id));
                await addDoc(dbCol('logs'), { category:'ADMIN', action:`Eliminazione: ${item.name}`, details:`ID: ${item.id}`, userEmail:this.user?.email||'', timestamp:serverTimestamp() });
                toast('Articolo eliminato', 'red');
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
                toast(this.editingInstrument ? 'Strumento aggiornato' : 'Strumento aggiunto');
                this.clearInstrumentForm();
            } catch(e) { console.error(e); alert('Errore.'); }
            finally { this.saving = false; }
        },

        // DASHBOARD CHARTS
        initCharts() {
            if (typeof Chart === 'undefined') return;
            const ctxInv = document.getElementById('inventoryCategoryChart');
            const ctxMov = document.getElementById('stockMovementsChart');
            if (this.invChart) this.invChart.destroy();
            if (this.movChart) this.movChart.destroy();

            // Inventory Chart Data
            const catCounts = {};
            this.inventory.forEach(i => { const c = i.category || 'Altro'; catCounts[c] = (catCounts[c]||0) + 1; });
            const bgColors = ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#64748b'];

            if (ctxInv) {
                this.invChart = new Chart(ctxInv, {
                    type: 'doughnut',
                    data: { labels: Object.keys(catCounts), datasets: [{ data: Object.values(catCounts), backgroundColor: bgColors, borderWidth: 0 }] },
                    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { font: { size: 10, family: 'Inter, sans-serif' } } } }, cutout: '70%' }
                });
            }

            // Movements Chart Data (Add vs Remove counts from recent movements)
            let mAdds = 0, mRemoves = 0;
            this.recentMovements.forEach(m => { if(m.action==='add') mAdds++; else if(m.action==='remove') mRemoves++; });
            
            if (ctxMov) {
                this.movChart = new Chart(ctxMov, {
                    type: 'bar',
                    data: { labels: ['Carichi', 'Scarichi'], datasets: [{ label:'Operazioni Recenti', data: [mAdds, mRemoves], backgroundColor: ['#10b981', '#ef4444'], borderRadius: 6 }] },
                    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
                });
            }
        },

        // LABELS GENERATION (JsBarcode)
        generateSelectedLabels() {
            if (typeof JsBarcode === 'undefined') return;
            const srcList = this.labelsType === 'inventory' ? this.inventory : this.resources;
            const container = document.getElementById('labels-preview');
            const printCont = document.getElementById('print-labels-container');
            if (!container || !printCont) return;
            
            container.innerHTML = ''; printCont.innerHTML = '';
            
            const toGenerate = srcList.filter(item => this.selectedLabels.includes(item.id));
            if (toGenerate.length === 0) {
                container.innerHTML = '<p class="text-xs text-slate-400 col-span-full text-center py-4">Seleziona articoli per visualizzare l\'anteprima.</p>';
                return;
            }

            toGenerate.forEach(item => {
                const displayName = (item.description || item.name || 'Senza Nome').toUpperCase();
                
                // --- PREVIEW UI ---
                const wrapperUI = document.createElement('div');
                wrapperUI.className = 'bg-slate-50 border border-slate-200 rounded-xl p-3 flex flex-col items-center justify-center gap-2';
                
                const previewTitle = document.createElement('div');
                previewTitle.className = 'text-[9px] font-black text-slate-600 truncate w-full text-center';
                previewTitle.textContent = displayName;
                
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.className = 'w-full max-h-[40px]';
                
                wrapperUI.appendChild(previewTitle);
                wrapperUI.appendChild(svg);
                container.appendChild(wrapperUI);
                JsBarcode(svg, String(item.id), { format: "CODE128", width: 1.5, height: 30, displayValue: true, fontSize: 10, margin: 2 });

                // --- PRINT UI (Hidden) ---
                const printWrap = document.createElement('div');
                printWrap.className = 'label-card';
                
                const printTitle = document.createElement('h3');
                printTitle.textContent = displayName;
                
                const printSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                printSvg.className = 'label-barcode';
                
                const printId = document.createElement('p');
                printId.className = 'label-id';
                printId.textContent = item.id;
                
                printWrap.appendChild(printTitle);
                printWrap.appendChild(printSvg);
                printWrap.appendChild(printId);
                printCont.appendChild(printWrap);
                
                JsBarcode(printSvg, String(item.id), { format: "CODE128", width: 2, height: 55, displayValue: false, margin: 0 });
            });
        },

        printLabels() {
            if (!this.selectedLabels.length) return;
            const printContents = document.getElementById('print-labels-container').innerHTML;
            const printWin = window.open('', '_blank', 'width=900,height=700');
            printWin.document.write(`
<!DOCTYPE html>
<html>
<head>
<title>Etichette - LabScan Beta</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; padding: 20px; background: #fff; }
  h1 { text-align:center; font-size:18px; margin-bottom:16px; color:#1e293b; text-transform:uppercase; font-weight:900; }
  .grid { display:grid; grid-template-columns: repeat(3, 1fr); gap:16px; }
  .label-card {
    border: 2px solid #1e293b; border-radius: 12px; padding: 16px;
    text-align: center; page-break-inside: avoid; break-inside: avoid; background:#fff;
  }
  .label-card h3 { font-size:14px; font-weight:900; text-transform:uppercase; margin-bottom:8px; line-height:1.2; color:#0f172a; }
  .label-card .label-id { font-family: monospace; font-size:11px; font-weight:700; margin-top:8px; letter-spacing:1px; color:#475569; }
  .label-barcode { display:block; margin:4px auto; max-width:100%; height: auto; }
  .no-print { text-align:center; margin-bottom:20px; padding-bottom:10px; border-bottom:1px solid #e2e8f0; }
  .no-print button {
    padding: 12px 24px; font-size:13px; font-weight:700; border:none; border-radius:10px;
    cursor:pointer; margin:0 6px; transition: all 0.2s;
  }
  .btn-print { background:#4f46e5; color:#fff; box-shadow: 0 4px 6px -1px rgba(79, 70, 229, 0.2); }
  .btn-print:hover { background:#4338ca; transform: translateY(-1px); }
  .btn-close { background:#f1f5f9; color:#475569; }
  .btn-close:hover { background:#e2e8f0; }
  @media print {
    .no-print { display:none; }
    body { padding: 0; }
    .grid { gap: 12px; }
  }
</style>
</head>
<body>
<div class="no-print">
  <button class="btn-print" onclick="window.print()">🖨️ STAMPA / SALVA PDF</button>
  <button class="btn-close" onclick="window.close()">✕ CHIUDI</button>
</div>
<h1>Etichette ${this.labelsType === 'inventory' ? 'Magazzino' : 'Strumenti'}</h1>
<div class="grid">${printContents}</div>
</body></html>`);
            printWin.document.close();
            this.selectedLabels = [];
        },

        // SETTINGS & ROLES
        async addRole(colName, email, inputKey) {
            email = email.trim();
            if (!email) return;
            try {
                const docRef = doc(db, 'artifacts', APP_ID, 'settings', colName, 'list', email); 
                // Using nested logic to match schema. Co-admins use generic "emails" while supervisors use "list" in the stable app.
                if (colName === 'admins') {
                    await setDoc(doc(db, 'artifacts', APP_ID, 'settings', colName, 'emails', email), { email, addedAt: serverTimestamp() });
                } else {
                    await setDoc(doc(db, 'artifacts', APP_ID, 'settings', colName, 'list', email), { email, addedAt: serverTimestamp() });
                }
                toast(`${email} aggiunto come ${colName}`);
                this[inputKey] = '';
            } catch(e) { console.error(e); alert('Errore permessi'); }
        },
        async removeRole(colName, email) {
            if (!confirm(`Rimuovere i privilegi a ${email}?`)) return;
            try {
                if (colName === 'admins') {
                    await deleteDoc(doc(db, 'artifacts', APP_ID, 'settings', colName, 'emails', email));
                } else {
                    await deleteDoc(doc(db, 'artifacts', APP_ID, 'settings', colName, 'list', email));
                }
                toast(`${email} rimosso`, 'red');
            } catch(e) { console.error(e); alert('Errore permessi'); }
        }

    }));
});
