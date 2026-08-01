# Installation Guide — Linux Server

This guide covers everything needed to run Learnkins Room on a Linux server from scratch.
Tested on Ubuntu 22.04 LTS.

---

## Table of Contents

- [System Requirements](#system-requirements)
- [Step 1 — Server Setup](#step-1--server-setup)
- [Step 2 — Install Node.js](#step-2--install-nodejs)
- [Step 3 — Clone the Project](#step-3--clone-the-project)
- [Step 4 — Firebase Project Setup](#step-4--firebase-project-setup)
- [Step 5 — Firestore Rules](#step-5--firestore-rules)
- [Step 6 — Firebase Storage Rules](#step-6--firebase-storage-rules)
- [Step 7 — Service Account](#step-7--service-account)
- [Step 8 — Gemini API Key](#step-8--gemini-api-key)
- [Step 9 — Environment Variables](#step-9--environment-variables)
- [Step 10 — Install Dependencies](#step-10--install-dependencies)
- [Step 11 — Run the Server](#step-11--run-the-server)
- [Step 12 — Keep It Running with PM2](#step-12--keep-it-running-with-pm2)
- [Step 13 — Nginx Reverse Proxy](#step-13--nginx-reverse-proxy)
- [Step 14 — Connect a Domain with Cloudflare](#step-14--connect-a-domain-with-cloudflare)
- [Step 15 — SSL with Certbot](#step-15--ssl-with-certbot)
- [Firestore Indexes](#firestore-indexes)
- [Verify Everything Works](#verify-everything-works)
- [Common Errors](#common-errors)

---

## System Requirements

- Ubuntu 20.04 or 22.04 LTS (or any Debian-based distro)
- At least 1 GB RAM
- At least 10 GB disk
- A non-root user with sudo access (recommended)
- Ports 80 and 443 open in your firewall/security group

---

## Step 1 — Server Setup

Update the system and install basic tools.

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl wget unzip ufw
```

Set up the firewall.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
sudo ufw status
```

If you are on a cloud provider (AWS, DigitalOcean, Hetzner, etc.), also open ports 80 and 443 in the provider's security group or firewall dashboard — UFW alone is not enough on some providers.

---

## Step 2 — Install Node.js

Use NodeSource to install Node.js v20 (LTS).

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Verify.

```bash
node -v    # should print v20.x.x
npm -v     # should print 10.x.x
```

Install Yarn if you prefer it (optional — npm works fine too).

```bash
npm install -g yarn
```

---

## Step 3 — Clone the Project

```bash
cd /var/www
sudo mkdir learnkins-room
sudo chown $USER:$USER learnkins-room
git clone https://github.com/your-username/learnkins-room.git learnkins-room
cd learnkins-room
```

If you are deploying without Git, upload your files via SFTP and place them in `/var/www/learnkins-room`.

The directory should look like this after cloning:

```
/var/www/learnkins-room/
├── index.js
├── package.json
├── yarn.lock
├── .env              (you will create this)
├── service-account.json  (you will add this)
├── public/
└── node_modules/     (after install)
```

---

## Step 4 — Firebase Project Setup

### 4.1 Create a Firebase Project

1. Go to [https://console.firebase.google.com](https://console.firebase.google.com)
2. Click "Add project"
3. Enter a name (e.g. `learnkins-room-prod`)
4. Disable Google Analytics if you do not need it
5. Click "Create project"

### 4.2 Enable Authentication

1. In the Firebase Console, go to **Build > Authentication**
2. Click "Get started"
3. Go to the **Sign-in method** tab
4. Enable **Google** as a sign-in provider
5. Set a support email
6. Save

### 4.3 Enable Firestore

1. Go to **Build > Firestore Database**
2. Click "Create database"
3. Choose **Production mode** (you will add rules in Step 5)
4. Select a region close to your users (e.g. `asia-south1` for India)
5. Click "Enable"

### 4.4 Enable Storage

1. Go to **Build > Storage**
2. Click "Get started"
3. Choose Production mode
4. Select the same region as Firestore
5. Click "Done"

### 4.5 Get Firebase Client Config

1. Go to **Project Settings** (gear icon, top left)
2. Scroll down to "Your apps"
3. Click the web icon (`</>`)
4. Register the app with a nickname
5. Copy the `firebaseConfig` object — you will need these values for `.env`

It looks like this:

```js
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef"
};
```

### 4.6 Add Authorized Domains

1. Go to **Authentication > Settings > Authorized domains**
2. Add your domain (e.g. `learnkinsroom.dev`)
3. Also add your server IP if testing without a domain

---

## Step 5 — Firestore Rules

In the Firebase Console, go to **Firestore > Rules** and replace the default rules with these:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Users — only the owner can write their own profile
    match /users/{uid} {
      allow read:  if request.auth != null;
      allow write: if request.auth != null && request.auth.uid == uid;
    }

    // Rooms — members can read, server handles writes via Admin SDK
    match /rooms/{roomId} {
      allow read: if request.auth != null &&
        request.auth.uid in resource.data.members;

      // Messages subcollection — members can read and write
      match /messages/{msgId} {
        allow read: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/rooms/$(roomId)).data.members;
        allow create: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/rooms/$(roomId)).data.members &&
          request.resource.data.uid == request.auth.uid;
        allow update: if request.auth != null &&
          request.auth.uid == resource.data.uid;
        allow delete: if false; // handled server-side (soft delete)
      }

      // Typing subcollection — members can read and write their own doc
      match /typing/{uid} {
        allow read: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/rooms/$(roomId)).data.members;
        allow write: if request.auth != null && request.auth.uid == uid;
      }

      // Files subcollection — members can read, server handles writes
      match /files/{fileId} {
        allow read: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/rooms/$(roomId)).data.members;
        allow write: if false; // server-side only via Admin SDK
      }

      // PRs subcollection — members can read, server handles writes
      match /prs/{prId} {
        allow read: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/rooms/$(roomId)).data.members;
        allow write: if false; // server-side only via Admin SDK
      }

      // Editor state
      match /editor/{doc} {
        allow read: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/rooms/$(roomId)).data.members;
        allow write: if false; // server-side only
      }
    }
  }
}
```

Click **Publish**.

These rules allow:
- Only room members to read room data and messages
- Members to write their own messages and typing status
- Everything else (rooms, files, PRs, editor) to be written only via the Admin SDK on your server (bypasses rules entirely)

---

## Step 6 — Firebase Storage Rules

In the Firebase Console, go to **Storage > Rules** and replace with:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {

    // Room file uploads — authenticated users only
    match /rooms/{roomId}/{allPaths=**} {
      allow read:  if request.auth != null;
      allow write: if false; // server generates signed URLs only
    }
  }
}
```

Click **Publish**.

---

## Step 7 — Service Account

The service account gives your Node.js server Admin SDK access to Firebase.

1. Go to **Firebase Console > Project Settings > Service Accounts**
2. Click "Generate new private key"
3. Confirm and download the JSON file
4. Rename it to `service-account.json`
5. Upload it to your server at `/var/www/learnkins-room/service-account.json`

```bash
# If uploading via scp from your local machine
scp service-account.json user@your-server-ip:/var/www/learnkins-room/service-account.json
```

Set strict permissions on it — this file is sensitive.

```bash
chmod 600 /var/www/learnkins-room/service-account.json
```

Never commit this file to Git. Verify it is in `.gitignore`:

```bash
grep service-account .gitignore
# should print: service-account.json
```

---

## Step 8 — Gemini API Key

1. Go to [https://aistudio.google.com](https://aistudio.google.com)
2. Sign in with a Google account
3. Click "Get API key"
4. Click "Create API key in new project" or select an existing project
5. Copy the key — you will add it to `.env` in the next step

The free tier is generous enough for development and small teams. For production with many users, set up billing at [https://console.cloud.google.com](https://console.cloud.google.com).

---

## Step 9 — Environment Variables

Create the `.env` file at the project root.

```bash
cd /var/www/learnkins-room
nano .env
```

Paste and fill in all values:

```env
# ── Firebase Client (from Step 4.5) ──────────────────────────
FIREBASE_API_KEY=AIzaSy...
FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
FIREBASE_PROJECT_ID=your-project
FIREBASE_STORAGE_BUCKET=your-project.appspot.com
FIREBASE_MESSAGING_SENDER_ID=123456789
FIREBASE_APP_ID=1:123456789:web:abcdef

# ── Gemini (from Step 8) ──────────────────────────────────────
GEMINI_API_KEY=AIzaSy...

# ── Server ────────────────────────────────────────────────────
PORT=3000
```

Save with `Ctrl+O`, exit with `Ctrl+X`.

Set permissions.

```bash
chmod 600 .env
```

---

## Step 10 — Install Dependencies

```bash
cd /var/www/learnkins-room
npm install
# or if using yarn
yarn install
```

This installs:
- `express` — HTTP server and routing
- `cors` — cross-origin request handling
- `dotenv` — loads `.env` into `process.env`
- `firebase-admin` — server-side Firebase access (bypasses security rules)
- `@google/genai` — Gemini API SDK
- `marked` — markdown to HTML parser

---

## Step 11 — Run the Server

Test that it starts correctly.

```bash
cd /var/www/learnkins-room
node index.js
```

You should see:

```
  Learnkins Room → http://localhost:3000
```

Test it.

```bash
curl http://localhost:3000/api/debug
# should return: {"status":"OK","firestore":true,"gemini":true,"node":"v20.x.x"}
```

Press `Ctrl+C` to stop. Now set it up properly with PM2.

---

## Step 12 — Keep It Running with PM2

PM2 is a process manager that keeps Node.js apps running after you log out and restarts them on crash.

```bash
npm install -g pm2
```

Start Learnkins Room with PM2.

```bash
cd /var/www/learnkins-room
pm2 start index.js --name learnkins-room
```

Save the process list and set PM2 to start on reboot.

```bash
pm2 save
pm2 startup
# pm2 startup will print a command — copy and run it
# it looks like: sudo env PATH=... pm2 startup systemd -u youruser --hp /home/youruser
```

Useful PM2 commands.

```bash
pm2 status                  # see running apps
pm2 logs learnkins-room          # live logs
pm2 logs learnkins-room --lines 50  # last 50 lines
pm2 restart learnkins-room       # restart after code changes
pm2 stop learnkins-room          # stop
pm2 delete learnkins-room        # remove from PM2
```

---

## Step 13 — Nginx Reverse Proxy

Nginx sits in front of Node.js, handles port 80/443, and forwards requests to port 3000.

Install Nginx.

```bash
sudo apt install -y nginx
```

Create a config file for Learnkins Room.

```bash
sudo nano /etc/nginx/sites-available/learnkins-room
```

Paste this config (replace `yourdomain.com` with your actual domain or server IP):

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    # Increase body size limit for file uploads
    client_max_body_size 20M;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;

        # Required for SSE (AI streaming)
        proxy_set_header   Connection '';
        proxy_buffering    off;
        proxy_cache        off;
        chunked_transfer_encoding on;

        # Standard proxy headers
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Timeouts — increase for long AI responses
        proxy_read_timeout    120s;
        proxy_connect_timeout 120s;
        proxy_send_timeout    120s;
    }
}
```

Enable the site.

```bash
sudo ln -s /etc/nginx/sites-available/learnkins-room /etc/nginx/sites-enabled/
sudo nginx -t        # test config — must say "syntax is ok"
sudo systemctl reload nginx
```

---

## Step 14 — Connect a Domain with Cloudflare

### 14.1 Add Your Domain to Cloudflare

1. Go to [https://dash.cloudflare.com](https://dash.cloudflare.com)
2. Click "Add a site"
3. Enter your domain name
4. Select the Free plan
5. Cloudflare will scan your existing DNS records

### 14.2 Update Nameservers at Your Registrar

Cloudflare will give you two nameservers like:
```
aria.ns.cloudflare.com
bob.ns.cloudflare.com
```

Go to wherever you bought your domain (Namecheap, GoDaddy, Porkbun, etc.) and replace the default nameservers with Cloudflare's. DNS propagation takes 5–30 minutes usually, up to 48 hours in rare cases.

### 14.3 Add DNS Records in Cloudflare

In Cloudflare DNS dashboard, add:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `@` | your server IP | Proxied (orange cloud) |
| A | `www` | your server IP | Proxied (orange cloud) |

"Proxied" means traffic goes through Cloudflare's network. This gives you free DDoS protection and hides your real server IP.

### 14.4 SSL/TLS Settings in Cloudflare

1. Go to **SSL/TLS > Overview**
2. Set encryption mode to **Full (strict)** — this requires a real SSL cert on your server (done in Step 15)

If you skip Step 15, use **Full** (not strict) temporarily.

### 14.5 Recommended Cloudflare Settings

Under **SSL/TLS > Edge Certificates**:
- Enable "Always Use HTTPS"
- Enable "Automatic HTTPS Rewrites"

Under **Speed > Optimization**:
- You can enable Auto Minify for JS/CSS/HTML if you want
- Do not enable Rocket Loader — it can break Firebase and module scripts

Under **Security > Settings**:
- Set Security Level to "Medium" for now

---

## Step 15 — SSL with Certbot

Even with Cloudflare, you need a cert on the server for Full (strict) mode.

Install Certbot.

```bash
sudo apt install -y certbot python3-certbot-nginx
```

Get the certificate. Replace with your actual domain.

```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

Follow the prompts — enter your email and agree to the terms. Certbot will automatically modify your Nginx config to handle HTTPS.

Test auto-renewal.

```bash
sudo certbot renew --dry-run
```

Certbot installs a cron job or systemd timer that renews the cert automatically before it expires (every 90 days).

After this, your Nginx config will have a `server` block for port 443 that Certbot added. Your site is now live over HTTPS.

Reload Nginx.

```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## Firestore Indexes

Firestore requires composite indexes for queries that filter and order on multiple fields. Without them, certain queries will fail with an error in the server logs.

Go to **Firestore > Indexes > Composite** and create these:

| Collection | Fields | Order |
|---|---|---|
| `messages` (subcollection) | `createdAt` | Ascending |
| `prs` (subcollection) | `createdAt` | Descending |
| `files` (subcollection) | `createdAt` | Ascending |

You can also let the server log the index creation URL automatically — when a query fails due to a missing index, Firebase prints a direct link in the error message that takes you straight to the index creation screen. Just run the app, trigger the query, and check `pm2 logs learnkins-room`.

---

## Verify Everything Works

Run through this checklist after deployment.

```bash
# 1. Server is running
pm2 status

# 2. Debug endpoint responds
curl https://yourdomain.com/api/debug

# 3. Check logs for errors
pm2 logs learnkins-room --lines 30

# 4. Nginx is active
sudo systemctl status nginx

# 5. SSL is valid
curl -I https://yourdomain.com
# Look for: HTTP/2 200 and server: cloudflare
```

In the browser:
- Sign in with Google — should redirect to lobby
- Create a room — should show invite code
- Open the room — chat, editor, and AI panels should load
- Type a message — should appear in real time
- Type `@ai hello` — AI should respond in chat
- Open Personal AI panel — type something, response should stream
- Open Code Editor — create a file, submit PR, approve it as admin

---

## Common Errors

**`Error: Failed to parse private key`**
Your `service-account.json` is malformed or the path is wrong. Check that it is at the project root and the JSON is valid.

```bash
node -e "require('./service-account.json'); console.log('OK')"
```

**`Error: Cannot find module 'firebase-admin'`**
Dependencies not installed. Run `npm install` in the project root.

**`FirebaseError: Missing or insufficient permissions`**
Firestore rules are blocking a query. Check the Firestore Rules tab and the server logs for the specific collection path. The Admin SDK bypasses rules — this error comes from client-side Firestore calls (onSnapshot listeners).

**AI streaming stops or never completes**
Nginx is buffering the SSE response. Make sure your Nginx config has:
```nginx
proxy_buffering off;
proxy_cache off;
proxy_set_header Connection '';
```

**`CORS error` in browser console**
The `origin` in `index.js` cors config does not match your domain. The current config uses `*` which allows all origins — if you have restricted it, add your domain.

**`502 Bad Gateway`**
Node.js is not running or crashed. Check with `pm2 status` and `pm2 logs learnkins-room`.

**Port 3000 already in use**
```bash
sudo lsof -i :3000
# kill the PID shown
kill -9 <PID>
```

**Cloudflare 525 SSL Handshake Failed**
Your SSL cert is missing or invalid on the server. Run Certbot again or temporarily switch Cloudflare SSL mode from "Full (strict)" to "Full".

**Google sign-in fails with `auth/unauthorized-domain`**
Your domain is not in Firebase Auth > Authorized Domains. Add it there.