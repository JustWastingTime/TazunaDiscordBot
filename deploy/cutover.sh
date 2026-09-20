#!/usr/bin/env bash
# After Tazuna is running on the droplet:
# 1. Point DNS A records at the Reserved IP.
# 2. certbot --nginx -d bot.example.com -d dash.example.com
# 3. Discord app → Interactions Endpoint URL = https://bot.example.com/interactions
# 4. OAuth2 redirect = https://dash.example.com/api/auth/callback (same app or a dedicated one)
# 5. npm run register  (picks up /club dashboard)
# 6. Confirm slash commands, then terminate the EC2 and release its Elastic IP.
set -euo pipefail
echo "See comments in this file for the Discord/DNS cutover checklist."
