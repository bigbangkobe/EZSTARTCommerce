import { headers } from 'next/headers';
import { AccessConsole } from '../../access-console';
export default async function Page() { await headers(); return <AccessConsole />; }
