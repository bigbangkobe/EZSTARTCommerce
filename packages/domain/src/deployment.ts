/**
 * 交付工具链纯规则层（配置化前台与交付体系重做方案 P4）。
 *
 * 把已验证的 mrinhk 单实例部署资产（compose / Caddyfile / deploy.sh）抽象成
 * 「一份 manifest → 一个实例目录」的标准包，并给出批量升级的兼容性判定。
 * 这里只回答「部署包该有哪些文件、版本能不能升、升级按什么顺序」，
 * 不碰文件、不碰网络、不碰 YAML、不碰 docker（全部由 scripts 层负责）。
 *
 * 不变量（与 theme.ts / instance-manifest.ts 同一纪律）：
 * 1. 闭集：组件名、密钥变量、发布分组、部署包文件清单均为注册表闭集，未知值直接拒绝。
 * 2. 密钥不落配置：SECRET_ENV_KEYS 只能由 CLI 生成/注入，manifest 与包清单里不保存值。
 * 3. 升级不猜：跨 major、降级、未知 schema 版本一律阻断，交人工评估，不自动放行。
 * 4. 分组顺序固定：pilot → canary → standard，未知分组拒绝，避免"全量同时升级"。
 */

import { SUPPORTED_SCHEMA_VERSIONS } from './instance-manifest.js';

export class DeploymentError extends Error {
  constructor(readonly field: string, readonly code = 'DEPLOYMENT_VALIDATION_ERROR') { super(field); }
}
function fail(field: string, code = 'DEPLOYMENT_VALIDATION_ERROR'): never {
  throw new DeploymentError(field, code);
}

/** 部署包覆盖的四个版本化组件；与 compose 中的服务一一对应。 */
export const CORE_COMPONENTS = ['api', 'admin', 'worker', 'storefront'] as const;
export type CoreComponent = (typeof CORE_COMPONENTS)[number];

/** 发布分组，顺序即批量升级的执行顺序。 */
export const RELEASE_GROUPS = ['pilot', 'canary', 'standard'] as const;
export type ReleaseGroup = (typeof RELEASE_GROUPS)[number];

/** 部署包必需文件；缺任一件视为制品不完整，不允许交付。 */
export const BUNDLE_FILES = [
  'instance.yaml',
  'docker-compose.yml',
  'Caddyfile',
  '.env.example',
  'deploy.sh',
  'DEPLOY.md',
  'bundle-manifest.json',
] as const;
export type BundleFile = (typeof BUNDLE_FILES)[number];

/**
 * 必须由 CLI 生成并安全注入的环境变量。
 * 绝不接受来自 manifest / 模板的明文值，防止密钥进 Git 或跨实例复用。
 */
export const SECRET_ENV_KEYS = [
  'POSTGRES_PASSWORD',
  'INSTANCE_ID',
  'IDENTITY_ENCRYPTION_KEY',
  // 对账端点令牌：每个实例独立生成，泄露即可被伪造成对账调用
  'INTERNAL_JOB_TOKEN',
] as const;

/** 由 manifest 推导、可写入 .env 的非敏感变量。 */
export const PUBLIC_ENV_KEYS = ['POSTGRES_USER', 'POSTGRES_DB', 'SITE_DOMAIN'] as const;

const INSTANCE_ID = /^[a-z][a-z0-9-]{1,48}$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** compose 项目名与镜像前缀，保持与现有 `ezstart-mrinhk-*` 命名一致。 */
export function composeProjectName(instanceId: string): string {
  if (!INSTANCE_ID.test(instanceId)) fail('instance.id', 'DEPLOYMENT_INSTANCE_ID_INVALID');
  return `ezstart-${instanceId}`;
}

