#!/usr/bin/env node
// 把所有（或指定范围的）SKU 库存校准到一个目标值，走官方库存调整接口（带原因的流水，不直改现存量）。
//
// 用法：
//   node scripts/seed-inventory.mjs --target 1000 --api https://mrinhk.com --origin https://mrinhk.com --creds /tmp/c.json
//   node scripts/seed-inventory.mjs --target 1000 --dry-run        # 只列出差异，不写库
//   node scripts/seed-inventory.mjs --target 1000 --skus A,B,C     # 只动指定 SKU
//
// 说明：每个变体一次写请求；后端限流是每 IP 每 15 分钟 60 次写，脚本撞到 429 会自动等窗口续跑。
import { writeFile } from 'node:fs/promises';
import { createClient, describe as describeResult, sleep } from './lib/admin-api.mjs';

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const option = (name, fallback = undefined) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
};

if (flag('help')) {
  console.log(`库存校准

  --target <n>        目标现存量，默认 1000（整数，0..100000）
  --skus a,b,c        只处理这些 SKU（默认全部）
  --api <base>        API 地址，默认 $API_BASE 或 http://127.0.0.1:3001
  --origin <url>      写请求 Origin，默认 $APP_ORIGIN 或 https://mrinhk.com
  --creds <path>      管理员凭据 JSON（email/password[/totpSecret] 或 sessionToken+csrfToken）
  --delay <ms>        每条间隔，默认 120
  --retry-wait <秒>   429 后等待，默认 905
  --dry-run           只打印差异与预计写次数
  --limit <n>         只处理前 n 个
  --report <path>     写行级 JSON 报告
`);
  process.exit(0);
}

const API = String(option('api', process.env.API_BASE ?? 'http://127.0.0.1:3001')).replace(/\/$/, '');
const ORIGIN = String(option('origin', process.env.APP_ORIGIN ?? 'https://mrinhk.com'));
const CREDS = String(option('creds', process.env.SECRET_FILE ?? '/secrets/admin.json'));
const TARGET = Number(option('target', 1000));
const DELAY = Number(option('delay', 120)) || 0;
const RETRY_WAIT = Number(option('retry-wait', 905)) || 905;
const DRY_RUN = flag('dry-run');
const LIMIT = Number(option('limit', 0)) || 0;
const REPORT_PATH = option('report', null);
const SKU_FILTER = String(option('skus', '')).split(',').map(value => value.trim()).filter(Boolean);

if (!Number.isSafeInteger(TARGET) || TARGET < 0 || TARGET > 100_000) {
  console.error(`✗ --target 必须是 0..100000 的整数，收到 ${TARGET}`);
  process.exit(2);
}

const log = (...args) => console.log('•', ...args);
const warn = (...args) => console.warn('!', ...args);
const fail = (...args) => console.error('✗', ...args);

const client = await createClient({ api: API, origin: ORIGIN, credsPath: CREDS, retryWait: RETRY_WAIT, log, warn });
log(`已登录 ${API}`);

// ---- 枚举库存 ---------------------------------------------------------------
const stock = [];
let cursor = null;
for (let page = 0; page < 500; page += 1) {
  const result = await client.get(`/api/v1/admin/inventory?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  if (result.status !== 200) { fail(`读取库存失败：${describeResult(result)}`); process.exit(1); }
  const data = result.body.data;
  stock.push(...(data.items ?? []));
  if (!data.hasMore) break;
  cursor = data.nextCursor;
}
log(`库存条目 ${stock.length} 个`);

const targets = (SKU_FILTER.length ? stock.filter(item => SKU_FILTER.includes(item.sku)) : stock)
  .filter((item, index, list) => list.findIndex(other => other.sku === item.sku) === index)
  .slice(0, LIMIT > 0 ? LIMIT : undefined);

const plan = targets.map(item => {
  // 目标值不能低于已占用数量（DB CHECK: reserved <= onHand），否则把目标抬到 reserved
  const goal = Math.max(TARGET, item.reserved ?? 0);
  return { sku: item.sku, variantId: item.variantId, onHand: item.onHand, reserved: item.reserved ?? 0,
    version: item.version, goal, delta: goal - item.onHand };
});

const pending = plan.filter(entry => entry.delta !== 0);
log(`待调整 ${pending.length} 个（已是 ${TARGET} 的 ${plan.length - pending.length} 个跳过）；预计写请求 ${pending.length} 次，约 ${Math.ceil(pending.length / 60) * 15} 分钟`);

if (DRY_RUN) {
  for (const entry of pending.slice(0, 40)) {
    console.log(`   ${entry.sku}: ${entry.onHand} → ${entry.goal}（delta ${entry.delta > 0 ? '+' : ''}${entry.delta}, expectedVersion ${entry.version}）`);
  }
  if (pending.length > 40) console.log(`   …其余 ${pending.length - 40} 个省略`);
  process.exit(0);
}

// ---- 执行 -------------------------------------------------------------------
const results = [];
let done = 0;
for (const entry of pending) {
  const result = await client.post('/api/v1/admin/inventory/adjustments', {
    variantId: entry.variantId,
    delta: entry.delta,
    reason: '批量初始库存',
    reasonCode: 'import',
    expectedVersion: entry.version,
  }, { idempotency: `seed-inv-${entry.sku}-${entry.goal}` });

  if (result.status >= 400) {
    fail(`${entry.sku}: ${describeResult(result)}`);
    results.push({ ...entry, ok: false, error: describeResult(result) });
  } else {
    done += 1;
    results.push({ ...entry, ok: true, onHandAfter: result.body?.data?.onHand ?? entry.goal });
    if (done % 20 === 0 || done === pending.length) log(`已处理 ${done}/${pending.length}`);
  }
  if (DELAY) await sleep(DELAY);
}

const failed = results.filter(entry => !entry.ok);
console.log('\n================ 汇总 ================');
console.log(`目标 ${TARGET}｜成功 ${done}｜失败 ${failed.length}｜无需调整 ${plan.length - pending.length}`);
for (const entry of failed.slice(0, 20)) console.log(`  ✗ ${entry.sku}: ${entry.error}`);

if (REPORT_PATH && REPORT_PATH !== true) {
  await writeFile(REPORT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), api: API, target: TARGET,
    total: plan.length, changed: done, failed: failed.length, results }, null, 2), 'utf8');
  log(`报告写入 ${REPORT_PATH}`);
}

process.exit(failed.length ? 1 : 0);
