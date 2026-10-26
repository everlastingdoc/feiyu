#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $EUID == 0 ]]; then
  exec runuser -u feiyu -- /usr/local/bin/feiyu "$@"
fi
[[ $(id -un) == feiyu ]] || { echo '请运行 sudo feiyu ...。' >&2; exit 1; }
export FEIYU_CONFIG=/etc/feiyu/config.json
export FEIYU_DATA_DIR=/var/lib/feiyu
export FEIYU_ENV_FILE=/etc/feiyu/assistant.env
export NODE_OPTIONS=--max-old-space-size=192
exec /opt/feiyu/node/bin/node /opt/feiyu/current/bin/feiyu.mjs "$@"
