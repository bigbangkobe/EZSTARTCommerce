import { headers } from 'next/headers';
import { PasswordForm } from '../../password-form';
export default async function Page() { await headers(); return <PasswordForm />; }
