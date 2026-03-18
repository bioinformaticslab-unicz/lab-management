// firebase.js — LABSCAN Beta
// Central Firebase initialization — all other modules import from here.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, GoogleAuthProvider } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

export const FIREBASE_CONFIG = {
    apiKey: "AIzaSyAWbSxLJcDbB0bvd4HoMii3Z5CavR8vR-I",
    authDomain: "unisca-lab.firebaseapp.com",
    projectId: "unisca-lab",
    storageBucket: "unisca-lab.firebasestorage.app",
    messagingSenderId: "775803411857",
    appId: "1:775803411857:web:1a24be42a1c70482ad8e30",
    measurementId: "G-3ECHHPDZJZ"
};

export const APP_ID = 'unisca-lab-v1';

const firebaseApp = initializeApp(FIREBASE_CONFIG);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
export const googleProvider = new GoogleAuthProvider();

// Helper: Firestore collection path
export const col = (...segments) => ['artifacts', APP_ID, 'public', 'data', ...segments].join('/');
