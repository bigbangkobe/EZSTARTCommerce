import { headers } from 'next/headers';
import { ThemeConsole } from '../../theme-console';
// 与其它后台页一致：显式读取请求头，确保按请求渲染并带上 CSP nonce。
export default async function Page() { await headers(); return <ThemeConsole />; }
