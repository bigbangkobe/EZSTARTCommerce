import { headers } from 'next/headers';
import { ResetForm } from '../../reset-form';
export default async function Page() { await headers(); return <ResetForm />; }
