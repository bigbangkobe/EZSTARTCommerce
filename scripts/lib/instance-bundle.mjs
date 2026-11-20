/**
 * 交付工具链公共逻辑（P4）：manifest → 标准部署包。
 *
 * 纯判断复用 packages/domain 的规则层；本模块只做 IO（读模板、写文件、注入密钥）。
 * 模板来自 deploy/templates/instance，由已验证的 mrinhk 生产资产参数化而来。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  normalizeInstanceManifest, InstanceManifestError, unsignedBlockers,
} from '../../dist/packages/domain/src/instance-manifest.js';
import {
  assertBundleComplete, assertNoUnknownPlaceholder, BUNDLE_FILES, SECRET_ENV_KEYS,
} from '../../dist/packages/domain/src/deployment.js';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TEMPLATE_DIR = join(ROOT, 'deploy', 'templates', 'instance');

/** 模板文件 → 交付文件；.env.example 模板不带前导点，避免被 .gitignore 忽略。 */
const TEMPLATE_MAP = {
  'docker-compose.yml.tpl': 'docker-compose.yml',
  'Caddyfile.tpl': 'Caddyfile',
  'deploy.sh.tpl': 'deploy.sh',
  'env.example.tpl': '.env.example',
  'DEPLOY.md.tpl': 'DEPLOY.md',
};

export class BundleError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** 读 YAML 并用 P3 规则层校验；可选检查上线阻断项。 */
export function readManifest(file, { requireLaunchReady = false } = {}) {
  let raw;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new BundleError(`读取/解析配置失败：${file}\n  ${error.message}`);
  }
  try {
    const manifest = normalizeInstanceManifest(raw);
    if (requireLaunchReady) {
      const blockers = unsignedBlockers(manifest);
      if (blockers.length) {
        throw new BundleError(
          `配置结构合法，但上线阻断项未签字，拒绝交付：\n  - ${blockers.join('\n  - ')}\n` +
          '请先完成 CLIENT_LAUNCH_INPUTS 的签字确认，再重新生成。', 2,
        );
      }
    }
    return manifest;
  } catch (error) {
    if (error instanceof BundleError) throw error;
    if (error instanceof InstanceManifestError) {
      throw new BundleError(`配置校验失败 [${error.code}]：${error.field}`);
    }
    throw error;
  }
}

function renderTemplate(content, vars) {
  assertNoUnknownPlaceholder(content);
  let out = content;
  for (const [key, value] of Object.entries(vars)) out = out.replaceAll(`{{${key}}}`, value);
  const remaining = out.match(/\{\{(INSTANCE_ID|SITE_DOMAIN|STOREFRONT_APP|STOREFRONT_PKG)\}\}/g);
  if (remaining) throw new BundleError(`模板仍有未替换占位符：${[...new Set(remaining)].join(', ')}`);
  return out;
}

/**
 * 构建标准部署包。默认输出 deploy/merchants/<id>；目标非空时拒绝覆盖（保护现有生产实例）。
 * 返回 { manifest, outDir, configHash, files }。
 */
export function buildBundle({
  manifestFile,
  outDir,
  force = false,
  requireLaunchReady = false,
  coreVersion = '0.1.0',
  themeSchemaVersion = 1,
} = {}) {
  const manifest = readManifest(manifestFile, { requireLaunchReady });
  const id = manifest.instance.id;
  const target = resolve(outDir ?? join(ROOT, 'deploy', 'merchants', id));

  if (existsSync(target) && readdirSync(target).length > 0 && !force) {
    throw new BundleError(
      `目标目录非空，拒绝覆盖：${target}\n` +
      '如确认要重建该实例的部署包，请显式加 --force（.env 仍受独立保护，不会被覆盖）。',
    );
  }
  mkdirSync(target, { recursive: true });

  const vars = {
    INSTANCE_ID: id,
    SITE_DOMAIN: manifest.instance.domain,
    STOREFRONT_APP: `storefront-${id}`,
    STOREFRONT_PKG: `@ezstart/storefront-${id}`,
  };

  for (const [template, output] of Object.entries(TEMPLATE_MAP)) {
    const source = join(TEMPLATE_DIR, template);
    if (!existsSync(source)) throw new BundleError(`缺少部署模板：${source}`);
    let content;
    try {
      content = renderTemplate(readFileSync(source, 'utf8'), vars);
    } catch (error) {
      if (error?.code === 'DEPLOYMENT_PLACEHOLDER_UNKNOWN') {
        throw new BundleError(`模板 ${template} 含未知占位符：${error.field}`);
      }
      throw error;
    }
    writeFileSync(join(target, output), content, 'utf8');
    if (output === 'deploy.sh') chmodSync(join(target, output), 0o755);
  }

  const normalizedYaml = stringifyYaml(manifest);
  writeFileSync(join(target, 'instance.yaml'), normalizedYaml, 'utf8');
  const configHash = createHash('sha256').update(normalizedYaml).digest('hex');

  const bundleManifest = {
    bundleVersion: 1,
    generatedAt: new Date().toISOString(),
    instanceId: id,
    domain: manifest.instance.domain,
    coreVersion,
    themeSchemaVersion,
    manifestSchemaVersion: manifest.schemaVersion,
    configHash,
    sourceManifest: basename(manifestFile),
    files: [...BUNDLE_FILES],
    // 只登记键名，永远不写入密钥值
    secretKeys: [...SECRET_ENV_KEYS],
  };
  writeFileSync(join(target, 'bundle-manifest.json'), `${JSON.stringify(bundleManifest, null, 2)}\n`, 'utf8');

  // .env 是 init 阶段注入的运行时密钥，不属于部署包制品，完整性检查时排除。
  const delivered = readdirSync(target).filter((f) => f !== '.env');
  assertBundleComplete(delivered);

  return { manifest, outDir: target, configHash, files: delivered.sort(), bundleManifest };
}

/** 根据 manifest 生成 .env（密钥本地生成、chmod 600）；已存在则拒绝覆盖。 */
export function writeEnv({ outDir, manifest, force = false } = {}) {
  const envPath = join(outDir, '.env');
  if (existsSync(envPath) && !force) {
    throw new BundleError(`已存在 .env，拒绝覆盖（保护现有密钥）：${envPath}\n如确认重置，请显式加 --force。`);
  }
  // 模板统一 LF；兼容可能残留 CRLF 的旧实例目录，避免正则的 (.*) 被 \r 截断。
  const template = readFileSync(join(outDir, '.env.example'), 'utf8').replace(/\r\n/g, '\n');
  const generated = {
    POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
    INSTANCE_ID: randomUUID(),
    IDENTITY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  };
  const lines = template.split('\n').map((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || !(match[1] in generated)) return line;
    return `${match[1]}=${generated[match[1]]}`;
  });
  writeFileSync(envPath, `${lines.join('\n')}`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(envPath, 0o600);
  return { envPath, injectedKeys: SECRET_ENV_KEYS.filter((k) => k in generated), domain: manifest.instance.domain };
}
