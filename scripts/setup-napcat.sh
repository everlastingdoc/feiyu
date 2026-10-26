#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_root
require_platform
ACCOUNT=${1:?用法：sudo bash scripts/setup-napcat.sh 机器人QQ号}
[[ $ACCOUNT =~ ^[0-9]{5,12}$ ]] || { echo 'QQ号格式无效。' >&2; exit 1; }
[[ -x $APP/node/bin/node && -e $APP/current ]] || { echo '请先安装助理项目。' >&2; exit 1; }
[[ ! -e /var/lib/feiyu-napcat/napcat ]] || { echo '已有 NapCat 数据；请保留现有登录与配置，按部署文档维护。' >&2; exit 1; }
# Validate credentials before downloading/installing additional components.
run_cli napcat-config --account "$ACCOUNT" --output "$DATA/napcat-preflight"
apt-get update
apt-get install -y --no-install-recommends unzip xvfb xauth g++ libnss3 libgbm1 libasound2 libgssapi-krb5-2
install -d -m 755 "$APP/napcat" "$APP/downloads"
download 'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.41/NapCat.Shell.zip' "$APP/downloads/NapCat.Shell-v4.18.41.zip"
printf '%s  %s\n' '6801f93e533846cea05f4f531874a0e84371ab2331c5585b57cd7e3b869cf96b' "$APP/downloads/NapCat.Shell-v4.18.41.zip" | sha256sum --check --strict -
download 'https://raw.githubusercontent.com/NapNeko/napcat-linux-launcher/557b5ea2de8867ae8d72f5054ab0cdd96c0aa9c7/launcher.cpp' "$APP/napcat/launcher.cpp"
printf '%s  %s\n' '4bb4c04b379cb6bb361dee6b3561ec24f85f32e13ca86a359895e9c67203e258' "$APP/napcat/launcher.cpp" | sha256sum --check --strict -
g++ -shared -fPIC "$APP/napcat/launcher.cpp" -o "$APP/napcat/libnapcat_launcher.so" -ldl
QQ_PACKAGE="$APP/downloads/linuxqq_3.2.34-53644_amd64.deb"
download 'https://qqdl.gtimg.cn/qqfile/QQNT/9.9.36/beta/9ee04bef/linuxqq_3.2.34-53644_amd64.deb' "$QQ_PACKAGE"
[[ $(dpkg-deb -f "$QQ_PACKAGE" Architecture) == amd64 ]]
[[ $(dpkg-deb -f "$QQ_PACKAGE" Version) == '3.2.34-53644' ]]
# Tencent's endpoint supplies no signed digest. Record the received file's digest for later comparison.
sha256sum "$QQ_PACKAGE" > "$APP/napcat/qq-package.sha256"
apt-get install -y --no-install-recommends "$QQ_PACKAGE"
install -d -o feiyu -g feiyu -m 700 /var/lib/feiyu-napcat /var/lib/feiyu-napcat/napcat
unzip -q "$APP/downloads/NapCat.Shell-v4.18.41.zip" -d /var/lib/feiyu-napcat/napcat
[[ -f /var/lib/feiyu-napcat/napcat/napcat.mjs ]]
chown -R feiyu:feiyu /var/lib/feiyu-napcat
chmod -R go-rwx /var/lib/feiyu-napcat
run_cli napcat-config --account "$ACCOUNT" --output /var/lib/feiyu-napcat/napcat/config
install -m 644 "$APP/current/deploy/feiyu-napcat.service" /etc/systemd/system/feiyu-napcat.service
systemctl daemon-reload
systemctl enable feiyu-napcat.service
echo '备用通道已安装。SSH转发 127.0.0.1:6099 后，启动 feiyu-napcat，在WebUI扫码登录。'
echo '登录成功后 sudo feiyu transport use onebot，重启 feiyu，再执行 pair 和完整验收。'
echo '通道、72小时送达及1GB资源约束均仍待真实服务器验收。'
