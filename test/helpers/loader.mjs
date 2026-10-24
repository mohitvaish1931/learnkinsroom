// Maps the Firestore CDN module used by the browser code onto an in-memory fake.
const FIRESTORE_URL = 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

export async function resolve(specifier, context, next) {
  if (specifier === FIRESTORE_URL) {
    return { url: new URL('./fake-firestore.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
