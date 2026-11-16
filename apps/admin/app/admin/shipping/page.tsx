import { headers } from 'next/headers';
import { ShippingConsole } from '../../shipping-console';
export default async function Page() { await headers(); return <ShippingConsole />; }
