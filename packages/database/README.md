# 身份数据与迁移

`schema.prisma` 与 `migrations/202610190001_identity` 定义本轮身份模型；客户端通过 Prisma 7.10.1、adapter-pg 连接独立 PostgreSQL 18。

从项目根目录运行 `pnpm db:generate` / `pnpm db:validate`。准备项目专属数据库并填写私有 `.env` 后，使用 `pnpm db:migrate` 应用已提交迁移；不使用 db push 替代迁移记录。

初始 SQL 从 Prisma 模型 diff 生成，并补充模型无法表达的 CHECK、部分唯一索引及追加审计触发器。后续变更须创建新迁移，保留这些约束；已经应用的 SQL 文件不可直接修改。服务启动/就绪会检查初始迁移的校验和与完成状态，未来增加迁移时须同步完善版本清单校验。

连接池强制 UTC；禁止 DATABASE_URL 自带 options 参数覆盖时区。生成文件在 src/generated，忽略提交，由构建阶段再生成。完整运行说明和当前限制见 [身份实现说明](../../docs/03-开发文档/R1_IDENTITY_IMPLEMENTATION.md)。