/** 镜像名由实例 ID + 组件派生；migrate/worker 复用 api 镜像（沿用现有 compose 约定）。 */
export function imageName(instanceId: string, component: CoreComponent): string {
  if (!(CORE_COMPONENTS as readonly string[]).includes(component)) fail('component', 'DEPLOYMENT_COMPONENT_UNKNOWN');
  return `${composeProjectName(instanceId)}-${component}`;
}

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(value: string): Version {
  const m = SEMVER.exec(value);
  if (!m) fail('version', 'DEPLOYMENT_VERSION_INVALID');
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** 语义化版本比较：a > b 返回正数，相等返回 0。 */
export function compareVersion(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  return (x.major - y.major) || (x.minor - y.minor) || (x.patch - y.patch);
}

/** 单实例在版本清单中的记录（路径等 IO 信息由 CLI 层持有，规则层不关心）。 */
export interface InstanceRecord {
  id: string;
  group: ReleaseGroup;
  coreVersion: string;
  themeSchemaVersion: number;
  manifestSchemaVersion: number;
  /** 主题 schema 变更已人工评审并确认迁移；未确认时禁止跨越主题 schema 版本。 */
  themeMigrationReviewed?: boolean;
}

export interface CompatibilityResult {
  ok: boolean;
  reasons: string[];
}

export interface VersionTarget {
  coreVersion: string;
  themeSchemaVersion: number;
  manifestSchemaVersion: number;
}

/**
 * 升级兼容性判定。只放行「同 major 的前进版本 + schema 已支持 + 主题迁移已确认」。
 * 返回 reasons 而非直接抛错，便于 CLI 一次性列出全部阻断原因。
 */
export function checkUpgradeCompatibility(current: InstanceRecord, target: VersionTarget): CompatibilityResult {
  const reasons: string[] = [];
  const now = parseVersion(current.coreVersion);
  const next = parseVersion(target.coreVersion);
  if (next.major !== now.major) {
    reasons.push(`core major 跨版本 ${now.major}→${next.major}：需人工迁移评估，禁止自动升级`);
  } else if (compareVersion(target.coreVersion, current.coreVersion) < 0) {
    reasons.push(`core 版本回退 ${current.coreVersion}→${target.coreVersion}：禁止降级`);
  }
  const supported = SUPPORTED_SCHEMA_VERSIONS as readonly number[];
  if (!supported.includes(current.manifestSchemaVersion)) {
    reasons.push(`实例 manifest schema v${current.manifestSchemaVersion} 已不受支持`);
  }
  if (!supported.includes(target.manifestSchemaVersion)) {
    reasons.push(`目标 manifest schema v${target.manifestSchemaVersion} 不受支持`);
  }
  if (target.themeSchemaVersion > current.themeSchemaVersion && !current.themeMigrationReviewed) {
    reasons.push(`主题 schema v${current.themeSchemaVersion}→v${target.themeSchemaVersion} 未经迁移评审确认`);
  }
  return { ok: reasons.length === 0, reasons };
}

export interface InstanceUpgradePlan {
  id: string;
  group: ReleaseGroup;
  from: string;
  to: string;
  /** 冒烟与回滚动作由 CLI 按此顺序执行，避免"只拉镜像不验证"。 */
  actions: readonly string[];
  blockers: string[];
  ok: boolean;
}

export interface FleetUpgradePlan {
  target: VersionTarget;
  /** 按分组排序后的实例 ID 执行序列。 */
  order: string[];
  plans: InstanceUpgradePlan[];
  blockedCount: number;
}

export const UPGRADE_ACTIONS = [
  'backup database and media',
  'pin image tags to target version',
  'run prisma migrate deploy',
  'health check (/api/v1/health/ready)',
  'smoke test (home / product / guest checkout / admin login)',
] as const;

/** 生成逐实例升级计划：先 pilot、再 canary、最后 standard；阻断实例不进入自动执行序列。 */
export function planFleetUpgrade(records: readonly InstanceRecord[], target: VersionTarget): FleetUpgradePlan {
  const normalized = records.map((record) => {
    if (!(RELEASE_GROUPS as readonly string[]).includes(record.group)) {
      fail(`instances.${record.id}.group`, 'DEPLOYMENT_GROUP_UNKNOWN');
    }
    return record;
  });
  const sorted = [...normalized].sort(
    (a, b) => RELEASE_GROUPS.indexOf(a.group) - RELEASE_GROUPS.indexOf(b.group) || a.id.localeCompare(b.id),
  );
  const plans: InstanceUpgradePlan[] = sorted.map((record) => {
    const { reasons } = checkUpgradeCompatibility(record, target);
    return {
      id: record.id,
      group: record.group,
      from: record.coreVersion,
      to: target.coreVersion,
      actions: UPGRADE_ACTIONS,
      blockers: reasons,
      ok: reasons.length === 0,
    };
  });
  return {
    target,
    order: plans.filter((p) => p.ok).map((p) => p.id),
    plans,
    blockedCount: plans.filter((p) => !p.ok).length,
  };
}

/** 部署包完整性检查：文件清单必须恰好覆盖 BUNDLE_FILES（不多不少）。 */
export function assertBundleComplete(files: readonly string[]): void {
  const expected: string[] = [...BUNDLE_FILES].sort();
  const actual: string[] = [...files].sort();
  const missing = expected.filter((f) => !actual.includes(f));
  const extra = actual.filter((f) => !expected.includes(f));
  if (missing.length) fail(`bundle.missing.${missing.join(',')}`, 'DEPLOYMENT_BUNDLE_INCOMPLETE');
  if (extra.length) fail(`bundle.extra.${extra.join(',')}`, 'DEPLOYMENT_BUNDLE_UNKNOWN_FILE');
}

/** 渲染模板时允许替换的占位符闭集，拼错占位符在构建阶段就报错。 */
export const TEMPLATE_PLACEHOLDERS = [
  '{{INSTANCE_ID}}',
  '{{SITE_DOMAIN}}',
  '{{STOREFRONT_APP}}',
  '{{STOREFRONT_PKG}}',
] as const;

export function assertNoUnknownPlaceholder(content: string): void {
  const found = content.match(/\{\{[A-Z_]+\}\}/g) ?? [];
  for (const token of found) {
    if (!(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(token)) {
      fail(`template.placeholder.${token}`, 'DEPLOYMENT_PLACEHOLDER_UNKNOWN');
    }
  }
}
