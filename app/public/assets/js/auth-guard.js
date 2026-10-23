import { auth } from './firebase-config.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

export function requireAuth(callback) {
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      sessionStorage.setItem('redirectAfterAuth', window.location.pathname);
      window.location.href = '/auth/';
    } else {
      callback(user);
    }
  });
}
