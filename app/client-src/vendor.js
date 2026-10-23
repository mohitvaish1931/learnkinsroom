// Browser bundle of the collaboration/sanitization libraries.
// Rebuild with `npm run build:vendor` after bumping any of these packages.
export * as Y from 'yjs';
export * as awarenessProtocol from 'y-protocols/awareness';
export { CodemirrorBinding } from 'y-codemirror';
export { default as DOMPurify } from 'dompurify';
