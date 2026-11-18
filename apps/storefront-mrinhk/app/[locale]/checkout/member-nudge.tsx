'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fetchProfile } from '../../../lib/member-client';
import { copyFor, localePath, type Locale } from '../../../lib/i18n';

/**
 * 结账页的会员提示。
 *
 * 只在「未登录」时出现：没开积分时说「登录可积分」就是骗人的，所以只承诺一定成立的事
 * ——订单会归到会员账户。未登录不影响下单：这是提示，不是前置条件。
 */
export default function MemberNudge({ locale }: { locale: Locale }) {
  const t = copyFor[locale];
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchProfile();
      if (cancelled) return;
      if (result.ok) return; // 已登录，不需要提示
      setShow(true);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!show) return null;
  return (
    <p className="form-note member-nudge">
      <Link href={localePath(locale, '/login')}>{t.checkout.memberNudge}</Link>{t.checkout.memberNudgeTail}
    </p>
  );
}
