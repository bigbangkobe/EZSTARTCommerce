#!/usr/bin/env bash
# IN先生 —— 配置会员验证码邮件（SMTP）一键脚本，Gmail 专用
#
# 用法（SSH 登录服务器后，在本目录下执行）：
#   cd /opt/ezstart-mrinhk/deploy/merchants/mrinhk
#   ./setup-smtp.sh
# 脚本会交互式询问 Gmail 信息，写入 .env，修复旧字段名，然后重新部署并自检。
#
# 安全约定：
#   - 密码用 read -s 输入，不回显、不写进脚本、不进 shell 历史；
#   - .env 权限强制 600，仅 ec2-user 可读；
#   - 修改前自动备份 .env 到 .env.bak.<时间戳>。
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ "$(id -u)" -eq 0 ]; then
  echo "请用 ec2-user 执行（不要用 root）：su - ec2-user 后再运行" >&2
  exit 1
fi
[ -f .env ] || { echo "缺少 .env，请先从 .env.example 复制" >&2; exit 1; }

echo "=========================================================="
echo " IN先生 · 会员邮件（SMTP）配置 · Gmail"
echo "=========================================================="
echo "Gmail 的 SMTP 密码不是网页登录密码，必须先申请『应用专用密码』："
echo "  1) 打开 https://myaccount.google.com/security ，开启『两步验证』（2-Step Verification）"
echo "  2) 打开 https://myaccount.google.com/apppasswords"
echo "  3) 应用选『邮件 / Mail』，设备选『其他 / Other』，随便命名（如 IN先生官网），点生成"
echo "  4) 复制生成的 16 位密码（中间空格去掉也可），下面第 4 项粘贴它"
echo "  5) 下面第 3、5 项都填同一个 Gmail 地址（如 yourname@gmail.com）"
echo "  注意：看不到 apppasswords 页面，说明账号未开启两步验证，或 Google Workspace 被管理员禁用。"
echo

read -r -p "1/5 SMTP 主机 [smtp.gmail.com]: " HOST; HOST="${HOST:-smtp.gmail.com}"
read -r -p "2/5 SMTP 端口 [587]: " PORT; PORT="${PORT:-587}"
read -r -p "3/5 Gmail 地址 (USER): " USER
read -r -s -p "4/5 应用专用密码 (16 位，输入不显示): " PASS; echo
read -r -p "5/5 寄件人邮箱 (FROM，与第 3 项相同): " FROM

# 基本校验，避免把空值写进去导致 worker 启动失败
for pair in "HOST:$HOST" "USER:$USER" "PASS:$PASS" "FROM:$FROM"; do
  key="${pair%%:*}"; val="${pair#*:}"
  if [ -z "$val" ]; then echo "x $key 不能为空，已中止" >&2; exit 1; fi
done
case "$FROM" in
  *@*.*) ;;
  *) echo "x FROM 必须是合法邮箱地址" >&2; exit 1 ;;
esac

# 写 .env：先删掉旧的（含错误字段名 SMTP_MAPP），再追加新值，避免重复键。
# 注意 worker 代码读的是 SMTP_FROM，绝不能写成 SMTP_MAPP，否则 worker 启动即失败。
STAMP="$(date +%Y%m%d-%H%M%S)"
cp -a .env ".env.bak.$STAMP"
echo "已备份 .env -> .env.bak.$STAMP"
grep -vE '^(SMTP_HOST|SMTP_PORT|SMTP_USER|SMTP_PASSWORD|SMTP_FROM|SMTP_MAPP)=' .env > ".env.tmp.$$"
mv ".env.tmp.$$" .env
{
  echo "SMTP_HOST=$HOST"
  echo "SMTP_PORT=$PORT"
  echo "SMTP_USER=$USER"
  echo "SMTP_PASSWORD=$PASS"
  FKEY="SMTP_FRO""M"
  echo "${FKEY}=$FROM"
} >> .env
chmod 600 .env
echo "OK SMTP 配置已写入 .env（权限 600）"

# 重新部署：deploy.sh 检测到 SMTP_HOST 会自动带 --profile smtp 拉起通知 worker
echo "开始重新部署并拉起通知 worker ..."
./deploy.sh --no-pull

echo
echo "=========================================================="
echo " 自检：确认 worker 已启动"
echo "=========================================================="
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"
$DOCKER compose --profile smtp ps --format '{{.Name}} | {{.Status}}' | grep -E 'worker|api' || true
echo
echo "若 worker 状态为 Up，到管理后台 admin.mrinhk.com -> 通知/邮件自检 发一封测试信；"
echo "或在网站前台申请一次会员验证码，收信即代表配置成功。"
echo "如 worker 未启动，查看日志：docker compose --profile smtp logs --tail=50 worker"
