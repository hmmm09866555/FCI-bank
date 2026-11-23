# FCI Bank: mobile app + backend

An installable app (PWA) with its own Node backend. No dependencies and no build step.

```
server.js          backend: API, realtime sync, auth, ledger rules, static hosting
public/index.html  the app (your original UI, now talking to the backend)
public/sw.js, manifest.webmanifest, icons/   make it installable on a phone
Dockerfile         for hosting
```

## Run it

```bash
node server.js            # needs Node 18+
# open http://localhost:3000
```

On first start it prints a generated **admin password** (also saved in `data/admin_password.txt`).
To choose your own: `ADMIN_PASSWORD=yourpassword node server.js`.

Admin dashboard: open `/#admin` and sign in with that password.

## Settings (environment variables)

| Variable | Purpose |
|---|---|
| `PORT` | default 3000 |
| `DATA_DIR` | where `data.json` (all bank data) and secrets live. **Put this on persistent storage.** |
| `ADMIN_PASSWORD` | admin dashboard password |
| `ACCESS_CODE` | optional. If set, nobody can even load the data without this code (recommended, since the app is a private friends bank) |
| `TRUST_PROXY=1` | set when behind a host's proxy so rate limits use real client IPs (the Dockerfile sets it) |
| `CORS_ORIGIN` | only if the app is served from a different origin than the API |

## Put it on the internet (needed so phones can reach it)

Any host that runs Node or Docker with a **persistent disk** works (Fly.io, Railway, Render, a VPS).
Mount the disk at `/data` (the Dockerfile uses `DATA_DIR=/data`) and set `ADMIN_PASSWORD` and `ACCESS_CODE`.
It must be served over **HTTPS** for phones to install it.

## Install on a phone

- **iPhone (Safari):** open your URL, Share, **Add to Home Screen**.
- **Android (Chrome):** open your URL, menu, **Install app**.

It opens full screen with its own icon, like a native app.

## Real App Store / Play Store builds (optional)

Wrap the hosted site with [Capacitor](https://capacitorjs.com):

```bash
npm i @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios
npx cap init "FCI Bank" com.yourname.fci --web-dir=public
# in capacitor.config.json add:  "server": { "url": "https://YOUR-HOST", "cleartext": false }
npx cap add android && npx cap add ios
npx cap open android   # or ios (iOS needs a Mac + Xcode)
```

Store publishing needs developer accounts (Google Play $25 one-off, Apple $99/year).

## What the backend enforces

- PINs and recovery words are stored salted + scrypt-hashed; hashes are never sent to browsers.
- Login/recovery/admin are rate limited with lockouts.
- Signed session tokens; users can only act on their own account.
- Ledger is append-only. The server checks ownership, balances, credit limits, per-transaction and daily limits, holdings for sells, and that trade prices match the market engine.
- Admin-only: funds, reversals, settings, suspending users, points, application and ticket status.
- Maintenance mode and "registration closed" are enforced server-side.

## Backups

Everything is in `DATA_DIR/data.json`. Copy that file to back up; replace it (server stopped) to restore.

## Limits to know about

- Data lives in one JSON file and every change is pushed to all connected phones: fine for dozens of friends, not thousands. Move to a database if it grows.
- Your original app's data was stored inside claude.ai and can't be moved automatically; this starts fresh.
- It's still a simulator: balances are fictional and nothing here is a real financial service.

## Android APK

`android/` is a small native Android app that opens your hosted FCI site full screen (back button, offline screen, icon included).
**Untested build**: it was written without an Android SDK available, so run the first build and tell me if Gradle complains.

**Easiest: build it in GitHub (no Android Studio needed)**
1. Host the server first (see above) so you have an `https://` address.
2. Put this folder in a new GitHub repository (the `.github/workflows/apk.yml` file must be in the repo root).
3. On GitHub: **Actions, Build Android APK, Run workflow**, and enter your address.
4. When it finishes (a few minutes), download **FCI-Bank-apk** from the run page, unzip it, and send `app-debug.apk` to people.

**Or locally** with Android Studio / SDK + Gradle 8.9:
`cd android && gradle assembleDebug -PappUrl=https://your-host/` then take `app/build/outputs/apk/debug/app-debug.apk`.

Android users open the APK and allow "install from unknown sources" once. The APK is debug-signed, which is fine for sharing with friends but not for Google Play.
The address is baked into the APK, so changing hosts means building a new one.
