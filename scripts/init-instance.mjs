#!/usr/bin/env node
/**
 * 一键起实例（P4）：校验 → 生成部署包 → 注入密钥 → （可选）启动与冒烟。
 *
 * 用法：node scripts/init-instance.mjs <instance.yaml> [--out <dir>] [--execute]
 *       [--core-version 0.1.0] [--theme-schema 1] [--force] [--scaffold]
 *
 * 默认 dry-run：只生成制品与命令清单，不调用 docker。
 * --execute 才真正执行 docker compose；--scaffold 仅生成骨架（不要求上线签字）。
 * 生产交付默认要求 10 项上线阻断全部签字，否则以退出码 2 拒绝。
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { buildBundle, writeEnv, BundleError } from './lib/instance-bundle.mjs';

const [, , file, ...args] = process.argv;

function readFlag(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) throw new BundleError(`${name} 缺少取值`);
  return value;
}

try {
  if (!file) {
    throw new BundleError(
      '用法：node scripts/init-instance.mjs <instance.yaml> [--out <dir>] [--execute] ' +
      '[--core-version 0.1.0] [--theme-schema 1] [--force] [--scaffold]',
    );
  }
  const execute = args.includes('--execute');
  const scaffold = args.includes('--scaffold');
  const force = args.includes('--force');

  const built = buildBundle({
    manifestFile: file,
    outDir: readFlag('--out', undefined),
    coreVersion: readFlag('--core-version', '0.1.0'),
    themeSchemaVersion: Number(readFlag('--theme-schema', '1')),
    requireLaunchReady: !scaffold,
    force,
  });

  const env = writeEnv({ outDir: built.outDir, manifest: built.manifest, force });
  const domain = built.manifest.instance.domain;
  const commands = [
    `cd ${built.outDir}`,
    'docker compose config -q',
    'docker compose up -d --build',
    `curl -fsS https://${domain}/api/v1/health/live`,
    `curl -fsS https://admin.${domain}/`,
  ];

  console.log(`${execute ? '🚀 执行起实例' : '🔍 演练起实例（dry-run）'}：${built.manifest.instance.id}`);
  console.log(`   配置：${file}`);
  console.log(`   .env：${env.envPath}（权限 600，注入 ${env.injectedKeys.join(', ')}）`);
  console.log('   待执行命令：');
  for (const command of commands) console.log(`     $ ${command}`);

  if (execute) {
    // Windows 本地演练不映射 Unix 权限位；正式执行环境为 Linux 服务器，必须校验。
    if (process.platform !== 'win32') {
      const mode = statSync(env.envPath).mode & 0o777;
      if (mode !== 0o600) throw new BundleError(`.env 权限必须为 600（当前 ${mode.toString(8)}）`);
    }
    const steps = [
      ['docker', ['compose', 'config', '-q']],
      ['docker', ['compose', 'up', '-d', '--build']],
      ['curl', ['-fsS', `https://${domain}/api/v1/health/live`]],
    ];
    for (const [command, params] of steps) {
      const result = spawnSync(command, params, { cwd: built.outDir, stdio: 'inherit' });
      if (result.status !== 0) {
        throw new BundleError(
          `执行失败：${command} ${params.join(' ')}\n` +
          `如需回退请在实例目录执行 ./deploy.sh --rollback（数据库不回滚，迁移只前进）。`,
        );
      }
    }
  }

  console.log('\n交付清单：');
  console.log(`  - core ${built.bundleManifest.coreVersion} · theme schema v${built.bundleManifest.themeSchemaVersion}`);
  console.log(`  - 配置哈希 ${built.configHash}`);
  console.log('  - 备份点：首次启动前请在客户侧确认数据库备份策略');
  console.log(`  - 访问地址 https://${domain} · https://admin.${domain}`);
  if (!execute) console.log('\n（dry-run 未启动任何容器。确认无误后加 --execute）');
} catch (error) {
  if (error instanceof BundleError) {
    console.error(`[起实例失败] ${error.message}`);
    process.exit(error.exitCode);
  }
  console.error('[起实例失败]', error);
  process.exit(1);
}
