#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_root
require_platform
resolve_commit "${1:?用法：sudo bash scripts/update.sh Git标签或提交}"
OLD=$(realpath -- "$APP/current")
[[ $OLD == "$APP/releases/"* && -f $OLD/RELEASE ]]
restore_previous() {
  local code=$?
  trap - ERR
  set +e
  systemctl stop feiyu.service
  link_release "$OLD" current
  install_units "$OLD"
  start_services
  echo "更新失败，已切回代码 $OLD；运行数据保留，备份 ${BACKUP:-尚未生成}。" >&2
  exit "$code"
}
trap restore_previous ERR
# On the 1GB server, stop both components before npm/build to avoid competing for RAM.
stop_services
backup_data
install_node
build_release
link_release "$OLD" previous
link_release "$RELEASE" current
install_units "$RELEASE"
install -m 755 "$RELEASE/scripts/feiyu-wrapper.sh" /usr/local/bin/feiyu
start_services
wait_health
trap - ERR
echo "已更新至 $COMMIT。数据、主人绑定、通知和会话仍位于 $DATA。"
