#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for RecruitOS.
#
# The repository pins Node 24.19.0 (see .node-version and package.json engines)
# with engine-strict enabled, so pnpm refuses to install under the default image
# Node. This script installs and defaults that Node through the image's nvm, then
# installs workspace dependencies from the committed lockfile. It is safe to run
# repeatedly and against a warm snapshot.
set -euo pipefail

NODE_VERSION="$(tr -d '[:space:]' < "$(dirname "$0")/../.node-version")"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

nvm install "$NODE_VERSION"
nvm alias default "$NODE_VERSION"
nvm use default

corepack enable
corepack pnpm install --frozen-lockfile

echo "RecruitOS bootstrap complete on Node $(node -v) with pnpm $(pnpm -v)"
