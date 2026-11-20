#!/usr/bin/env node
/**
 * 对账任务触发器（在 api 容器内执行）。
 *
 *   docker compose exec -T api node scripts/reconcile.mjs
 *   docker compose exec -T api node scripts/reconcile.mjs --older-than=60 --limit=200
 *
 * 它不做业务，只把请求转给 API 的对账端点：业务逻辑只有一份，
 * 脚本再实现一遍就会和生产行为分叉。令牌从 INTERNAL_JOB_TOKEN 读取，不写进命令行——
 * 命令行参数会出现在 ps 和 shell history 里。
 */
const baseUrl = (process.env.RECONCILE_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`)
  .replace(/\/+$/, '');
const token = process.env.INTERNAL_JOB_TOKEN ?? '';

const args = new Map(process.argv.slice(2).map(argument => {
  const [key, value] = argument.replace(/^--/, '').split('=');
  return [key, value ?? 'true'];
}));

if (token.length < 24) {
  console.error('INTERNAL_JOB_TOKEN 未配置或过短（至少 24 字符）；对账端点默认关闭。');
  process.exit(2);
}

const payload = {};
if (args.has('older-than')) payload.olderThanMinutes = Number(args.get('older-than'));
if (args.has('limit')) payload.limit = Number(args.get('limit'));

const response = await fetch(`${baseUrl}/api/v1/internal/jobs/reconcile`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-job-token': token },
  body: JSON.stringify(payload),
});

const text = await response.text();
if (!response.ok) {
  console.error(`对账失败 HTTP ${response.status}: ${text}`);
  process.exit(1);
}

const body = JSON.parse(text);
const report = body?.data ?? body;
// 只打印计数，不打印订单号：日志会长期留存，没必要把客户订单散进去。
console.log(JSON.stringify({ payments: report.payments, refunds: report.refunds,
  errors: report.errors?.length ?? 0, olderThanMinutes: report.olderThanMinutes }));
if (report.errors?.length) {
  console.error('失败明细（前 20 条）:', JSON.stringify(report.errors.slice(0, 20)));
}
// 有失败项也算"跑完了"，退出码 0；只有请求本身失败才非 0，避免 cron 天天报警。
