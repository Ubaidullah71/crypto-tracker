# Running on a VPS

The bot only makes outgoing connections (to Discord and to public blockchain and price APIs) and
keeps a small SQLite database, so any small VPS works. 1 vCPU, 1 GB RAM and a few GB of disk are
plenty for a personal setup. No inbound ports are needed besides your own remote access (SSH or
RDP).

Run the bot on one machine at a time. Two copies with the same database or token would both post
notifications.

- [Linux (Debian / Ubuntu)](#linux-debian--ubuntu)
- [Windows Server](#windows-server)
- [Moving from another computer](#moving-from-another-computer)

Before you start, check that your provider allows always-on applications on your plan. The bot
does not mine anything; it only reads public data.

## Linux (Debian / Ubuntu)

Written for Debian 12 and Ubuntu 22.04 / 24.04. Commands assume a user with `sudo`.

### 1. Prepare the server

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install git curl ca-certificates unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades      # automatic security updates

# Node.js 24 from NodeSource (x86 and ARM)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt -y install nodejs
node -v                                              # v24.x
```

The Node.js in the default Debian/Ubuntu repositories is usually too old (22.18 or newer is
required).

### 2. Install the bot

A dedicated user without a login shell keeps the bot separate from everything else:

```bash
sudo useradd --system --create-home --home-dir /opt/crypto-portfolio --shell /usr/sbin/nologin cryptobot
sudo -u cryptobot git clone https://github.com/Ubaidullah71/crypto-tracker.git /opt/crypto-portfolio/app
cd /opt/crypto-portfolio/app
sudo -u cryptobot npm ci --omit=dev
```

### 3. Configure

```bash
sudo -u cryptobot cp .env.example .env
sudo -u cryptobot nano .env            # DISCORD_TOKEN, DISCORD_CLIENT_ID, OWNER_IDS, ...
sudo chmod 600 .env
```

Copy your wallet list from your own computer:

```bash
scp wallets.txt you@your-server:/tmp/wallets.txt
ssh you@your-server 'sudo install -o cryptobot -g cryptobot -m 600 /tmp/wallets.txt /opt/crypto-portfolio/app/wallets.txt && rm /tmp/wallets.txt'
```

Or skip this: a template is created on first start, and `/wallet add` works too.

Optional first run in the foreground to see that everything connects (Ctrl+C to stop):

```bash
sudo -u cryptobot npm start
```

### 4. Run as a service

The unit file in `deploy/` expects the bot in `/opt/crypto-portfolio/app`, run by `cryptobot`.
Adjust `WorkingDirectory`, `ExecStart` and `ReadWritePaths` if you chose other paths.

```bash
sudo cp deploy/crypto-portfolio.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now crypto-portfolio
sudo systemctl status crypto-portfolio
journalctl -u crypto-portfolio -f        # live logs (Ctrl+C stops watching, not the bot)
```

The service restarts after a crash and starts again after a reboot.

### 5. Update

```bash
cd /opt/crypto-portfolio/app
sudo -u cryptobot git pull
sudo -u cryptobot npm ci --omit=dev
sudo systemctl restart crypto-portfolio
```

Database changes are applied automatically on start.

### 6. Back up

A daily copy of the database, `.env` and `wallets.txt`, kept for 14 days:

```bash
sudo mkdir -p /var/backups/crypto-portfolio
sudo tee /etc/cron.daily/crypto-portfolio-backup > /dev/null <<'EOF'
#!/bin/sh
set -e
APP=/opt/crypto-portfolio/app
DEST=/var/backups/crypto-portfolio/$(date +%F)
mkdir -p "$DEST"
cp -a "$APP/data" "$APP/.env" "$APP/wallets.txt" "$DEST"/ 2>/dev/null || true
chmod -R go-rwx /var/backups/crypto-portfolio
find /var/backups/crypto-portfolio -mindepth 1 -maxdepth 1 -mtime +14 -exec rm -rf {} +
EOF
sudo chmod +x /etc/cron.daily/crypto-portfolio-backup
```

Copy backups off the server now and then. They contain your addresses and history.

### 7. Security checklist

- SSH with keys only (`PasswordAuthentication no` in `/etc/ssh/sshd_config`), and a firewall
  that allows only SSH inbound, for example `sudo ufw allow OpenSSH && sudo ufw enable`.
- `.env` and `wallets.txt` readable only by `cryptobot` (`chmod 600`).
- The service runs unprivileged with a read-only view of the system (see the unit file).
- **Public Bot** turned off in the Discord Developer Portal.
- Server and bot kept up to date.

## Windows Server

Written for Windows Server 2019 and newer. Use an administrator PowerShell.

### 1. Install Node.js and Git

```powershell
winget install --id OpenJS.NodeJS.LTS -e     # or the 24.x installer from nodejs.org
winget install --id Git.Git -e
```

If `winget` is not available (older Server editions), download the installers from
[nodejs.org](https://nodejs.org) and [git-scm.com](https://git-scm.com). Open a new PowerShell
window afterwards and check `node -v` (22.18 or newer).

### 2. Install and configure

```powershell
mkdir C:\crypto-portfolio
cd C:\crypto-portfolio
git clone https://github.com/Ubaidullah71/crypto-tracker.git app
cd app
npm ci --omit=dev
copy .env.example .env
notepad .env
```

Put `wallets.txt` in the same folder (or let the bot create the template on first start), then try
it once in the foreground with `npm start` (Ctrl+C to stop).

Limit who can read the folder (it holds your token and addresses):

```powershell
icacls C:\crypto-portfolio /inheritance:r /grant:r "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "${env:USERNAME}:(OI)(CI)F"
```

### 3. Run in the background

Both options keep the bot running after you disconnect from RDP. Pick one.

**NSSM** (recommended on a server: a real Windows service that starts at boot, before anyone
logs in). Download [nssm.cc](https://nssm.cc/download), put `nssm.exe` somewhere on your `PATH`,
then:

```powershell
$node = (Get-Command node).Source
nssm install crypto-portfolio $node "--disable-warning=ExperimentalWarning src/index.ts"
nssm set crypto-portfolio AppDirectory C:\crypto-portfolio\app
nssm set crypto-portfolio AppStdout C:\crypto-portfolio\bot.log
nssm set crypto-portfolio AppStderr C:\crypto-portfolio\bot.log
nssm set crypto-portfolio AppRotateFiles 1
nssm set crypto-portfolio AppRotateBytes 10485760
nssm start crypto-portfolio
```

The service runs as LocalSystem by default. To run it as a normal account instead, set it with
`nssm set crypto-portfolio ObjectName .\<user> <password>` and give that account access to the
folder.

**PM2** (simplest if you stay logged in, or on a desktop PC):

```powershell
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs crypto-portfolio      # live logs
```

PM2 does not start itself after a reboot on Windows. Either log in and run `pm2 resurrect`
after a reboot, or use NSSM.

### 4. Update

```powershell
cd C:\crypto-portfolio\app
git pull
npm ci --omit=dev
nssm restart crypto-portfolio       # or: pm2 restart crypto-portfolio
```

### 5. Back up and secure

- Copy `data\`, `.env` and `wallets.txt` somewhere safe regularly (Task Scheduler with
  `robocopy` works well).
- Use a strong RDP password, or restrict RDP to your own IP in the provider's firewall. No other
  inbound ports are needed.
- Keep Windows Update on.

## Moving from another computer

Stop the bot on the old machine, then copy its `data` folder, `.env` and `wallets.txt` into the
new install folder before the first start there. History, categories, prices and settings all
come along, so nothing is imported again. On Linux, fix the owner afterwards:

```bash
sudo chown -R cryptobot:cryptobot /opt/crypto-portfolio/app/data
sudo chmod 700 /opt/crypto-portfolio/app/data
```
