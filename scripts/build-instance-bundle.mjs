#!/usr/bin/env node
/**
 * 标准部署包构建器（P4）。
 *
 * 用法：node scripts/build-instance-bundle.mjs <instance.yaml> [--out <dir>]
 *       [--core-version 0.1.0] [--theme-schema 1] [--require-launch-ready] [--force]
 *
 * 从参数化模板 + 实例配置生成完整部署目录。默认不要求上线签字（仅生成制品）；
 * 加 --require-launch-ready 时，未签字的阻断项会让构建以退出码 2 失败。
 */
import { buildBundle, BundleError } from './lib/instance-bundle.mjs';

const [, , file, ...args] = process.argv;

function readFlag(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) {
    throw new BundleError(`${name} 缺少取值`);
  }
  return value;
}

try {
  if (!file) {
    throw new BundleError(
      '用法：node scripts/build-instance-bundle.mjs <instance.yaml> [--out <dir>] ' +
      '[--core-version 0.1.0] [--theme-schema 1] [--require-launch-ready] [--force]',
    );
  }
  const built = buildBundle({
    manifestFile: file,
    outDir: readFlag('--out', undefined),
    coreVersion: readFlag('--core-version', '0.1.0'),
    themeSchemaVersion: Number(readFlag('--theme-schema', '1')),
    requireLaunchReady: args.includes('--require-launch-ready'),
    force: args.includes('--force'),
  });

  console.log(`✅ 部署包已生成：${built.outDir}`);
  console.log(`   实例：${built.manifest.instance.id} · ${built.manifest.instance.domain}`);
  console.log(`   版本：core ${built.bundleManifest.coreVersion} · theme schema v${built.bundleManifest.themeSchemaVersion}`);
  console.log(`   配置哈希：${built.configHash.slice(0, 16)}…`);
  console.log(`   文件清单：${built.files.join(', ')}`);
  console.log('   密钥：未写入部署包，由 instance:init 注入 .env（chmod 600）');
} catch (error) {
  if (error instanceof BundleError) {
    console.error(`[构建失败] ${error.message}`);
    process.exit(error.exitCode);
  }
  console.error('[构建失败]', error);
  process.exit(1);
}
