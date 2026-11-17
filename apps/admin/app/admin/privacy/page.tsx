import { headers } from 'next/headers';
import { PrivacyConsole } from '../../privacy-console';
// 与其它后台页一致：显式读取请求头，确保按请求渲染并带上 CSP nonce，否则静态预渲染的内联脚本会被 CSP 拦掉。
export default async function Page() { await headers(); return <PrivacyConsole />; }
