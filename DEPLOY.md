# BintuPay Deployment Guide

This guide covers deploying BintuPay (API + frontend) on **Render**, **Ubuntu VPS**, and **Termux**.

---

## What You Need

| Requirement | Where to get it |
|-------------|-----------------|
| **Node.js 20+** | Install via NodeSource or nvm |
| **pnpm** | `npm i -g pnpm` |
| **PostgreSQL 14+** | Render provides this; on VPS install `postgresql` |
| **Paystack Secret Key** | [paystack.com](https://paystack.com) → Settings → API Keys |
| **Telegram Bot Token** | [@BotFather](https://t.me/botfather) → /newbot |
| **GitHub repo** (optional) | Push your code for Render auto-deploy |

### Required Environment Variables

```bash
DATABASE_URL=postgres://user:pass@host:5432/dbname
PAYSTACK_SECRET_KEY=sk_test_xxxxxxxxx
TELEGRAM_BOT_TOKEN=xxxxxxxx:xxxxxxxxxxxxxxxx
SESSION_SECRET=any-random-string-32-chars-plus
FRONTEND_URL=https://your-domain.com          # optional — used by Telegram bot for card links
PORT=8080                                      # API server port
```

---

## 1. Deploy on Render (Easiest — Free tier available)

### Step 1: Push to GitHub

```bash
git remote add origin https://github.com/YOURNAME/bintupay.git
git push -u origin main
```

### Step 2: Create Render Services

Go to [dashboard.render.com](https://dashboard.render.com) and create:

#### A. PostgreSQL Database
1. Click **New** → **PostgreSQL**
2. Name it `bintupay-db`
3. Choose region (same as your web service)
4. Create → copy the **Internal Database URL** (looks like `postgres://bintupay:pass@dpg-xxxxx-a.oregon-postgres.render.com/bintupay_xxxxx`)

#### B. Web Service (API + Frontend)
1. Click **New** → **Web Service**
2. Connect your GitHub repo
3. Configure:

| Setting | Value |
|---------|-------|
| **Name** | `bintupay-api` |
| **Runtime** | `Node` |
| **Build Command** | `pnpm install && pnpm run build` |
| **Start Command** | `node artifacts/api-server/dist/index.mjs` |
| **Plan** | Free (or paid for always-on) |

4. Add **Environment Variables**:
   - `DATABASE_URL` → paste the Postgres URL from Step A
   - `PAYSTACK_SECRET_KEY` → your Paystack test/live key
   - `TELEGRAM_BOT_TOKEN` → from @BotFather
   - `SESSION_SECRET` → generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `FRONTEND_URL` → your Render service URL (e.g. `https://bintupay-api.onrender.com`)
   - `NODE_ENV` → `production`

5. Click **Create Web Service**

Render auto-deploys on every `git push`.

### Step 3: Set Telegram Webhook

Once your Render URL is live:

```bash
curl -X POST "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://bintupay-api.onrender.com/api/bot"}'
```

### Step 4: Run Database Migrations

In Render dashboard, open your service shell and run:

```bash
pnpm --filter @workspace/db run push
```

Or if migrations fail, use:

```bash
npx drizzle-kit push
```

---

## 2. Deploy on Ubuntu VPS (DigitalOcean, Linode, AWS EC2, Hetzner)

### Step 1: Provision Server

Get an Ubuntu 22.04/24.04 VPS with at least:
- 1 CPU, 1GB RAM, 20GB SSD

SSH in:

```bash
ssh root@your-server-ip
```

### Step 2: Install Dependencies

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Install pnpm
npm install -g pnpm

# Install PostgreSQL
apt install -y postgresql postgresql-contrib

# Install PM2 (process manager)
npm install -g pm2

# Install nginx (reverse proxy)
apt install -y nginx
```

### Step 3: Set Up PostgreSQL

```bash
# Switch to postgres user
su - postgres

# Create database and user
psql -c "CREATE USER bintu WITH PASSWORD 'strong_password_here';"
psql -c "CREATE DATABASE bintupay OWNER bintu;"
psql -c "ALTER USER bintu WITH SUPERUSER;"
exit
```

### Step 4: Clone & Build

```bash
cd /var/www
git clone https://github.com/YOURNAME/bintupay.git
cd bintupay

# Install all dependencies
pnpm install

# Build everything
pnpm run build
```

### Step 5: Create Environment File

```bash
cat > .env << 'EOF'
NODE_ENV=production
DATABASE_URL=postgres://bintu:strong_password_here@localhost:5432/bintupay
PAYSTACK_SECRET_KEY=sk_test_xxxxxxxxx
TELEGRAM_BOT_TOKEN=xxxxxxxx:xxxxxxxxxxxxxxxx
SESSION_SECRET=your-random-32-char-secret
FRONTEND_URL=https://your-domain.com
PORT=8080
EOF
```

### Step 6: Run Database Migrations

```bash
pnpm --filter @workspace/db run push
```

If this fails, try:
```bash
cd lib/db && npx drizzle-kit push
```

### Step 7: Start API Server with PM2

```bash
pm2 start artifacts/api-server/dist/index.mjs --name "bintupay-api" -- --port 8080

# Save PM2 config
pm2 save
pm2 startup systemd
```

### Step 8: Configure Nginx Reverse Proxy

```bash
cat > /etc/nginx/sites-available/bintupay << 'EOF'
server {
    listen 80;
    server_name your-domain.com www.your-domain.com;

    location / {
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
}
EOF

ln -s /etc/nginx/sites-available/bintupay /etc/nginx/sites-enabled/
rm /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx
```

### Step 9: SSL with Certbot (Free HTTPS)

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d your-domain.com -d www.your-domain.com
```

### Step 10: Set Telegram Webhook

```bash
curl -X POST "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://your-domain.com/api/bot"}'
```

### Step 11: Update Firewall

```bash
ufw allow 'Nginx Full'
ufw allow OpenSSH
ufw enable
```

### Useful PM2 Commands

```bash
pm2 status                    # See running processes
pm2 logs bintupay-api       # View logs
pm2 restart bintupay-api    # Restart after code changes
pm2 stop bintupay-api       # Stop the service
```

---

## 3. Deploy on Termux (Android Phone/Tablet)

> **Warning**: Running a production payment gateway on a phone is NOT recommended for real customers. Use this only for testing, demos, or personal use.

### Step 1: Install Termux

Download from [F-Droid](https://f-droid.org/packages/com.termux/) (not Play Store — it's outdated).

### Step 2: Install Packages

Open Termux and run:

```bash
pkg update && pkg upgrade -y
pkg install nodejs git postgresql nginx -y
npm install -g pnpm pm2
```

### Step 3: Set Up PostgreSQL

```bash
# Initialize database
pg_ctl -D $PREFIX/var/lib/postgresql initdb

# Start PostgreSQL
pg_ctl -D $PREFIX/var/lib/postgresql start

# Create database
createdb bintupay
createuser bintu
```

### Step 4: Clone & Build

```bash
cd ~
git clone https://github.com/YOURNAME/bintupay.git
cd bintupay
pnpm install
pnpm run build
```

### Step 5: Create .env

```bash
cat > .env << 'EOF'
NODE_ENV=production
DATABASE_URL=postgres://bintu@localhost:5432/bintupay
PAYSTACK_SECRET_KEY=sk_test_xxxxxxxxx
TELEGRAM_BOT_TOKEN=xxxxxxxx:xxxxxxxxxxxxxxxx
SESSION_SECRET=your-random-secret-here
FRONTEND_URL=http://localhost:8080
PORT=8080
EOF
```

### Step 6: Run Migrations

```bash
pnpm --filter @workspace/db run push
```

### Step 7: Start the Server

```bash
pm2 start artifacts/api-server/dist/index.mjs --name "bintupay" -- --port 8080
pm2 save
```

### Step 8: Expose to Internet (Optional)

For Telegram webhooks to reach your phone, you need a public URL. Options:

**Option A: ngrok (easiest)**
```bash
pkg install ngrok
ngrok http 8080
# Copy the HTTPS URL, then set webhook:
curl -X POST "https://api.telegram.org/botYOUR_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://your-ngrok-url.ngrok-free.app/api/bot"}'
```

**Option B: LocalTunnel (free, no signup)**
```bash
npm install -g localtunnel
lt --port 8080
```

**Option C: Cloudflare Tunnel**
```bash
# Install cloudflared
pkg install cloudflared
cloudflared tunnel --url http://localhost:8080
```

### Step 9: Keep Termux Running

Android kills background apps. To keep BintuPay alive:

1. **Disable battery optimization** for Termux in Android Settings
2. **Acquire wake lock** in Termux:
   ```bash
   termux-wake-lock
   ```
3. **Run in a tmux session** (survives closing the app):
   ```bash
   pkg install tmux
   tmux new -s bintupay
   # Inside tmux:
   node artifacts/api-server/dist/index.mjs
   # Press Ctrl+B then D to detach
   # Reattach later: tmux attach -t bintupay
   ```

---

## Post-Deploy Checklist

After any deployment, verify everything works:

```bash
# 1. Health check
curl https://your-domain.com/api/healthz

# 2. Check Telegram webhook
curl "https://api.telegram.org/botYOUR_TOKEN/getWebhookInfo"

# 3. Test a payment (use Paystack test mode)
curl -X POST https://your-domain.com/api/payment?action=charge \
  -H "Content-Type: application/json" \
  -d '{"amount":100,"phone":"+254712345678"}'

# 4. Check logs
pm2 logs bintupay-api   # or
journalctl -u bintupay-api -f   # if using systemd
```

---

## Updating After Code Changes

```bash
cd /var/www/bintupay   # or wherever you cloned
git pull origin main
pnpm install
pnpm run build
pm2 restart bintupay-api
```

For **Render**: Just `git push origin main` — Render auto-deploys.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `PORT not set` | Add `PORT=8080` to environment variables |
| `DATABASE_URL` error | Check Postgres is running: `sudo systemctl status postgresql` |
| Paystack charges fail | Verify `PAYSTACK_SECRET_KEY` starts with `sk_test_` or `sk_live_` |
| Telegram not responding | Check webhook URL: `curl botAPI/getWebhookInfo` |
| Frontend 404 on refresh | Nginx is proxying correctly — check `location /` block |
| Build fails | Run `pnpm install` again, ensure Node.js 20+ |
| CORS errors | The API has CORS enabled by default — check `FRONTEND_URL` env var |

---

## Architecture on Production

```
User/Phone
    |
    v
[ Nginx / Render Proxy ]  <-- HTTPS
    |
    +---> [ BintuPay API Server :8080 ]
    |       +-- /api/payment (Paystack)
    |       +-- /api/bot (Telegram webhook)
    |       +-- /api/healthz
    |
    +---> [ React Frontend ] (served by API or separate nginx)
    |
[ PostgreSQL ]
```

On Render, everything runs in one Web Service.  
On VPS, Nginx handles HTTPS and routes to the Node.js API.
