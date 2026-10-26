#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_root
run_cli doctor "$@"
run_cli health --require-connected
systemctl show feiyu.slice --property=MemoryCurrent,MemoryPeak,MemoryMax,MemorySwapMax
awk '/MemTotal:|MemAvailable:|SwapTotal:|SwapFree:/ { print }' /proc/meminfo
ss -lntp '( sport = :3001 or sport = :6099 )'
