"use client";
import { useEffect, useRef, useState, type FormEvent } from 'react';

type Market = { marketCode: string; enabled: boolean; eligibleProductIds: string[]; reviewStatus: string; reviewValidUntil: string | null };
type Config = { displayName: string; locales: string[]; defaultLocale: string; baseCurrency: string; timezone: string;
  featureFlags: Record<string, boolean>; marketProfiles: Market[];
  brandAssets: { logoMediaId: string | null; faviconMediaId: string | null }; version: number; updatedAt: string };
type Session = { permissionCodes: string[]; csrfToken: string };
type MailTestJob = { id: string; recipientMasked: string; status: string; attempts: number;
  lastErrorCode: string | null; createdAt: string; sentAt: string | null };

const LOCALES = [['zh-CN', '简体中文'], ['zh-HK', '繁體中文'], ['en', 'English']] as const;
const FLAGS = [['guestCheckout', '访客结账'], ['memberOtpLogin', '会员验证码登录'], ['codPayment', '货到付款'],
  ['onlinePayment', '线上支付'], ['ageVerification', '年龄验证']] as const;
const STATUS: Record<string, string> = { pending: '待审核', approved: '已通过', rejected: '已拒绝', revoked: '已撤销', expired: '已过期' };
const MAIL_STATUS: Record<string, string> = { pending: '待发送', processing: '发送中', sent: '已送达', failed: '失败', cancelled: '已取消' };

