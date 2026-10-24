import { auth } from './firebase-config.js';

// Get Firebase ID token for API calls
export async function getToken() {
  const user = auth.currentUser;
  if (!user) return null;
  return await user.getIdToken();
}

// Authenticated fetch wrapper
export async function apiFetch(url, options = {}) {
  const token = await getToken();
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...options.headers
    }
  }).then(r => r.json());
}

// Show toast notification
export function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  document.getElementById('toast-msg').textContent = msg;
  toast.className = `show ${type}`;
  setTimeout(() => toast.classList.remove('show'), 3500);
}

// Format timestamp
export function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Generate avatar initials fallback
export function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}