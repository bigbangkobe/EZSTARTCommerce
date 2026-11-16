import { headers } from 'next/headers';
import { CatalogConsole } from '../../catalog-console';
export default async function Page() { await headers(); return <CatalogConsole />; }
