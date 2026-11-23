import { headers } from 'next/headers';
import { ImportConsole } from '../../../import-console';

export default async function Page() {
  await headers();
  return <ImportConsole />;
}
