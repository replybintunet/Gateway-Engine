# BintuPay — Deployment Guide

Complete deployment instructions for **Render**, **Ubuntu VPS / localhost**, and **Termux (Android)**.

---

## What You Need

| Requirement | Where to get it |
|-------------|-----------------|
| **Node.js 20+** | https://nodejs.org or via `nvm` |
| **pnpm** | `npm i -g pnpm` |
| **PostgreSQL 14+** | Render provides it; on VPS install `postgresql` |
| **Paystack Secret Key** | paystack.com → Settings → API Keys → Live Secret Key |
| **Telegram Bot Token** | Telegram → @BotFather → `/newbot` |

---

## Required Environment Variables

Set these in your environment before starting the server:

```bash
PORT=8080
NODE_ENV=production
DATABASE_URL=postgres://user:pass@host:5432/dbname
PAYSTACK_SECRET_KEY=sk_live_xxxxxxxxxxxxxxxxxx
TELEGRAM_BOT_TOKEN=1234567890:AABBCCDDxxxxxxxxxxxx
SESSION_SECRET=any-random-string-at-least-32-chars
FRONTEND_URL=https://your-public-domain.com    # used by bot for card payment links
```

> **Important — Build Note:**  
> Do NOT run `pnpm run build` (root script) in production. It tries to build  
> the `mockup-sandbox` and `bintupay` Vite apps which require `PORT` and  
> `BASE_PATH` env vars at build time and will crash without them.  
> Always build only the API server with:  
> `pnpm --filter @workspace/api-server run build`

---

## 1. Deploy on Render (Recommended — Free Tier Available)

Render is the easiest option. The `render.yaml` in this repo handles everything automatically.

### Step 1 — Push to GitHub

```bash
git remote add origin https://github.com/YOUR_USERNAME/bintupay.git
git push -u origin main
```

### Step 2 — Create Services via Blueprint

