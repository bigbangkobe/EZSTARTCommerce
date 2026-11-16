import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

export function connectDatabase(connectionString: string) {
  const url = new URL(connectionString);
  if (!['postgresql:', 'postgres:'].includes(url.protocol)) throw new Error('Expected a PostgreSQL connection URL');
  if (url.searchParams.has('options')) throw new Error('Database connection options are controlled by the application');
  // adapter-pg normalizes timestamptz strings as UTC. Every pooled connection must
  // request UTC, even when initdb inherited a local (e.g. Asia/Shanghai) timezone.
  return new PrismaClient({ adapter: new PrismaPg({ connectionString, options: '-c timezone=UTC', connectionTimeoutMillis: 5_000, max: 10 }) });
}

export { PrismaClient };
export type { Prisma } from './generated/client.js';
