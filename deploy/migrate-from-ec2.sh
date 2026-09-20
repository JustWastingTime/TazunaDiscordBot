#!/usr/bin/env bash
# Copy Tazuna live JSON from the old AWS host onto this droplet.
# Run from the droplet (or your PC with both SSH keys).
#
# Usage:
#   EC2_HOST=ec2-user@old.example.com \
#   EC2_PATH=~/TazunaDiscordBot \
#   LOCAL_PATH=/home/tazuna/TazunaDiscordBot \
#   ./deploy/migrate-from-ec2.sh
set -euo pipefail
EC2_HOST="${EC2_HOST:?set EC2_HOST e.g. ec2-user@1.2.3.4}"
EC2_PATH="${EC2_PATH:-~/TazunaDiscordBot}"
LOCAL_PATH="${LOCAL_PATH:-.}"

mkdir -p "${LOCAL_PATH}/data"
echo "Pass 1: copy data/ and .env while the old bot may still be running…"
rsync -avz --progress "${EC2_HOST}:${EC2_PATH}/data/" "${LOCAL_PATH}/data/"
rsync -avz "${EC2_HOST}:${EC2_PATH}/.env" "${LOCAL_PATH}/.env" || true
# config.json is tracked in git, but channel/message IDs are often edited in place on the host.
rsync -avz "${EC2_HOST}:${EC2_PATH}/config.json" "${LOCAL_PATH}/config.json" || true
rsync -avz "${EC2_HOST}:${EC2_PATH}/assets/skillemotes.json" "${LOCAL_PATH}/assets/skillemotes.json" || true
rsync -avz "${EC2_HOST}:${EC2_PATH}/assets/generated/" "${LOCAL_PATH}/assets/generated/" || true

echo
echo "Stop Tazuna on EC2 now (pm2 stop / systemctl stop), then re-run this script"
echo "or run: FINAL=1 $0"
if [[ "${FINAL:-}" == "1" ]]; then
  echo "Final pass…"
  rsync -avz --progress "${EC2_HOST}:${EC2_PATH}/data/" "${LOCAL_PATH}/data/"
  echo "Start Tazuna on this droplet, then point Discord Interactions URL to https://YOUR_DOMAIN/interactions"
  echo "After slash commands, quiz, gamba, and clubs look right: terminate the EC2 and release its Elastic IP."
fi
