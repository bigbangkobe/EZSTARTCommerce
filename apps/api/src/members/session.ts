import type { Prisma } from '../../../../packages/database/src/client.js';
import { sessionTokenDigest } from '../../../../packages/domain/src/members.js';
import { AuthError } from '../identity/service.js';

type Tx = Prisma.TransactionClient;

/**
 * 会员会话解析（会员模块内部共用）。
 *
 * 只认 token 摘要：cookie 被换掉、库被读走都拿不到可用会话。
 * 会话有效不代表会员可用——被停用/关闭的会员即使会话还没过期也不能继续访问。
 */
export async function resolveMemberSession(tx: Tx, token: string) {
  const clock = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const now = clock[0]!.now;
  const session = await tx.memberSession.findUnique({ where: { tokenDigest: sessionTokenDigest(token) },
    include: { member: { include: { customer: true } } } });
  if (!session || session.status !== 'active' || session.expiresAt.getTime() <= now.getTime()) {
    throw new AuthError(401, 'UNAUTHORIZED');
  }
  if (session.member.status !== 'active') throw new AuthError(401, 'UNAUTHORIZED');
  return { session, member: session.member, customer: session.member.customer, now };
}
