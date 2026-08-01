# Contributing to Learnkins Room

Contributions are welcome. Before working on anything significant, open an issue first so we can discuss it and avoid duplicate work.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Workflow](#workflow)
- [Code Guidelines](#code-guidelines)
- [Commit Messages](#commit-messages)
- [What to Work On](#what-to-work-on)
- [What We Will Not Merge](#what-we-will-not-merge)
- [Security](#security)

---

## Getting Started

Read [INSTALLATION.md](./INSTALLATION.md) for the full setup guide. Short version:

```bash
git clone https://github.com/your-username/learnkins-room.git
cd learnkins-room
npm install
cp .env.example .env
# fill in Firebase and Gemini credentials
# place service-account.json at project root
node index.js
```

Once running, open `http://localhost:3000`, sign in with Google, and make sure the core flow works — create a room, send a message, open the editor — before making any changes.

---

## Project Structure

```
/
├── index.js              all backend logic — Express routes, Firebase Admin, AI
├── service-account.json  Firebase Admin credentials — never commit this
├── .env                  secrets — never commit this
├── package.json
└── public/
    ├── index.html        landing page
    ├── auth/             Google sign-in
    ├── lobby/            room list, create, join
    └── chat/             main workspace — chat, editor, AI panels
```

Frontend is plain HTML. No build step, no bundler. Libraries are loaded from CDN. All frontend logic lives in `<script type="module">` inside each page's HTML file. The non-module script handles theme, cursor glow, and keyboard shortcuts only.

Backend is a single `index.js` file. All API routes, middleware, Firebase Admin initialization, and AI calls are in there.

---

## Workflow

1. Open an issue describing what you want to fix or build
2. Wait for a response before writing code on large features
3. Fork the repository
4. Create a branch from `main`

```bash
git checkout -b fix/describe-what-youre-fixing
git checkout -b feature/describe-what-youre-adding
git checkout -b docs/what-youre-documenting
```

5. Make your changes
6. Test manually — go through the full user flow affected by your change
7. Commit with a clear message
8. Push to your fork and open a pull request against `main`
9. Fill in the PR description — what changed, why, and how to test it

---

## Code Guidelines

**General**
- Use `const` and `let` only, never `var`
- Use `async/await` over `.then()` chains
- Keep functions small and named clearly
- Delete commented-out code before submitting

**Backend (`index.js`)**
- Every protected route runs `verifyToken` middleware first
- Wrap all route logic in `try/catch` and return `res.status(500).json({ error: err.message })`
- Always check membership or role before returning room data
- Server writes to Firestore via Admin SDK — never expose write logic to the client

**Frontend (`public/`)**
- All page logic goes in `<script type="module">`
- The non-module script is for theme, animations, and keyboard shortcuts only — keep it that way
- Always escape user content before inserting into `innerHTML` — use the `esc()` helper
- Code blocks extracted from user messages must be escaped before rendering — do not skip this
- Firebase Client SDK is only for auth state and `onSnapshot` listeners — all data writes go through the REST API
- Do not add new CDN dependencies without discussing it first

**Styling**
- Use Tailwind utility classes for layout and spacing
- Custom styles go in the `<style>` block of the relevant HTML file
- Follow the existing CSS variable naming (`--bg`, `--bg2`, `--border`, `--text`, `--muted`, etc.)
- Changes must work in both dark and light theme — test both before submitting

---

## Commit Messages

Short, present tense, lowercase. Describe what the commit does, not what you did.

```
Good:
  fix message not clearing after send
  add copy button to code blocks in chat
  update firestore rules for typing subcollection
  remove unused variable in initRoom

Not good:
  fixed stuff
  WIP
  updates
  I added the copy button feature to the chat code blocks
```

If a commit needs more context, add a blank line and a short body:

```
fix AI stream cutting off on long responses

nginx was buffering the SSE response. added proxy_buffering off
and increased proxy_read_timeout to 120s in the nginx config.
```

---

## What to Work On

Good starting points if you are new to the codebase:

- Better empty states for file explorer, PR list, rooms list
- Input validation — room name length, file name characters, empty messages
- Error messages that say something useful instead of raw API errors
- UI improvements that work in both themes
- Fixing typos or improving clarity in README or this file

More involved areas — open an issue before starting:

- Live collaborative editing (needs a real strategy — OT or CRDT)
- Voice and video (Agora SDK integration)
- GitHub repo sync
- Notification system
- Message pagination UI
- AI context awareness (reading the open file)

---

## What We Will Not Merge

- Code that exposes API keys, service account credentials, or `.env` values
- Direct commits to `main` — everything goes through a PR
- Features that remove or break existing functionality without prior discussion
- Frontend changes that only work in dark mode or only work in light mode
- Inline styles that hardcode colors instead of using CSS variables
- Large refactors without an issue and discussion first
- Anything that adds a required build step to the frontend without strong justification

---

## Security

If you find a security issue — especially anything involving authentication, Firestore rules, or API key exposure — do not open a public GitHub issue. Contact the maintainer directly. We will respond quickly and credit you in the fix.

---

## Questions

Open an issue tagged `[Question]`. No question is too basic.