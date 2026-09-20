#!/usr/bin/env bash
# 1–2 GB swap so npm install and map renders do not OOM a $6 (1 GB) droplet.
set -euo pipefail
SWAP_GB="${1:-2}"
SWAPFILE=/swapfile
if swapon --show | grep -q .; then
  echo "Swap already enabled:"
  swapon --show
  exit 0
fi
fallocate -l "${SWAP_GB}G" "$SWAPFILE" || dd if=/dev/zero of="$SWAPFILE" bs=1M count=$((SWAP_GB * 1024))
chmod 600 "$SWAPFILE"
mkswap "$SWAPFILE"
swapon "$SWAPFILE"
if ! grep -q "$SWAPFILE" /etc/fstab; then
  echo "$SWAPFILE none swap sw 0 0" >> /etc/fstab
fi
echo "Swap enabled (${SWAP_GB}G). Resize the droplet to 2 GB before selling premium dashboards."
swapon --show
