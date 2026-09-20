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
# build-essential is required: UmaClubDashboard lists better-sqlite3 as a runtime
# dependency, and npm falls back to `node-gyp rebuild` when no prebuilt binary
# matches the installed Node ABI. Without `make` the install fails with
# "gyp ERR! not ok ... not found: make".
sudo apt update && sudo apt install -y curl git rsync build-essential
node -v          # must be >= 18; only install Node 20 if it is missing or older
sudo npm i -g pm2
```

`build-essential` pulls in `make`, `gcc`/`g++` and the libc headers; `python3` is
already present on Ubuntu 24.04. Compiling better-sqlite3 is memory-hungry, so do
the swap step below **before** any `npm ci`.

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

There is no database to export — the bot's entire live state is JSON files under
`data/`. `deploy/migrate-from-ec2.sh` rsyncs `data/`, `.env`, `config.json`,
`assets/skillemotes.json` and `assets/generated/`. `node_modules/` is never copied.

### 4a. The three variables

| Variable | Value | Where to find it |
| --- | --- | --- |
| `EC2_HOST` | `<ssh-user>@<ip>` | AWS Console → EC2 → Instances → select it → **Connect** → **SSH client** tab prints the literal `ssh -i "key.pem" <user>@<host>` line. User is `ec2-user` on Amazon Linux, `ubuntu` on Ubuntu AMIs. |
| `EC2_PATH` | absolute path of the checkout on EC2 | `ssh <user>@<ip> 'pm2 describe tazuna \| grep -iE "script path\|exec cwd"'` — pm2 records the working directory. `ps -ef \| grep app.js` also works. |
| `LOCAL_PATH` | `$HOME/TazunaDiscordBot` on the droplet | `echo $HOME` |

### 4b. What the script assumes

- `rsync` installed **on both ends**. The droplet got it in step 3; check EC2 with
  `ssh <user>@<ip> 'rsync --version | head -1'`.
- Port 22 on the EC2 security group open to **the droplet's IP only**, not the world.
  Remove the rule when finished.
- **SSH must find your key without being told.** The script calls bare `rsync` with no
  `-i` flag, so a key at a non-default path is ignored and you get
  `Permission denied (publickey)`. Fix with `RSYNC_RSH` (4c) or `~/.ssh/config`.
- `${EC2_PATH}/data/` must exist. The first `rsync` has no `|| true` and the script
  runs under `set -euo pipefail`, so a wrong path aborts immediately.

### 4c. Get the EC2 key onto the droplet

When the key is not there, ssh says so and copies nothing:

```
Warning: Identity file /home/deploy/.ssh/ec2-key.pem not accessible: No such file or directory
```

Check what the droplet actually has first:

```bash
ls -la ~/.ssh/
```

**Option A — copy the existing `.pem` from Windows.** Name the destination file
explicitly, or `scp` puts it under its original name:

```powershell
scp C:\path\to\ec2-key.pem deploy@159.223.94.94:/home/deploy/.ssh/ec2-key.pem
```

```bash
# on the droplet
chmod 600 ~/.ssh/ec2-key.pem
head -1 ~/.ssh/ec2-key.pem   # must say BEGIN OPENSSH PRIVATE KEY or BEGIN RSA PRIVATE KEY
export RSYNC_RSH="ssh -i $HOME/.ssh/ec2-key.pem"
```

A PuTTY `.ppk` is **not** usable by `ssh -i`. Convert it in PuTTYgen: **Load** the
`.ppk` → **Conversions → Export OpenSSH key** → save as `ec2-key.pem`. If the file
starts with `PuTTY-User-Key-File`, it is still a `.ppk`.

**Option B — generate a key on the droplet and authorise it on EC2.** No transfer:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/ec2-key -N ""
cat ~/.ssh/ec2-key.pub
```

Paste that line into the EC2 user's `~/.ssh/authorized_keys` — easiest through the AWS
console (**EC2 → select instance → Connect → EC2 Instance Connect**, a browser shell).
Then set `RSYNC_RSH="ssh -i $HOME/.ssh/ec2-key"`.

> The commands in 4d–4g are written with `~/.ssh/ec2-key.pem`, which is only a
> placeholder for *whatever private key file you actually created*. Option B produces
> `~/.ssh/ec2-key` with no extension. Substitute your real filename everywhere; a
> mismatch prints `Warning: Identity file ... not accessible: No such file or directory`
> and copies nothing.

**Option C — an ssh config entry** on the droplet, so `EC2_HOST=ec2tazuna` and no
`RSYNC_RSH` is needed:

```
Host ec2tazuna
    HostName <ec2-ip>
    User <ssh-user>
    IdentityFile ~/.ssh/ec2-key.pem
```


### 4d. Preflight — before touching anything

```bash
ssh -i ~/.ssh/ec2-key.pem <user>@<ip> \
  'hostname; rsync --version | head -1; ls -la <EC2_PATH>/data | head'
```