1. Go to [dashboard.render.com](https://dashboard.render.com)
2. Click **New +** → **Blueprint**
3. Connect your GitHub repository
4. Render will detect `render.yaml` and propose 3 services:
   - `bintupay-api` — Express API + Telegram bot
   - `bintupay-web` — React frontend (static site)
   - `bintupay-db` — PostgreSQL database
5. Click **Apply**

### Step 3 — Fill in Secrets When Prompted

Render will ask you to provide:

| Variable | Value |
|----------|-------|
| `PAYSTACK_SECRET_KEY` | Your Paystack live secret key (`sk_live_…`) |
| `TELEGRAM_BOT_TOKEN` | Your bot token from @BotFather |

Everything else (`DATABASE_URL`, `SESSION_SECRET`, `FRONTEND_URL`) is auto-configured by `render.yaml`.

### Step 4 — Wait for Build (~3–5 min)

The build command that runs is:
```bash
pnpm install --frozen-lockfile && pnpm --filter @workspace/api-server run build
```
This only compiles the API server — it avoids the Vite build-time `PORT` requirement that breaks a full root build.

### Step 5 — Register the Telegram Webhook (Once Only)

After the service is live, run this once to connect your bot:

```bash
curl -X POST "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://bintupay-api.onrender.com/api/bot","drop_pending_updates":true}'
```

Confirm it worked:
```bash
curl "https://api.telegram.org/botYOUR_BOT_TOKEN/getWebhookInfo"
```

### Step 6 — Verify Everything

```bash
# Health check
curl https://bintupay-api.onrender.com/api/healthz

# Test M-Pesa charge endpoint
curl -X POST https://bintupay-api.onrender.com/api/payment?action=charge \
  -H "Content-Type: application/json" \
  -d '{"amount":"10","phone":"0712345678"}'
```

### Render Notes

- **Free tier sleeps after 15 min of inactivity** — upgrade to Starter ($7/mo) to stay always-on
- **Auto-deploys on every `git push`** — no manual action needed after initial setup
- **Frontend → API routing** — the static site rewrites `/api/*` requests to the API service automatically (configured in `render.yaml`)

---

## 2. Deploy on Ubuntu VPS / Localhost

Works on Ubuntu 20.04, 22.04, 24.04 and any Debian-based system (including WSL on Windows).

### Step 1 — Install System Dependencies

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Confirm version (must be 20+)
node -v

# Install pnpm
npm install -g pnpm

# Install PostgreSQL
sudo apt install -y postgresql postgresql-contrib

# Install PM2 (keeps the server running after logout)
npm install -g pm2

# Install nginx (routes HTTPS traffic to Node.js)
sudo apt install -y nginx
```

### Step 2 — Set Up PostgreSQL

```bash
sudo -u postgres psql << 'SQL'
CREATE USER bintu WITH PASSWORD 'choose_a_strong_password';
CREATE DATABASE bintupay OWNER bintu;
GRANT ALL PRIVILEGES ON DATABASE bintupay TO bintu;
SQL
```

Test the connection:
```bash
psql "postgres://bintu:choose_a_strong_password@localhost:5432/bintupay" -c '\l'
```

### Step 3 — Clone the Repository

```bash
cd /var/www
sudo git clone https://github.com/YOUR_USERNAME/bintupay.git
sudo chown -R $USER:$USER /var/www/bintupay
cd /var/www/bintupay
```

For **local development** (not a server), clone anywhere:
```bash
git clone https://github.com/YOUR_USERNAME/bintupay.git
cd bintupay
```

### Step 4 — Install Dependencies

```bash
pnpm install
```

### Step 5 — Build the API Server

```bash
# Build ONLY the API server (do NOT use 'pnpm run build' — see note at top)
pnpm --filter @workspace/api-server run build
```

You should see output like:
```
dist/index.mjs    1.4mb
⚡ Done in 400ms
```

### Step 6 — Create Environment File

```bash
cat > /var/www/bintupay/.env << 'EOF'
NODE_ENV=production
PORT=8080
DATABASE_URL=postgres://bintu:choose_a_strong_password@localhost:5432/bintupay
PAYSTACK_SECRET_KEY=sk_live_xxxxxxxxxxxxxxxxxx
TELEGRAM_BOT_TOKEN=1234567890:AABBCCDDxxxxxxxxxxxx
SESSION_SECRET=paste-output-of-command-below
FRONTEND_URL=https://your-domain.com
EOF
```

Generate `SESSION_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 7 — Run Database Migrations

```bash
cd /var/www/bintupay
pnpm --filter @workspace/db run push
```

### Step 8 — Start with PM2

```bash
cd /var/www/bintupay

# Load .env and start
pm2 start artifacts/api-server/dist/index.mjs \
  --name "bintupay-api" \
  --env production \
  -- --env-file /var/www/bintupay/.env

# If your Node.js supports --env-file natively (Node 20+):
pm2 start artifacts/api-server/dist/index.mjs \
  --name "bintupay-api" \
  --node-args="--env-file=/var/www/bintupay/.env"

# Alternatively, export vars first then start:
export $(cat .env | xargs) && pm2 start artifacts/api-server/dist/index.mjs --name "bintupay-api"

# Save so PM2 restarts on reboot
pm2 save
pm2 startup systemd
# Run the command PM2 prints
```

Check it's running:
```bash
pm2 status
pm2 logs bintupay-api
curl http://localhost:8080/api/healthz
```

### Step 9 — Configure Nginx (HTTPS Reverse Proxy)

```bash
sudo tee /etc/nginx/sites-available/bintupay << 'EOF'
server {
    listen 80;
    server_name your-domain.com www.your-domain.com;

    # Serve the React frontend (built static files)
    root /var/www/bintupay/artifacts/bintupay/dist/public;
    index index.html;

    # Forward /api/* to Node.js
    location /api/ {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # All other routes → React app
    location / {
        try_files $uri $uri/ /index.html;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/bintupay /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx
```

### Step 10 — Build the Frontend (for nginx to serve)

```bash
cd /var/www/bintupay
PORT=10000 BASE_PATH=/ NODE_ENV=production \
  pnpm --filter @workspace/bintupay run build
```

### Step 11 — SSL with Certbot (Free HTTPS)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com -d www.your-domain.com
```

### Step 12 — Set Telegram Webhook

```bash
curl -X POST "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://your-domain.com/api/bot","drop_pending_updates":true}'
```

### Step 13 — Firewall

```bash
sudo ufw allow 'Nginx Full'
sudo ufw allow OpenSSH
sudo ufw enable
```

### Updating After Code Changes

```bash
cd /var/www/bintupay
git pull origin main
pnpm install
pnpm --filter @workspace/api-server run build
PORT=10000 BASE_PATH=/ NODE_ENV=production pnpm --filter @workspace/bintupay run build
pm2 restart bintupay-api
```

---

## 3. Deploy on Termux (Android)

> **Note:** Suitable for personal use, testing, or demos. Not recommended for high-traffic production use — Android may kill background processes.

### Step 1 — Install Termux

Download from [F-Droid](https://f-droid.org/packages/com.termux/) (the Play Store version is outdated).

### Step 2 — Install Packages

```bash
pkg update && pkg upgrade -y
pkg install nodejs-lts git postgresql tmux -y
npm install -g pnpm pm2
```

Verify Node.js:
```bash
node -v   # Must be 18+ (Termux provides nodejs-lts)
```

### Step 3 — Set Up PostgreSQL

```bash
# Initialize the database cluster
pg_ctl -D $PREFIX/var/lib/postgresql initdb

# Start PostgreSQL
pg_ctl -D $PREFIX/var/lib/postgresql start

# Create database
createdb bintupay
psql bintupay -c "CREATE USER bintu WITH PASSWORD 'password'; GRANT ALL ON DATABASE bintupay TO bintu;"
```

To auto-start PostgreSQL on Termux open:
```bash
echo 'pg_ctl -D $PREFIX/var/lib/postgresql start' >> ~/.bashrc
```

### Step 4 — Clone & Build

```bash
cd ~
git clone https://github.com/YOUR_USERNAME/bintupay.git
cd bintupay

