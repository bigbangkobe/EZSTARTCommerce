'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fetchProfile } from '../lib/member-client';

/**
 * 页头会员入口：未登录引导登入，已登录直接进会员中心。
 *
 * 登录与登出都走整页跳转，所以这里只需要在挂载时判断一次，
 * 不需要订阅事件或轮询。
 */
export default function MemberLink() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchProfile();
      if (!cancelled) setSignedIn(result.ok);
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <Link href={signedIn ? '/member' : '/login'}>
      {signedIn === null ? '會員' : signedIn ? '會員中心' : '登入'}
    </Link>
  );
}
