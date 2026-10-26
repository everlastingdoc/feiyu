#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_root
WAS_ACTIVE=0
if systemctl is-active --quiet feiyu.service; then WAS_ACTIVE=1; fi
resume() {
  if [[ $NAPCAT_WAS_ACTIVE == 1 ]]; then systemctl start feiyu-napcat.service; fi
  if [[ $WAS_ACTIVE == 1 ]]; then systemctl start feiyu.service; fi
}
trap resume EXIT
stop_services
backup_data