This confirms connectivity, rsync on EC2, and that `data/` is where you think it is.
Preview the transfer without writing:

```bash
rsync -avz --dry-run --stats "$EC2_HOST:<EC2_PATH>/data/" "$LOCAL_PATH/data/"
```

### 4e. Pass 1 — while the old bot is still running

```bash
cd ~/TazunaDiscordBot
export RSYNC_RSH="ssh -i $HOME/.ssh/ec2-key.pem"
EC2_HOST=<ssh-user>@<ec2-ip> \
EC2_PATH=/home/<ssh-user>/TazunaDiscordBot \
LOCAL_PATH=$HOME/TazunaDiscordBot \
bash deploy/migrate-from-ec2.sh
```

The trailing `\` is load-bearing: the `VAR=value` pairs only reach the script's
environment because they prefix the command on the *same* logical line. Setting them
on separate lines creates plain shell variables that child processes never inherit,
and the script fails with:

```
deploy/migrate-from-ec2.sh: line 11: EC2_HOST: set EC2_HOST e.g. ec2-user@1.2.3.4
```

Either keep the backslashes, or `export` each one on its own line. Check with
`echo "$EC2_HOST"` — an empty line means it is not set.

This **overwrites `$LOCAL_PATH/.env`** with the one from EC2 — that is how the
credentials arrive, so do not hand-write `.env` first.

### 4f. Pass 2 — after stopping the old bot

```bash
ssh -i ~/.ssh/ec2-key.pem <user>@<ip> 'pm2 stop tazuna'

FINAL=1 EC2_HOST=<ssh-user>@<ec2-ip> \
  EC2_PATH=/home/<ssh-user>/TazunaDiscordBot \
  LOCAL_PATH=$HOME/TazunaDiscordBot \
  bash deploy/migrate-from-ec2.sh
```

Only `data/` is re-synced here, which is correct — nothing else changes while the bot
runs. If the droplet cannot reach EC2 at all, fall back to relaying through your PC
(`scp -r` EC2 → PC → droplet); keep `node_modules/` out of it.

### 4g. Verify the copy

```bash
du -sh ~/TazunaDiscordBot/data && ls ~/TazunaDiscordBot/data
ssh -i ~/.ssh/ec2-key.pem <user>@<ip> 'du -sh <EC2_PATH>/data && ls <EC2_PATH>/data'
```

The two listings should match, and the droplet must not be smaller. Check the file
names against the inventory in section 1, and confirm `.env` exists.


### 4h. Build and start

With both repos cloned as siblings (step 3) and dependencies installed, build the
dashboard and start the bot. `dashboard:build` is
`npm --prefix ../UmaClubDashboard run build` (which is `tsc -b && vite build`) and
then copies `dist` into `web/dashboard`:

```bash
cd ~/TazunaDiscordBot
npm run dashboard:build
pm2 start deploy/ecosystem.config.cjs    # listens on 3010 — see step 7
pm2 save && pm2 startup
```

If pm2 was already managing another site on this droplet, `pm2 ls` will show both, and
`pm2 save` preserves both across a reboot. Verify the app answers on `127.0.0.1:3010`
before putting Caddy in front of it (step 7).


`web/dashboard/` is build output and gitignored apart from a `.gitkeep`, so this
step is why the folder has to be rebuilt rather than copied off EC2.

`app.js` already mounts the dashboard in-process (`mountDashboard(app)`, wired at
line ~735), so this one process serves the bot *and* the dashboard. There is no
second service to run.

### 4i. Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Warning: Identity file ... not accessible` | Wrong key path/filename, or the key is still on your PC. See 4c. |
| `ssh: connect to host ... port 22: Connection timed out` | Packets dropped: the **security group** has no SSH rule for the droplet's IP, or the instance is stopped. `Connection refused` instead would mean sshd is down. |
| `Permission denied (publickey)` | The network is fine; the key is not in that user's `authorized_keys`. See 4c. |
| `rsync: command not found` | Install `rsync` on EC2. |
| `rsync error: unexplained error (code 255)` immediately after a timeout | rsync could not open the SSH connection at all — fix the transport, not the paths. |

`timed out` is the key distinction: it is a firewall drop, not an authentication
failure, so no amount of key fixing will help. The security group needs
**SSH / TCP / 22 / `<droplet-ip>/32`**. Confirm the droplet's **egress** address before
adding it — AWS matches the source IP it actually sees, which can differ from the one
in your login banner:

```bash
curl -4 -s https://ifconfig.me; echo
```

Do not widen the rule to `0.0.0.0/0`; scope it to that single address and remove it
when the migration is done.

Quick port test, no rsync or key involved:

```bash
timeout 10 bash -c 'cat < /dev/null > /dev/tcp/<ec2-ip>/22' \
  && echo 'port 22 reachable' || echo 'blocked or filtered'
```

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
