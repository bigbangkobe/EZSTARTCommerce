import { headers } from 'next/headers';
import { IdentityForm } from '../../identity-form';
export default async function Page() { await headers(); return <IdentityForm initialMode="invite" />; }
