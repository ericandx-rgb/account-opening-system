import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyByX5qBF6Z5jr6yD70WaqlJEfaSjyoAP1s",
  authDomain: "account-opening-system-eirik.firebaseapp.com",
  projectId: "account-opening-system-eirik",
  storageBucket: "account-opening-system-eirik.firebasestorage.app",
  messagingSenderId: "299885772489",
  appId: "1:299885772489:web:ca93045b5181e0789f9718"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();
export const db = getFirestore(app);