export function SettingsConsole() {
  const session = useRef<Session | null>(null); const [permissions, setPermissions] = useState<string[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [newMarket, setNewMarket] = useState('');
  const [tests, setTests] = useState<MailTestJob[]>([]);
  const canManage = permissions.includes('store.settings.manage');
  const canSeeMail = permissions.includes('notifications.read');

  async function request<T>(path: string, method = 'GET', body?: object, version?: number): Promise<{ data: T; etag: string | null }> {
    const response = await fetch(`/api/v1/admin/${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CSRF-Token': session.current?.csrfToken ?? '' } : {}),
      ...(version !== undefined ? { 'If-Match': `"${version}"` } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 401) { location.assign('/admin/login'); throw new Error('会话已失效，请重新登录。'); }
    if (!response.ok) {
      if (response.status === 409) throw new Error('配置已被其他操作修改，请刷新后核对再试。');
      if (response.status === 403) throw new Error('当前账号没有执行此操作所需的权限；记录市场审核仅限店主。');
      if (response.status === 422) throw new Error('填写内容不符合要求：请检查默认语言是否在启用语言内、时区是否为有效 IANA 区域、市场是否已审核且未过期。');
      if (response.status === 429) throw new Error('操作过于频繁，请稍后重试。');
      throw new Error('操作未完成，请稍后重试。');
    }
    const payload = await response.json();
    return { data: payload.data as T, etag: response.headers.get('etag') };
  }

  async function reload() {
    const current = await request<Session>('auth/session');
    session.current = { permissionCodes: current.data.permissionCodes, csrfToken: current.data.csrfToken };
    setPermissions(current.data.permissionCodes);
    const config = await request<Config>('store-config');
    setConfig(config.data); setReady(true);
  }
  useEffect(() => { reload().catch(reason => setError(reason instanceof Error ? reason.message : '加载失败。')); }, []);
  // 邮件自检与店铺设置是两回事：有 notifications.read 就能看，哪怕没有设置权限。
  useEffect(() => { if (canSeeMail) request<{ items: MailTestJob[] }>('mail/test?limit=10')
    .then(current => setTests(current.data.items)).catch(() => {}); }, [canSeeMail]);

  function sendTestMail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void run(async () => {
      await request('mail/test', 'POST', { recipient: values.get('recipient'), locale: 'zh-HK' });
      const current = await request<{ items: MailTestJob[] }>('mail/test?limit=10');
      setTests(current.data.items);
      setNotice('测试邮件已入队，由通知 worker 投递；几分钟内未收到的话，请在下方核对任务状态。');
    });
  }

  async function run(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { await action(); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '请求未完成。'); }
    finally { setBusy(false); }
  }

  function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!config) return;
    const values = new FormData(event.currentTarget);
    const locales = values.getAll('locales').map(String);
    if (!locales.length) { setError('至少保留一种启用语言。'); return; }
    const featureFlags = Object.fromEntries(FLAGS.map(([flag]) => [flag, values.get(`flag:${flag}`) === 'on']));
    void run(async () => {
      const saved = await request<Config>('store-config', 'PATCH', {
        displayName: values.get('displayName'), locales, defaultLocale: values.get('defaultLocale'),
        baseCurrency: values.get('baseCurrency'), timezone: values.get('timezone'), featureFlags,
      }, config.version);
      setConfig(saved.data); setNotice('店铺设置已保存，并写入审计记录。');
    });
  }

  function addMarket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!config) return;
    const code = newMarket.trim().toUpperCase();
    if (!/^[A-Z0-9-]{2,16}$/.test(code)) { setError('市场代码需为 2–16 位字母、数字或连字符。'); return; }
    if (config.marketProfiles.some(market => market.marketCode === code)) { setError('该市场已存在。'); return; }
    void run(async () => {
      const saved = await request<Config>('store-config', 'PATCH', { marketProfiles: [{ marketCode: code, enabled: false }] }, config.version);
      setConfig(saved.data); setNewMarket(''); setNotice('市场档案已建立，需记录审核结论后才能开启交易。');
    });
  }

  function toggleMarket(market: Market, enabled: boolean) {
    if (!config) return;
    if (enabled && market.reviewStatus !== 'approved') { setError('未通过审核的市场不能开启交易。'); return; }
    void run(async () => {
      const saved = await request<Config>('store-config', 'PATCH', { marketProfiles: [{ marketCode: market.marketCode, enabled }] }, config.version);
      setConfig(saved.data); setNotice(enabled ? `已开启 ${market.marketCode} 的交易。` : `已关闭 ${market.marketCode} 的交易。`);
    });
  }

  function recordReview(event: FormEvent<HTMLFormElement>, market: Market) {
    event.preventDefault(); if (!config) return;
    const form = event.currentTarget; const values = new FormData(form);
    const validUntil = String(values.get('validUntil') ?? '');
    void run(async () => {
      await request(`store-config/markets/${market.marketCode}/reviews`, 'POST', {
        decision: values.get('decision'), evidenceReference: values.get('evidenceReference'), reason: values.get('reason'),
        validUntil: validUntil ? new Date(validUntil).toISOString() : null, confirmedMarketCode: values.get('confirmedMarketCode'),
      }, config.version);
      form.reset(); setNotice('审核结论已追加记录；审核通过不会自动开启市场。');
    });
  }

  return <main className="console"><div className="brand">EZSTART<span>Commerce</span></div><header><div><p className="eyebrow">店铺管理</p><h1>店铺设置</h1></div><div className="actions">
    <a href="/admin/catalog">商品目录</a><a href="/admin/access">员工与角色</a>{permissions.includes('audit.read') && <a href="/admin/audit">审计记录</a>}{permissions.includes('media.manage') && <a href="/admin/media">媒体库</a>}{permissions.includes('shipping.manage') && <a href="/admin/shipping">配送与结账</a>}{permissions.includes('orders.read') && <a href="/admin/orders">订单</a>}{(permissions.includes('payments.read') || permissions.includes('payment.config')) && <a href="/admin/payments">付款</a>}{permissions.includes('inventory.read') && <a href="/admin/inventory">库存</a>}{permissions.includes('aftersales.read') && <a href="/admin/aftersales">售后</a>}{permissions.includes('coupons.read') && <a href="/admin/coupons">优惠券</a>}{permissions.includes('members.manage') && <a href="/admin/members">会员与积分</a>}{permissions.includes('privacy.read') && <a href="/admin/privacy">资料请求</a>}    <button disabled={busy || !canManage} onClick={() => void run(async () => {})}>刷新配置</button></div></header>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
    {!ready && !error && <p>正在检查会话与权限…</p>}
    {ready && !canManage && <section><h2>没有店铺设置权限</h2><p>店铺设置只对获 store.settings.manage 的员工开放，请联系店主。</p></section>}
    {ready && canManage && config && <>
      <section aria-labelledby="brand-title"><h2 id="brand-title">基本信息</h2>
        <form key={`settings:${config.version}`} onSubmit={saveSettings}>
          <label>店铺名称<input name="displayName" defaultValue={config.displayName} required maxLength={120} /></label>
          <fieldset><legend>启用语言（至少一种；商品发布前每种启用语言都必须有完整翻译）</legend>
            {LOCALES.map(([code, label]) => <label className="check" key={code}><input type="checkbox" name="locales" value={code} defaultChecked={config.locales.includes(code)} />{label}</label>)}
          </fieldset>
          <label>默认语言<select name="defaultLocale" defaultValue={config.defaultLocale}>
            {LOCALES.filter(([code]) => config.locales.includes(code)).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select></label>
          <label>基础币种（ISO 4217 三位代码；产生交易后不可更改）<input name="baseCurrency" defaultValue={config.baseCurrency} pattern="[A-Z]{3}" required maxLength={3} /></label>
          <label>时区（IANA 名称，如 Asia/Hong_Kong）<input name="timezone" defaultValue={config.timezone} required maxLength={100} /></label>
          <fieldset><legend>功能开关</legend>
            {FLAGS.map(([flag, label]) => <label className="check" key={flag}><input type="checkbox" name={`flag:${flag}`} defaultChecked={config.featureFlags[flag] === true} />{label}</label>)}
          </fieldset>
          <p><small>版本 {config.version} · 最近更新 {new Date(config.updatedAt).toLocaleString('zh-CN')}</small></p>
          <label className="check"><input type="checkbox" required />我已核对语言、币种与时区，并确认保存</label>
          <button disabled={busy}>保存店铺设置</button>
        </form>
      </section>
      <section aria-labelledby="market-title"><h2 id="market-title">市场与交易资格</h2>
        <p>市场只有先记录“审核通过”且未过期的结论，才能开启交易；审核结论只是记录客户提供的依据，不代替法律判断。</p>
        {config.marketProfiles.length === 0 && <p>尚未建立市场档案。</p>}
        {config.marketProfiles.map(market => <article key={market.marketCode}>
          <h3>{market.marketCode} <span className="preset">{STATUS[market.reviewStatus] ?? market.reviewStatus}</span></h3>
          <p>{market.enabled ? '当前开放交易' : '当前不开放交易'}{market.reviewValidUntil && ` · 审核有效期至 ${new Date(market.reviewValidUntil).toLocaleString('zh-CN')}`}</p>
          <div className="actions">
            <button disabled={busy || (!market.enabled && market.reviewStatus !== 'approved')} onClick={() => toggleMarket(market, !market.enabled)}>
              {market.enabled ? `关闭 ${market.marketCode} 交易` : `开启 ${market.marketCode} 交易`}</button>
          </div>
          <form onSubmit={event => recordReview(event, market)}>
            <label>审核结论<select name="decision" defaultValue="approved">
              <option value="approved">通过</option><option value="rejected">拒绝</option><option value="revoked">撤销</option>
            </select></label>
            <label>依据引用<input name="evidenceReference" required maxLength={500} placeholder="客户律师意见编号或文件引用" /></label>
            <label>说明<textarea name="reason" required maxLength={1000} /></label>
            <label>有效期（可留空表示长期有效）<input name="validUntil" type="datetime-local" /></label>
            <label>确认市场代码<input name="confirmedMarketCode" required placeholder={market.marketCode} maxLength={16} /></label>
            <label className="check"><input type="checkbox" required />我确认本结论由客户或其顾问提供，仅记录依据</label>
            <button disabled={busy}>记录 {market.marketCode} 审核结论</button>
          </form>
        </article>)}
        <form onSubmit={addMarket}><label>新增市场代码<input value={newMarket} onChange={event => setNewMarket(event.target.value)} placeholder="如 HK" maxLength={16} /></label><button disabled={busy}>建立市场档案</button></form>
      </section>
    </>}
    {ready && canSeeMail && <section aria-labelledby="mail-title"><h2 id="mail-title">邮件自检</h2>
      <p>会员验证码与员工邀请都经同一条通知队列投递。发一封测试邮件即可验证 SMTP 凭据与 worker 是否正常；
        任务一直停在「待发送」通常意味着 worker 没有启动，或 SMTP 配置仍为空。</p>
      {permissions.includes('notifications.manage') && <form onSubmit={sendTestMail}>
        <label>收件邮箱<input name="recipient" type="email" required maxLength={320} placeholder="you@example.com" /></label>
        <button disabled={busy}>发送测试邮件</button>
      </form>}
      {tests.length > 0 && <table><thead><tr><th>时间</th><th>收件人</th><th>状态</th><th>尝试</th><th>结果</th></tr></thead>
        <tbody>{tests.map(job => <tr key={job.id}>
          <td>{new Date(job.createdAt).toLocaleString('zh-CN')}</td>
          <td>{job.recipientMasked ?? '—'}</td>
          <td>{MAIL_STATUS[job.status] ?? job.status}</td>
          <td>{job.attempts}</td>
          <td>{job.sentAt ? new Date(job.sentAt).toLocaleString('zh-CN') : (job.lastErrorCode ?? '')}</td>
        </tr>)}</tbody></table>}
    </section>}
  </main>;
}
