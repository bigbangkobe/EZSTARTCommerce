#!/usr/bin/env node
/**
 * 批量升级规划器（P4）：从版本清单生成逐实例升级计划，无中控、可分组演练。
 *
 * 用法：node scripts/upgrade-instances.mjs <inventory.yaml> <target-version>
 *       [--theme-schema 1] [--manifest-schema 1] [--execute]
 *
 * 默认 dry-run：只输出计划与阻断原因；--execute 才按分组顺序逐实例执行 deploy.sh，
 * 任一失败立即停止并提示回滚。兼容性与执行顺序都由 domain 规则层决定。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  planFleetUpgrade, RELEASE_GROUPS, DeploymentError,
} from '../dist/packages/domain/src/deployment.js';
import { ROOT, BundleError } from './lib/instance-bundle.mjs';

const [, , file, version, ...args] = process.argv;

function readFlag(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) throw new BundleError(`${name} 缺少取值`);
  return value;
}

try {
  if (!file || !version) {
    throw new BundleError(
      '用法：node scripts/upgrade-instances.mjs <inventory.yaml> <target-version> ' +
      '[--theme-schema 1] [--manifest-schema 1] [--execute]',
    );
  }
  const inventory = parseYaml(readFileSync(file, 'utf8'));
  if (!Array.isArray(inventory?.instances)) throw new BundleError('版本清单缺少 instances 数组');

  const records = inventory.instances.map((item, index) => {
    for (const key of ['id', 'group', 'coreVersion', 'themeSchemaVersion', 'manifestSchemaVersion']) {
      if (item?.[key] === undefined) throw new BundleError(`instances[${index}].${key} 缺失`);
    }
    return {
      id: item.id,
      group: item.group,
      coreVersion: item.coreVersion,
      themeSchemaVersion: Number(item.themeSchemaVersion),
      manifestSchemaVersion: Number(item.manifestSchemaVersion),
      themeMigrationReviewed: item.themeMigrationReviewed === true,
    };
  });

  const target = {
    coreVersion: version,
    themeSchemaVersion: Number(readFlag('--theme-schema', '1')),
    manifestSchemaVersion: Number(readFlag('--manifest-schema', '1')),
  };
  const plan = planFleetUpgrade(records, target);
  const execute = args.includes('--execute');

  console.log(`${execute ? '🚀 执行批量升级' : '🔍 演练批量升级（dry-run）'}：目标 core ${target.coreVersion}`);
  for (const group of RELEASE_GROUPS) {
    const plans = plan.plans.filter((p) => p.group === group);
    if (!plans.length) continue;
    console.log(`\n[${group}]`);
    for (const p of plans) {
      console.log(`  ${p.ok ? '✓' : '✗'} ${p.id}  ${p.from} → ${p.to}`);
      for (const reason of p.blockers) console.log(`     阻断：${reason}`);
    }
  }
  console.log(`\n可自动执行 ${plan.order.length} 个实例，阻断 ${plan.blockedCount} 个。`);
  console.log(`执行顺序：${plan.order.join(' → ') || '（无）'}`);
  console.log('每个实例动作：备份 → 钉住镜像 → migration → 健康检查 → 冒烟 → 失败自动提示回滚');

  if (execute) {
    for (const id of plan.order) {
      const item = inventory.instances.find((r) => r.id === id);
      const dir = resolve(ROOT, item?.dir ?? join('deploy', 'merchants', id));
      const script = join(dir, 'deploy.sh');
      if (!existsSync(script)) throw new BundleError(`实例 ${id} 缺少部署脚本：${script}`);
      console.log(`\n>>> 升级 ${id}（${dir}）`);
      const result = spawnSync('bash', ['deploy.sh'], { cwd: dir, stdio: 'inherit' });
      if (result.status !== 0) {
        throw new BundleError(
          `实例 ${id} 升级失败，已停止后续实例。\n` +
          `请在该目录执行 ./deploy.sh --rollback 回退镜像，并核查数据库迁移状态。`,
        );
      }
    }
    console.log('\n✅ 批量升级完成');
  } else {
    console.log('\n（dry-run 未执行任何升级。确认无误后加 --execute）');
  }
} catch (error) {
  if (error instanceof BundleError || error instanceof DeploymentError) {
    console.error(`[升级失败] ${error.message}`);
    process.exit(1);
  }
  console.error('[升级失败]', error);
  process.exit(1);
}
