import { headers } from 'next/headers';
import { WorkbenchConsole } from '../workbench-console';
export default async function Page() { await headers(); return <WorkbenchConsole />; }
