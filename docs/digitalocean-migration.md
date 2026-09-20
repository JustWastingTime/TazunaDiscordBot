# Migrating off AWS (EC2) onto a DigitalOcean droplet

Runtime: one Node process (`scripts/app.js`) that also serves the club dashboard on
port 3000. There are **no AWS services in this codebase** — no `@aws-sdk`, no S3, no
DynamoDB, no RDS, nothing reads `AWS_*` env vars. The AWS side is a plain EC2
instance running a checkout, so "moving the data" means copying files.

## 1. What actually holds state

Everything below is either gitignored or edited in place on the host, so it will
**not** arrive via `git clone`.

| Path | Contents |
| --- | --- |
| `data/` | All bot state — see list below |
| `.env` | Discord token, `APP_ID`, `PUBLIC_KEY`, `OCR_SPACE_KEY`, `UMA_API_KEY`, dashboard OAuth secrets |
| `config.json` | `applicationChannel`, `leaderboardChannel`, `leaderboardClubs`, `leaderboardMessageId` |
| `assets/skillemotes.json` | Custom emoji map |
| `assets/generated/skill-maps/` | Gitignored rendered maps |
| `web/dashboard/` | Built frontend — **rebuild it, do not copy it** |

`data/` files (one JSON file per feature, all written by the bot at runtime):

```
application-channels.json   applications.json        circle-targets.json
dashboard.json              event-channels.json      event-posts.json
event-runtime.json          guild-clubs.json         leaderboard-channels.json
mine-alarm.json             premium-guilds.json      quiz-guilds.json
quiz-state.json             schedule-cache.json      signups.json
skill-cm-range.json         user-links.json
```

`data/tazuna.db` is a **leftover SQLite file** — nothing in the bot imports
`better-sqlite3` or opens it any more (the bot is pure JSON). Copy it for safety,
but it is dead weight.

## 2. What is *not* on EC2

The club dashboard currently deployed free on Vercel keeps its data in **Neon
Postgres** (`DATABASE_URL`), not on the EC2 box. A droplet-only migration will not
carry applicants, planning boards, blacklist, tournaments, member links, staff or
theme settings across. See section 5.

The Vercel dashboard also has a local-only SQLite workspace
(`UmaClubDashboard/data/dashboard.sqlite`) — that is the offline planner app on your
PC, never deployed.

## 3. The droplet

The $12/month Basic tier (2 GB RAM / 1 vCPU / 50 GB SSD) is the right size for bot +
dashboard in one process — it matches what `deploy/setup-swap.sh` already recommends
("resize to 2 GB before selling premium dashboards"). Confirm current specs on the
DigitalOcean pricing page. Ubuntu 24.04 LTS. **Attach a Reserved IP** before you
touch DNS.

```bash
# as an existing sudo user — do NOT create a new user if one already exists,
# and do NOT install nginx if Caddy already owns 80/443 (see section 7).
sudo apt update && sudo apt install -y curl git rsync
node -v          # must be >= 18; only install Node 20 if it is missing or older
sudo npm i -g pm2
```

Do **not** run `su root` — Ubuntu ships with no root password, so it always fails.
Use `sudo`.

`deploy/setup-swap.sh` lives in the repo, so run it right after cloning (section 4):

```bash
sudo bash deploy/setup-swap.sh 2
```

If the droplet already has swap, the script detects it via `swapon --show` and exits
without changes — safe to run either way. Equivalently, inline:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Node 20 because `package.json` requires `>=18` and `dashboard:build` uses
`fs.cpSync` (Node 16.7+).

## 4. Copy the bot from EC2

`deploy/migrate-from-ec2.sh` does this. It rsyncs `data/`, `.env`, `config.json`,
`assets/skillemotes.json` and `assets/generated/`. Two ways to run it:

**A. Droplet pulls from EC2** (needs the EC2 key on the droplet):

```bash
ssh -i ~/.ssh/ec2.pem tazuna@<EC2_IP> 'pm2 stop tazuna'   # stop BEFORE the final pass
EC2_HOST=tazuna@<EC2_IP> EC2_PATH=~/TazunaDiscordBot \
LOCAL_PATH=/home/tazuna/TazunaDiscordBot \
bash deploy/migrate-from-ec2.sh
```

**B. Your PC relays it** (both keys local) — clone the repo onto the droplet first,
then from the droplet run the script pulling from EC2; or rsync EC2 → PC and PC →
droplet with `rsync -avz --exclude node_modules`.

Notes:

- Do a **first pass while the old bot is still running**, then stop it on EC2 and
  re-run with `FINAL=1` so you do not lose writes made mid-copy.
- `rsync` over SSH needs port 22 reachable on the EC2 security group from the
  droplet's IP. Add it temporarily, remove it after.
- Never rsync `node_modules/` — run `npm ci` on the droplet instead.

Then, with `UmaClubDashboard` cloned as a **sibling directory** — `dashboard:build`
is `npm --prefix ../UmaClubDashboard run build`, and that build is `tsc -b && vite
build`, so the dashboard's own devDependencies must be installed too:

```bash
cd /home/tazuna
git clone <your-fork-url> TazunaDiscordBot
git clone <your-fork-url> UmaClubDashboard

cd /home/tazuna/TazunaDiscordBot && npm ci
cd /home/tazuna/UmaClubDashboard && npm ci        # required, not just for local dev

cd /home/tazuna/TazunaDiscordBot
npm run dashboard:build     # builds ../UmaClubDashboard and copies dist -> web/dashboard
pm2 start deploy/ecosystem.config.cjs
pm2 save && pm2 startup
```

`web/dashboard/` is build output and gitignored apart from a `.gitkeep`, so this
step is why the folder has to be rebuilt rather than copied off EC2.

`app.js` already mounts the dashboard in-process (`mountDashboard(app)`, wired at
line ~735), so this one process serves the bot *and* the dashboard. There is no
second service to run.

## 5. Migrating the dashboard data out of Neon

This is the piece no script handles yet. The bot's dashboard store
(`scripts/dashboardStore.js` → `data/dashboard.json` and
`scripts/applicationStorage.js` → `data/applications.json`) is JSON, while the
Vercel app reads Postgres via `api/_lib/db.ts`. The table shapes differ, so a dump
has to be transformed — there is no importer in the repo.

Export first:

```bash
pg_dump "$DATABASE_URL" --no-owner --no-acl -Fc -f dashboard.dump
pg_restore -l dashboard.dump     # see the table list
```

Tables the bot cares about: `applicants`, `clubs`, `planning`/assignments,
`blacklist`, `member_links`, `member_profiles`, `staff`, `site_theme`,
`tournaments`, `tournament_players`, `tournament_picks`.

Two options:

1. **Write a one-off importer** that reads the Postgres rows and writes the JSON
   shapes `dashboardStore.js` expects. Cleanest long-term, since the droplet then
   owns the data.
2. **Keep Neon** and leave the Vercel app as the dashboard, with the droplet only
   running the bot. Cheapest path, but the dashboard is then not "connected" to the
   bot, which is what you asked for.

Option 1 is the actual goal and is a self-contained script — ask and I'll write it
against the real table schemas.

## 6. Env vars the dashboard needs

The bot's `.env.sample` documents these; none are set in the current local `.env`,
so the dashboard will 500 until they exist:

```
DISCORD_CLIENT_ID=            # or reuse APP_ID
DISCORD_CLIENT_SECRET=
DASHBOARD_SESSION_SECRET=     # long random string (SESSION_SECRET also accepted)
DASHBOARD_PUBLIC_URL=https://dash.example.com   # SITE_URL also accepted
DASHBOARD_SEED_GUILD_ID=      # optional: seed clubs.json into this guild
DASHBOARD_MAX_CLUBS=8
DASHBOARD_CACHE_MS=300000
UMA_API_KEY=                  # also required for /register, /profile, leaderboards
PREMIUM_GUILD_IDS=            # comma-separated; gates the dashboard per guild
```

## 7. Reverse proxy, TLS and cutover

### 7a. Droplet already running Caddy (existing site)

Skip `deploy/nginx-tazuna.conf` entirely — installing nginx would fight Caddy for
ports 80/443. Add a site block to the **existing** Caddyfile and reload, so the site
you already host stays up.

```bash
cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak     # always back up first
```

Append (same process serves both hostnames). Note the port: **3010**, because a
droplet that already runs a site often has 3000 occupied by it. Check with
`sudo ss -tlnp` and use whatever free port matches `PORT` in
`deploy/ecosystem.config.cjs`:

```caddyfile
bot.example.com, dash.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:3010
}
```

Then:

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy      # reload, not restart — keeps the existing site served
```

Caddy issues the certificates automatically once DNS resolves, so **point DNS at the
droplet before reloading**. Check for a pre-existing catch-all block (`:443` with no
hostname) if your new hostnames do not pick up a cert.

### 7b. Fresh droplet, no proxy yet

Use the bundled config: `deploy/nginx-tazuna.conf` already proxies
`bot.example.com` and `dash.example.com` to `127.0.0.1:3000` — change its `upstream`
port to match `PORT` in `deploy/ecosystem.config.cjs` (3010 by default). Replace the
hostnames, symlink into `sites-enabled`, then `certbot --nginx -d bot.example.com -d
dash.example.com`.

### 7c. Cutover (both paths)

1. Point DNS A records at the Reserved IP — add the two subdomains only; do not
   touch the records for the site you already host.
2. Ensure TLS is serving both hostnames.
3. Discord app → **Interactions Endpoint URL** = `https://bot.example.com/interactions`
4. Discord app → OAuth2 redirect = `https://dash.example.com/api/auth/callback`
5. `npm run register`
6. Verify slash commands, quiz, gamba and clubs, **then** terminate the EC2
   instance and release its Elastic IP.

Do not terminate EC2 until step 6 passes; that instance is your only copy of `data/`.

## 8. Watch-outs

- **Secrets are sitting in plaintext** in both `.env` files on this machine
  (Discord bot token, `UMA_API_KEY`, `OCR_SPACE_KEY`). They are gitignored, so they
  should not be in git history — but if that token was ever shared, rotate it in the
  Discord developer portal before cutover. Update the droplet `.env` after rotating.
- Single Node process, `max_memory_restart: '700M'` in pm2 — on a 2 GB box the
  dashboard plus map rendering plus cron jobs can spike. Swap is mandatory.
- `data/` is the entire bot state with no database underneath it. Back it up
  (cron a `tar` of `data/`) before you need it — there is no WAL or replica.
