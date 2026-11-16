import { headers } from 'next/headers';
import { MediaConsole } from '../../media-console';
export default async function Page() { await headers(); return <MediaConsole />; }
