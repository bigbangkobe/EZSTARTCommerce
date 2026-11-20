#!/usr/bin/env node
/**
 * 实例配置源校验器（重做方案 P3）。
 *
 * 用法：node scripts/validate-instance-manifest.mjs <instance.yaml>
 *       node scripts/validate-instance-manifest.mjs <instance.yaml> --require-launch-ready
 *
 * 读取 YAML → 交给 domain 纯规则层校验 → 输出结构结果与上线阻断清单。
 * 退出码：0 = 结构合法；1 = 结构非法或入参错误；2 = 结构合法但未通过上线阻断（仅 --require-launch-ready）。
 *
 * 设计要点：脚本层只做 IO（读文件、解析 YAML、打印），所有判断在 domain 层，
 * 与后台/API 共用同一套规则，避免"脚本说通过、运行时却拒绝"的漂移。
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
// 引用 tsc 构建产物（与 tests 一致）；运行前需先 pnpm build。
import {
  normalizeInstanceManifest, InstanceManifestError, launchBlockerStatus, canLaunch,
} from '../dist/packages/domain/src/instance-manifest.js';

const [, , file, ...flags] = process.argv;
const requireLaunchReady = flags.includes('--require-launch-ready');

if (!file) {
  console.error('用法：node scripts/validate-instance-manifest.mjs <instance.yaml> [--require-launch-ready]');
  process.exit(1);
}

let raw;
try {
  raw = parseYaml(readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`[读取失败] ${file}`);
  console.error(`  ${error.message}`);
  process.exit(1);
}

let manifest;
try {
  manifest = normalizeInstanceManifest(raw);
} catch (error) {
  if (error instanceof InstanceManifestError) {
    console.error('[结构校验] 不通过');
    console.error(`  字段：${error.field}`);
    console.error(`  规则：${error.code}`);
    process.exit(1);
  }
  throw error;
}

console.log('[结构校验] 通过');
console.log(`  实例：${manifest.instance.id}  域名：${manifest.instance.domain}`);
console.log(`  市场：${manifest.instance.market}  币种：${manifest.instance.currency}  语言：${manifest.instance.locales.join(', ')}`);
console.log(`  主题：${manifest.theme.fontPair} / ${manifest.theme.primaryColor}  首页区块：${manifest.storefront.homeSections.length} 个`);

const status = launchBlockerStatus(manifest);
const signed = status.filter((s) => s.signed);
const unsigned = status.filter((s) => !s.signed);
console.log(`\n[上线阻断项] ${signed.length}/${status.length} 已签字`);
for (const s of status) console.log(`  ${s.signed ? '[✓]' : '[ ]'} ${s.key}`);

if (requireLaunchReady && !canLaunch(manifest)) {
  console.error(`\n[上线判定] 不通过：${unsigned.length} 项阻断未签字，禁止生产发布`);
  process.exit(2);
}
console.log(canLaunch(manifest) ? '\n[上线判定] 通过' : '\n[上线判定] 未就绪（结构合法，签字未完成）');
