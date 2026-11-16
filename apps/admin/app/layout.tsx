import type { ReactNode } from 'react';
import './style.css';
export const metadata = { title: 'EZSTARTCommerce · 店铺管理', robots: { index: false, follow: false } };
export default function Layout({ children }: { children: ReactNode }) { return <html lang="zh-CN"><body>{children}</body></html>; }
