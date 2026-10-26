#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_root
OLD=$(realpath -- "$APP/current")
TARGET=$(realpath -- "$APP/previous")
[[ $OLD == "$APP/releases/"* && $TARGET == "$APP/releases/"* && -f $TARGET/RELEASE ]]
recover() {
  local code=$?
  trap - ERR
  set +e
  systemctl stop feiyu.service
  link_release "$OLD" current
  install_units "$OLD"
  start_services
  echo '回滚未通过健康检查，已恢复原代码。' >&2
  exit "$code"
}
trap recover ERR
stop_services
backup_data
link_release "$TARGET" current
install_units "$TARGET"
start_services
wait_health
link_release "$OLD" previous
trap - ERR
echo '代码回滚完成；运行数据保留。需要恢复数据时请按部署文档执行 restore。'
