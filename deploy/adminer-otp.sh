#!/usr/bin/env bash
#
# A new authenticator secret for Adminer.
#
#   ./deploy/adminer-otp.sh
#
# Prints a base32 secret and the otpauth:// link for it. Put the secret in
# deploy/.env as ADMINER_OTP_SECRET, add the link to your authenticator app
# (paste it, or `qrencode -t ansiutf8 '<link>'` to scan), then restart Adminer.
# Nothing is written by this script: the secret is shown once, here.

set -euo pipefail
SECRET="$(head -c 20 /dev/urandom | base32 | tr -d '=')"
echo "ADMINER_OTP_SECRET=${SECRET}"
echo "otpauth://totp/BTC%20Desk%20Adminer?secret=${SECRET}&issuer=BTC%20Desk%20Adminer"