# Install dependencies
pnpm install

# Build ONLY the API server
pnpm --filter @workspace/api-server run build
```

### Step 5 — Create .env

```bash
cat > ~/bintupay/.env << 'EOF'
NODE_ENV=production
PORT=8080
DATABASE_URL=postgres://bintu:password@localhost:5432/bintupay
PAYSTACK_SECRET_KEY=sk_live_xxxxxxxxxxxxxxxxxx
TELEGRAM_BOT_TOKEN=1234567890:AABBCCDDxxxxxxxxxxxx
SESSION_SECRET=random-32-char-string-here
FRONTEND_URL=https://your-tunnel-url.ngrok-free.app
EOF
```

### Step 6 — Run Migrations

```bash
cd ~/bintupay
pnpm --filter @workspace/db run push
```

### Step 7 — Start the Server (in tmux so it survives app close)

```bash
pkg install tmux
tmux new -s bintupay

# Inside tmux:
cd ~/bintupay
export $(cat .env | xargs) && node artifacts/api-server/dist/index.mjs

# Detach (server keeps running): Ctrl+B then D
# Reattach later: tmux attach -t bintupay
```

### Step 8 — Expose to Internet (Required for Telegram Webhooks)

Your phone needs a public HTTPS URL. Pick one:

**Option A — ngrok (easiest)**
```bash
# In a NEW tmux window (Ctrl+B then C):
pkg install wget
wget https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-arm64.tgz
tar xf ngrok-v3-stable-linux-arm64.tgz
./ngrok http 8080
# Copy the https://xxxxx.ngrok-free.app URL
```

**Option B — Cloudflare Tunnel (free, no account needed)**
```bash
pkg install cloudflare-warp
cloudflared tunnel --url http://localhost:8080
# Copy the https://random-name.trycloudflare.com URL
```

### Step 9 — Set Telegram Webhook

```bash
curl -X POST "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://YOUR_TUNNEL_URL/api/bot","drop_pending_updates":true}'
```

### Step 10 — Keep Termux Alive

```bash
# Prevent Android from killing Termux in background
termux-wake-lock

# In Android Settings → Battery → BintuPay/Termux → Disable battery optimization
```

---

## Post-Deploy Checklist

Run these after any deployment to confirm everything works:

```bash
# 1. Health check
curl https://your-domain.com/api/healthz
# Expected: {"status":"ok","service":"bintupay-api","timestamp":"..."}

# 2. Check Telegram webhook
curl "https://api.telegram.org/botYOUR_TOKEN/getWebhookInfo"
# Expected: {"ok":true,"result":{"url":"https://...","has_custom_certificate":false,...}}

# 3. Test M-Pesa endpoint
curl -X POST https://your-domain.com/api/payment?action=charge \
  -H "Content-Type: application/json" \
  -d '{"amount":"10","phone":"0712345678"}'
# Expected: {"status":true,"data":{"reference":"...","status":"pay_offline",...}}

# 4. Test bot — open Telegram and send /start to your bot
```

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `PORT environment variable is required` | Running `pnpm run build` at root level | Use `pnpm --filter @workspace/api-server run build` instead |
| `BASE_PATH environment variable is required` | Same root build issue | Same fix as above |
| `PAYSTACK_SECRET_KEY is not configured` | Missing env var | Add to `.env` or Render environment |
| `DATABASE_URL` connection error | Postgres not running or wrong URL | Run `sudo systemctl status postgresql` |
| Paystack returns 401 | Wrong or test key used with live endpoint | Use `sk_live_` key, not `sk_test_` |
| Telegram bot not responding | Webhook not set or wrong URL | Re-run the `setWebhook` curl command |
| Frontend shows blank page | Frontend not built | Run the bintupay build command with PORT and BASE_PATH |
| `frozen-lockfile` fails on install | Lockfile out of sync | Run `pnpm install` (without `--frozen-lockfile`) once, commit `pnpm-lock.yaml` |
| PM2 can't find `.env` | Wrong path | Use `export $(cat .env | xargs)` before `pm2 start` |
| Render service sleeps | Free tier limitation | Upgrade to Starter plan ($7/mo) for always-on |

---

## Architecture

```
Browser / Telegram
        |
        v (HTTPS)
[ Nginx  OR  Render Proxy ]
        |
        +---> GET /*         → React frontend (static files)
        |
        +---> /api/payment   → Express: Paystack M-Pesa / Card charge
        +---> /api/bot       → Express: Telegram webhook handler
        +---> /api/healthz   → Express: health check
        |
        v
[ PostgreSQL ]  (transaction history, sessions)
        |
        v
[ Paystack API ]  (payment processing, verification)
[ Telegram API ]  (bot messages, buttons)
```

On **Render**: two services (`bintupay-web` static + `bintupay-api` Node.js) + one managed Postgres.  
On **VPS / Ubuntu**: Nginx serves static files and proxies `/api/*` to Node.js PM2 process.  
On **Termux**: Node.js runs directly, tunnel (ngrok/cloudflared) provides the public HTTPS URL.
