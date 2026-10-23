# Changelog

All notable changes to Learnkins Room are documented here.

---

## [1.1.0] — 2026-10-23

### Added
- **Live collaborative editing** — files are Yjs CRDT documents synced over Firestore: simultaneous typing, coloured remote cursors with names, per-user undo, "live · N editing" indicator, and a reset-to-saved action.
- **Voice rooms** — WebRTC audio mesh with Firestore signalling; join/leave, mute (`Ctrl+Shift+M`), deafen, speaking indicators, optional TURN (`TURN_URL`…).
- **Automatic GitHub push** — per-room repo/branch/folder/token settings; merged PRs, admin saves, renames and deletes become commits (single commit per change via the Git Data API, retries if the branch moved). "Test connection" and "Push all files now" actions. Commit links posted to chat.
- **PR diff view** with line numbers, and **AI review** of the diff.
- **Run code** in the browser — JavaScript (Web Worker with time limit), Python (Pyodide), HTML preview.
- **Presence** — online dots and "editing <file>" per member; realtime member/role updates; desktop notification on @mention.
- **Room settings** modal (name, description, GitHub) and room deletion.
- System messages for joins/leaves and GitHub pushes.
- `firestore.rules`, `storage.rules`, `cors.json`, `firebase.json`, and a `node:test` suite (`npm test`).

### Fixed
- `@ai` replies were written by the browser as `uid: "ai"`, which the documented Firestore rules reject — the server now posts them.
- Admin "Save" showed "Saved directly" but only created a pending PR; admin saves now merge (and push) immediately.
- Older messages loaded in reverse order when scrolling up, and messages vanished from view as new ones arrived (query window "removed" events were treated as deletions).
- Stored XSS: AI/`textHtml` messages, attachment URLs and display names could inject script; all rendered HTML is now sanitized (DOMPurify) and URLs restricted to http(s).
- SSRF: `/api/ai/chat` fetched any attachment URL; it now only reads this project's storage bucket.
- Any signed-in user could delete any object in the storage bucket, upload into any room, or write typing/editor state for rooms they weren't in — all routes now check membership and role.
- Viewers could submit PRs; viewer role is now enforced server-side and the editor is read-only for them.
- AI routes crashed when `GEMINI_API_KEY` was missing; routes without Firebase crashed instead of returning 503.
- PRs could be approved twice; approval is now transactional. Editing a deleted file or creating a duplicate file name is rejected.
- Removing a member failed if they had no user document; deleting a room left its subcollections behind.
- Uploaded files are now readable via Firebase download tokens, so attachments work with locked-down storage rules.
- PR emails escaped user content, are skipped when mail isn't configured, and use the request origin when `APP_URL` is unset.
- Typing indicator: throttled pings and stale entries from closed tabs are ignored.
- Duplicate `#pr-btn` id, missing sidebar icon, wrong module import in `assets/js/helpers.js`, corrupted `.gitignore` lines, and the unauthenticated `/api/debug` endpoint (removed).

---

## [1.0.0] — 2026-03-06

Initial release.

---

### Added

**Authentication**
- Google OAuth sign-in via Firebase Authentication
- Auto user profile creation in Firestore on first login
- Auth guard on all pages — unauthenticated users redirected to sign-in
- Firebase ID token verification on every API request server-side

**Rooms**
- Create rooms with name, optional description, and optional GitHub repo link
- Join rooms via 6-character invite code
- Shareable invite link with `?join=CODE` URL parameter
- Admin can regenerate invite codes
- Room list in lobby showing member count and user role
- Role system — admin, member, viewer

**Chat**
- Real-time messaging via Firestore `onSnapshot`
- Reply to any message with inline quote preview
- Edit own messages (shows edited tag)
- Soft delete messages — marked deleted, text cleared, not wiped from history
- `@mention` autocomplete dropdown for all room members
- `@ai` mention triggers an AI response posted visibly in the chat
- Typing indicators — real-time, debounced, per user
- Auto code block detection — fenced backtick blocks render with syntax highlighting and a copy button
- Inline code rendering with backticks
- Bold and italic markdown formatting
- User-typed HTML is safely escaped — no XSS
- Message timestamps

