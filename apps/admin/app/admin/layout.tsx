import type { ReactNode } from 'react';
import { AdminShell } from '../admin-shell';

/** 后台统一外壳：左侧导航 + 内容区。登录类页面由 AdminShell 自行放行，不加外壳。 */
export default function Layout({ children }: { children: ReactNode }) { return <AdminShell>{children}</AdminShell>; }
