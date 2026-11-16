import { headers } from 'next/headers';
import { PaymentsConsole } from '../../payments-console';
export default async function Page() { await headers(); return <PaymentsConsole />; }
