#!/usr/bin/env bash
# Sourced by deployment scripts; fixed directories keep code and data independent.
set -Eeuo pipefail
APP=/opt/feiyu
DATA=/var/lib/feiyu
CONFIG=/etc/feiyu
BACKUPS=/var/backups/feiyu
NODE_VERSION=24.19.0
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
export PATH="$APP/node/bin:/usr/sbin:/usr/bin:/sbin:/bin"

require_root() {
  [[ $EUID == 0 ]] || { echo '请使用 sudo bash 执行部署脚本。' >&2; exit 1; }
  exec 9>/run/lock/feiyu-deploy.lock
  flock -n 9 || { echo '另一个部署或备份操作正在运行。' >&2; exit 1; }
}
require_platform() {
  [[ $(uname -m) == x86_64 ]] || { echo '此部署脚本仅支持 x86_64。' >&2; exit 1; }
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ $ID == ubuntu && $VERSION_ID == 22.04 ]] || { echo '此部署脚本面向 Ubuntu 22.04。' >&2; exit 1; }
  [[ $(stat -fc %T /sys/fs/cgroup) == cgroup2fs ]] || { echo '需要 cgroup v2，以合并限制助理与 QQ 组件的内存。' >&2; exit 1; }
}
git_source() { git -c safe.directory="$SOURCE" -C "$SOURCE" "$@"; }
resolve_commit() {
  git_source rev-parse --show-toplevel >/dev/null
  [[ -z $(git_source status --porcelain --untracked-files=no) ]] || { echo '请先提交或撤销源码修改；部署仅使用指定 Git 版本。' >&2; return 1; }
  COMMIT=$(git_source rev-parse --verify --end-of-options "${1:-HEAD}^{commit}")
  [[ $COMMIT =~ ^[a-f0-9]{40}$ ]] || return 1
}
download() { curl --fail --location --show-error --silent --retry 3 --connect-timeout 20 --max-time 1800 --proto '=https' --proto-redir '=https' "$1" -o "$2"; }
install_node() {
  if [[ -x $APP/node/bin/node && $($APP/node/bin/node --version) == v$NODE_VERSION ]]; then chmod 755 "$APP/node"; return; fi
  install -d -m 755 "$APP/downloads"
  local file="node-v$NODE_VERSION-linux-x64.tar.xz" staging
  download "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" "$APP/downloads/node-checksums.txt"
  download "https://nodejs.org/dist/v$NODE_VERSION/$file" "$APP/downloads/$file"
  (cd "$APP/downloads"; awk -v name="$file" '$2 == name { print; found=1 } END { if (!found) exit 1 }' node-checksums.txt | sha256sum --check --strict -)
  staging=$(mktemp -d "$APP/node-new.XXXXXX")
  tar -xJf "$APP/downloads/$file" -C "$staging" --strip-components=1
  [[ $($staging/bin/node --version) == v$NODE_VERSION ]]
  chmod 755 "$staging"
  if [[ -e $APP/node ]]; then mv -- "$APP/node" "$APP/node-before-$(date -u +%Y%m%dT%H%M%S)"; fi
  mv -- "$staging" "$APP/node"
}
build_release() {
  RELEASE="$APP/releases/$COMMIT-$(date -u +%Y%m%dT%H%M%S)-$RANDOM"
  install -d -m 755 "$RELEASE"
  git_source archive --format=tar "$COMMIT" | tar -x -C "$RELEASE"
  [[ -f $RELEASE/package-lock.json && -f $RELEASE/src/plugin.ts ]]
  (
    cd "$RELEASE"
    export NODE_OPTIONS=--max-old-space-size=256
    npm ci --ignore-scripts --no-audit --no-fund
    npm run build
    npm prune --omit=dev --ignore-scripts --no-audit --no-fund
  )
  printf '%s\n' "$COMMIT" > "$RELEASE/RELEASE"
}
run_cli() {
  runuser -u feiyu -- env FEIYU_DATA_DIR="$DATA" FEIYU_CONFIG="$CONFIG/config.json" FEIYU_ENV_FILE="$CONFIG/assistant.env" \
    "$APP/node/bin/node" "$APP/current/bin/feiyu.mjs" "$@"
}
install_units() {
  install -m 644 "$1/deploy/feiyu.slice" /etc/systemd/system/feiyu.slice
  install -m 644 "$1/deploy/feiyu.service" /etc/systemd/system/feiyu.service
  if [[ -e /etc/systemd/system/feiyu-napcat.service ]]; then install -m 644 "$1/deploy/feiyu-napcat.service" /etc/systemd/system/feiyu-napcat.service; fi
  systemctl daemon-reload
}
link_release() {
  local target=$1 name=$2 scratch
  [[ $name == current || $name == previous ]]
  [[ $(realpath -- "$target") == "$APP/releases/"* ]]
  scratch=$(mktemp -d "$APP/link.XXXXXX")
  ln -s -- "$target" "$scratch/$name"
  mv -Tf -- "$scratch/$name" "$APP/$name"
  rmdir -- "$scratch"
}
NAPCAT_WAS_ACTIVE=0
stop_services() {
  if systemctl is-active --quiet feiyu-napcat.service; then NAPCAT_WAS_ACTIVE=1; systemctl stop feiyu-napcat.service; fi
  systemctl stop feiyu.service
}
start_services() {
  if [[ $NAPCAT_WAS_ACTIVE == 1 ]]; then systemctl start feiyu-napcat.service; fi
  systemctl reset-failed feiyu.service
  systemctl start feiyu.service
}
backup_data() {
  install -d -o root -g feiyu -m 770 "$BACKUPS"
  BACKUP="$BACKUPS/$(date -u +%Y%m%dT%H%M%S)-$RANDOM"
  run_cli backup --output "$BACKUP"
  if [[ -f $APP/current/RELEASE ]]; then cp -- "$APP/current/RELEASE" "$BACKUP/RELEASE"; fi
  if [[ -d /var/lib/feiyu-napcat ]]; then
    tar -czf "$BACKUP/napcat-login-data.tar.gz" -C /var/lib feiyu-napcat
    chmod 600 "$BACKUP/napcat-login-data.tar.gz"
  fi
  echo "一致性备份：$BACKUP"
}
wait_health() {
  local attempt
  for attempt in {1..90}; do
    if run_cli health --require-connected >/dev/null 2>&1; then echo '服务和 QQ 连接健康检查通过；实际主动送达仍需验收。'; return 0; fi
    sleep 1
  done
  echo '启动或 QQ 连接健康检查失败。请查看 journalctl -u feiyu。' >&2
  return 1
}
