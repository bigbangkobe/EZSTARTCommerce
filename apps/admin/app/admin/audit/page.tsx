import { headers } from 'next/headers';
import { AuditConsole } from '../../audit-console';
export default async function Page() { await headers(); return <AuditConsole />; }
