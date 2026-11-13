#!/usr/bin/env bash
set -euo pipefail

# The hosted Linux image can select an Azure mirror whose DNS is unavailable.
# Change only that Ubuntu mirror hostname; keep the signed repositories,
# package suites, and all other configured sources unchanged.
mirrors=${1:-/etc/apt/apt-mirrors.txt}
if [[ ! -f "$mirrors" ]] || ! grep -Fq azure.archive.ubuntu.com "$mirrors"; then
  exit 0
fi
if [[ $# -eq 0 ]]; then
  sudo sed -i 's/azure\.archive\.ubuntu\.com/archive.ubuntu.com/g' "$mirrors"
else
  sed -i 's/azure\.archive\.ubuntu\.com/archive.ubuntu.com/g' "$mirrors"
fi
if grep -Fq azure.archive.ubuntu.com "$mirrors"; then
  echo 'Ubuntu apt mirror replacement did not complete' >&2
  exit 1
fi
