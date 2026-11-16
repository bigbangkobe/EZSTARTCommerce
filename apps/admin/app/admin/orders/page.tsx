import { headers } from 'next/headers';
import { OrdersConsole } from '../../orders-console';
export default async function Page() { await headers(); return <OrdersConsole />; }
