# Saroye Express Inc. — Parcel & Courier Delivery App

A complete, self-hostable dispatch app for **Saroye Express Inc.**:

- **Customers** — request a delivery, get a tracking code instantly, track parcels (received → picked up → in transit → delivered), click-to-call the recipient, copy the tracking code.
- **Drivers** — separate portal: register with driver photo, driving licence and work permit / PR card; application starts as *pending review*; approved drivers see **only their own assigned jobs**; they can read owner correction notes and resubmit documents.
- **Owner** — separate, password-protected portal: first-run setup creates a private username + password and collects identity verification (full legal name, email, phone, owner photo, government photo ID, proof of company authority). Sign-in locks for 15 minutes after 5 failed attempts. The control center has **Orders** (approve/reject requests, location-aware driver assignment, direct status overrides), **Drivers** (review documents, approve, request corrections) and **Zones** (service areas, postal prefixes, pricing, same-day flag, pause/edit/delete) tabs.

## How it's built

- **Backend:** Node.js + Express, one process serves the API and the website.
- **Database:** SQLite file (`better-sqlite3`) — no separate database server needed.
- **Files:** uploaded documents are stored on local disk.
- **Sign-in:** server sessions (cookies), passwords hashed with bcrypt.

## Run it on your own computer (to try it)

1. Install [Node.js](https://nodejs.org) version 20 or newer.
2. Open a terminal in this folder and run:
   ```
   npm install
   npm start
   ```
3. Open http://localhost:3000 in your browser.
4. **First-run owner setup:** the terminal prints a one-time setup token. Open
   http://localhost:3000/owner.html, enter the token, choose your username and
   password, and fill in your owner details. After this, the token is useless —
   nobody else can claim the owner account.

## Put it on the internet (so customers & drivers can use it)

The easiest way for a non-technical owner is **Render** (free to start).

### Step-by-step with Render

1. **Put this code on GitHub.**
   - Create a free account at https://github.com.
   - Create a new repository (call it `saroye-express`), then upload this whole
     folder into it (GitHub's web page has an "uploading an existing file"
     button — you can drag the folder's contents in).

2. **Create a free Render account** at https://render.com (you can sign up with
   your GitHub account — one click).

3. **Create the app on Render.**
   - In the Render dashboard click **New +** → **Web Service**.
   - Choose **Build and deploy from a Git repository**, connect your
     `saroye-express` repo, and click Connect.
   - Render reads the `Dockerfile` automatically. Leave the detected settings.
   - Under **Environment Variables**, add:
     - `SESSION_SECRET` → a long random string. Make one here:
       https://www.random.org/strings/ (or ask someone technical to run
       `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
     - `OWNER_SETUP_TOKEN` → pick a secret word/number only you know
       (e.g. `saroye-owner-48291`). You'll need it once, at setup.
   - Click **Add Disk**: name it `saroye-data`, mount path `/data`, size 1 GB.
     (This keeps your database and uploaded documents safe when Render restarts.)
   - Click **Create Web Service** and wait a few minutes for the first deploy.

4. **Open your new public link.** Render gives you a URL like
   `https://saroye-express.onrender.com`. Open it — your app is live!

5. **Create your owner account (do this first).**
   - Go to `https://YOUR-APP.onrender.com/owner.html`.
   - Enter the `OWNER_SETUP_TOKEN` you set in step 3, choose your username and
     password, and complete your owner details (name, email, phone, photo,
     government ID, proof of company authority).
   - From now on, sign in at `/owner.html` with your username and password.
     Nobody else can create an owner account.

6. **Set up your delivery zones** (Owner → Zones tab): add each service area
   with its postal code prefixes and your prices. Active zones automatically
   appear on the customer request page.

7. **Share the link** with customers and drivers:
   - Customers: `https://YOUR-APP.onrender.com` (request + track)
   - Drivers: `https://YOUR-APP.onrender.com/driver.html` (register / sign in)
   - Keep `https://YOUR-APP.onrender.com/owner.html` private — that's yours.

> **Note:** Render's free tier sleeps after ~15 minutes of inactivity, so the
> first visit after a while takes ~30 seconds to wake up. Their paid tier
> (a few dollars/month) keeps it always-on. The 1 GB disk above is also a paid
> add-on on Render — without it, uploaded documents and the database are lost
> on redeploy, so the disk is strongly recommended once real drivers sign up.

### Alternative: run it with Docker on any server

If you (or someone helping you) have a server with Docker:

```
# 1. Copy this folder to the server, then:
SESSION_SECRET=your-long-random-secret OWNER_SETUP_TOKEN=your-secret-token docker compose up -d --build

# 2. Read the one-time setup token (only needed if you didn't set OWNER_SETUP_TOKEN):
docker logs saroye-express | grep -A2 "setup token"

# 3. Open http://YOUR-SERVER-IP:3000/owner.html and complete owner setup.
```

Data persists in the `saroye-data` Docker volume.

## Environment variables

| Variable | Required | What it does |
|---|---|---|
| `SESSION_SECRET` | **Yes (production)** | Long random string that secures sign-in sessions. |
| `OWNER_SETUP_TOKEN` | Recommended | Your secret one-time token for first-run owner setup. If empty, a random one is printed to the server logs at first boot. |
| `PORT` | No | Port to listen on (default `3000`; hosts like Render set it automatically). |
| `DB_PATH` | No | SQLite file location (default `./data/saroye.db`). |
| `UPLOAD_DIR` | No | Uploaded documents folder (default `./uploads`). |
| `MAX_FILE_MB` | No | Max size per uploaded document in MB (default `8`). |
| `COOKIE_SECURE` | No | Set to `1` when serving behind HTTPS. |

## Project layout

```
server.js            Express app: API + serves the frontend
db.js                SQLite schema (created automatically on first boot)
public/
  index.html         Customer home: request a delivery, view zones
  track.html         Parcel tracking page
  driver.html        Driver portal (register / sign in / my jobs)
  owner.html         Owner portal (setup / sign in / control center)
  style.css          Shared styles & Saroye Express Inc. branding
uploads/             Uploaded documents (created at runtime; keep private)
data/                SQLite database file (created at runtime)
Dockerfile           Container build for Render / any Docker host
docker-compose.yml   One-command deploy with persistent storage
.env.example         Copy to .env for local configuration
```

## Security notes

- Owner and driver passwords are hashed with bcrypt; sessions live in
  httpOnly cookies (no tokens in browser storage).
- Owner setup requires the one-time setup token and becomes impossible after
  the owner account exists; owner sign-in locks for 15 minutes after
  5 failed attempts.
- Uploaded documents are **never** served publicly — drivers can only download
  their own files, and only a signed-in owner can open any document.
- Drivers only ever see their own assigned jobs; customers only see tracking.
- The database starts empty: no fake prices, areas or contact details are
  invented — the owner configures zones and pricing themselves.
