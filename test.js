    <script type="module">
        import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
        import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
        import { getFirestore, collection, addDoc, query, where, orderBy, onSnapshot, serverTimestamp, deleteDoc, doc, updateDoc, setDoc, getDoc, getDocs, runTransaction } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

        // --- INSERISCI QUI LA TUA CONFIGURAZIONE FIREBASE ---
        const firebaseConfig = {
            apiKey: "AIzaSyAWbSxLJcDbB0bvd4HoMii3Z5CavR8vR-I",
            authDomain: "unisca-lab.firebaseapp.com",
            projectId: "unisca-lab",
            storageBucket: "unisca-lab.firebasestorage.app",
            messagingSenderId: "775803411857",
            appId: "1:775803411857:web:1a24be42a1c70482ad8e30",
            measurementId: "G-3ECHHPDZJZ"
        };
        const appId = 'unisca-lab-v1';

        const app = initializeApp(firebaseConfig);
        const auth = getAuth(app);
        const db = getFirestore(app);
        const googleProvider = new GoogleAuthProvider();

        // --- EMAILJS CONFIG (Replace with your actual IDs) ---
        const EMAILJS_PUBLIC_KEY = 'OSVoNoZCEeHUrwaaq';
        const EMAILJS_SERVICE_ID = 'service_6zh4wqk';
        const EMAILJS_RESTOCK_TEMPLATE_ID = 'template_6nayepk';
        const EMAILJS_BOOKING_CONFIRM_TEMPLATE_ID = 'template_hvc2lnt';
        try { emailjs.init(EMAILJS_PUBLIC_KEY); } catch (e) { console.warn('EmailJS init failed:', e); }

        let currentUser = null;
        let currentItem = null;
        let currentItemName = null;
        let html5QrCode = null;
        let adminMode = false;
        let isAdmin = false;
        let isRegisterMode = false;
        let editingBookingId = null;
        let currentStockAction = null;

        // Nuove variabili RBAC
        let userRole = 'user'; // 'main_admin', 'co_admin', 'supervisor', 'user'
        let supervisorPermissions = {};
        let isDesktopMode = localStorage.getItem('desktopMode') !== null
            ? localStorage.getItem('desktopMode') === 'true'
            : (window.innerWidth >= 1024 && !('ontouchstart' in window));
        let isBatchMode = false;
        let batchCart = [];
        let globalSettingsCache = {};

        // Inactivity Timer
        let inactivityTimer = null;
        const INACTIVITY_LIMIT_MS = 5 * 60 * 1000; // 5 minutes

        window.resetInactivityTimer = () => {
            if (inactivityTimer) clearTimeout(inactivityTimer);
            if (currentUser) {
                inactivityTimer = setTimeout(() => {
                    if (currentUser) {
                        console.log("Inattività prolungata. Disconnessione automatica.");
                        window.logoutUser(true);
                    }
                }, INACTIVITY_LIMIT_MS);
            }
        };

        // Event listeners for user activity
        ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(evt => {
            document.addEventListener(evt, window.resetInactivityTimer, { passive: true });
        });

        // Setup globale tastiera
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const modals = ['modal-stock', 'modal-order', 'modal-booking', 'modal-calendar', 'modal-admin-booking'];
                modals.forEach(id => {
                    const el = document.getElementById(id);
                    if (el && !el.classList.contains('hidden')) el.classList.add('hidden');
                });
                return;
            }
            // Auto-focus manual code logic
            if (isDesktopMode && !document.getElementById('view-scanner').classList.contains('hidden')) {
                const active = document.activeElement;
                if (active && active.tagName !== 'INPUT' && active.tagName !== 'TEXTAREA') {
                    const inp = document.getElementById('inp-manual-code');
                    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
                        inp.focus();
                    }
                }
            }
        });

        window.currentFoundBooking = null;
        window.currentInstrumentData = {};
        window.calendarBookingsCache = [];
        window.adminBookingsCache = [];
        window.allInstrumentsCache = [];
        window.allInventoryCache = [];
        window.currentInventoryData = {};
        window.resourcesCache = [];
        window.allLogsCache = [];


        // --- LOGGING SYSTEM ---
        window.logAction = async (action, category, details, specificUser = null) => {
            try {
                const user = specificUser || currentUser;
                const logData = {
                    timestamp: serverTimestamp(),
                    action: action,      // CREATE, UPDATE, DELETE, EMAIL, LOGIN, ERROR
                    category: category,  // BOOKING, INVENTORY, ADMIN, SYSTEM, AUTH
                    details: details,    // String or Object
                    userId: user ? user.uid : 'system',
                    userEmail: user ? (user.email || 'system') : 'system',
                    userName: user ? (user.displayName || 'system') : 'system'
                };
                await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'logs'), logData);
                console.log(`[LOG] ${category} - ${action}:`, details);
            } catch (e) {
                console.warn("Logging failed:", e);
            }
        };

        // AUTH
        onAuthStateChanged(auth, async (user) => {
            if (user) {
                // Determine Role
                const uEmail = user.email.toLowerCase();
                const MAIN_ADMINS = ['vono.niccolo@gmail.com'];
                userRole = 'user';
                supervisorPermissions = {};
                isAdmin = false;

                if (MAIN_ADMINS.includes(uEmail)) {
                    userRole = 'main_admin';
                } else {
                    try {
                        const coAdminSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'admins'));
                        if (coAdminSnap.exists() && (coAdminSnap.data().emails || []).includes(uEmail)) {
                            userRole = 'co_admin';
                        } else {
                            const supSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'supervisors'));
                            if (supSnap.exists()) {
                                const sups = supSnap.data().list || [];
                                const mySup = sups.find(s => s.email === uEmail);
                                if (mySup) {
                                    userRole = 'supervisor';
                                    supervisorPermissions = mySup.permissions || {};
                                }
                            }
                        }
                    } catch (e) { console.warn('Role check failed:', e); }
                }

                if (userRole === 'user') {
                    if (!uEmail.endsWith('@studenti.unicz.it') && !uEmail.endsWith('@unicz.it')) {
                        alert("Accesso negato. Solo domini @studenti.unicz.it o @unicz.it sono ammessi.");
                        await signOut(auth);
                        return;
                    }

                    try {
                        const accessSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'access'));
                        if (accessSnap.exists()) {
                            const data = accessSnap.data();
                            if (data.restrictedMode === true) {
                                const allowedUsers = data.allowedUsers || [];
                                if (!allowedUsers.includes(uEmail)) {
                                    alert("Accesso Negato: questo account non è autorizzato durante la restrizione accessi in corso.");
                                    await signOut(auth);
                                    return;
                                }
                            }
                        }
                    } catch (e) { console.warn("Access check failed:", e); }

                } else {
                    isAdmin = true;
                    adminMode = true; // Auto-enter admin mode se non-user
                }

                currentUser = user;
                document.getElementById('view-login').classList.add('hidden');
                document.getElementById('user-status').classList.remove('bg-red-500', 'animate-pulse');
                document.getElementById('user-status').classList.add('bg-green-500');
                document.getElementById('btn-logout').classList.remove('hidden');
                const displayName = user.displayName || user.email || user.uid.slice(0, 8);
                const nameEl = document.getElementById('user-display-name');
                nameEl.innerText = displayName;
                nameEl.classList.remove('hidden');

                // Hide/show settings sections based on role
                const coAdminSec = document.getElementById('co-admin-section');
                const supSec = document.getElementById('supervisor-section');
                if (coAdminSec) coAdminSec.style.display = userRole === 'main_admin' ? 'block' : 'none';
                if (supSec) supSec.style.display = (userRole === 'main_admin' || userRole === 'co_admin') ? 'block' : 'none';

                loadGlobalSettings();
                loadPublicInventory();
                loadResourcesCache();
                checkUrlParams();
                logAction('LOGIN', 'AUTH', `User logged in: ${user.email} Role: ${userRole}`);
                window.resetInactivityTimer();
            } else {
                document.getElementById('view-login').classList.remove('hidden');
                document.getElementById('btn-logout').classList.add('hidden');
                document.getElementById('user-display-name').classList.add('hidden');
            }
        });

        // --- AUTH FUNCTIONS ---
        window.loginWithEmail = async () => {
            const email = document.getElementById('inp-login-email').value.trim();
            const password = document.getElementById('inp-login-password').value;
            const errorEl = document.getElementById('login-error');
            errorEl.classList.add('hidden');
            if (!email || !password) { errorEl.innerText = 'Inserisci email e password.'; errorEl.classList.remove('hidden'); return; }
            try {
                if (isRegisterMode) {
                    await createUserWithEmailAndPassword(auth, email, password);
                } else {
                    await signInWithEmailAndPassword(auth, email, password);
                }
            } catch (e) {
                let msg = 'Errore di autenticazione.';
                if (e.code === 'auth/user-not-found' || e.code === 'auth/invalid-credential') msg = 'Credenziali non valide.';
                else if (e.code === 'auth/email-already-in-use') msg = 'Email già registrata.';
                else if (e.code === 'auth/weak-password') msg = 'Password troppo debole (min 6 caratteri).';
                else if (e.code === 'auth/invalid-email') msg = 'Email non valida.';
                errorEl.innerText = msg;
                errorEl.classList.remove('hidden');
            }
        };
        window.loginWithGoogle = async () => {
            try { await signInWithPopup(auth, googleProvider); }
            catch (e) {
                const errorEl = document.getElementById('login-error');
                errorEl.innerText = 'Errore Google Sign-In: ' + e.message;
                errorEl.classList.remove('hidden');
            }
        };
        window.logoutUser = async (isAuto = false) => {
            if (isAuto || confirm('Sei sicuro di voler uscire?')) {
                if (inactivityTimer) clearTimeout(inactivityTimer);
                if (isAuto) alert("Sessione scaduta per inattività (5 minuti).");
                logAction('LOGOUT', 'AUTH', `User logged out: ${currentUser ? currentUser.email : 'unknown'}`);
                adminMode = false;
                isAdmin = false;
                await signOut(auth);
            }
        };
        window.toggleRegisterMode = () => {
            isRegisterMode = !isRegisterMode;
            const btn = document.getElementById('btn-toggle-register');
            btn.innerText = isRegisterMode ? 'Hai già un account? ACCEDI' : 'Non hai un account? REGISTRATI';
            document.querySelector('#login-form-container .space-y-3 button:first-of-type').innerText = isRegisterMode ? 'REGISTRATI' : 'ACCEDI';
        };

        // --- HELPER LOADERS ---
        function loadResourcesCache() {
            const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'resources'));
            onSnapshot(q, (snapshot) => {
                window.resourcesCache = [];
                snapshot.forEach(doc => window.resourcesCache.push(doc.data()));
            });
        }

        function loadInventoryCategories() {
            // Get unique categories from inventory items
            const categories = new Set();
            window.allInventoryCache.forEach(item => {
                if (item.category) categories.add(item.category);
            });
            // Standard categories always present
            categories.add("Reagenti");
            categories.add("Vetreria");
            categories.add("DPI");
            categories.add("Cancelleria");

            const select = document.getElementById('inp-inv-category');
            select.innerHTML = '<option value="" disabled selected>Seleziona Categoria...</option>';

            Array.from(categories).sort().forEach(cat => {
                select.innerHTML += `<option value="${cat}">${cat}</option>`;
            });
            select.innerHTML += `<option value="new">+ Nuova Categoria...</option>`;
        }

        // --- SCANNER ROUTER ---
        const onScanSuccess = (decodedText) => {
            if (!isBatchMode) {
                stopScanner();
            }
            let finalCode = decodedText;
            if (decodedText.includes("?r=")) {
                try {
                    const url = new URL(decodedText);
                    const p = new URLSearchParams(url.search);
                    if (p.get('r')) finalCode = p.get('r');
                } catch (e) { }
            }
            handleScannedCode(finalCode);
        };
        // MAKE GLOBAL FOR CLICK EVENTS
        window.handleScannedCode = async function (code) {

            // --- BATCH MODE ---
            if (isBatchMode) {
                const invItem = window.allInventoryCache.find(i => i.id === code || i.id === code.replace(/\//g, '_'));
                if (invItem) {
                    const existing = batchCart.find(i => i.id === invItem.id);
                    if (existing) {
                        existing.qtyToAdd += 1;
                    } else {
                        batchCart.push({ ...invItem, qtyToAdd: 1 });
                    }
                    updateBatchUI();

                    const toast = document.createElement('div');
                    toast.className = 'fixed top-5 right-5 bg-emerald-600 text-white px-4 py-2 rounded shadow-lg z-[200] text-xs font-bold fade-in';
                    toast.innerHTML = `<i data-lucide="check" class="inline w-3 h-3"></i> ${invItem.name} aggiunto!`;
                    document.body.appendChild(toast);
                    setTimeout(() => toast.remove(), 2000);

                    document.getElementById('inp-manual-code').value = '';
                    setTimeout(() => document.getElementById('inp-manual-code').focus(), 50);
                    return;
                } else {
                    alert('Codice non trovato nel Magazzino per il Carrello.');
                    document.getElementById('inp-manual-code').value = '';
                    return;
                }
            }

            // --- STANDARD MODE ---
            currentItem = code;

            // 1. Cerca nei Tools (Exact ID)
            const toolRef = doc(db, 'artifacts', appId, 'public', 'data', 'resources', code.replace(/\//g, '_'));
            const toolSnap = await getDoc(toolRef);
            if (toolSnap.exists()) {
                showDetails(code);
                return;
            }

            // 2. Cerca nel Magazzino (Exact ID)
            const invRef = doc(db, 'artifacts', appId, 'public', 'data', 'inventory', code.replace(/\//g, '_'));
            const invSnap = await getDoc(invRef);
            if (invSnap.exists()) {
                showInventoryView(code, invSnap.data());
                return;
            }

            // 3. Sconosciuto
            if (adminMode) {
                if (confirm(`Codice "${code}" non trovato.\n\nCreare come articolo di MAGAZZINO?\n(OK = Magazzino, Annulla = Strumento)`)) {
                    switchAdminTab('inventory');
                    document.getElementById('inp-inv-id').value = code;
                    window.switchView('view-admin');
                } else {
                    switchAdminTab('instruments');
                    document.getElementById('inp-inst-id').value = code;
                    window.switchView('view-admin');
                }
            } else {
                alert("Codice non riconosciuto.");
                window.resetApp();
            }
        }

        // --- INVENTORY VIEW ---
        function showInventoryView(id, data) {
            window.switchView('view-inventory');
            window.currentInventoryData = data;
            document.getElementById('inv-item-name').innerText = data.name || "Sconosciuto";
            document.getElementById('inv-item-qty').innerText = data.quantity || 0;
            document.getElementById('inv-item-brand').innerText = data.brand || "---";
            document.getElementById('inv-item-threshold').innerText = data.threshold || 0;
            document.getElementById('inv-item-category-view').innerText = data.category || "---";

            // Set Image
            const imgEl = document.getElementById('inv-item-img-display');
            if (data.image) {
                imgEl.src = data.image;
                imgEl.classList.remove('hidden');
            } else {
                imgEl.src = '';
                imgEl.classList.add('hidden');
            }

            let unitLabel = data.unit || "pz";
            if (data.unit === 'pacco') {
                document.getElementById('inv-item-unit').innerText = "pacchi";
                const totalPieces = (data.quantity || 0) * (data.packSize || 1);
                document.getElementById('inv-item-pack-detail').innerText = `(1 pacco = ${data.packSize || 1} pz. Totale: ${totalPieces} pz)`;
                document.getElementById('inv-item-pack-detail').classList.remove('hidden');
            } else {
                document.getElementById('inv-item-unit').innerText = unitLabel;
                document.getElementById('inv-item-pack-detail').classList.add('hidden');
            }

            document.getElementById('inv-item-loc').innerHTML = `<i data-lucide="map-pin" class="w-3 h-3"></i> ${data.location || "N/D"}`;

            const qtyEl = document.getElementById('inv-item-qty');
            const alertEl = document.getElementById('inv-alert-restock');
            if (data.quantity <= (data.threshold || 0)) {
                qtyEl.classList.replace('text-white', 'text-red-400');
                alertEl.classList.remove('hidden');
            } else {
                qtyEl.classList.replace('text-red-400', 'text-white');
                alertEl.classList.add('hidden');
            }

            // Show Order Status Banner
            if (data.isOrdered) {
                document.getElementById('inv-alert-ordered').classList.remove('hidden');
                document.getElementById('inv-ordered-text').innerText = `Ordinato il ${data.orderDate || '?'} da ${data.orderBy || '?'} (Q.tà: ${data.orderQuantity || '?'})`;
            } else {
                document.getElementById('inv-alert-ordered').classList.add('hidden');
            }

            // Show Manual Order Button for Admins/Supervisors
            const btnManualOrder = document.getElementById('btn-manual-order');
            if (btnManualOrder) {
                if (isAdmin || (userRole === 'supervisor' && supervisorPermissions.inventory)) {
                    btnManualOrder.classList.remove('hidden');
                } else {
                    btnManualOrder.classList.add('hidden');
                }
            }

            loadStockHistory(id);
        }

        window.openStockModal = (action) => {
            currentStockAction = action;
            const title = action === 'add' ? "Rifornimento (+)" : "Prelievo (-)";
            const unit = window.currentInventoryData.unit === 'pacco' ? 'pacchi' : window.currentInventoryData.unit;

            document.getElementById('stock-modal-title').innerText = title;
            document.getElementById('stock-modal-unit').innerText = unit;
            document.getElementById('inp-stock-qty').value = '';
            document.getElementById('inp-stock-user-id').value = ''; // Reset user ID

            // Gestione Checkbox rimuovi ordine
            if (action === 'add' && window.currentInventoryData.isOrdered) {
                document.getElementById('div-remove-order').classList.remove('hidden');
            } else {
                document.getElementById('div-remove-order').classList.add('hidden');
            }

            document.getElementById('modal-stock').classList.remove('hidden');
            document.getElementById('inp-stock-qty').focus();
        };

        window.openOrderModal = (itemId) => {
            const selectEl = document.getElementById('inp-order-item');
            if (itemId) {
                // Opened from a specific item detail
                const itemData = window.currentInventoryData;
                selectEl.innerHTML = `<option value="${itemId}" selected>${itemData.name}</option>`;
                selectEl.disabled = true;
                selectEl.classList.add('bg-slate-100');
                document.getElementById('lbl-order-unit').innerText = itemData.unit === 'pacco' ? 'pacchi' : (itemData.unit || 'pz');
            } else {
                // Opened globally
                selectEl.innerHTML = '<option value="">-- Seleziona Articolo --</option>' + (window.allInventoryCache || []).map(i => `<option value="${i.id}">${i.name} (${i.id})</option>`).join('');
                selectEl.disabled = false;
                selectEl.classList.remove('bg-slate-100');
                document.getElementById('lbl-order-unit').innerText = 'unità';
            }

            document.getElementById('inp-order-qty').value = '';
            document.getElementById('inp-order-by').value = currentUser ? (currentUser.displayName || '') : '';
            document.getElementById('inp-order-date').valueAsDate = new Date();
            document.getElementById('modal-order').classList.remove('hidden');
        };

        window.confirmOrder = async (e) => {
            e.preventDefault();
            const itemId = document.getElementById('inp-order-item').value;
            const qty = parseFloat(document.getElementById('inp-order-qty').value);
            const by = document.getElementById('inp-order-by').value;
            const date = document.getElementById('inp-order-date').value;

            if (!itemId) return alert("Seleziona un articolo.");
            if (!qty || qty <= 0) return alert("Quantità non valida.");

            const safeId = itemId.replace(/\//g, '_');

            try {
                await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'inventory', safeId), {
                    isOrdered: true,
                    orderQuantity: qty,
                    orderBy: by,
                    orderDate: date
                });
                alert("Ordine salvato in Riordino.");
                document.getElementById('modal-order').classList.add('hidden');
                // Refresh view if in detail view
                if (!document.getElementById('view-inventory').classList.contains('hidden')) {
                    const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'inventory', safeId));
                    showInventoryView(currentItem, snap.data());
                }
                logAction('UPDATE', 'INVENTORY', `Order status updated for ${safeId}: ${qty} ordered by ${by} on ${date}`);
            } catch (e) { alert(e); }
        };

        window.confirmStockMovement = async (e) => {
            e.preventDefault();
            const qty = parseFloat(document.getElementById('inp-stock-qty').value);
            if (!qty || qty <= 0) return alert("Quantità non valida.");
            const operatorName = document.getElementById('inp-stock-user-id').value.trim();
            const removeOrder = document.getElementById('inp-remove-order').checked;

            const safeId = currentItem.replace(/\//g, '_');
            const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'inventory', safeId);

            try {
                await runTransaction(db, async (transaction) => {
                    const sfDoc = await transaction.get(docRef);
                    if (!sfDoc.exists()) throw "Non trovato!";

                    const currentQty = parseFloat(sfDoc.data().quantity || 0);
                    let newQty = currentQty;
                    let updates = {};

                    if (currentStockAction === 'add') {
                        newQty += qty;
                        if (removeOrder && sfDoc.data().isOrdered) {
                            updates.isOrdered = false;
                            updates.orderQuantity = null;
                            updates.orderBy = null;
                            updates.orderDate = null;
                        }
                    } else {
                        if (currentQty < qty) throw "Quantità insufficiente!";
                        newQty -= qty;
                    }

                    updates.quantity = newQty;
                    transaction.update(docRef, updates);

                    const movementRef = doc(collection(db, 'artifacts', appId, 'public', 'data', 'stock_movements'));
                    transaction.set(movementRef, {
                        itemId: currentItem,
                        itemName: sfDoc.data().name,
                        action: currentStockAction,
                        amount: qty,
                        unit: sfDoc.data().unit,
                        user: currentUser.uid,
                        operatorName: operatorName || 'Anonimo',
                        timestamp: serverTimestamp()
                    });
                });

                document.getElementById('modal-stock').classList.add('hidden');
                const updatedSnap = await getDoc(docRef);
                const updatedData = updatedSnap.data();
                showInventoryView(currentItem, updatedData);

                logAction('UPDATE', 'INVENTORY', `Stock movement for ${updatedData.name} (${currentItem}): ${currentStockAction === 'add' ? '+' : '-'}${qty} ${updatedData.unit}. User: ${operatorName}`);

                // --- RESTOCK ALERT EMAIL ---
                checkAndSendRestockEmail(updatedData);

            } catch (err) { alert("Errore: " + err); }
        };

        // SHARED FUNCTION FOR LOW STOCK EMAILS
        async function checkAndSendRestockEmail(itemData) {
            console.log(`[EMAIL CHECK] Item: ${itemData.name}, Qty: ${itemData.quantity}, Threshold: ${itemData.threshold || 0}, Email: ${itemData.restockEmail}`);
            if (itemData.quantity <= (itemData.threshold || 0)) {
                if (itemData.restockEmail) {
                    try {
                        // Visual feedback
                        const toast = document.createElement('div');
                        toast.className = 'fixed top-5 right-5 bg-indigo-600 text-white px-4 py-2 rounded shadow-lg z-[200] text-xs font-bold fade-in';
                        toast.innerHTML = `<i data-lucide="mail" class="inline w-3 h-3"></i> Invio email riordino (${itemData.name})...`;
                        document.body.appendChild(toast);
                        setTimeout(() => toast.remove(), 3000);

                        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_RESTOCK_TEMPLATE_ID, {
                            to_email: itemData.restockEmail,
                            product_name: itemData.name,
                            current_qty: itemData.quantity,
                            threshold: itemData.threshold,
                            unit: itemData.unit === 'pacco' ? 'pacchi' : (itemData.unit || 'pz'),
                            from_name: 'LABSCAN Lab'
                        });

                        console.log('Restock alert email sent to', itemData.restockEmail);
                        logAction('EMAIL', 'SYSTEM', `Restock alert sent to ${itemData.restockEmail} for ${itemData.name}`);

                        // Success toast
                        toast.className = 'fixed top-5 right-5 bg-green-600 text-white px-4 py-2 rounded shadow-lg z-[200] text-xs font-bold fade-in';
                        toast.innerText = `Email inviata per ${itemData.name}!`;
                    } catch (emailErr) {
                        console.warn('Restock email failed:', emailErr);
                        logAction('ERROR', 'SYSTEM', `Email failed for ${itemData.name}: ${emailErr.text || emailErr}`);
                    }
                } else {
                    console.warn('Low stock but no restock email configured for', itemData.name);
                    logAction('EMAIL_SKIP', 'SYSTEM', `Restock alert skipped for ${itemData.name}: No email set.`);
                }
            }
        }

        function loadStockHistory(itemId) {
            const listEl = document.getElementById('stock-history-list');
            listEl.innerHTML = '<p class="text-xs text-center text-slate-400">Caricamento...</p>';

            const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'stock_movements'),
                where("itemId", "==", itemId));

            onSnapshot(q, (snapshot) => {
                const moves = [];
                snapshot.forEach(d => moves.push(d.data()));
                moves.sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));
                const recent = moves.slice(0, 5);

                if (recent.length === 0) {
                    listEl.innerHTML = '<p class="text-xs italic text-slate-400 text-center">Nessun movimento recente.</p>';
                    return;
                }

                listEl.innerHTML = recent.map(m => `
                    <div class="flex flex-col text-xs p-2 bg-slate-50 rounded border border-slate-100 mb-1">
                        <div class="flex justify-between items-center mb-1">
                            <span class="${m.action === 'add' ? 'text-emerald-600' : 'text-red-600'} font-bold">
                                ${m.action === 'add' ? '+' : '-'}${m.amount} <span class="text-slate-400 font-normal">${m.unit === 'pacco' ? 'pacchi' : (m.unit || '')}</span>
                            </span>
                            <span class="text-slate-400 text-[10px]">${m.timestamp ? new Date(m.timestamp.seconds * 1000).toLocaleDateString() : ''}</span>
                        </div>
                        <div class="text-[10px] text-slate-500 italic truncate"><i data-lucide="user" class="w-3 h-3 inline"></i> ${m.operatorName || 'Anonimo'}</div>
                    </div>
                `).join('');
                lucide.createIcons();
            });
        }

        // --- PUBLIC INVENTORY LIST ---
        window.showPublicInventoryList = () => {
            window.switchView('view-inventory-list');
            // loadPublicInventory called on init
            renderInventoryList(window.allInventoryCache, document.getElementById('public-inventory-container'), false);
        }
        let currentInventoryTab = 'all';

        window.switchPublicInventoryTab = (tab) => {
            currentInventoryTab = tab;
            if (tab === 'reorder') {
                document.getElementById('tab-inv-reorder').classList.replace('bg-white', 'bg-emerald-600');
                document.getElementById('tab-inv-reorder').classList.replace('text-slate-600', 'text-white');
                document.getElementById('tab-inv-all').classList.replace('bg-emerald-600', 'bg-white');
                document.getElementById('tab-inv-all').classList.replace('text-white', 'text-slate-600');
                if (window.currentUser && ['main_admin', 'co_admin', 'supervisor'].includes(window.currentUserRole)) {
                    document.getElementById('btn-add-reorder-public').classList.remove('hidden');
                }
            } else {
                document.getElementById('tab-inv-all').classList.replace('bg-white', 'bg-emerald-600');
                document.getElementById('tab-inv-all').classList.replace('text-slate-600', 'text-white');
                document.getElementById('tab-inv-reorder').classList.replace('bg-emerald-600', 'bg-white');
                document.getElementById('tab-inv-reorder').classList.replace('text-white', 'text-slate-600');
                document.getElementById('btn-add-reorder-public').classList.add('hidden');
            }
            filterInventoryList(document.querySelector('#view-inventory-list input[type="text"]').value || '');
        };

        window.loadPublicInventory = () => {
            const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'inventory'));
            onSnapshot(q, (snapshot) => {
                window.allInventoryCache = [];
                snapshot.forEach(doc => window.allInventoryCache.push(doc.data()));
                loadInventoryCategories(); // Update options for Admin form when cache updates

                // If public view or admin view is active, rerender using filter
                filterInventoryList(document.querySelector('#view-inventory-list input[type="text"]').value || '');
            });
        }

        window.filterInventoryList = (term) => {
            term = (term || '').toLowerCase();
            const isAdminView = document.getElementById('view-inventory-list').classList.contains('hidden');
            const container = document.getElementById(isAdminView ? 'inventory-list' : 'public-inventory-container');

            let filtered = window.allInventoryCache.filter(i =>
                i.name.toLowerCase().includes(term) ||
                i.id.toLowerCase().includes(term) ||
                (i.brand && i.brand.toLowerCase().includes(term)) ||
                (i.category && i.category.toLowerCase().includes(term))
            );

            if (!isAdminView && currentInventoryTab === 'reorder') {
                filtered = filtered.filter(i => i.isOrdered);
            }

            renderInventoryList(filtered, container, isAdminView);
        }

        function renderInventoryList(items, container, isAdmin) {
            const isReorderTab = currentInventoryTab === 'reorder';

            if (items.length === 0) {
                container.innerHTML = '<p class="text-center text-xs text-slate-400">Nessun articolo trovato in questa vista.</p>';
                return;
            }

            container.innerHTML = items.map(i => {
                const isLow = (i.quantity || 0) <= (i.threshold || 0);
                const clickAction = isAdmin
                    ? `editInventoryItem('${i.id}', '${i.name.replace(/'/g, "\\'")}', '${i.unit}', '${i.threshold}', '${(i.location || '').replace(/'/g, "\\'")}', '${i.packSize || ''}', '${(i.brand || '').replace(/'/g, "\\'")}', '${(i.category || '').replace(/'/g, "\\'")}', '${(i.image || '').replace(/'/g, "\\'")}', '${i.quantity}', '${(i.restockEmail || '').replace(/'/g, "\\'")}')`
                    : `handleScannedCode('${i.id}')`;

                let quantityDisplay = `${i.quantity} <span class="text-[10px] text-slate-400">${i.unit}</span>`;
                if (i.unit === 'pacco') {
                    const total = (i.quantity || 0) * (i.packSize || 1);
                    quantityDisplay = `${i.quantity} pacchi <span class="block text-[9px] text-slate-400">(${total} pz tot)</span>`;
                }

                // In Reorder tab, show order info
                let orderBadge = '';
                if (isReorderTab) {
                    orderBadge = `
                    <div class="mt-2 text-xs font-bold text-indigo-700 bg-indigo-50 p-2 rounded border border-indigo-100 flex justify-between items-center">
                        <span><i data-lucide="truck" class="w-3 h-3 inline"></i> Ordinato: +${i.orderQuantity} ${i.unit === 'pacco' ? 'pacchi' : (i.unit || 'pz')} (${i.orderDate || ''})</span>
                        ${!isAdmin ? `<button onclick="event.stopPropagation(); confirmArrival('${i.id}', ${i.orderQuantity})" class="px-2 py-1 bg-indigo-600 text-white rounded text-[10px] hover:bg-indigo-700 transition">CONFERMA ARRIVO</button>` : ''}
                    </div>`;
                }

                let checkboxHtml = '';
                // Only show checkbox if admin, not reorder tab, and bulk mode is active
                if (isAdmin && !isReorderTab && window.isBulkMode) {
                    checkboxHtml = `<input type="checkbox" value="${i.id}" class="chk-inv-bulk w-5 h-5 rounded border-slate-300 text-red-600 mr-3 shrink-0 cursor-pointer" onclick="event.stopPropagation(); window.updateBulkDeleteUI()">`;
                }

                // If in bulk mode, clicking the card checks the box. Otherwise, it edits.
                const finalClickAction = (isAdmin && !isReorderTab && window.isBulkMode) 
                    ? `const cb = this.querySelector('.chk-inv-bulk'); if(cb) { cb.checked = !cb.checked; window.updateBulkDeleteUI(); }` 
                    : clickAction;

                return `
                <div onclick="${finalClickAction}" class="bg-white p-3 rounded-lg border ${isLow ? 'border-red-300 bg-red-50' : 'border-slate-100'} flex flex-col shadow-sm cursor-pointer hover:border-indigo-300 ${window.isBulkMode ? 'hover:bg-slate-50' : ''}">
                    <div class="flex items-center w-full">
                        ${checkboxHtml}
                        <div class="flex justify-between items-center w-full">
                            <div class="flex-1">
                            <div class="flex items-center gap-2">
                                 <div class="text-xs font-bold text-slate-700">${i.name}</div>
                                 ${i.category ? `<span class="text-[8px] bg-slate-200 px-1 rounded text-slate-500 uppercase">${i.category}</span>` : ''}
                            </div>
                            <div class="text-[10px] text-slate-500 font-medium">${i.brand || ''}</div>
                            <div class="text-[10px] text-slate-400 font-mono">${i.id} | ${i.location || '-'}</div>
                        </div>
                        <div class="text-right flex items-center gap-2">
                            <div>
                                <p class="text-sm font-bold ${isLow ? 'text-red-600' : 'text-slate-800'}">${quantityDisplay}</p>
                                ${isLow ? '<p class="text-[9px] text-red-500 font-bold uppercase">SCORTA BASSA</p>' : ''}
                            </div>
                            ${isAdmin && !isReorderTab && !window.isBulkMode ? `<button onclick="event.stopPropagation(); deleteInventoryItem('${i.id}')" class="p-2 bg-red-100 text-red-600 rounded-lg hover:bg-red-200 transition"><i data-lucide="trash-2" class="w-4 h-4"></i></button>` : ''}
                        </div>
                        </div>
                    </div>
                    ${orderBadge}
                </div>`;
                </div>`;
            }).join('');
            lucide.createIcons();
        }

        // --- RIORDINO CONFIRMATION ALGORITHM ---
        window.confirmArrival = async (id, orderQty) => {
            if (!confirm(`Confermare l'arrivo di in magazzino di +${orderQty} unità per l'articolo ${id}?`)) return;
            const safeId = id.replace(/\//g, '_');
            const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'inventory', safeId);

            try {
                await runTransaction(db, async (transaction) => {
                    const sfDoc = await transaction.get(docRef);
                    if (!sfDoc.exists()) throw "Articolo non trovato!";
                    const d = sfDoc.data();

                    const newQty = parseFloat(d.quantity || 0) + parseFloat(orderQty);

                    transaction.update(docRef, {
                        quantity: newQty,
                        isOrdered: false,
                        orderQuantity: null,
                        orderBy: null,
                        orderDate: null
                    });

                    const moveRef = doc(collection(db, 'artifacts', appId, 'public', 'data', 'stock_movements'));
                    transaction.set(moveRef, {
                        itemId: id,
                        itemName: d.name,
                        action: 'add',
                        amount: parseFloat(orderQty),
                        unit: d.unit || 'pz',
                        user: currentUser ? currentUser.uid : 'system',
                        operatorName: currentUser ? currentUser.displayName || currentUser.email : 'Utente',
                        timestamp: serverTimestamp(),
                        isArrival: true
                    });
                });
                alert('Arrivo confermato! Le scorte sono state aggiornate.');
                logAction('UPDATE', 'INVENTORY', `Arrival confirmed for ${id}: added +${orderQty} units.`);
            } catch (err) { alert("Errore: " + err); }
        };

        // --- BULK DELETE LOGIC ---
        window.isBulkMode = false;

        window.toggleBulkMode = () => {
            window.isBulkMode = !window.isBulkMode;
            const btnToggle = document.getElementById('btn-toggle-bulk');
            const divActions = document.getElementById('div-bulk-actions');
            
            if (window.isBulkMode) {
                btnToggle.classList.replace('bg-slate-50', 'bg-red-100');
                btnToggle.classList.replace('text-slate-600', 'text-red-700');
                btnToggle.classList.replace('border-slate-200', 'border-red-300');
                divActions.classList.remove('hidden');
            } else {
                btnToggle.classList.replace('bg-red-100', 'bg-slate-50');
                btnToggle.classList.replace('text-red-700', 'text-slate-600');
                btnToggle.classList.replace('border-red-300', 'border-slate-200');
                divActions.classList.add('hidden');
                // Deselect all when exiting
                window.toggleAllInventorySelection(false);
            }
            // Re-render list to show/hide checkboxes
            if (document.getElementById('inp-inv-search')) {
                window.filterInventoryLocal();
            }
        };

        window.updateBulkDeleteUI = () => {
            const checked = document.querySelectorAll('.chk-inv-bulk:checked').length;
            const btn = document.getElementById('btn-bulk-delete');
            const countSpan = document.getElementById('bulk-delete-count');
            
            if (btn && countSpan) {
                countSpan.innerText = checked;
                if (checked > 0) {
                    btn.disabled = false;
                    btn.classList.remove('opacity-50', 'cursor-not-allowed');
                    btn.classList.add('hover:bg-red-700');
                } else {
                    btn.disabled = true;
                    btn.classList.add('opacity-50', 'cursor-not-allowed');
                    btn.classList.remove('hover:bg-red-700');
                }
            }
            const selectAllChk = document.getElementById('chk-inv-select-all');
            if (selectAllChk) {
                const total = document.querySelectorAll('.chk-inv-bulk').length;
                selectAllChk.checked = (total > 0 && checked === total);
            }
        };

        window.toggleAllInventorySelection = (isChecked) => {
            document.querySelectorAll('.chk-inv-bulk').forEach(chk => chk.checked = isChecked);
            window.updateBulkDeleteUI();
        };

        window.bulkDeleteSelected = async () => {
            const checkedBoxes = Array.from(document.querySelectorAll('.chk-inv-bulk:checked'));
            const checkedIds = checkedBoxes.map(c => c.value);
            if (checkedIds.length === 0) return;
            if (!confirm(`Sei sicuro di voler eliminare ${checkedIds.length} articoli? Questa operazione è irreversibile.`)) return;
            
            try {
                for (let id of checkedIds) {
                    const safeId = id.replace(/\//g, '_');
                    await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'inventory', safeId));
                    logAction('DELETE', 'INVENTORY', `Item deleted (Bulk): ${id}`);
                }
                alert(`${checkedIds.length} articoli eliminati con successo.`);
                window.updateBulkDeleteUI(); // Reset UI
            } catch (err) {
                alert("Errore durante l'eliminazione multipla: " + err);
            }
        };

        // --- ADMIN INVENTORY ---
        window.checkNewCategory = (select) => {
            const input = document.getElementById('inp-inv-category-new');
            if (select.value === 'new') {
                input.classList.remove('hidden');
                input.required = true;
            } else {
                input.classList.add('hidden');
                input.required = false;
            }
        }

        window.togglePackSize = () => {
            const unit = document.getElementById('inp-inv-unit').value;
            const packDiv = document.getElementById('div-inv-packsize');
            const packInput = document.getElementById('inp-inv-packsize');

            if (unit === 'pacco') {
                packDiv.classList.remove('hidden');
                packInput.required = true;
            } else {
                packDiv.classList.add('hidden');
                packInput.required = false;
            }
        };

        window.saveInventoryItem = async (e) => {
            e.preventDefault();
            const id = document.getElementById('inp-inv-id').value.trim();
            const name = document.getElementById('inp-inv-name').value.trim();
            const brand = document.getElementById('inp-inv-brand').value.trim();
            const unit = document.getElementById('inp-inv-unit').value;
            const threshold = parseFloat(document.getElementById('inp-inv-threshold').value) || 0;
            const loc = document.getElementById('inp-inv-loc').value.trim();
            const image = document.getElementById('inp-inv-image').value.trim();
            const qtyInput = document.getElementById('inp-inv-qty');

            let category = document.getElementById('inp-inv-category').value;
            if (category === 'new') category = document.getElementById('inp-inv-category-new').value.trim();

            let packSize = 1;
            if (unit === 'pacco') {
                packSize = parseFloat(document.getElementById('inp-inv-packsize').value);
                if (!packSize || packSize <= 0) return alert("Inserire numero pezzi per pacco.");
            }

            if (!id || !name) return alert("Dati obbligatori.");

            try {
                const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'inventory', id.replace(/\//g, '_'));

                // Determine quantity: use admin input if valid number, else preserve/init
                let finalQty = 0;
                if (qtyInput.value !== "") {
                    finalQty = parseFloat(qtyInput.value);
                } else {
                    const snap = await getDoc(docRef);
                    finalQty = snap.exists() ? snap.data().quantity : 0;
                }

                const restockEmail = document.getElementById('inp-inv-restock-email').value.trim();
                await setDoc(docRef, {
                    id, name, brand, unit, threshold, location: loc, quantity: finalQty, packSize: packSize, category: category || '', image: image || '', restockEmail: restockEmail || ''
                });
                alert("Articolo salvato!");
                logAction('UPDATE', 'INVENTORY', `Inventory item saved: ${name} (${id}). Qty: ${finalQty}`);
                clearInventoryForm();
            } catch (e) { alert(e.message); }
        };

        window.deleteInventoryItem = async (id) => {
            if (confirm("Sei sicuro di voler eliminare questo articolo dal magazzino?")) {
                try {
                    await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'inventory', id.replace(/\//g, '_')));
                    logAction('DELETE', 'INVENTORY', `Inventory item deleted: ${id}`);
                } catch (e) { alert("Errore: " + e.message); }
            }
        };

        window.clearInventoryForm = () => {
            document.getElementById('inp-inv-id').value = '';
            document.getElementById('inp-inv-name').value = '';
            document.getElementById('inp-inv-brand').value = '';
            document.getElementById('inp-inv-unit').value = 'pz';
            document.getElementById('inp-inv-threshold').value = '';
            document.getElementById('inp-inv-loc').value = '';
            document.getElementById('inp-inv-packsize').value = '';
            document.getElementById('inp-inv-category').value = '';
            document.getElementById('inp-inv-image').value = '';
            document.getElementById('inp-inv-qty').value = '';
            document.getElementById('inp-inv-restock-email').value = '';
            document.getElementById('inp-inv-category-new').classList.add('hidden');
            togglePackSize();
            document.getElementById('inp-inv-id').readOnly = false;
        }

        window.editInventoryItem = (id, name, unit, threshold, loc, packSize, brand, category, image, qty, restockEmail) => {
            document.getElementById('inp-inv-id').value = id;
            document.getElementById('inp-inv-name').value = name;
            document.getElementById('inp-inv-brand').value = brand || '';
            document.getElementById('inp-inv-unit').value = unit;
            document.getElementById('inp-inv-threshold').value = threshold;
            document.getElementById('inp-inv-loc').value = loc;
            document.getElementById('inp-inv-image').value = image || '';
            document.getElementById('inp-inv-qty').value = qty !== 'undefined' ? qty : 0;
            document.getElementById('inp-inv-restock-email').value = restockEmail || '';

            // Handle Category select
            const catSelect = document.getElementById('inp-inv-category');
            let catFound = false;
            for (let i = 0; i < catSelect.options.length; i++) {
                if (catSelect.options[i].value === category) {
                    catSelect.selectedIndex = i;
                    catFound = true;
                    break;
                }
            }
            if (!catFound && category) {
                catSelect.value = 'new';
                document.getElementById('inp-inv-category-new').classList.remove('hidden');
                document.getElementById('inp-inv-category-new').value = category;
            } else {
                document.getElementById('inp-inv-category-new').classList.add('hidden');
            }

            if (packSize && packSize !== 'undefined') document.getElementById('inp-inv-packsize').value = packSize;

            togglePackSize();
            document.getElementById('inp-inv-id').readOnly = true;
            document.querySelector('.bg-white').scrollIntoView({ behavior: 'smooth' });
        }

        window.loadInventoryListAdmin = () => {
            const listEl = document.getElementById('inventory-list');
            listEl.innerHTML = '<p class="text-center text-xs">Caricamento...</p>';
            // Uses already loaded cache
            renderInventoryList(window.allInventoryCache, listEl, true);
        };

        // --- IMPORT/EXPORT ---
        window.exportInventoryCSV = () => {
            if (window.allInventoryCache.length === 0) return alert("Nessun dato.");
            const headers = ["ID", "Nome", "Marchio", "Categoria", "Unita", "Quantita", "Pezzi_Pacco", "Soglia", "Posizione"];
            const rows = window.allInventoryCache.map(i => [
                i.id, i.name, i.brand || '', i.category || '', i.unit, i.quantity, i.packSize || 1, i.threshold, i.location || ''
            ]);
            const csvContent = "data:text/csv;charset=utf-8," + headers.join(",") + "\n" + rows.map(e => e.join(",")).join("\n");
            const link = document.createElement("a");
            link.href = encodeURI(csvContent);
            link.download = `inventory_${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(link); link.click(); document.body.removeChild(link);
        };

        window.downloadInventoryTemplate = () => {
            const headers = ["ID", "Nome", "Marchio", "Categoria", "Unita", "Quantita", "Pezzi_Pacco", "Soglia", "Posizione", "Immagine"];
            const csvContent = "data:text/csv;charset=utf-8," + headers.join(",");
            const link = document.createElement("a");
            link.href = encodeURI(csvContent);
            link.download = "inventory_template.csv";
            document.body.appendChild(link); link.click(); document.body.removeChild(link);
        };

        window.importInventoryCSV = (input) => {
            const file = input.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (e) => {
                const text = e.target.result;
                const rows = text.split('\n').slice(1); // skip header
                let count = 0;
                for (let row of rows) {
                    const cols = row.split(',');
                    if (cols.length < 2) continue;
                    // Format: ID, Name, Brand, Category, Unit, Qty, PackSize, Threshold, Loc, Image, RestockEmail
                    const [id, name, brand, category, unit, qty, packSize, threshold, loc, image, restockEmail] = cols;
                    if (id && name) {
                        try {
                            await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'inventory', id.trim().replace(/\//g, '_')), {
                                id: id.trim(), name: name.trim(), brand: brand?.trim() || '', category: category?.trim() || '', unit: unit?.trim() || 'pz',
                                quantity: parseFloat(qty) || 0, packSize: parseFloat(packSize) || 1,
                                threshold: parseFloat(threshold) || 0, location: loc?.trim() || '', image: image?.trim() || '', restockEmail: restockEmail?.trim() || ''
                            }, { merge: true });
                            count++;
                        } catch (err) { console.error("Import error row", row, err); }
                    }
                }
                alert(`Importati/Aggiornati ${count} articoli.`);
                input.value = ''; // reset
            };
            reader.readAsText(file);
        };

        // --- UTILS & STARTUP ---
        function checkUrlParams() {
            const urlParams = new URLSearchParams(window.location.search);
            const mode = urlParams.get('mode');
            const resourceId = urlParams.get('r');

            if (mode === 'totem') {
                initTotemMode();
            } else {
                loadGlobalSettings();
                if (resourceId) handleScannedCode(resourceId);
            }
        }

        // --- SMART SEARCH (Strumenti + Magazzino — Fuse.js Fuzzy) ---
        let _searchTimeout = null;
        window.smartSearch = (term) => {
            clearTimeout(_searchTimeout);
            const container = document.getElementById('smart-search-results');
            if (!term || term.trim().length < 2) {
                container.classList.add('hidden');
                return;
            }
            _searchTimeout = setTimeout(() => {
                const searchTerm = term.trim();
                const results = [];

                // Build instruments list for Fuse
                let instruments = window.allInstrumentsCache?.length > 0 ? window.allInstrumentsCache : (window.resourcesCache || []);
                
                // Filter out restricted instruments for standard users
                if (!isAdmin && userRole !== 'supervisor') {
                    instruments = instruments.filter(inst => !inst.isRestricted);
                }

                if (instruments.length > 0) {
                    const fuseInst = new Fuse(instruments, { keys: ['description', 'id', 'contact'], threshold: 0.4, includeScore: true });
                    fuseInst.search(searchTerm).forEach(r => {
                        const inst = r.item;
                        results.push({ type: 'instrument', id: inst.id, name: inst.description || inst.id, sub: inst.contact || inst.id, imageUrl: inst.imageUrl, bookable: inst.isBookable !== false, score: r.score });
                    });
                }

                // Build inventory list for Fuse
                const inventory = window.allInventoryCache || [];
                if (inventory.length > 0) {
                    const fuseInv = new Fuse(inventory, { keys: ['name', 'brand', 'id', 'category'], threshold: 0.4, includeScore: true });
                    fuseInv.search(searchTerm).forEach(r => {
                        const item = r.item;
                        const lowStock = (item.quantity || 0) <= (item.threshold || 0);
                        results.push({ type: 'inventory', id: item.id, name: item.name, sub: item.brand ? `${item.brand} \u2022 ${item.category || ''}` : (item.category || item.id), qty: item.quantity, unit: item.unit || 'pz', lowStock, imageUrl: item.image, score: r.score });
                    });
                }

                // Sort by best score (lowest = best match)
                results.sort((a, b) => a.score - b.score);

                if (results.length === 0) {
                    container.innerHTML = `<div class="p-4 text-center text-xs text-slate-400">Nessun risultato per "${searchTerm}"</div>`;
                } else {
                    container.innerHTML = results.slice(0, 10).map(r => {
                        if (r.type === 'instrument') {
                            const iconHtml = r.imageUrl
                                ? `<img src="${r.imageUrl}" class="w-10 h-10 rounded-xl object-cover flex-shrink-0 shadow-sm border border-slate-200">`
                                : `<div class="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center flex-shrink-0"><i data-lucide="microscope" class="w-5 h-5 text-indigo-600"></i></div>`;

                            return `<button onclick="navigateToInstrument('${r.id}')" class="w-full flex items-center gap-3 p-3 hover:bg-slate-50 transition text-left border-b border-slate-100 last:border-0">
                                ${iconHtml}
                                <div class="flex-1 min-w-0">
                                    <p class="text-sm font-bold text-slate-800 truncate">${r.name}</p>
                                    <p class="text-[10px] text-slate-400 truncate font-mono mt-0.5">${r.sub}</p>
                                </div>
                                <span class="text-[10px] font-bold px-2 py-1 rounded-full bg-indigo-100 ${r.bookable ? 'text-indigo-600' : 'text-red-500 bg-red-100'} whitespace-nowrap shadow-sm border ${r.bookable ? 'border-indigo-200' : 'border-red-200'}">${r.bookable ? '\ud83d\udd2c Prenota' : 'NON DISP.'}</span>
                            </button>`;
                        } else {
                            const stockColor = r.lowStock ? 'text-red-700 bg-red-100 border border-red-200' : 'text-emerald-700 bg-emerald-100 border border-emerald-200';
                            const iconHtml = r.imageUrl
                                ? `<img src="${r.imageUrl}" class="w-10 h-10 rounded-xl object-cover flex-shrink-0 shadow-sm border border-slate-200">`
                                : `<div class="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center flex-shrink-0"><i data-lucide="package" class="w-5 h-5 text-emerald-600"></i></div>`;

                            return `<button onclick="navigateToInventory('${r.id}')" class="w-full flex items-center gap-3 p-3 hover:bg-slate-50 transition text-left border-b border-slate-100 last:border-0">
                                ${iconHtml}
                                <div class="flex-1 min-w-0">
                                    <p class="text-sm font-bold text-slate-800 truncate">${r.name}</p>
                                    <p class="text-[10px] text-slate-400 truncate mt-0.5">${r.sub}</p>
                                </div>
                                <div class="text-right flex-shrink-0">
                                    <span class="text-[10px] font-bold ${stockColor} px-2 py-0.5 rounded-full shadow-sm">${r.qty} <span class="text-[9px] uppercase">${r.unit}</span></span>
                                </div>
                            </button>`;
                        }
                    }).join('');
                }
                container.classList.remove('hidden');
                lucide.createIcons();
            }, 200);
        };
        window.smartSearchGo = () => {
            const term = document.getElementById('inp-manual-code').value.trim();
            if (!term) return;
            // If dropdown has exactly one result, navigate to it
            const container = document.getElementById('smart-search-results');
            const buttons = container.querySelectorAll('button');
            if (buttons.length === 1) {
                buttons[0].click();
                return;
            }
            // Otherwise fallback to old handleScannedCode
            handleScannedCode(term);
            container.classList.add('hidden');
        };
        window.navigateToInstrument = (id) => {
            document.getElementById('smart-search-results').classList.add('hidden');
            document.getElementById('inp-manual-code').value = '';
            handleScannedCode(id);
        };
        window.navigateToInventory = (id) => {
            document.getElementById('smart-search-results').classList.add('hidden');
            document.getElementById('inp-manual-code').value = '';
            handleScannedCode(id);
        };
        // Close dropdown on click outside
        document.addEventListener('click', (e) => {
            const container = document.getElementById('smart-search-results');
            const input = document.getElementById('inp-manual-code');
            if (container && !container.contains(e.target) && e.target !== input) {
                container.classList.add('hidden');
            }
        });

        // --- ADMIN TABS (UPDATED) ---
        window.switchAdminTab = (tab) => {
            if (userRole === 'supervisor') {
                if (tab === 'bookings' && !supervisorPermissions.bookings) return alert("Non hai accesso alle Prenotazioni.");
                if (tab === 'inventory' && !supervisorPermissions.inventory) return alert("Non hai accesso al Magazzino.");
                if (tab === 'instruments' && !supervisorPermissions.instruments) return alert("Non hai accesso agli Strumenti.");
                if (tab === 'logs' && !supervisorPermissions.logs) return alert("Non hai accesso ai Log.");
                if (tab === 'labels' && !supervisorPermissions.instruments && !supervisorPermissions.inventory) return alert("Non hai accesso alle Etichette.");
                if (tab === 'settings' || tab === 'access') return alert("Non hai accesso a questa sezione.");
            }
            if (userRole === 'user') return alert('Accesso negato.');

            document.querySelectorAll('.admin-tab-btn').forEach(b => {
                b.classList.remove('bg-white', 'text-indigo-700', 'shadow-sm');
                b.classList.add('text-slate-500');
            });
            document.getElementById('tab-btn-' + tab).classList.add('bg-white', 'text-indigo-700', 'shadow-sm');

            ['bookings', 'instruments', 'labels', 'settings', 'access', 'inventory', 'logs'].forEach(t => {
                const el = document.getElementById('admin-content-' + t);
                if (el) el.classList.add('hidden');
            });
            document.getElementById('admin-content-' + tab).classList.remove('hidden');

            if (tab === 'bookings') loadAdminBookings();
            if (tab === 'instruments') loadInstruments();
            if (tab === 'inventory') loadInventoryListAdmin();
            if (tab === 'logs') loadAdminLogs();
            if (tab === 'labels') loadLabelsList();
            if (tab === 'access') loadAccessSettings();
        };

        window.toggleDesktopMode = () => {
            isDesktopMode = !isDesktopMode;
            localStorage.setItem('desktopMode', isDesktopMode);
            applyDesktopMode();
        };

        window.applyDesktopMode = () => {
            const btn = document.getElementById('btn-toggle-desktop');
            const cam = document.getElementById('camera-container');
            const inp = document.getElementById('inp-manual-code');
            const main = document.getElementById('main-container');

            if (isDesktopMode) {
                if (btn) btn.innerHTML = '<i data-lucide="smartphone" class="w-3 h-3"></i> <span>MODALITÀ MOBILE</span>';
                if (cam) cam.classList.add('hidden');
                if (inp) {
                    inp.classList.add('text-lg', 'py-6', 'font-black', 'shadow-2xl', 'text-center');
                    inp.placeholder = "Scansiona il QR Code / Barcode...";
                    setTimeout(() => inp.focus(), 300);
                }
                if (main) { main.classList.remove('max-w-md'); main.classList.add('max-w-5xl'); }
            } else {
                if (btn) btn.innerHTML = '<i data-lucide="laptop" class="w-3 h-3"></i> <span>MODALITÀ DESKTOP</span>';
                if (cam) cam.classList.remove('hidden');
                if (inp) {
                    inp.classList.remove('text-lg', 'py-6', 'font-black', 'shadow-2xl', 'text-center');
                    inp.placeholder = "Cerca strumento o materiale...";
                }
                if (main) { main.classList.remove('max-w-5xl'); main.classList.add('max-w-md', 'lg:max-w-3xl'); }
            }
            if (window.lucide) lucide.createIcons();
        };

        window.resetApp = () => {
            if (window.history.pushState) window.history.pushState({ path: window.location.href.split('?')[0] }, '', window.location.href.split('?')[0]);
            window.switchView('view-scanner');
            document.getElementById('camera-overlay').classList.remove('hidden');
            document.getElementById('btn-stop').classList.add('hidden');
            document.getElementById('inp-manual-code').value = '';
            adminMode = false;
            loadGlobalSettings();
            applyDesktopMode();
        };
        window.switchView = (id) => {
            ['view-scanner', 'view-details', 'view-admin', 'view-my-booking', 'view-inventory', 'view-inventory-list', 'view-batch-summary'].forEach(v => {
                const el = document.getElementById(v);
                if (el) el.classList.add('hidden');
            });
            const target = document.getElementById(id);
            if (target) target.classList.remove('hidden');
        };
        window.startScanner = async () => {
            document.getElementById('camera-overlay').classList.add('hidden');
            html5QrCode = new Html5Qrcode("reader");
            await html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 250, height: 250 } }, onScanSuccess);
        };
        window.stopScanner = async () => { if (html5QrCode) await html5QrCode.stop(); resetApp(); };

        function isIpAddress(str) {
            return /^(\\d{1,3}\\.){3}\\d{1,3}(:\\d+)?$/.test(str);
        }
        function renderIdLink(id, isDark = false) {
            if (isIpAddress(id)) {
                return `<a href="http://${id}" target="_blank" class="font-mono ${isDark ? 'text-indigo-300 hover:text-indigo-100' : 'text-blue-500 hover:text-blue-700'} underline mt-1 inline-flex items-center gap-1"><i data-lucide="external-link" class="w-3 h-3"></i> ${id}</a>`;
            }
            return `<span class="font-mono ${isDark ? 'text-slate-400' : 'text-slate-400'}">ID: ${id}</span>`;
        }
        async function showDetails(text) {
            window.switchView('view-details');
            document.getElementById('item-title').innerText = text;
            document.getElementById('item-subtitle').innerHTML = renderIdLink(text, true);
            document.getElementById('btn-main-book').classList.remove('hidden');
            document.getElementById('badge-status').classList.add('hidden');
            document.getElementById('ip-actions').classList.add('hidden');
            document.getElementById('inst-public-img-tag').classList.add('hidden');
            window.currentInstrumentData = { id: text };
            loadBookings(text);
            try {
                const docSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'resources', text.replace(/\//g, '_')));
                if (docSnap.exists()) {
                    const data = docSnap.data();
                    
                    if (data.isRestricted && !isAdmin && userRole !== 'supervisor') {
                        alert("Strumento con accesso ristretto. Solo gli Amministratori o i Supervisori possono visualizzarlo.");
                        window.switchView('view-home');
                        return;
                    }

                    window.currentInstrumentData = data;
                    document.getElementById('item-title').innerText = data.description || text;
                    document.getElementById('item-subtitle').innerHTML = renderIdLink(data.id || text, true);

                    const imgTg = document.getElementById('inst-public-img-tag');
                    if (data.imageUrl) {
                        imgTg.src = data.imageUrl;
                        imgTg.classList.remove('hidden');
                    } else {
                        imgTg.src = '';
                        imgTg.classList.add('hidden');
                    }

                    if (isIpAddress(data.id || text)) {
                        document.getElementById('ip-actions').classList.remove('hidden');
                        document.getElementById('btn-open-ip').href = 'http://' + (data.id || text);
                    }
                    if (data.isBookable === false) {
                        document.getElementById('btn-main-book').classList.add('hidden');
                        document.getElementById('badge-status').classList.remove('hidden');
                    }
                }
                if (window.lucide) lucide.createIcons();
            } catch (e) { }
        }

        // --- ADMIN BOOKINGS & INSTRUMENTS ---
        window.loadAdminBookings = () => {
            const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'bookings'));
            onSnapshot(q, (snapshot) => {
                const bookings = [];
                snapshot.forEach(doc => bookings.push({ id: doc.id, ...doc.data() }));
                window.adminBookingsCache = bookings;
                document.getElementById('admin-list').innerHTML = bookings.map(b =>
                    `<div class="bg-white p-2 border-b text-xs flex justify-between items-center">
                        <div><span>${b.resourceName || b.resourceId} - ${b.userName}</span><span class="text-slate-400 block text-[10px]">${new Date(b.startDate).toLocaleDateString()}</span></div>
                        <div class="flex gap-2"><button onclick="editBookingFromAdmin('${b.id}')" class="p-1 bg-amber-100 rounded"><i data-lucide="pencil" class="w-3 h-3"></i></button><button onclick="deleteBooking('${b.id}')" class="p-1 bg-red-100 rounded"><i data-lucide="trash-2" class="w-3 h-3"></i></button></div>
                    </div>`
                ).join('');
                lucide.createIcons();
            });
        }
        window.loadInstruments = () => {
            const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'resources'));
            onSnapshot(q, (snapshot) => {
                const items = [];
                snapshot.forEach(doc => items.push(doc.data()));
                window.allInstrumentsCache = items;
                document.getElementById('instruments-list').innerHTML = items.map(item => {
                    const ipLink = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(item.id)
                        ? `<a href="http://${item.id}" target="_blank" class="text-[10px] text-blue-500 hover:text-blue-700 underline font-mono inline-flex items-center gap-0.5"><i data-lucide="external-link" class="w-2.5 h-2.5"></i> ${item.id}</a>`
                        : `<div class="text-[10px] text-slate-400 font-mono">${item.id}</div>`;
                    return `
                    <div id="inst-card-${item.id.replace(/\./g, '-')}" class="inst-card bg-white p-3 rounded-lg border border-slate-100 flex justify-between items-center shadow-sm cursor-pointer hover:border-indigo-400 transition" onclick="editInstrument('${item.id}')">
                        <div>
                            <div class="flex items-center gap-2">
                                ${item.imageUrl ? `<img src="${item.imageUrl}" class="w-6 h-6 rounded object-cover shadow-sm">` : ''}
                                <div class="text-xs font-bold text-slate-700">${item.description}</div>
                            </div>
                            ${ipLink}
                        </div>
                        <div class="flex gap-2">
                            <button onclick="event.stopPropagation(); openCalendarForInstrument('${item.id}', '${item.description}')" class="p-2 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition"><i data-lucide="calendar" class="w-4 h-4"></i></button>
                        </div>
                    </div>`;
                }).join('');
                if (window.lucide) lucide.createIcons();
            });
        };

        window.saveInstrument = async (e) => {
            e.preventDefault();
            const id = document.getElementById('inp-inst-id').value.trim();
            const desc = document.getElementById('inp-inst-desc').value.trim();
            const contact = document.getElementById('inp-inst-contact').value.trim();
            const url = document.getElementById('inp-inst-image').value.trim();
            const bookable = document.getElementById('inp-inst-bookable').checked;
            const restricted = document.getElementById('inp-inst-restricted').checked;
            try {
                await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'resources', id.replace(/\//g, '_')), {
                    id, description: desc, contact, imageUrl: url, isBookable: bookable, isRestricted: restricted, updatedAt: serverTimestamp()
                });
                alert("Salvato!");
                logAction('UPDATE', 'INSTRUMENT', `Instrument saved: ${desc} (${id})`);
                clearInstrumentForm();
            } catch (e) { alert(e.message); }
        };
        window.clearInstrumentForm = () => {
            document.querySelectorAll('.inst-card').forEach(c => c.classList.remove('ring-2', 'ring-indigo-500', 'bg-indigo-50'));
            document.getElementById('inst-form-title').innerHTML = '<i data-lucide="settings-2" class="w-4 h-4 text-slate-500"></i> Configura Nuovo';

            document.getElementById('inp-inst-id').value = '';
            document.getElementById('inp-inst-desc').value = '';
            document.getElementById('inp-inst-contact').value = '';
            document.getElementById('inp-inst-image').value = '';
            document.getElementById('inp-inst-restricted').checked = false;
            document.getElementById('inp-inst-id').readOnly = false;
            if (window.lucide) lucide.createIcons();
        };
        window.editInstrument = (id) => {
            const inst = window.allInstrumentsCache.find(i => i.id === id);
            if (!inst) return;

            document.querySelectorAll('.inst-card').forEach(c => c.classList.remove('ring-2', 'ring-indigo-500', 'bg-indigo-50'));
            const card = document.getElementById(`inst-card-${id.replace(/\\./g, '-')}`);
            if (card) card.classList.add('ring-2', 'ring-indigo-500', 'bg-indigo-50');

            document.getElementById('inst-form-title').innerHTML = `<i data-lucide="edit-3" class="w-4 h-4 text-indigo-600"></i> Modifica: ${inst.description}`;
            if (window.lucide) lucide.createIcons();

            document.getElementById('inp-inst-id').value = inst.id;
            document.getElementById('inp-inst-desc').value = inst.description;
            document.getElementById('inp-inst-contact').value = inst.contact || '';
            document.getElementById('inp-inst-image').value = inst.imageUrl || '';
            document.getElementById('inp-inst-bookable').checked = inst.isBookable !== false;
            document.getElementById('inp-inst-restricted').checked = inst.isRestricted === true;
            document.getElementById('inp-inst-id').readOnly = true;
            document.querySelector('#admin-content-instruments').scrollIntoView({ behavior: 'smooth' });
        };

        // --- TIME SLOT PICKER UTILS ---
        function generateTimeSlots() {
            const slots = [];
            for (let h = 5; h <= 20; h++) {
                slots.push(`${String(h).padStart(2, '0')}:00`);
                slots.push(`${String(h).padStart(2, '0')}:30`);
            }
            slots.push('21:00');
            return slots;
        }
        // Fetch booked intervals for a resource on a given date
        async function getBookedSlots(resourceId, dateStr, excludeBookingId) {
            if (!resourceId || !dateStr) return [];
            const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'bookings'), where('resourceId', '==', resourceId));
            const snapshot = await getDocs(q);
            const booked = [];
            snapshot.forEach(d => {
                if (d.id === excludeBookingId) return;
                const b = d.data();
                const bStart = new Date(b.startDate), bEnd = new Date(b.endDate);
                const dayStart = new Date(dateStr + 'T00:00');
                const dayEnd = new Date(dateStr + 'T23:59');
                if (bStart <= dayEnd && bEnd >= dayStart) {
                    booked.push({ start: bStart, end: bEnd });
                }
            });
            return booked;
        }
        function isSlotBooked(slotTime, dateStr, bookedIntervals) {
            const slotStart = new Date(dateStr + 'T' + slotTime);
            const slotEnd = new Date(slotStart.getTime() + 30 * 60000); // 30 min slot
            return bookedIntervals.some(b => slotStart < b.end && slotEnd > b.start);
        }
        async function renderTimeSlots(containerId, hiddenInputId, type, prefix, resourceId, dateStr, excludeBookingId) {
            const container = document.getElementById(containerId);
            const slots = generateTimeSlots();
            let bookedIntervals = [];
            if (resourceId && dateStr) {
                bookedIntervals = await getBookedSlots(resourceId, dateStr, excludeBookingId);
            }
            container.innerHTML = slots.map(slot => {
                const booked = dateStr && isSlotBooked(slot, dateStr, bookedIntervals);
                if (booked) {
                    return `<button type="button" class="time-slot-btn text-[11px] py-1.5 px-1 rounded-lg border border-slate-100 bg-slate-100 text-slate-300 cursor-not-allowed font-medium" data-time="${slot}" disabled title="Occupato">${slot}</button>`;
                }
                return `<button type="button" class="time-slot-btn text-[11px] py-1.5 px-1 rounded-lg border border-slate-200 text-slate-600 hover:bg-indigo-100 hover:border-indigo-400 transition-all font-medium" data-time="${slot}" data-prefix="${prefix}" data-type="${type}" onclick="selectTimeSlot(this, '${hiddenInputId}', '${prefix}', '${type}')">${slot}</button>`;
            }).join('');
        }
        window.selectTimeSlot = (btn, hiddenInputId, prefix, type) => {
            if (btn.disabled) return;
            btn.parentElement.querySelectorAll('.time-slot-btn').forEach(b => {
                if (!b.disabled) {
                    b.classList.remove('bg-indigo-600', 'text-white', 'border-indigo-600');
                    b.classList.add('border-slate-200', 'text-slate-600');
                }
            });
            btn.classList.add('bg-indigo-600', 'text-white', 'border-indigo-600');
            btn.classList.remove('border-slate-200', 'text-slate-600');
            const dateInput = document.getElementById(prefix === 'admin' ? `inp-admin-${type}-date` : `inp-${type}-date`);
            const date = dateInput.value;
            if (date) {
                document.getElementById(hiddenInputId).value = date + 'T' + btn.dataset.time;
            } else {
                document.getElementById(hiddenInputId).value = btn.dataset.time;
            }
            if (type === 'start') {
                const endHidden = document.getElementById(prefix === 'admin' ? 'inp-admin-end' : 'inp-end');
                const endDateInput = document.getElementById(prefix === 'admin' ? 'inp-admin-end-date' : 'inp-end-date');
                if (dateInput.value === endDateInput.value && (!endHidden.value || endHidden.value.indexOf('T') === -1)) {
                    const slots = generateTimeSlots();
                    const idx = slots.indexOf(btn.dataset.time);
                    if (idx >= 0 && idx < slots.length - 1) {
                        const endContainer = document.getElementById(prefix === 'admin' ? 'admin-time-slots-end' : 'time-slots-end');
                        const nextBtn = endContainer.querySelector(`[data-time="${slots[idx + 1]}"]:not([disabled])`);
                        if (nextBtn) selectTimeSlot(nextBtn, prefix === 'admin' ? 'inp-admin-end' : 'inp-end', prefix, 'end');
                    }
                }
            }
        };
        async function onDateChange(prefix, type) {
            const dateVal = document.getElementById(prefix === 'admin' ? `inp-admin-${type}-date` : `inp-${type}-date`).value;
            let resourceId = prefix === 'admin' ? document.getElementById('inp-admin-instrument').value : currentItem;
            const excludeId = prefix === 'admin' ? window._editingAdminBookingId : editingBookingId;

            await renderTimeSlots(
                prefix === 'admin' ? `admin-time-slots-${type}` : `time-slots-${type}`,
                prefix === 'admin' ? `inp-admin-${type}` : `inp-${type}`,
                type, prefix, resourceId, dateVal, excludeId
            );

            if (type === 'start') {
                const endDateInput = document.getElementById(prefix === 'admin' ? 'inp-admin-end-date' : 'inp-end-date');
                if (!endDateInput.value) {
                    endDateInput.value = dateVal;
                    onDateChange(prefix, 'end');
                }
            }
            document.getElementById(prefix === 'admin' ? `inp-admin-${type}` : `inp-${type}`).value = '';
        }
        // Overlap checking utility
        async function checkBookingOverlap(resourceId, startStr, endStr, excludeBookingId) {
            const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'bookings'), where('resourceId', '==', resourceId));
            const snapshot = await getDocs(q);
            const newStart = new Date(startStr), newEnd = new Date(endStr);
            let overlap = false;
            snapshot.forEach(d => {
                if (d.id === excludeBookingId) return;
                const b = d.data();
                const bStart = new Date(b.startDate), bEnd = new Date(b.endDate);
                if (newStart < bEnd && newEnd > bStart) overlap = true;
            });
            return overlap;
        }

        // --- BOOKING LOGIC ---
        window.showBookingForm = () => {
            editingBookingId = null;
            document.getElementById('modal-booking').classList.remove('hidden');
            const info = window.currentInstrumentData?.contact || "Non assegnato";
            document.getElementById('booking-contact-info').innerText = info;
            // Init time slot pickers (no date yet, so no availability check)
            renderTimeSlots('time-slots-start', 'inp-start', 'start', 'user');
            renderTimeSlots('time-slots-end', 'inp-end', 'end', 'user');
            document.getElementById('inp-start').value = '';
            document.getElementById('inp-end').value = '';
            document.getElementById('inp-start-date').value = '';
            document.getElementById('inp-end-date').value = '';
            document.getElementById('inp-start-date').onchange = () => onDateChange('user', 'start');
            document.getElementById('inp-end-date').onchange = () => onDateChange('user', 'end');
            document.getElementById('booking-overlap-warning').classList.add('hidden');
            setTimeout(() => document.getElementById('inp-name').focus(), 100);
        };
        window.hideBookingForm = () => document.getElementById('modal-booking').classList.add('hidden');
        window.handleBooking = async (e) => {
            e.preventDefault();
            if (!currentUser) return alert("No connection");
            const name = document.getElementById('inp-name').value;
            const email = document.getElementById('inp-booking-email').value.trim();
            const start = document.getElementById('inp-start').value;
            const end = document.getElementById('inp-end').value;
            if (!start || !end || start.indexOf('T') === -1 || end.indexOf('T') === -1) return alert('Seleziona data e orari.');
            if (new Date(start) >= new Date(end)) return alert('L\'ora di fine deve essere dopo l\'inizio.');
            try {
                // Overlap check
                const resourceId = currentItem;
                const hasOverlap = await checkBookingOverlap(resourceId, start, end, editingBookingId);
                if (hasOverlap) {
                    document.getElementById('booking-overlap-warning').classList.remove('hidden');
                    return alert('⚠️ Orario non disponibile! C\'è già una prenotazione in questo intervallo.');
                }
                document.getElementById('booking-overlap-warning').classList.add('hidden');
                if (editingBookingId) {
                    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'bookings', editingBookingId), {
                        userName: name, email: email || '', startDate: start, endDate: end, updatedAt: serverTimestamp()
                    });
                    logAction('UPDATE', 'BOOKING', `Booking updated for ${currentItemName} (${currentItem}). New time: ${start} - ${end}`);
                    alert("Modificata!");
                } else {
                    const pnr = Math.random().toString(36).substring(2, 8).toUpperCase();
                    const resourceName = currentItemName || currentItem;
                    await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'bookings'), {
                        resourceId: currentItem, resourceName: resourceName,
                        userName: name, email: email || '', startDate: start, endDate: end, pnr: pnr, bookedBy: currentUser.uid, createdAt: serverTimestamp()
                    });
                    alert(`Confermata! PNR: ${pnr}`);
                    // Send confirmation email
                    if (email) {
                        sendBookingConfirmation(email, name, resourceName, start, end, pnr);
                    }
                    logAction('CREATE', 'BOOKING', `New booking for ${resourceName} (${currentItem}). Time: ${start} - ${end}. PNR: ${pnr}`);
                }
                hideBookingForm();
            } catch (e) { alert(e.message); }
        };
        function loadBookings(itemId) {
            const listEl = document.getElementById('bookings-list');
            listEl.innerHTML = '<p class="text-center text-xs text-slate-400">Caricamento...</p>';
            const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'bookings'), where("resourceId", "==", itemId));
            onSnapshot(q, (snapshot) => {
                const bookings = [];
                snapshot.forEach(doc => bookings.push({ id: doc.id, ...doc.data() }));
                window.calendarBookingsCache = bookings;
                const now = new Date();
                const futureBookings = bookings.filter(b => new Date(b.endDate) >= now);
                if (futureBookings.length > 0) {
                    listEl.innerHTML = `<p class="text-xs text-center text-slate-500">${futureBookings.length} prenotazioni future</p>`;
                } else {
                    listEl.innerHTML = '<div class="text-center py-4"><span class="inline-block px-4 py-2 bg-emerald-100 text-emerald-700 rounded-full text-sm font-black uppercase tracking-wider">✅ LIBERO</span></div>';
                }
                // Render inline weekly calendar
                renderWeekCalendar();
            });
        }

        // --- CALENDARIO SETTIMANALE (COLLAPSIBLE) ---
        window.toggleWeekCalendar = () => {
            const wrapper = document.getElementById('week-cal-wrapper');
            const txt = document.getElementById('week-cal-toggle-txt');
            if (wrapper.classList.contains('hidden')) {
                wrapper.classList.remove('hidden');
                txt.innerText = 'Nascondi Calendario Settimanale';
                renderWeekCalendar();
            } else {
                wrapper.classList.add('hidden');
                txt.innerText = 'Mostra Calendario Settimanale';
            }
        };

        let _weekCalOffset = 0; // 0 = this week, 1 = next week, etc.

        window.shiftWeekCalendar = (dir) => {
            _weekCalOffset += dir;
            renderWeekCalendar();
        };

        function getMonday(d) {
            const dt = new Date(d);
            const day = dt.getDay();
            const diff = dt.getDate() - day + (day === 0 ? -6 : 1);
            dt.setDate(diff);
            dt.setHours(0, 0, 0, 0);
            return dt;
        }

        function renderWeekCalendar() {
            const bookings = window.calendarBookingsCache || [];
            const grid = document.getElementById('week-cal-grid');
            const title = document.getElementById('week-cal-title');
            if (!grid) return;

            const today = new Date();
            const monday = getMonday(today);
            monday.setDate(monday.getDate() + _weekCalOffset * 7);
            const sunday = new Date(monday);
            sunday.setDate(sunday.getDate() + 6);

            const dayNames = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
            const months = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];
            title.innerText = `${monday.getDate()} ${months[monday.getMonth()]} — ${sunday.getDate()} ${months[sunday.getMonth()]} ${sunday.getFullYear()}`;

            const startHour = 8;
            const endHour = 20;
            let html = '';

            // Day header row
            for (let d = 0; d < 7; d++) {
                const dt = new Date(monday);
                dt.setDate(dt.getDate() + d);
                const isToday = dt.toDateString() === today.toDateString();
                html += `<div class="py-1.5 border-b border-slate-100 ${isToday ? 'bg-indigo-50 text-indigo-700 font-black' : 'bg-slate-50'}">${dayNames[d]}<br><span class="text-[8px] font-normal">${dt.getDate()}</span></div>`;
            }

            // Time rows (each row = 1 hour block)
            for (let h = startHour; h < endHour; h++) {
                for (let d = 0; d < 7; d++) {
                    const dt = new Date(monday);
                    dt.setDate(dt.getDate() + d);
                    const slotStart = new Date(dt); slotStart.setHours(h, 0, 0, 0);
                    const slotEnd = new Date(dt); slotEnd.setHours(h + 1, 0, 0, 0);

                    // Check if any booking overlaps this slot
                    const overlap = bookings.find(b => {
                        const bs = new Date(b.startDate);
                        const be = new Date(b.endDate);
                        return bs < slotEnd && be > slotStart;
                    });

                    const isPast = slotEnd < today;
                    let cellClass = 'border-r border-b border-slate-50 py-0.5';
                    let cellContent = '';

                    if (overlap) {
                        cellClass += ' bg-red-100 text-red-600';
                        cellContent = `<span class="text-[7px]">${h}:00</span>`;
                    } else if (isPast) {
                        cellClass += ' bg-slate-50 text-slate-300';
                        cellContent = `<span class="text-[7px]">${h}</span>`;
                    } else {
                        cellClass += ' bg-emerald-50 text-emerald-500';
                        cellContent = `<span class="text-[7px]">${h}</span>`;
                    }

                    html += `<div class="${cellClass}">${cellContent}</div>`;
                }
            }

            grid.innerHTML = html;
        }

        // --- TOTEM ---
        function initTotemMode() {
            document.getElementById('main-header').classList.add('hidden');
            document.getElementById('main-container').classList.add('hidden');
            document.getElementById('view-totem').classList.remove('hidden');
            setInterval(updateTotemClock, 1000);
            updateTotemClock();
            loadTotemData();
        }
        function updateTotemClock() {
            const now = new Date();
            document.getElementById('totem-clock').innerText = now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
        }
        function loadTotemData() {
            const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'bookings'));
            onSnapshot(q, (snapshot) => {
                const bookings = [];
                snapshot.forEach(doc => bookings.push({ id: doc.id, ...doc.data() }));
                const now = new Date();
                const active = bookings.filter(b => { const s = new Date(b.startDate), e = new Date(b.endDate); return now >= s && now <= e; });
                const upcoming = bookings.filter(b => new Date(b.startDate) > now).sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
                document.getElementById('totem-active-list').innerHTML = active.map(b => `<div class="bg-slate-800 p-3 mb-2 rounded border-l-4 border-emerald-500"><h3 class="font-bold text-white">${b.resourceName}</h3><p class="text-emerald-400">${b.userName}</p></div>`).join('') || '<p class="text-slate-500">Nessuna attività</p>';
                document.getElementById('totem-upcoming-list').innerHTML = upcoming.map(b => `<div class="bg-slate-800 p-3 mb-2 rounded"><div class="flex justify-between"><span class="text-white font-bold">${b.resourceName}</span><span class="text-slate-400 text-sm">${new Date(b.startDate).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })}</span></div><div class="flex justify-between mt-1"><span class="text-indigo-400 text-sm">${b.userName}</span><span class="text-emerald-400 text-sm">${new Date(b.startDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${new Date(b.endDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div></div>`).join('') || '<p class="text-slate-500">Nessuna prenotazione</p>';

                // Totem Stock Alerts (New v4.8)
                updateTotemStockAlerts();
            });
        }

        function updateTotemStockAlerts() {
            const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'inventory'));
            onSnapshot(q, (snapshot) => {
                const alerts = [];
                snapshot.forEach(doc => {
                    const i = doc.data();
                    if ((i.quantity || 0) <= (i.threshold || 0)) alerts.push(`${i.name} (Sotto scorta)`);
                });
                const ticker = document.querySelector('#totem-stock-alerts .animate-marquee');
                if (ticker) ticker.innerText = alerts.length ? "ATTENZIONE: " + alerts.join(" • ") : "";
            });
        }

        // --- ADMIN LOGIN & EXPORT ---
        window.showAdminLogin = () => {
            if (!currentUser) { alert('Effettua prima il login.'); return; }
            if (isAdmin) {
                adminMode = true;
                document.getElementById('view-maintenance').classList.add('hidden');
                window.switchView('view-admin');

                // Hide/show tabs based on supervisor permissions
                if (userRole === 'supervisor') {
                    document.getElementById('tab-btn-bookings').style.display = supervisorPermissions.bookings ? 'block' : 'none';
                    document.getElementById('tab-btn-inventory').style.display = supervisorPermissions.inventory ? 'block' : 'none';
                    document.getElementById('tab-btn-instruments').style.display = supervisorPermissions.instruments ? 'block' : 'none';
                    document.getElementById('tab-btn-logs').style.display = supervisorPermissions.logs ? 'block' : 'none';
                    document.getElementById('tab-btn-settings').style.display = 'none';

                    if (supervisorPermissions.bookings) switchAdminTab('bookings');
                    else if (supervisorPermissions.inventory) switchAdminTab('inventory');
                    else if (supervisorPermissions.instruments) switchAdminTab('instruments');
                    else if (supervisorPermissions.logs) switchAdminTab('logs');
                } else {
                    document.getElementById('tab-btn-bookings').style.display = 'block';
                    document.getElementById('tab-btn-inventory').style.display = 'block';
                    document.getElementById('tab-btn-instruments').style.display = 'block';
                    document.getElementById('tab-btn-logs').style.display = 'block';
                    document.getElementById('tab-btn-settings').style.display = 'block';
                    switchAdminTab('bookings');
                    loadAdminEmails(); // For Co-Admins
                    loadSupervisors(); // For Supervisors
                }
            } else {
                alert('Non hai i permessi di amministratore. Contatta un admin per essere abilitato.');
            }
        };
        window.exportBookingsCSV = () => {
            const bookings = window.adminBookingsCache;
            if (!bookings || bookings.length === 0) return alert("Nessun dato.");
            const rows = bookings.map(b => [b.resourceId, b.resourceName, b.userName, b.startDate, b.endDate].join(","));
            const csvContent = "data:text/csv;charset=utf-8,ID,Nome,Utente,Inizio,Fine\n" + rows.join("\n");
            const link = document.createElement("a"); link.href = encodeURI(csvContent); link.download = "report.csv"; document.body.appendChild(link); link.click();
        };
        // --- ETICHETTE (LABELS) ---
        let currentLabelTab = 'strum';

        window.switchLabelTab = (tab) => {
            currentLabelTab = tab;
            document.getElementById('lbl-tab-strum').className = tab === 'strum'
                ? 'flex-1 py-2 bg-indigo-600 text-white rounded-lg text-xs font-bold transition shadow-sm'
                : 'flex-1 py-2 bg-white text-slate-600 hover:bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold transition shadow-sm';
            document.getElementById('lbl-tab-magaz').className = tab === 'magaz'
                ? 'flex-1 py-2 bg-indigo-600 text-white rounded-lg text-xs font-bold transition shadow-sm'
                : 'flex-1 py-2 bg-white text-slate-600 hover:bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold transition shadow-sm';

            document.getElementById('lbl-check-all').checked = false;
            loadLabelsList();
        };

        window.loadLabelsList = () => {
            const container = document.getElementById('labels-item-list');
            const items = currentLabelTab === 'strum' ? (window.allInstrumentsCache || []) : (window.allInventoryCache || []);

            document.getElementById('lbl-count-strum').innerText = (window.allInstrumentsCache || []).length;
            document.getElementById('lbl-count-magaz').innerText = (window.allInventoryCache || []).length;

            if (items.length === 0) {
                container.innerHTML = '<p class="text-xs text-slate-400 text-center py-4">Nessun elemento trovato.</p>';
                return;
            }

            container.innerHTML = items.map(item => {
                const title = currentLabelTab === 'strum' ? item.description : item.name;
                const sub = currentLabelTab === 'strum' ? item.id : (item.id || item.brand || item.category || '');
                return `<label class="flex items-center gap-3 p-2 hover:bg-slate-50 rounded-lg border border-transparent hover:border-slate-100 transition cursor-pointer">
                    <input type="checkbox" value="${item.id}" class="lbl-item-checkbox w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500">
                    <div class="flex-1 min-w-0">
                        <p class="text-sm font-bold text-slate-800 truncate">${title}</p>
                        <p class="text-[10px] text-slate-400 font-mono truncate">${sub}</p>
                    </div>
                </label>`;
            }).join('');
        };

        window.toggleAllLabels = (checked) => {
            document.querySelectorAll('.lbl-item-checkbox').forEach(cb => cb.checked = checked);
        };

        window.clearLabelSelection = () => {
            document.getElementById('lbl-check-all').checked = false;
            document.querySelectorAll('.lbl-item-checkbox').forEach(cb => cb.checked = false);
        };

        window.generateLabels = async () => {
            const selectedIds = Array.from(document.querySelectorAll('.lbl-item-checkbox:checked')).map(cb => cb.value);
            if (selectedIds.length === 0) return alert("Seleziona almeno un elemento!");

            const doQR = document.getElementById('lbl-opt-qr').checked;
            const doBC = document.getElementById('lbl-opt-bc').checked;
            if (!doQR && !doBC) return alert("Scegli un formato in alto (QR o Barcode)!");

            const items = currentLabelTab === 'strum' ? window.allInstrumentsCache : window.allInventoryCache;
            const selectedItems = items.filter(i => selectedIds.includes(i.id));

            // Build label cards HTML
            let cardsHtml = '';
            for (const item of selectedItems) {
                const title = currentLabelTab === 'strum' ? item.description : item.name;
                const sub = item.id;
                let codesHtml = '';

                if (doBC) {
                    codesHtml += `<svg class="label-barcode" data-barcode="${sub}"></svg>`;
                }
                if (doQR) {
                    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(sub)}`;
                    codesHtml += `<img src="${qrUrl}" width="140" height="140" style="display:block;margin:8px auto 0;">`;
                }

                cardsHtml += `
                <div class="label-card">
                    <h3>${title}</h3>
                    ${codesHtml}
                    <p class="label-id">${sub}</p>
                </div>`;
            }

            // Open a clean popup window for print / save-as-PDF
            const printWin = window.open('', '_blank', 'width=800,height=600');
            printWin.document.write(`<!DOCTYPE html>
<html><head><title>Etichette - UniScan</title>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"><\/script>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; padding: 20px; background: #fff; }
  h1 { text-align:center; font-size:18px; margin-bottom:16px; color:#333; }
  .grid { display:grid; grid-template-columns: repeat(3, 1fr); gap:16px; }
  .label-card {
    border: 2px solid #1e293b; border-radius: 12px; padding: 16px;
    text-align: center; page-break-inside: avoid; break-inside: avoid; background:#fff;
  }
  .label-card h3 { font-size:14px; font-weight:900; text-transform:uppercase; margin-bottom:8px; line-height:1.2; }
  .label-card .label-id { font-family: monospace; font-size:11px; font-weight:700; margin-top:8px; letter-spacing:1px; color:#475569; }
  .label-barcode { display:block; margin:4px auto; max-width:100%; }
  .no-print { text-align:center; margin-bottom:16px; }
  .no-print button {
    padding: 10px 24px; font-size:13px; font-weight:700; border:none; border-radius:8px;
    cursor:pointer; margin:0 6px; transition: background 0.2s;
  }
  .btn-print { background:#4f46e5; color:#fff; }
  .btn-print:hover { background:#4338ca; }
  .btn-close { background:#e2e8f0; color:#334155; }
  .btn-close:hover { background:#cbd5e1; }
  @media print {
    .no-print { display:none; }
    body { padding: 0; }
    .grid { gap: 12px; }
  }
</style>
</head><body>
<div class="no-print">
  <button class="btn-print" onclick="window.print()">🖨️ STAMPA / SALVA PDF</button>
  <button class="btn-close" onclick="window.close()">✕ CHIUDI</button>
</div>
<h1>Etichette ${currentLabelTab === 'strum' ? 'Strumenti' : 'Magazzino'}</h1>
<div class="grid">${cardsHtml}</div>
<script>
  document.querySelectorAll('.label-barcode').forEach(svg => {
    try { JsBarcode(svg, svg.dataset.barcode, { format:'CODE128', width:2, height:55, displayValue:false, margin:0 }); } catch(e){}
  });
<\/script>
</body></html>`);
            printWin.document.close();
        };
        window.copyDirectLink = () => {
            navigator.clipboard.writeText(window.location.href.split('?')[0] + '?r=' + currentItem).then(() => alert("Copiato!"));
        };
        window.openCalendarModal = () => { document.getElementById('modal-calendar').classList.remove('hidden'); };
        window.openCalendarForInstrument = (id, name) => {
            document.getElementById('modal-calendar').classList.remove('hidden');
            const container = document.getElementById('calendar-container');
            container.innerHTML = '<p class="text-center text-xs text-slate-400">Caricamento...</p>';
            const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'bookings'), where('resourceId', '==', id));
            onSnapshot(q, (snapshot) => {
                const bookings = [];
                snapshot.forEach(d => bookings.push({ id: d.id, ...d.data() }));
                const now = new Date();
                const future = bookings.filter(b => new Date(b.endDate) >= now).sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
                if (future.length === 0) {
                    container.innerHTML = `<div class="text-center py-8"><p class="text-lg font-bold text-slate-700">${name}</p><div class="mt-4"><span class="inline-block px-6 py-3 bg-emerald-100 text-emerald-700 rounded-full text-lg font-black uppercase tracking-wider">✅ LIBERO</span></div></div>`;
                } else {
                    container.innerHTML = `<p class="text-sm font-bold text-slate-700 mb-3">${name} — ${future.length} prenotazioni</p>` +
                        future.map(b => {
                            const sd = new Date(b.startDate), ed = new Date(b.endDate);
                            const isActive = now >= sd && now <= ed;
                            const border = isActive ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200';
                            return `<div class="p-3 mb-2 rounded-lg border-l-4 ${border} bg-white shadow-sm">
                                <div class="flex justify-between items-center">
                                    <span class="text-sm font-bold text-slate-700">${b.userName}</span>
                                    ${isActive ? '<span class="text-[10px] bg-emerald-500 text-white px-2 py-0.5 rounded-full font-bold">IN USO</span>' : ''}
                                </div>
                                <div class="text-xs text-slate-500 mt-1">${sd.toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'short' })} • ${sd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${ed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                                ${b.pnr ? '<div class="text-[10px] text-slate-400 mt-1 font-mono">PNR: ' + b.pnr + '</div>' : ''}
                            </div>`;
                        }).join('');
                }
            });
        };
        window.reportIssue = () => alert("Segnalazione inviata.");

        function loadGlobalSettings() {
            onSnapshot(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'global'), (doc) => {
                if (doc.exists()) {
                    globalSettingsCache = doc.data();

                    if (doc.data().maintenanceMode && !adminMode) {
                        document.getElementById('view-maintenance').classList.remove('hidden');
                    } else {
                        document.getElementById('view-maintenance').classList.add('hidden');
                    }

                    document.getElementById('maint-ref-name').innerText = doc.data().referentName || '';
                    document.getElementById('inp-maint-active').checked = doc.data().maintenanceMode === true;
                    document.getElementById('inp-setting-batch').checked = doc.data().batchInventoryEnabled === true;
                    document.getElementById('inp-maint-name').value = doc.data().referentName || '';
                    document.getElementById('inp-maint-email').value = doc.data().referentEmail || '';

                    const batchBtn = document.getElementById('btn-toggle-batch');
                    if (batchBtn) batchBtn.style.display = doc.data().batchInventoryEnabled ? 'flex' : 'none';
                    if (!doc.data().batchInventoryEnabled) { isBatchMode = false; updateBatchUI(); }
                }
            });
        }
        window.saveGlobalSettings = async () => {
            const active = document.getElementById('inp-maint-active').checked;
            const batchEn = document.getElementById('inp-setting-batch').checked;
            const refName = document.getElementById('inp-maint-name').value;
            const refEmail = document.getElementById('inp-maint-email').value;

            await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'global'), {
                maintenanceMode: active,
                batchInventoryEnabled: batchEn,
                referentName: refName,
                referentEmail: refEmail
            }, { merge: true });

            logAction('UPDATE', 'SETTINGS', `Global settings updated. Maintenance: ${active}, Batch Enabled: ${batchEn}`);
            alert("Settings salvati.");
        };
        window.deleteBooking = async (id) => {
            if (confirm("Eliminare?")) {
                await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'bookings', id));
                logAction('DELETE', 'BOOKING', `Booking ${id} deleted by user.`);
            }
        };
        window.editBookingFromAdmin = (id) => {
            const booking = window.adminBookingsCache.find(b => b.id === id);
            if (!booking) return alert('Prenotazione non trovata.');
            // Reuse admin booking modal for editing
            const instruments = window.allInstrumentsCache.length > 0 ? window.allInstrumentsCache : (window.resourcesCache || []);
            const select = document.getElementById('inp-admin-instrument');
            select.innerHTML = '<option value="" disabled>Seleziona strumento...</option>';
            instruments.forEach(inst => {
                const selected = inst.id === booking.resourceId ? 'selected' : '';
                select.innerHTML += `<option value="${inst.id}" data-desc="${inst.description}" ${selected}>${inst.description} (${inst.id})</option>`;
            });
            if (!instruments.find(i => i.id === booking.resourceId)) {
                select.innerHTML += `<option value="${booking.resourceId}" data-desc="${booking.resourceName || booking.resourceId}" selected>${booking.resourceName || booking.resourceId}</option>`;
            }
            document.getElementById('inp-admin-name').value = booking.userName || '';
            document.getElementById('inp-admin-booking-email').value = booking.email || '';
            // Init time slot pickers for admin
            renderTimeSlots('admin-time-slots-start', 'inp-admin-start', 'start', 'admin');
            renderTimeSlots('admin-time-slots-end', 'inp-admin-end', 'end', 'admin');
            // Pre-select date and times from existing booking
            if (booking.startDate) {
                const [dateStr, startTime] = booking.startDate.split('T');
                document.getElementById('inp-admin-start-date').value = dateStr;
                document.getElementById('inp-admin-start').value = booking.startDate;
                if (startTime) {
                    const startSlotTime = startTime.substring(0, 5);
                    const startBtn = document.querySelector(`#admin-time-slots-start [data-time="${startSlotTime}"]`);
                    if (startBtn) { startBtn.classList.add('bg-indigo-600', 'text-white', 'border-indigo-600'); startBtn.classList.remove('border-slate-200', 'text-slate-600'); }
                }
            }
            if (booking.endDate) {
                const [endDateStr, endTime] = booking.endDate.split('T');
                document.getElementById('inp-admin-end-date').value = endDateStr;
                document.getElementById('inp-admin-end').value = booking.endDate;
                if (endTime) {
                    const endSlotTime = endTime.substring(0, 5);
                    const endBtn = document.querySelector(`#admin-time-slots-end [data-time="${endSlotTime}"]`);
                    if (endBtn) { endBtn.classList.add('bg-indigo-600', 'text-white', 'border-indigo-600'); endBtn.classList.remove('border-slate-200', 'text-slate-600'); }
                }
            }
            document.getElementById('inp-admin-start-date').onchange = () => onDateChange('admin', 'start');
            document.getElementById('inp-admin-end-date').onchange = () => onDateChange('admin', 'end');
            document.getElementById('admin-booking-overlap-warning').classList.add('hidden');
            window._editingAdminBookingId = id;
            document.getElementById('modal-admin-booking').classList.remove('hidden');
            lucide.createIcons();
        };
        window.openEditModal = () => {
            if (window.currentFoundBooking) {
                editBookingFromAdmin(window.currentFoundBooking.id);
            }
        };
        window.showMyBookingSearch = () => {
            document.getElementById('inp-pnr-search').value = '';
            document.getElementById('pnr-result').innerHTML = '';
            window.switchView('view-my-booking');
            setTimeout(() => document.getElementById('inp-pnr-search').focus(), 100);
        };
        window.searchMyBooking = async () => {
            const originalVal = document.getElementById('inp-pnr-search').value;
            const val = originalVal.trim();
            if (!val) return;
            const resEl = document.getElementById('pnr-result');
            const movContainer = document.getElementById('profile-movements-result');
            const movList = document.getElementById('profile-movements-list');

            resEl.innerHTML = '<p class="text-xs text-center text-slate-400">Ricerca in corso...</p>';
            movContainer.classList.add('hidden');
            movList.innerHTML = '';

            try {
                // 1. Search Bookings (by Email or PNR)
                let qBook;
                const isEmailSearch = val.includes('@');

                if (isEmailSearch) {
                    qBook = query(collection(db, 'artifacts', appId, 'public', 'data', 'bookings'), where('email', '==', val.toLowerCase()));
                } else if (val.length === 6) {
                    qBook = query(collection(db, 'artifacts', appId, 'public', 'data', 'bookings'), where('pnr', '==', val.toUpperCase()));
                } else {
                    // Fallback to empty query if it's just a name
                    qBook = null;
                }

                let foundBookings = false;
                if (qBook) {
                    const sBook = await getDocs(qBook);
                    if (!sBook.empty) {
                        foundBookings = true;
                        const bookings = [];
                        sBook.forEach(d => bookings.push({ id: d.id, ...d.data() }));
                        bookings.sort((a, b) => new Date(b.startDate) - new Date(a.startDate));

                        resEl.innerHTML = `<h3 class="text-sm font-bold text-slate-700 border-b pb-2 mb-3"><i data-lucide="calendar" class="inline w-4 h-4"></i> Prenotazioni</h3>` + bookings.map(b => {
                            const isPast = new Date(b.endDate) < new Date();
                            const opacity = isPast ? 'opacity-60' : '';
                            const titleTag = isPast ? `<span class="text-[10px] font-bold px-2 py-1 bg-slate-100 text-slate-500 rounded uppercase tracking-widest">Scaduta</span>` : `<span class="text-[10px] font-bold px-2 py-1 bg-emerald-100 text-emerald-700 rounded uppercase tracking-widest">Attiva</span>`;

                            return `
                            <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm ${opacity} mb-3">
                                <div class="flex justify-between items-start mb-2">
                                    <div>
                                        <span class="text-xs font-black text-slate-800">${b.resourceName}</span>
                                        <div class="text-[10px] text-slate-500 font-mono mt-0.5">PNR: ${b.pnr}</div>
                                    </div>
                                    ${titleTag}
                                </div>
                                <div class="text-[10px] text-slate-600 font-medium mb-3 bg-slate-50 p-2 rounded-lg border border-slate-100">
                                    <div><span class="text-slate-400 w-8 inline-block">Dal:</span> <span class="font-bold">${new Date(b.startDate).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}</span></div>
                                    <div class="mt-1"><span class="text-slate-400 w-8 inline-block">Al:</span> <span class="font-bold">${new Date(b.endDate).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}</span></div>
                                </div>
                                ${!isPast ? `
                                    <div class="flex gap-2">
                                        <button onclick="window.currentFoundBooking = {id:'${b.id}', ...${JSON.stringify(b).replace(/"/g, "&quot;")}}; window.openEditModal()" class="flex-1 py-1.5 bg-indigo-50 border border-indigo-200 text-indigo-700 rounded-lg text-[10px] font-bold shadow-sm hover:bg-indigo-100 transition"><i data-lucide="edit-3" class="w-3 h-3 inline"></i> MODIFICA</button>
                                        <button onclick="deleteBooking('${b.id}', true)" class="flex-1 py-1.5 bg-red-50 border border-red-200 text-red-600 rounded-lg text-[10px] font-bold shadow-sm hover:bg-red-100 transition"><i data-lucide="trash-2" class="w-3 h-3 inline"></i> CANCELLA</button>
                                    </div>
                                ` : ''}
                            </div>
                            `;
                        }).join('');
                    }
                }

                if (!foundBookings) {
                    resEl.innerHTML = "";
                }

                // 2. Search Inventory Movements (By operatorName)
                if (!isEmailSearch && val.length > 2) {
                    const qMov = query(collection(db, 'artifacts', appId, 'public', 'data', 'stock_movements'), where('operatorName', '==', originalVal));
                    const sMov = await getDocs(qMov);

                    if (!sMov.empty) {
                        movContainer.classList.remove('hidden');
                        const moves = [];
                        sMov.forEach(d => moves.push(d.data()));
                        moves.sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));

                        movList.innerHTML = moves.map(m => `
                            <div class="flex flex-col text-xs p-3 bg-white rounded-lg border border-slate-100 mb-2 shadow-sm">
                                <div class="flex justify-between items-center mb-1 border-b pb-1">
                                    <span class="font-bold text-slate-700 truncate mr-2">${m.itemName}</span>
                                    <span class="text-slate-400 text-[9px] whitespace-nowrap">${m.timestamp ? new Date(m.timestamp.seconds * 1000).toLocaleString('it-IT') : ''}</span>
                                </div>
                                <div class="flex justify-between items-center mt-1">
                                    <span class="text-[10px] text-slate-500 font-mono">${m.itemId}</span>
                                    <span class="${m.action === 'add' ? 'text-emerald-600' : 'text-red-600'} font-black px-2 py-0.5 bg-slate-50 rounded">
                                        ${m.action === 'add' ? '+' : '-'}${m.amount} ${m.unit === 'pacco' ? 'pacchi' : (m.unit || '')}
                                    </span>
                                </div>
                            </div>
                        `).join('');
                    }
                }

                if (!foundBookings && movContainer.classList.contains('hidden')) {
                    resEl.innerHTML = "<p class='text-xs text-red-500 font-bold text-center bg-red-50 p-3 rounded-xl border border-red-100'>Nessun risultato trovato con questo termine.</p>";
                }

                if (window.lucide) lucide.createIcons();

            } catch (e) {
                console.error(e);
                resEl.innerHTML = "<p class='text-xs text-red-500 font-bold text-center'>Errore di rete.</p>";
            }
        };

        // --- ADMIN BOOKING MODAL ---
        window.openAdminBookingModal = () => {
            window._editingAdminBookingId = null;
            const instruments = window.allInstrumentsCache.length > 0 ? window.allInstrumentsCache : (window.resourcesCache || []);
            if (instruments.length === 0) return alert('Nessuno strumento disponibile. Aggiungi strumenti prima.');
            const select = document.getElementById('inp-admin-instrument');
            select.innerHTML = '<option value="" disabled selected>Seleziona strumento...</option>';
            instruments.forEach(inst => {
                select.innerHTML += `<option value="${inst.id}" data-desc="${inst.description}">${inst.description} (${inst.id})</option>`;
            });
            document.getElementById('inp-admin-name').value = '';
            document.getElementById('inp-admin-booking-email').value = '';
            document.getElementById('inp-admin-start-date').value = '';
            document.getElementById('inp-admin-end-date').value = '';
            document.getElementById('inp-admin-start').value = '';
            document.getElementById('inp-admin-end').value = '';
            // Init time slot pickers
            renderTimeSlots('admin-time-slots-start', 'inp-admin-start', 'start', 'admin');
            renderTimeSlots('admin-time-slots-end', 'inp-admin-end', 'end', 'admin');
            document.getElementById('inp-admin-start-date').onchange = () => onDateChange('admin', 'start');
            document.getElementById('inp-admin-end-date').onchange = () => onDateChange('admin', 'end');
            document.getElementById('admin-booking-overlap-warning').classList.add('hidden');
            document.getElementById('modal-admin-booking').classList.remove('hidden');
            setTimeout(() => document.getElementById('inp-admin-name').focus(), 100);
            lucide.createIcons();
        };
        window.closeAdminBookingModal = () => {
            document.getElementById('modal-admin-booking').classList.add('hidden');
        };
        window.handleAdminBooking = async (e) => {
            e.preventDefault();
            if (!currentUser) return alert('No connection');
            const select = document.getElementById('inp-admin-instrument');
            const resourceId = select.value;
            const resourceName = select.options[select.selectedIndex].dataset.desc || resourceId;
            const userName = document.getElementById('inp-admin-name').value.trim();
            const email = document.getElementById('inp-admin-booking-email').value.trim();
            const start = document.getElementById('inp-admin-start').value;
            const end = document.getElementById('inp-admin-end').value;
            if (!resourceId || !userName || !start || !end || start.indexOf('T') === -1 || end.indexOf('T') === -1) return alert('Compilare tutti i campi e selezionare data e orari.');
            if (new Date(start) >= new Date(end)) return alert('L\'ora di fine deve essere dopo l\'inizio.');
            try {
                // Overlap check
                const hasOverlap = await checkBookingOverlap(resourceId, start, end, window._editingAdminBookingId);
                if (hasOverlap) {
                    document.getElementById('admin-booking-overlap-warning').classList.remove('hidden');
                    return alert('⚠️ Orario non disponibile! C\'è già una prenotazione in questo intervallo.');
                }
                document.getElementById('admin-booking-overlap-warning').classList.add('hidden');
                let pnr;
                if (window._editingAdminBookingId) {
                    const existingBooking = window.adminBookingsCache.find(b => b.id === window._editingAdminBookingId);
                    pnr = existingBooking?.pnr || Math.random().toString(36).substring(2, 8).toUpperCase();
                    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'bookings', window._editingAdminBookingId), {
                        resourceId, resourceName,
                        userName, email: email || '', startDate: start, endDate: end, updatedAt: serverTimestamp()
                    });
                    logAction('UPDATE', 'ADMIN', `Admin updated booking ${window._editingAdminBookingId} for ${resourceName}.`);
                    alert(`Prenotazione aggiornata! PNR: ${pnr}`);
                } else {
                    pnr = Math.random().toString(36).substring(2, 8).toUpperCase();
                    await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'bookings'), {
                        resourceId, resourceName,
                        userName, email: email || '', startDate: start, endDate: end,
                        pnr, bookedBy: currentUser.uid, createdAt: serverTimestamp()
                    });
                    logAction('CREATE', 'ADMIN', `Admin created booking for ${resourceName}. Time: ${start} - ${end}. PNR: ${pnr}`);
                    alert(`Prenotazione creata! PNR: ${pnr}`);
                }
                if (email) {
                    sendBookingConfirmation(email, userName, resourceName, start, end, pnr);
                }
                window._editingAdminBookingId = null;
                closeAdminBookingModal();
                loadAdminBookings();
            } catch (err) { alert('Errore: ' + err.message); }
        };

        // --- BATCH CART LOGIC ---
        window.toggleBatchMode = () => {
            isBatchMode = !isBatchMode;
            updateBatchUI();
        };

        window.updateBatchUI = () => {
            const lbl = document.getElementById('lbl-batch-mode');
            const cartBtn = document.getElementById('btn-cart');
            const count = document.getElementById('cart-count');

            if (lbl) lbl.innerText = isBatchMode ? 'MULTI' : 'SINGOLO';

            if (isBatchMode && batchCart.length > 0) {
                cartBtn.style.display = 'flex';
                count.innerText = batchCart.length;
            } else {
                cartBtn.style.display = 'none';
            }

            if (!isBatchMode && batchCart.length > 0) {
                if (confirm('Attenzione: il carrello contiene articoli. Svuotare il carrello per tornare alla modalità singola?')) {
                    batchCart = [];
                    updateBatchUI();
                } else {
                    isBatchMode = true;
                    if (lbl) lbl.innerText = 'MULTI';
                }
            }
        };

        window.showBatchCart = () => {
            document.getElementById('view-scanner').classList.add('hidden');
            importBatchItemsHTML();
            window.switchView('view-batch-summary');
            setTimeout(() => document.getElementById('inp-batch-operator').focus(), 100);
        };

        function importBatchItemsHTML() {
            const container = document.getElementById('batch-items-container');
            if (batchCart.length === 0) {
                container.innerHTML = '<p class="text-xs text-center text-slate-400">Carrello vuoto.</p>';
                return;
            }
            container.innerHTML = batchCart.map((i, idx) => `
                <div class="flex justify-between items-center bg-white border border-slate-200 p-3 rounded-xl shadow-sm">
                    <div class="flex-1">
                        <div class="text-xs font-bold text-slate-800 break-all">${i.name}</div>
                        <div class="text-[10px] text-slate-500 font-mono">${i.id || ''}</div>
                    </div>
                    <div class="flex items-center gap-2">
                        <input type="number" step="0.01" min="0.01" value="${i.qtyToAdd}" onchange="updateBatchQty(${idx}, this.value)" class="w-16 px-2 py-1 text-center font-mono font-bold border border-slate-300 rounded focus:ring-2 focus:ring-emerald-500 text-xs">
                        <span class="text-[10px] text-slate-500 w-8">${i.unit || 'pz'}</span>
                        <button type="button" onclick="removeBatchItem(${idx})" class="text-red-500 p-1 hover:bg-red-50 rounded"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                    </div>
                </div>
            `).join('');
            if (window.lucide) lucide.createIcons();
        }

        window.updateBatchQty = (idx, val) => {
            const num = parseFloat(val);
            if (num > 0) batchCart[idx].qtyToAdd = num;
        };

        window.removeBatchItem = (idx) => {
            batchCart.splice(idx, 1);
            importBatchItemsHTML();
            updateBatchUI();
            if (batchCart.length === 0) resetApp();
        };

        window.clearBatchCart = () => {
            if (confirm("Svuotare il carrello?")) {
                batchCart = [];
                resetApp();
            }
        };

        window.toggleBatchRemoveOrder = () => {
            const action = document.querySelector('input[name="batch-action"]:checked').value;
            const div = document.getElementById('div-batch-remove-order');
            if (action === 'add') div.style.display = 'flex';
            else div.style.display = 'none';
        };

        window.confirmBatchMovement = async (e) => {
            e.preventDefault();
            if (batchCart.length === 0) return alert("Carrello vuoto.");
            const action = document.querySelector('input[name="batch-action"]:checked').value;
            const operator = document.getElementById('inp-batch-operator').value.trim();
            const removeOrder = document.getElementById('inp-batch-remove-order').checked;

            if (!operator) return alert("Inserire Operatore.");

            try {
                const toast = document.createElement('div');
                toast.id = 'batch-loading-toast';
                toast.className = 'fixed inset-0 bg-slate-900/50 flex items-center justify-center z-[500] backdrop-blur-sm';
                toast.innerHTML = '<div class="bg-white p-6 rounded-2xl shadow-2xl flex flex-col items-center"><div class="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mb-3"></div><p class="font-bold text-slate-700">Salvataggio in batch...</p></div>';
                document.body.appendChild(toast);

                await runTransaction(db, async (t) => {
                    const docRefs = batchCart.map(item => doc(db, 'artifacts', appId, 'public', 'data', 'inventory', item.id.replace(/\//g, '_')));
                    const docsSnap = [];
                    for (let ref of docRefs) {
                        const snap = await t.get(ref);
                        if (!snap.exists()) throw `Articolo ${ref.id} non trovato.`;
                        docsSnap.push(snap);
                    }

                    batchCart.forEach((item, index) => {
                        const snap = docsSnap[index];
                        const d = snap.data();
                        let currentQty = parseFloat(d.quantity || 0);
                        let finalQty = currentQty;
                        let updates = {};

                        if (action === 'add') {
                            finalQty += item.qtyToAdd;
                            if (removeOrder && d.isOrdered) {
                                updates.isOrdered = false;
                                updates.orderBy = null;
                                updates.orderDate = null;
                            }
                        } else {
                            if (currentQty < item.qtyToAdd) throw `Scorte insufficienti per ${d.name}! Disp: ${currentQty}`;
                            finalQty -= item.qtyToAdd;
                        }

                        updates.quantity = finalQty;
                        t.update(snap.ref, updates);

                        const moveRef = doc(collection(db, 'artifacts', appId, 'public', 'data', 'stock_movements'));
                        t.set(moveRef, {
                            itemId: item.id,
                            itemName: d.name,
                            action: action,
                            amount: item.qtyToAdd,
                            unit: d.unit || 'pz',
                            user: currentUser.uid,
                            operatorName: operator,
                            timestamp: serverTimestamp(),
                            isBatch: true
                        });
                    });
                });

                document.getElementById('batch-loading-toast')?.remove();
                alert(`${batchCart.length} movimenti processati con successo!`);
                logAction('UPDATE', 'INVENTORY', `Batch ${action} completed for ${batchCart.length} items. Operator: ${operator}`);

                // --- CHECK LOW STOCK FOR EMAILS IN BATCH ---
                if (action === 'remove') {
                    for (let item of batchCart) {
                        const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'inventory', item.id.replace(/\//g, '_')));
                        if (snap.exists()) {
                            checkAndSendRestockEmail(snap.data());
                        }
                    }
                }

                batchCart = [];
                resetApp();
            } catch (err) {
                document.getElementById('batch-loading-toast')?.remove();
                alert("Errore Transazione: " + err);
            }
        };

        // --- CO-ADMIN EMAIL MANAGEMENT ---
        async function loadAdminEmails() {
            try {
                const adminSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'admins'));
                const emails = adminSnap.exists() ? (adminSnap.data().emails || []) : [];
                const container = document.getElementById('admin-list-emails');
                if (emails.length === 0) {
                    container.innerHTML = '<p class="text-xs text-slate-400">Nessun co-admin configurato.</p>';
                } else {
                    container.innerHTML = emails.map(em => `
                        <div class="flex justify-between items-center bg-white p-2 rounded border border-indigo-100">
                            <span class="text-xs font-mono text-slate-700">${em}</span>
                            <button onclick="removeAdminEmail('${em}')" class="text-red-500 text-xs font-bold px-2 py-1 hover:bg-red-50 rounded">✕</button>
                        </div>
                    `).join('');
                }
                const defaultInfo = '<p class="text-[10px] text-indigo-400 mt-2">Main Admin: vono.niccolo@gmail.com</p>';
                container.innerHTML += defaultInfo;
            } catch (e) { console.warn('Load admin emails failed:', e); }
        }
        window.addAdminEmail = async () => {
            const emailInput = document.getElementById('inp-new-admin-email');
            const newEmail = emailInput.value.trim().toLowerCase();
            if (!newEmail || !newEmail.includes('@')) return alert('Email non valida.');
            try {
                const adminRef = doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'admins');
                const adminSnap = await getDoc(adminRef);
                const emails = adminSnap.exists() ? (adminSnap.data().emails || []) : [];
                if (emails.includes(newEmail)) return alert('Email già presente.');
                emails.push(newEmail);
                await setDoc(adminRef, { emails }, { merge: true });
                emailInput.value = '';
                loadAdminEmails();
                logAction('UPDATE', 'SETTINGS', `Co-Admin added: ${newEmail}`);
                alert(`${newEmail} aggiunto come co-amministratore.`);
            } catch (e) { alert('Errore: ' + e.message); }
        };
        window.removeAdminEmail = async (emailToRemove) => {
            if (!confirm(`Rimuovere ${emailToRemove} dai co-amministratori?`)) return;
            try {
                const adminRef = doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'admins');
                const adminSnap = await getDoc(adminRef);
                const emails = adminSnap.exists() ? (adminSnap.data().emails || []) : [];
                const updated = emails.filter(em => em !== emailToRemove);
                await setDoc(adminRef, { emails: updated });
                loadAdminEmails();
                logAction('UPDATE', 'SETTINGS', `Co-Admin removed: ${emailToRemove}`);
            } catch (e) { alert('Errore: ' + e.message); }
        };

        // --- ACCESS CONTROL MANAGEMENT ---
        async function loadAccessSettings() {
            try {
                const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'access');
                const snap = await getDoc(docRef);
                const data = snap.exists() ? snap.data() : { restrictedMode: false, allowedUsers: [] };
                
                document.getElementById('inp-access-restricted').checked = data.restrictedMode === true;
                
                const users = data.allowedUsers || [];
                const container = document.getElementById('access-allowed-list');
                if (users.length === 0) {
                    container.innerHTML = '<p class="text-xs text-slate-400">Nessun utente nella lista. Se attivi la restrizione, tutti i normali account saranno bloccati.</p>';
                } else {
                    container.innerHTML = users.map(u => `
                        <div class="flex justify-between items-center bg-white p-2 rounded border border-rose-100 mb-1">
                            <span class="text-xs font-mono text-rose-900">${u}</span>
                            <button onclick="removeAllowedEmail('${u}')" class="text-red-500 text-xs font-bold px-2 py-1 hover:bg-red-50 rounded">✕</button>
                        </div>
                    `).join('');
                }
            } catch (e) {
                console.warn('Load access settings failed', e);
            }
        }

        window.saveAccessSettings = async () => {
            const isRestricted = document.getElementById('inp-access-restricted').checked;
            try {
                const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'access');
                await setDoc(docRef, { restrictedMode: isRestricted }, { merge: true });
                logAction('UPDATE', 'SETTINGS', `Restricted mode set to: ${isRestricted}`);
                alert("Opzioni di accesso salvate correttamente.");
            } catch (e) { alert('Errore: ' + e.message); }
        };

        window.addAllowedEmail = async () => {
            const emailInput = document.getElementById('inp-new-allowed-email');
            const newEmail = emailInput.value.trim().toLowerCase();
            if (!newEmail || !newEmail.includes('@')) return alert('Email non valida.');
            try {
                const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'access');
                const snap = await getDoc(docRef);
                const data = snap.exists() ? snap.data() : { allowedUsers: [] };
                const users = data.allowedUsers || [];
                
                if (users.includes(newEmail)) return alert('Email già presente.');
                users.push(newEmail);
                
                await setDoc(docRef, { allowedUsers: users }, { merge: true });
                emailInput.value = '';
                loadAccessSettings();
                logAction('UPDATE', 'SETTINGS', `Allowed user added: ${newEmail}`);
                alert(`${newEmail} aggiunto alla lista consentita.`);
            } catch (e) { alert('Errore: ' + e.message); }
        };

        window.removeAllowedEmail = async (emailToRemove) => {
            if (!confirm(`Rimuovere ${emailToRemove} dalla lista consentita?`)) return;
            try {
                const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'access');
                const snap = await getDoc(docRef);
                const data = snap.exists() ? snap.data() : { allowedUsers: [] };
                const users = data.allowedUsers || [];
                
                const updated = users.filter(u => u !== emailToRemove);
                await setDoc(docRef, { allowedUsers: updated }, { merge: true });
                
                loadAccessSettings();
                logAction('UPDATE', 'SETTINGS', `Allowed user removed: ${emailToRemove}`);
            } catch (e) { alert('Errore: ' + e.message); }
        };

        // --- SUPERVISOR MANAGEMENT ---
        async function loadSupervisors() {
            try {
                const supSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'supervisors'));
                const sups = supSnap.exists() ? (supSnap.data().list || []) : [];
                const container = document.getElementById('supervisor-list');
                if (sups.length === 0) {
                    container.innerHTML = '<p class="text-xs text-slate-400">Nessun supervisore configurato.</p>';
                } else {
                    container.innerHTML = sups.map(s => {
                        const perms = [];
                        if (s.permissions.bookings) perms.push('Prenotazioni');
                        if (s.permissions.inventory) perms.push('Magazzino');
                        if (s.permissions.instruments) perms.push('Strumenti');
                        if (s.permissions.logs) perms.push('Logs');
                        return `
                        <div class="flex justify-between items-start bg-white p-2 rounded border border-emerald-100">
                            <div>
                                <div class="text-xs font-mono text-slate-700 font-bold">${s.email}</div>
                                <div class="text-[9px] text-emerald-600">${perms.join(', ') || 'Nessun Permesso'}</div>
                            </div>
                            <button onclick="removeSupervisor('${s.email}')" class="text-red-500 text-xs font-bold px-2 py-1 hover:bg-red-50 rounded">✕</button>
                        </div>
                        `;
                    }).join('');
                }
            } catch (e) { console.warn('Load supervisors failed:', e); }
        }

        window.addSupervisor = async () => {
            const email = document.getElementById('inp-new-sup-email').value.trim().toLowerCase();
            if (!email || !email.includes('@')) return alert('Email non valida.');
            const perms = {
                bookings: document.getElementById('chk-sup-book').checked,
                inventory: document.getElementById('chk-sup-inv').checked,
                instruments: document.getElementById('chk-sup-inst').checked,
                logs: document.getElementById('chk-sup-logs').checked
            };
            try {
                const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'supervisors');
                const snap = await getDoc(docRef);
                const list = snap.exists() ? (snap.data().list || []) : [];
                const existingIdx = list.findIndex(s => s.email === email);
                if (existingIdx >= 0) {
                    list[existingIdx].permissions = perms;
                } else {
                    list.push({ email, permissions: perms });
                }
                await setDoc(docRef, { list }, { merge: true });
                document.getElementById('inp-new-sup-email').value = '';
                loadSupervisors();
                logAction('UPDATE', 'SETTINGS', `Supervisor added/updated: ${email}`);
                alert(`${email} salvato come Supervisore.`);
            } catch (e) { alert('Errore: ' + e.message); }
        }

        window.removeSupervisor = async (emailToRemove) => {
            if (!confirm(`Rimuovere ${emailToRemove} dai supervisori?`)) return;
            try {
                const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'supervisors');
                const snap = await getDoc(docRef);
                let list = snap.exists() ? (snap.data().list || []) : [];
                list = list.filter(s => s.email !== emailToRemove);
                await setDoc(docRef, { list });
                loadSupervisors();
                logAction('UPDATE', 'SETTINGS', `Supervisor removed: ${emailToRemove}`);
            } catch (e) { alert('Errore: ' + e.message); }
        }

        // --- BOOKING CONFIRMATION EMAIL ---
        function buildGoogleCalendarUrl(title, startStr, endStr, description) {
            // Convert datetime-local string "YYYY-MM-DDTHH:MM" to "YYYYMMDDTHHmmSS"
            const fmt = (s) => s.replace(/[-:]/g, '').replace('T', 'T') + '00';
            const params = new URLSearchParams({
                action: 'TEMPLATE',
                text: title,
                dates: `${fmt(startStr)}/${fmt(endStr)}`,
                details: description
            });
            return `https://calendar.google.com/calendar/render?${params.toString()}`;
        }

        async function sendBookingConfirmation(toEmail, userName, instrumentName, startDate, endDate, pnr) {
            const startFormatted = new Date(startDate).toLocaleString('it-IT', { dateStyle: 'full', timeStyle: 'short' });
            const endFormatted = new Date(endDate).toLocaleString('it-IT', { dateStyle: 'full', timeStyle: 'short' });
            const appUrl = window.location.href.split('?')[0];

            const calendarUrl = buildGoogleCalendarUrl(
                `Prenotazione: ${instrumentName}`,
                startDate, endDate,
                `Prenotazione UniScan Lab\nStrumento: ${instrumentName}\nPNR: ${pnr}\nGestisci: ${appUrl}`
            );

            try {
                await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_BOOKING_CONFIRM_TEMPLATE_ID, {
                    to_email: toEmail,
                    user_name: userName,
                    instrument_name: instrumentName,
                    start_date: startFormatted,
                    end_date: endFormatted,
                    pnr: pnr,
                    calendar_url: calendarUrl,
                    app_url: appUrl,
                    from_name: 'UniScan Lab'
                });
                console.log('Booking confirmation sent to', toEmail);
                logAction('EMAIL', 'SYSTEM', `Booking confirmation sent to ${toEmail} for ${instrumentName} (${pnr})`);
            } catch (err) { console.warn('Booking confirmation email failed:', err); }
        }



        // --- ADMIN LOGS ---
        window.loadAdminLogs = () => {
            const listEl = document.getElementById('admin-logs-list');
            listEl.innerHTML = '<p class="text-center text-xs text-slate-400">Caricamento log...</p>';

            // Limit to last 50 logs for performance
            const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'logs'), orderBy('timestamp', 'desc')); // Limited by UI scroll mostly, but could add limit(50)

            // Standard snapshot listener for realtime updates
            onSnapshot(q, (snapshot) => {
                const logs = [];
                snapshot.forEach(doc => logs.push({ id: doc.id, ...doc.data() }));
                window.allLogsCache = logs;

                if (logs.length === 0) {
                    listEl.innerHTML = '<p class="text-center text-xs text-slate-400">Nessun log presente.</p>';
                    return;
                }

                listEl.innerHTML = logs.slice(0, 100).map(l => {
                    let color = 'bg-slate-100 text-slate-600';
                    if (l.category === 'BOOKING') color = 'bg-indigo-50 text-indigo-600';
                    if (l.category === 'INVENTORY') color = 'bg-emerald-50 text-emerald-600';
                    if (l.category === 'ADMIN') color = 'bg-amber-50 text-amber-600';
                    if (l.category === 'SYSTEM') color = 'bg-purple-50 text-purple-600';
                    if (l.category === 'AUTH') color = 'bg-blue-50 text-blue-600';

                    const dateStr = l.timestamp ? new Date(l.timestamp.seconds * 1000).toLocaleString('it-IT') : '---';

                    return `
                     <div class="p-2 border-l-4 border-slate-300 bg-white shadow-sm mb-1 text-[10px] md:text-xs">
                         <div class="flex justify-between items-center mb-1">
                             <span class="font-bold px-1.5 py-0.5 rounded ${color} text-[9px] uppercase tracking-wider">${l.category}</span>
                             <span class="text-slate-400 text-[9px]">${dateStr}</span>
                         </div>
                         <div class="font-bold text-slate-700 mb-0.5">${l.action}</div>
                         <div class="text-slate-500 break-words">${l.details}</div>
                         <div class="text-[9px] text-slate-400 mt-1 italic text-right">User: ${l.userEmail || l.userId || 'System'}</div>
                     </div>`;
                }).join('');
            });
        };

        window.downloadLogsTXT = () => {
            if (!window.allLogsCache || window.allLogsCache.length === 0) return alert("Nessun log da scaricare.");

            const lines = window.allLogsCache.map(l => {
                const dateStr = l.timestamp ? new Date(l.timestamp.seconds * 1000).toLocaleString('it-IT') : '---';
                return `[${dateStr}] [${l.category}] ${l.action} - ${l.details} (User: ${l.userEmail || l.userId})`;
            });

            const content = lines.join('\\n');
            const blob = new Blob([content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `uniscan_logs_${new Date().toISOString().slice(0, 10)}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        };

        window.downloadLogsCSV = () => {
            if (!window.allLogsCache || window.allLogsCache.length === 0) return alert("Nessun log da scaricare.");

            const headers = ["Data", "Categoria", "Azione", "Dettagli", "Utente"];
            const rows = window.allLogsCache.map(l => {
                const dateStr = l.timestamp ? new Date(l.timestamp.seconds * 1000).toLocaleString('it-IT') : '---';
                return [
                    `"${dateStr}"`,
                    `"${l.category || ''}"`,
                    `"${(l.action || '').replace(/"/g, '""')}"`,
                    `"${(l.details || '').replace(/"/g, '""')}"`,
                    `"${(l.userEmail || l.userId || 'System').replace(/"/g, '""')}"`
                ];
            });

            const csvContent = "\uFEFF" + headers.join(",") + "\n" + rows.map(e => e.join(",")).join("\n");
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `uniscan_logs_${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        };

        // --- CSV EXPORT UPDATE (include restockEmail and safety quotes) ---
        const _origExportCSV = window.exportInventoryCSV;
        window.exportInventoryCSV = () => {
            if (window.allInventoryCache.length === 0) return alert("Nessun dato.");
            const headers = ["ID", "Nome", "Marchio", "Categoria", "Unita", "Quantita", "Pezzi_Pacco", "Soglia", "Posizione", "Immagine", "Email_Riordino"];
            const rows = window.allInventoryCache.map(i => [
                `"${(i.id || '').replace(/"/g, '""')}"`,
                `"${(i.name || '').replace(/"/g, '""')}"`,
                `"${(i.brand || '').replace(/"/g, '""')}"`,
                `"${(i.category || '').replace(/"/g, '""')}"`,
                `"${(i.unit || '').replace(/"/g, '""')}"`,
                i.quantity || 0,
                i.packSize || 1,
                i.threshold || 0,
                `"${(i.location || '').replace(/"/g, '""')}"`,
                `"${(i.image || '').replace(/"/g, '""')}"`,
                `"${(i.restockEmail || '').replace(/"/g, '""')}"`
            ]);

            const csvContent = "\uFEFF" + headers.join(",") + "\n" + rows.map(e => e.join(",")).join("\n");
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `inventory_${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        };

        // --- GLOBAL LISTENERS & UTILS ---
        window.exitTotemMode = () => {
            const url = new URL(window.location);
            url.searchParams.delete('mode');
            window.history.pushState({}, '', url);
            window.location.reload();
        };

        // Auto-focus scanner input
        document.addEventListener('keydown', (e) => {
            // Only if Scanner View is active
            if (document.getElementById('view-scanner').classList.contains('hidden')) return;

            // Ignore if already typing in an input
            const tag = e.target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;

            // Ignore control keys
            if (e.ctrlKey || e.altKey || e.metaKey) return;
            if (e.key.length > 1) return; // Ignore Enter, Esc, F1, etc (except maybe we want them? usually scanners send chars then Enter)

            // Focus the input
            const input = document.getElementById('inp-manual-code');
            input.focus();
        });

        lucide.createIcons();
    </script>