**Code Editor**
- CodeMirror 5 editor with Dracula theme (dark) and default theme (light)
- VS Code-style layout with file explorer sidebar
- File tree showing all committed room files with language icons
- Create new files — auto-detects language from extension
- Edit existing files — loads content into editor
- Admin can delete files directly
- `Ctrl+S` / `Cmd+S` submits a pull request
- Language selector with support for JavaScript, Python, HTML, CSS, Java, C, C++
- Copy code button in toolbar

**Pull Request System**
- File creation and edits by non-admins go as pending pull requests
- Admin PR panel with pending count badge
- Approve or reject PRs — approval commits the file to the room's file tree
- PR list shows submitter name, file name, type (create or edit), status, and timestamp
- File tree refreshes automatically after PR approval

**Personal AI Panel**
- Private AI assistant — not visible to other room members
- Streaming responses via Server-Sent Events — types out in real time
- Conversation history — last 10 messages sent as context to Gemini
- Typing animation while waiting for stream to start
- Blinking cursor during stream
- Code blocks in responses syntax highlighted after stream completes
- Clear chat button
- Non-stream fallback endpoint

**AI Backend**
- All AI calls go through the server — Gemini API key never exposed to client
- `@ai` group chat route returns `reply` (raw) and `replyHtml` (parsed markdown)
- Streaming route uses `generateContentStream` and pipes SSE chunks
- Markdown parsed server-side with `marked.js`
- Short code snippet verdict route for quick reviews

**Members & Admin**
- Members sidebar with role badges
- Right-click or tap member to open context menu
- Admin can change member roles
- Admin can remove members
- Members can leave a room themselves

**UI**
- Dark and light theme with localStorage persistence — no flash on load
- Three resizable panels — Chat, Code Editor, Personal AI
- Drag handles between panels to resize
- Collapse and expand any panel from the tab bar
- GSAP animations on page load and transitions
- Cursor glow effect
- Toast notifications for all actions
- Page loader with status messages
- JetBrains Mono font throughout
- Responsive sidebar with collapse toggle

**Backend**
- Single `index.js` Express server
- Firebase Admin SDK for server-side auth and Firestore writes
- All routes protected with `verifyToken` middleware
- `marked.js` for server-side markdown parsing
- Soft delete on messages
- Signed URL generation for Firebase Storage uploads
- Debug endpoint at `/api/debug`
- SPA fallback route for client-side navigation

---

### Technical Notes

- Migrated from PHP + Socket.io architecture to Node.js + Firestore
- No build step on the frontend — plain HTML with CDN libraries
- Firestore used for all real-time features — no WebSocket server needed
- Admin SDK bypasses Firestore security rules for all server writes
- SSE streaming requires Nginx `proxy_buffering off` to work correctly

---

## [1.0.1] — 2026-03-06

### Fixed

**Pull Request Emails**
- `fileName is not defined` error in `POST /api/rooms/:roomId/files` — now correctly reads `fileName` from `req.body` before use
- `fileName is not defined` error in `PATCH /api/rooms/:roomId/files/:fileId` — now extracted from Firestore (`fileSnap.data().fileName`) before the PR document is written
- Email block in both routes was referencing `fileSnap` which didn't exist in the POST route
- PR email failures no longer block the API response — emails are now sent after `res.json()` using `.catch()`

**Email / SMTP**
- Switched from inline Gmail transport to configurable SMTP via environment variables (`MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, `MAIL_USER`, `MAIL_PASS`, `MAIL_FROM`)
- Fixed SSL wrong version number error — `MAIL_SECURE=false` on port 587 now correctly uses STARTTLS instead of raw SSL
- Added `tls.rejectUnauthorized: false` option for shared hosting with self-signed certificates

**Real-time Updates**
- File tree and PR panel no longer require a page refresh to reflect changes
- Replaced one-time `loadFiles()` and `loadPRs()` calls with persistent Firestore `onSnapshot` listeners (`subscribeFiles`, `subscribePRs`)
- Editor content now auto-syncs when an admin approves a PR for the currently open file (only if editor has no unsaved changes)
- `unsubFiles` and `unsubPRs` listeners are properly torn down on sign out

### Refactored

- Extracted duplicate PR email logic from both file routes into a shared `notifyAdmins()` helper
- Added `editorDirty` flag to prevent live PR-approval sync from overwriting unsaved editor content
