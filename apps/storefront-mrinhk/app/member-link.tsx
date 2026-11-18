'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fetchProfile } from '../lib/member-client';
import { localePath } from '../lib/i18n';
import { useLocale } from '../lib/use-locale';

/**
 * 页头会员入口：未登录引导登入，已登录直接进会员中心。
 *
 * 登录与登出都走整页跳转，所以这里只需要在挂载时判断一次，
 * 不需要订阅事件或轮询。
 */
export default function MemberLink() {
  const { locale, t } = useLocale();
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
    <Link href={localePath(locale, signedIn ? '/member' : '/login')}>
      {signedIn === null ? t.nav.member : signedIn ? t.nav.memberCenter : t.nav.signIn}
    </Link>
  );
}
