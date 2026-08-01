# Learnkins Room

Learnkins Room is a real-time collaborative coding platform built for developer teams. It combines group chat, a shared code editor, a pull request workflow, and an AI coding assistant into a single browser-based workspace. Rooms are the core unit — each room has its own chat history, file tree, members, and settings.

> See [INSTALLATION.md](./INSTALLATION.md) for setup instructions.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [File Structure](#file-structure)
- [Pages](#pages)
- [Backend](#backend)
- [Database Structure](#database-structure)
- [AI Integration](#ai-integration)
- [Authentication & Authorization](#authentication--authorization)
- [Pull Request Workflow](#pull-request-workflow)
- [Typing Indicators](#typing-indicators)
- [Tech Stack](#tech-stack)
- [Environment Variables](#environment-variables)
- [Roadmap](#roadmap)
- [Known Limitations](#known-limitations)

---

## How It Works

A user signs in with Google OAuth. They land on the Lobby where they can create a new room or join one using a 6-character invite code. Once inside a room, they have three panels available — Chat, Code Editor, and Personal AI — all resizable and collapsible.

Everything in the chat is real-time via Firestore `onSnapshot` listeners. Messages are written directly to Firestore from the client. The server handles auth verification, room management, AI calls, and the pull request workflow.

The code editor lets members write and save files. Any file creation or edit by a non-admin is submitted as a Pull Request. Admins review and approve or reject PRs from a side panel. On approval, the file is committed into the room's file collection in Firestore.

The AI assistant works in two modes — group mode via `@ai` in chat, and private mode in the Personal AI panel with full streaming via Server-Sent Events.

---

## Architecture

```
Browser (HTML + Tailwind + Firebase JS SDK)
        |
        |--- Firestore (onSnapshot) -----> real-time messages, typing, file tree
        |
        |--- REST API (Express) ---------> auth, rooms, members, files, PRs, AI
                |
                |--- Firebase Admin SDK --> token verification, Firestore writes
                |--- Google Gemini API ---> AI responses (stream + non-stream)
                |--- marked.js -----------> markdown to HTML (server-side)
```

The client never calls Gemini directly. All AI requests go through the Express server, which holds the API key securely in `.env`. The server also parses AI markdown responses into HTML before sending to the client, so the frontend just renders it.

Firebase Client SDK is used only for:
- Google sign-in
- `onSnapshot` listeners for real-time chat and typing
- Reading auth state (`onAuthStateChanged`)

Everything else — room creation, joining, member management, file operations, PRs — goes through the Express REST API with a verified Firebase ID token in the `Authorization` header.

---

## File Structure

```
/                               server root (on host)
├── index.js                    Express server — all API routes, AI, Firebase Admin
├── service-account.json        Firebase Admin credentials (never commit this)
├── package.json
├── yarn.lock
├── .env                        all secrets and config
├── .htaccess                   Apache/Nginx rewrite rules if applicable
├── node_modules/
└── public/                     static frontend files served by Express
    ├── index.html              landing page
    ├── auth/
    │   └── index.html          Google OAuth sign-in page
    ├── lobby/
    │   └── index.html          room list, create room, join room
    └── chat/
        └── index.html          main room workspace (chat + editor + AI)
```

Notable points about this structure:
- The entire backend lives in a single `index.js` file at the root
- `public/` is served statically by Express via `express.static`
- `service-account.json` sits at root alongside `index.js` — it is required by Firebase Admin and must be gitignored
- There is no build step — all frontend files are plain HTML with CDN-loaded libraries

---

## Pages

### `/auth/`
Handles Google sign-in using Firebase Authentication. On successful sign-in, saves the user profile to Firestore via `POST /api/auth/profile` and redirects to `/lobby/`. If already signed in, redirects immediately.

### `/lobby/`
The home screen after login. Shows all rooms the user is a member of, with their role and member count. Two tabs: Create Room and Join Room. Create takes a name, optional description, and optional GitHub repo URL. Join takes a 6-character invite code. On room creation, an invite modal shows the code and shareable link. The URL parameter `?join=CODE` auto-fills the join tab.

### `/chat/`
The main workspace. Loaded via `?room=ROOM_ID`. On load it:
1. Verifies auth state
2. Fetches room data from `GET /api/rooms/:roomId`
3. Checks membership and reads the user's role
4. Starts a Firestore `onSnapshot` listener for messages
5. Starts a Firestore `onSnapshot` listener for typing indicators
6. Initializes CodeMirror editor
7. Loads the room's committed files
8. Loads all pull requests

The page has three panels:

**Chat panel** — real-time messaging. Supports reply, edit, soft-delete, @mentions with autocomplete dropdown, inline code rendering, fenced code blocks with syntax highlighting, and markdown formatting (bold, italic). Sending a message with `@ai` triggers an AI response that gets posted back to the chat as a message from "AI Assistant".

**Code Editor panel** — VS Code-style layout with a file explorer sidebar on the left and CodeMirror on the right. Files in the explorer are committed files from Firestore. Clicking a file loads it into the editor. The "+" button creates a new unsaved file. `Ctrl+S` submits a pull request. Language is auto-detected from the file extension.

**Personal AI panel** — private AI chat, not visible to other room members. Uses streaming via SSE. Each response types out in real-time as chunks arrive. Maintains a conversation history of the last 10 messages for context. Code blocks in responses are syntax highlighted on finalization.

---

## Backend

All routes are in `index.js`. Every protected route runs the `verifyToken` middleware first, which calls `admin.auth().verifyIdToken()` on the Bearer token from the `Authorization` header.

### Middleware

```
verifyToken     — required on all data routes
optionalAuth    — used on public-ish routes like invite preview
```

### Route Groups

**Config**
- `GET /api/config` — returns Firebase client config from env (no auth required)

**Auth**
- `GET /api/auth/me` — get current user's Firestore profile
- `POST /api/auth/profile` — create or update user profile (merge)

**Rooms**
- `POST /api/rooms/create` — creates room doc, sets creator as admin, adds room to user's rooms array
- `POST /api/rooms/join` — finds room by invite code, adds user as member
- `GET /api/rooms` — returns all rooms the user is a member of
- `GET /api/rooms/:id` — single room, checks membership before returning
- `PATCH /api/rooms/:id` — update name/description/repo (admin only)
- `DELETE /api/rooms/:id` — delete room (admin only)

**Members**
- `PATCH /api/rooms/:id/members/:uid/role` — change role: admin, member, or viewer (admin only)
- `DELETE /api/rooms/:id/members/:uid` — remove member or self-leave

**Messages**
- `GET /api/rooms/:id/messages` — paginated fetch with optional `before` cursor
- `DELETE /api/rooms/:id/messages/:msgId` — soft delete (sets `deleted: true`, clears text)

**Typing**
- `POST /api/rooms/:id/typing` — write `{name, updatedAt}` to `rooms/{id}/typing/{uid}`
- `DELETE /api/rooms/:id/typing` — remove own typing doc

**Editor**
- `GET /api/rooms/:id/editor` — get saved editor state (content, language, fileName)
- `PATCH /api/rooms/:id/editor` — save editor state

**Files**
- `GET /api/rooms/:id/files` — list all committed files ordered by creation time
- `POST /api/rooms/:id/files` — submit new file as a PR
- `PATCH /api/rooms/:id/files/:fileId` — submit edit as a PR
- `DELETE /api/rooms/:id/files/:fileId` — delete file directly (admin only)

**Pull Requests**
- `GET /api/rooms/:id/prs` — list last 50 PRs ordered by date
- `POST /api/rooms/:id/prs/:prId/review` — approve or reject; on approve, commits file to `files` collection

**Invites**
- `GET /api/invite/:code` — room preview by invite code (no auth needed)
- `POST /api/invite/:id/regenerate` — generate new invite code (admin only)

**AI**
- `POST /api/ai/chat` — for `@ai` in group chat; returns `{reply, replyHtml}`
- `POST /api/ai/private/stream` — SSE stream for personal AI panel
- `POST /api/ai/private` — non-stream fallback
- `POST /api/ai/snippet-verdict` — short code review (3 sentences max)

---

## Database Structure

All data lives in Firestore. No SQL.

```
users/
  {uid}/
    uid, displayName, email, photoURL, rooms[], createdAt

rooms/
  {roomId}/
    id, name, description, githubRepo, inviteCode
    createdBy, createdAt
    members/
      {uid}: { role, displayName, photoURL, joinedAt }

    messages/  (subcollection)
      {msgId}/
        uid, displayName, photoURL
        text, textHtml (AI only)
        isAI, deleted, edited
        createdAt
        replyTo: { id, uid, name, text }

    typing/  (subcollection)
      {uid}/
        name, updatedAt

    files/  (subcollection — committed files)
      {fileId}/
        fileName, language, content
        createdBy, createdAt
        lastEditBy, lastEditAt

    prs/  (subcollection)
      {prId}/
        id, type (create|edit), fileName, language, content
        fileId (for edits), uid, name, photo
        status (pending|approved|rejected)
        createdAt, reviewedBy, reviewedAt

    editor/  (subcollection)
      state/
        content, language, fileName
        lastEditedBy, lastEditedAt
```

---

## AI Integration

Learnkins Room uses Google Gemini 2.5 Flash via the `@google/genai` Node.js SDK.

**Group chat AI (`@ai` mention)**
When a message contains `@ai`, the client calls `POST /api/ai/chat` with the prompt. The server calls `generateContent`, parses the response with `marked.js`, and returns `{reply, replyHtml}`. The client then writes an AI message to Firestore with both fields, so it appears in the chat for all members in real time.

**Personal AI (streaming)**
The personal AI panel calls `POST /api/ai/private/stream`. The server uses `generateContentStream` and pipes chunks to the client as SSE events in the format `data: {"chunk": "..."}`. The client reads the stream with a `ReadableStream` reader, appends each chunk to the bubble live, then on the final `data: {"done": true, "html": "..."}` event it renders the fully parsed and highlighted response.

**Conversation history**
The personal AI panel keeps `aiHistory` in memory (last 10 messages). Each request sends this history as the `contents` array to Gemini, with roles mapped as `user` and `model`. This gives the AI context across messages in the same session.

**Markdown parsing**
All AI responses are parsed server-side with `marked.js` before being sent to the client. This means the client receives ready-to-render HTML. Code blocks in AI responses are syntax highlighted client-side with `highlight.js` after the stream finalizes.

---

## Authentication & Authorization

Sign-in uses Firebase Authentication with Google OAuth. After sign-in, the client gets an ID token via `user.getIdToken()`. This token is sent as a Bearer token on every API request.

The server verifies the token with `admin.auth().verifyIdToken(token)` on every protected route. This gives the server `req.user` with `uid`, `name`, `email`, `picture`.

Role-based access is enforced at the API level:

| Role | Can do |
|---|---|
| admin | everything — change roles, remove members, approve PRs, delete files, regen invite |
| member | send messages, submit file PRs, read everything |
| viewer | read-only (UI enforcement coming — API enforcement for file writes is in place) |

Admins cannot remove themselves if they are the last admin. Members can remove themselves (leave room).

---

## Pull Request Workflow

This is how file changes are managed in Learnkins Room:

1. A member opens a file or creates a new one in the editor
2. They make changes and press `Ctrl+S` or click the PR button
3. The client calls `POST /api/rooms/:id/files` (new file) or `PATCH /api/rooms/:id/files/:fileId` (edit)
4. The server creates a PR document in `rooms/{id}/prs` with status `pending`
5. Admins see a badge on the PR button showing pending count
6. Admin opens the PR panel, sees the list of pending PRs with submitter, file name, and type
7. Admin clicks Approve or Reject
8. The client calls `POST /api/rooms/:id/prs/:prId/review` with `{action: "approve"}`
9. On approve — the server writes the file content into `rooms/{id}/files` (create) or updates the existing file (edit)
10. The file explorer refreshes and the new content is live for all members

---

## Typing Indicators

Typing is tracked via a `typing` subcollection in each room. When a user types in the chat input, the client calls `POST /api/rooms/:id/typing`, which writes `{name, updatedAt}` to `rooms/{id}/typing/{uid}`. A 3-second debounce timer calls `DELETE /api/rooms/:id/typing` if the user stops typing.

The client listens to the `typing` collection with `onSnapshot`. When the snapshot changes, it filters out the current user and renders a "X is typing..." indicator above the input area. The indicator uses a CSS bounce animation on three dots.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML5, Tailwind CSS (CDN), JetBrains Mono |
| Realtime | Firebase Firestore (onSnapshot) |
| Authentication | Firebase Auth, Google OAuth 2.0 |
| Backend | Node.js, Express |
| AI | Google Gemini 2.5 Flash (`@google/genai`) |
| Markdown | marked.js (server-side parsing) |
| Code Editor | CodeMirror 5 |
| Syntax Highlight | highlight.js |
| Animations | GSAP 3 |
| Icons | Font Awesome 6 |
| Storage | Firebase Storage (signed URL uploads) |

---

## Environment Variables

```env
PORT=3000
APP_URL=https://yourdomain.com


FIREBASE_API_KEY=
FIREBASE_AUTH_DOMAIN=
FIREBASE_PROJECT_ID=
FIREBASE_STORAGE_BUCKET=
FIREBASE_MESSAGING_SENDER_ID=
FIREBASE_APP_ID=

FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=

GEMINI_API_KEY=


MAIL_HOST=mail.yourdomain.com
MAIL_PORT=587
MAIL_SECURE=false
MAIL_USER=noreply@yourdomain.com
MAIL_PASS=your-email-password
MAIL_FROM=Learnkins Room <noreply@yourdomain.com>
```

`service-account.json` is required separately — place it at the root alongside `index.js`. Download it from Firebase Console under Project Settings > Service Accounts.

---

## Roadmap

**Next**
- Voice rooms via Agora SDK
- Video calls
- Screen sharing
- Live collaborative code editing (real-time cursor sync)
- Viewer role fully enforced on chat input

**Planned**
- AI automatic code review when a PR is submitted
- AI reads the currently open file for context-aware answers
- File diff view when reviewing a PR
- Message reactions
- Message search
- Room activity feed (join, PR events, role changes)
- Notification system for @mentions and PR reviews

**Future**
- GitHub repo sync
- Public discoverable rooms
- Room templates with pre-loaded code scaffolds
- Export chat as markdown
- Mobile layout

---

## Known Limitations

- No live collaborative editing — if two people edit the same file simultaneously, last save wins
- File tree is flat — no folder/directory structure
- Messages are limited to the last 100 in a session
- Viewer role is not yet enforced on the chat input in the UI
- AI conversation history is session-only — clears on page refresh
- No message pagination UI — older messages require a page reload with a `before` cursor