'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fetchProfile } from '../../lib/member-client';

/**
 * 结账页的会员提示。
 *
 * 只在「积分功能已开启且未登录」时出现：没开积分时说「登录可积分」就是骗人的。
 * 未登录不影响下单——这是提示，不是前置条件。
 */
export default function MemberNudge() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchProfile();
      if (cancelled) return;
      if (result.ok) return; // 已登录，不需要提示
      // 未登录时读不到店铺的积分开关（档案接口要会话），所以只承诺一定成立的事：
      // 订单会归到会员账户。积分是否存在，等登录后在会员中心看。
      setShow(true);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!show) return null;
  return (
    <p className="form-note member-nudge">
      <Link href="/login">登入會員</Link>，這張訂單就會記錄在你的會員帳戶內；不登入也可直接結帳。
    </p>
  );
}
