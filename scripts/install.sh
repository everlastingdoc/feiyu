#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_root
require_platform
resolve_commit "${1:-HEAD}"
[[ ! -e $APP/current ]] || { echo '已安装；请使用 update.sh。' >&2; exit 1; }
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl xz-utils git
getent passwd feiyu >/dev/null || useradd --system --user-group --home-dir "$DATA" --shell /usr/sbin/nologin feiyu
install -d -m 755 "$APP" "$APP/releases"
install -d -o feiyu -g feiyu -m 700 "$DATA"
install -d -o root -g feiyu -m 770 "$CONFIG"
if [[ ! -f $CONFIG/config.json ]]; then install -o feiyu -g feiyu -m 600 "$SOURCE/config.example.json" "$CONFIG/config.json"; fi
if [[ ! -f $CONFIG/assistant.env ]]; then install -o feiyu -g feiyu -m 600 "$SOURCE/.env.example" "$CONFIG/assistant.env"; fi
install_node
build_release
link_release "$RELEASE" current
install_units "$RELEASE"
install -m 755 "$SOURCE/scripts/feiyu-wrapper.sh" /usr/local/bin/feiyu
systemctl enable feiyu.service
echo '安装完成。请填写 /etc/feiyu/assistant.env，检查 /etc/feiyu/config.json。'
echo '然后运行 sudo feiyu doctor --probe-model；通过后 sudo systemctl start feiyu。'
echo '最后 sudo feiyu pair，在 QQ 私聊完成绑定，并按 docs/acceptance.md 验收。'
