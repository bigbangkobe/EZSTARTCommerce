"use client";
import { useEffect, useRef, useState, type FormEvent } from 'react';

type Zone = { id: string; code: string; nameByLocale: Record<string, string>; countryCodes: string[]; regionCodes: string[];
  priority: number; enabled: boolean; version: number };
type Rate = { id: string; code: string; nameByLocale: Record<string, string>; zoneIds: string[]; fixedFeeMinor: number;
  freeAboveMinor: number | null; currency: string; estimatedMinDays: number | null; estimatedMaxDays: number | null;
  codEnabled: boolean; enabled: boolean; version: number };
type Method = { id: string; code: string; name: string; feeMinor: number; estimatedMinDays: number | null;
  estimatedMaxDays: number | null; codEnabled: boolean };
type Session = { permissionCodes: string[]; csrfToken: string };

/** 金额输入按“元”展示、按分存储：任何超过两位小数的输入都拒绝，不四舍五入。 */
function toMinor(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) return null;
  const [major = '0', cents = ''] = text.split('.');
  return Number(major) * 100 + Number(cents.padEnd(2, '0'));
}
function money(minor: number, currency: string) {
  return `${currency} ${(minor / 100).toFixed(2)}`;
}

export function ShippingConsole() {
  const session = useRef<Session | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [rates, setRates] = useState<Rate[]>([]);
  const [currency, setCurrency] = useState('HKD');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<Method[] | null>(null);
  const canManage = permissions.includes('shipping.manage');

  async function request<T>(path: string, method = 'GET', body?: object, version?: number): Promise<{ data: T }> {
    const response = await fetch(`/api/v1/admin/${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-CSRF-Token': session.current?.csrfToken ?? '' } : {}),
      ...(version !== undefined ? { 'If-Match': `"${version}"` } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 401) { location.assign('/admin/login'); throw new Error('会话已失效，请重新登录。'); }
    if (!response.ok) {
      if (response.status === 403) throw new Error('当前账号没有配送配置权限。');
      if (response.status === 409) throw new Error('编码已被占用，或该区域与其他启用区域重叠。');
      if (response.status === 422) throw new Error('填写内容不符合要求：国家码为两位大写字母，编码只含字母数字与 . _ -，币种必须是店铺基础币种。');
      throw new Error('操作未完成，请稍后重试。');
    }
    return { data: (await response.json()).data as T };
  }

  async function reload() {
    const current = await request<Session>('auth/session');
    session.current = { permissionCodes: current.data.permissionCodes, csrfToken: current.data.csrfToken };
    setPermissions(current.data.permissionCodes);
    const zoneList = await request<{ items: Zone[] }>('shipping/zones');
    const rateList = await request<{ items: Rate[] }>('shipping/rates');
    setZones(zoneList.data.items); setRates(rateList.data.items);
    setCurrency(rateList.data.items[0]?.currency ?? 'HKD');
  }
  useEffect(() => { reload().catch(reason => setError(reason instanceof Error ? reason.message : '加载失败。')); }, []);

  async function run(action: () => Promise<string>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { const message = await action(); await reload(); setNotice(message); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '请求未完成。'); }
    finally { setBusy(false); }
  }

  function names(values: FormData) {
    const en = String(values.get('nameEn') ?? '').trim();
    const zh = String(values.get('nameZh') ?? '').trim();
    return { ...(en ? { en } : {}), ...(zh ? { 'zh-HK': zh } : {}) };
  }
  function list(value: FormDataEntryValue | null) {
    return String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
  }

  function createZone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const localized = names(values);
    if (!Object.keys(localized).length) { setError('至少填写一种语言的区域名称。'); return; }
    const payload = { code: String(values.get('code') ?? ''), nameByLocale: localized, countryCodes: list(values.get('countries')),
      regionCodes: list(values.get('regions')), priority: Number(values.get('priority') ?? 0), enabled: true };
    void run(async () => { await request('shipping/zones', 'POST', payload); form.reset(); return '配送区已创建。'; });
  }

  function createRate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const zoneIds = values.getAll('zoneIds').map(String);
    const localized = names(values);
    if (!zoneIds.length) { setError('至少选择一个配送区。'); return; }
    if (!Object.keys(localized).length) { setError('至少填写一种语言的配送方式名称。'); return; }
    const fee = toMinor(String(values.get('fee') ?? ''));
    if (fee === null) { setError('运费请填写非负金额，最多两位小数。'); return; }
    const freeAboveText = String(values.get('freeAbove') ?? '').trim();
    const freeAbove = freeAboveText ? toMinor(freeAboveText) : null;
    if (freeAboveText && freeAbove === null) { setError('免邮门槛请填写非负金额，最多两位小数。'); return; }
    const minDays = String(values.get('minDays') ?? '').trim();
    const maxDays = String(values.get('maxDays') ?? '').trim();
    if (minDays && maxDays && Number(maxDays) < Number(minDays)) { setError('最长天数不能小于最短天数。'); return; }
    const payload = { code: String(values.get('code') ?? ''), nameByLocale: localized, zoneIds, fixedFeeMinor: fee,
      freeAboveMinor: freeAbove, currency, estimatedMinDays: minDays ? Number(minDays) : null,
      estimatedMaxDays: maxDays ? Number(maxDays) : null, codEnabled: values.get('cod') === 'on', enabled: true };
    void run(async () => { await request('shipping/rates', 'POST', payload); form.reset(); return '配送方式已创建。'; });
  }

  function toggle(kind: 'zones' | 'rates', id: string, enabled: boolean, version: number) {
    void run(async () => { await request(`shipping/${kind}/${id}`, 'PATCH', { enabled: !enabled }, version);
      return !enabled ? '已启用。' : '已停用；停用后该区域/方式不再参与结账。'; });
  }

  function quote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const subtotal = toMinor(String(values.get('subtotal') ?? ''));
    if (subtotal === null) { setError('试算金额请填写非负金额，最多两位小数。'); return; }
    void run(async () => {
      const result = await request<{ methods: Method[] }>('shipping/quote-preview', 'POST', {
        address: { countryCode: String(values.get('country') ?? '').toUpperCase(), regionCode: null, addressLine1: 'preview' },
        merchandiseSubtotalMinor: subtotal, currency });
      setPreview(result.data.methods);
      return `试算完成：${result.data.methods.length} 个可用方式。`;
    });
  }

  return <main className="console"><div className="brand">EZSTART<span>Commerce</span></div>
    <header><div><p className="eyebrow">店铺管理</p><h1>配送与结账</h1></div>
      <div className="actions"><a href="/admin/catalog">商品目录</a><a href="/admin/orders">订单</a><a href="/admin/settings">店铺设置</a>
        <a href="/admin/access">员工与角色</a>
        <button disabled={busy} onClick={() => void run(async () => '已刷新。')}>刷新配置</button></div></header>
    {error && <p className="error">{error}</p>}{notice && <p className="notice">{notice}</p>}
    {!canManage && <p className="error">当前账号没有配送配置权限（shipping.manage）。</p>}

    <section>
      <h2>配送区</h2>
      <p>按国家与区域划分。启用区之间不能出现重叠口径，否则同一地址会有两份运费。</p>
      {zones.map(zone => <article key={zone.id}>
        <h3>{zone.code} <span className="preset">{zone.enabled ? '启用' : '停用'}</span></h3>
        <p>{Object.values(zone.nameByLocale).join(' / ')}</p>
        <p>国家：{zone.countryCodes.join(', ')}{zone.regionCodes.length ? `；区域：${zone.regionCodes.join(', ')}` : '；全境'}</p>
        <p>优先级 {zone.priority} · 版本 {zone.version}</p>
        <div className="actions"><button className="secondary" disabled={busy || !canManage}
          onClick={() => toggle('zones', zone.id, zone.enabled, zone.version)}>{zone.enabled ? '停用' : '启用'}</button></div>
      </article>)}
      <form onSubmit={createZone}>
        <h3>新建配送区</h3>
        <label>编码<input name="code" required maxLength={80} placeholder="HK" /></label>
        <label>名称（英文）<input name="nameEn" maxLength={120} placeholder="Hong Kong" /></label>
        <label>名称（繁體中文，可空）<input name="nameZh" maxLength={120} /></label>
        <label>国家/地区代码<small>两位 ISO 码，逗号分隔，例如 HK,MO</small>
          <input name="countries" required placeholder="HK" /></label>
        <label>区域代码<small>可空表示全境；多个用逗号分隔</small><input name="regions" /></label>
        <label>优先级<input name="priority" type="number" min={0} max={10000} defaultValue={0} /></label>
        <button disabled={busy || !canManage}>创建配送区</button>
      </form>
    </section>

    <section>
      <h2>配送方式与费率</h2>
      <p>首期只支持固定运费与金额门槛免邮；币种固定为店铺基础币种 {currency}。</p>
      {rates.map(rate => <article key={rate.id}>
        <h3>{rate.code} <span className="preset">{rate.enabled ? '启用' : '停用'}</span></h3>
        <p>{Object.values(rate.nameByLocale).join(' / ')}</p>
        <p>运费 {money(rate.fixedFeeMinor, rate.currency)}{rate.freeAboveMinor !== null
          ? `，满 ${money(rate.freeAboveMinor, rate.currency)} 免邮` : ''}</p>
        <p>覆盖区：{rate.zoneIds.map(id => zones.find(zone => zone.id === id)?.code ?? id).join(', ')}
          {rate.estimatedMinDays !== null ? ` · ${rate.estimatedMinDays}–${rate.estimatedMaxDays ?? rate.estimatedMinDays} 天` : ''}
          {rate.codEnabled ? ' · 支持货到付款' : ''}</p>
        <div className="actions"><button className="secondary" disabled={busy || !canManage}
          onClick={() => toggle('rates', rate.id, rate.enabled, rate.version)}>{rate.enabled ? '停用' : '启用'}</button></div>
      </article>)}
      <form onSubmit={createRate}>
        <h3>新建配送方式</h3>
        <label>编码<input name="code" required maxLength={80} placeholder="STANDARD" /></label>
        <label>名称（英文）<input name="nameEn" maxLength={120} placeholder="Standard delivery" /></label>
        <label>名称（繁體中文，可空）<input name="nameZh" maxLength={120} /></label>
        <fieldset><legend>适用配送区</legend>{zones.length === 0 ? <p>先创建配送区。</p>
          : zones.map(zone => <label className="check" key={zone.id}><input type="checkbox" name="zoneIds" value={zone.id} />
            {zone.code} — {Object.values(zone.nameByLocale).join(' / ')}</label>)}</fieldset>
        <label>固定运费（{currency}）<input name="fee" required placeholder="30.00" /></label>
        <label>免邮门槛（{currency}，可空）<input name="freeAbove" placeholder="200.00" /></label>
        <label>预计最短天数<input name="minDays" type="number" min={0} max={365} /></label>
        <label>预计最长天数<input name="maxDays" type="number" min={0} max={365} /></label>
        <label className="check"><input type="checkbox" name="cod" />支持货到付款</label>
        <button disabled={busy || !canManage}>创建配送方式</button>
      </form>
    </section>

    <section>
      <h2>运费试算</h2>
      <p>按当前配置模拟结账：只返回覆盖该国家且已启用的方式。</p>
      <form onSubmit={quote}>
        <label>国家/地区代码<input name="country" required placeholder="HK" maxLength={2} /></label>
        <label>商品小计（{currency}）<input name="subtotal" required placeholder="100.00" /></label>
        <button disabled={busy || !canManage}>试算</button>
      </form>
      {preview && <article><h3>可用方式</h3>{preview.length === 0 ? <p>该国家暂无可用配送方式。</p>
        : <ul>{preview.map(method => <li key={method.id}>{method.code} — {method.name}：{money(method.feeMinor, currency)}
          {method.codEnabled ? '（可货到付款）' : ''}</li>)}</ul>}</article>}
    </section>
  </main>;
}
