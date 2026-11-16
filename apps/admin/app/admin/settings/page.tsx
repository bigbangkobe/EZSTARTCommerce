import { headers } from 'next/headers';
import { SettingsConsole } from '../../settings-console';
export default async function Page() { await headers(); return <SettingsConsole />; }
