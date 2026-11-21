"use client";
import { useEffect, useState, type ReactNode } from 'react';
import { dateTime, money, orderStatus, paymentStatus } from './labels';

type RecentOrder = { id: string; publicOrderNumber: string; orderStatus: string; paymentStatus: string;
  currency: string; totalMinor: number; createdAt: string };
type Summary = { generatedAt: string;
  orders: { awaitingConfirmation: number; awaitingDispatch: number; prepaidUnsettled: number };
  aftersales: { open: number } | null;
  inventory: { lowStock: number } | null;
  recentOrders: RecentOrder[] };

const ICONS: Record<string, ReactNode> = {
  confirm: <><circle cx="12" cy="12" r="8.6" /><path d="m8.4 12.2 2.5 2.5 4.7-5" /></>,
  dispatch: <><path d="M2.8 6.6h10.4v9.6H2.8zM13.2 10.2h3.6l3.4 3.2v2.8h-7z" /><circle cx="7" cy="18.4" r="1.6" /><circle cx="17.2" cy="18.4" r="1.6" /></>,
  prepaid: <><rect x="3" y="6" width="18" height="12.5" rx="2.2" /><path d="M3 10.4h18M16.4 14.6h1.8" /></>,
  aftersales: <><path d="M3.5 12a8.5 8.5 0 1 0 2.9-6.4" /><path d="M3.2 4.2v4.6h4.6" /></>,
  stock: <><path d="M12 3.2 20.4 8 12 12.8 3.6 8z" /><path d="M3.6 12.8 12 17.6l8.4-4.8" /></>,
};

function KpiIcon({ name }: { name: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>;
}

export function WorkbenchConsole() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      const response = await fetch('/api/v1/admin/workbench', { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 401) { location.assign('/admin/login'); return; }
      if (response.status === 403) { setError('当前角色没有查看工作台的权限（需要订单读取）。'); return; }
      if (!response.ok) { setError('工作台数据加载失败，请稍后刷新。'); return; }
      setData((await response.json()).data);
      setError('');
    } catch { setError('网络异常，工作台数据加载失败。'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);

  const cards = data ? [
    { key: 'confirm', icon: 'confirm', label: '待确认订单', value: data.orders.awaitingConfirmation, href: '/admin/orders',
      hint: '线下转账待核款，确认后才进入拣货' },
    { key: 'dispatch', icon: 'dispatch', label: '待发货', value: data.orders.awaitingDispatch, href: '/admin/orders',
      hint: '已确认但尚未完成发货' },
    { key: 'prepaid', icon: 'prepaid', label: '预付未收款', value: data.orders.prepaidUnsettled, href: '/admin/orders',
      hint: '未收到款前发货会被系统拦截' },
    ...(data.aftersales ? [{ key: 'aftersales', icon: 'aftersales', label: '待处理售后', value: data.aftersales.open,
      href: '/admin/aftersales', hint: '受理、审批、退换货处理中' }] : []),
    ...(data.inventory ? [{ key: 'stock', icon: 'stock', label: '低库存规格', value: data.inventory.lowStock,
      href: '/admin/inventory', hint: '可售数已到或低于阈值' }] : []),
  ] : [];

  const now = new Date();
  const weekday = '日一二三四五六'[now.getDay()];

  return <main className="console workbench">
    <header><div><p className="eyebrow">今日概览</p><h1>工作台</h1>
      <p className="lede">{now.getFullYear()} 年 {now.getMonth() + 1} 月 {now.getDate()} 日 周{weekday}
        {data && ` · 数据截至 ${dateTime(data.generatedAt)}`}</p></div>
      <div className="actions">
        <a className="btn secondary" href="/admin/orders">全部订单</a>
        <button className="secondary" disabled={busy} onClick={() => void load()}>{busy ? '刷新中…' : '刷新'}</button>
      </div></header>

    {error && <p role="alert" className="error">{error}</p>}
    {!data && !error && <p className="lede">正在汇总今日待办…</p>}

    {data && <>
      <section aria-label="待办概览"><div className="kpi-grid">
        {cards.map(card => <a className="kpi" key={card.key} href={card.href} data-tone={card.value > 0 ? 'hot' : 'calm'}>
          <span className="kpi-icon"><KpiIcon name={card.icon} /></span>
          <span className="kpi-body">
            <span className="kpi-head">
              <span className="kpi-label">{card.label}</span>
              {card.value > 0 && <span className="kpi-flag">待处理</span>}
            </span>
            <strong className="kpi-value">{card.value}</strong>
            <span className="kpi-hint">{card.hint}</span>
          </span>
        </a>)}
      </div></section>

      <div className="wb-split">
        <section aria-labelledby="recent-title">
          <h2 id="recent-title">最新订单</h2>
          {data.recentOrders.length === 0
            ? <div className="empty"><strong>还没有订单</strong><span>顾客下单后会出现在这里。</span></div>
            : <>
              <div className="table-wrap only-wide"><table className="table">
                <thead><tr><th>订单号</th><th>订单状态</th><th>收款状态</th><th>下单时间</th><th className="num">金额</th></tr></thead>
                <tbody>{data.recentOrders.map(order => {
                  const orderLabel = orderStatus(order.orderStatus);
                  const payLabel = paymentStatus(order.paymentStatus);
                  return <tr key={order.id}>
                    <td className="nowrap"><a href="/admin/orders">{order.publicOrderNumber}</a></td>
                    <td><span className="badge-status" data-tone={orderLabel.tone || undefined}>{orderLabel.label}</span></td>
                    <td><span className="badge-status" data-tone={payLabel.tone || undefined}>{payLabel.label}</span></td>
                    <td className="nowrap">{dateTime(order.createdAt)}</td>
                    <td className="num"><strong>{money(order.totalMinor, order.currency)}</strong></td>
                  </tr>;
                })}</tbody>
              </table></div>
              {/* 窄屏用行卡片：表格横滚会把金额和时间推到屏幕外，等于没显示 */}
              <ul className="order-list only-narrow">{data.recentOrders.map(order => {
                const orderLabel = orderStatus(order.orderStatus);
                const payLabel = paymentStatus(order.paymentStatus);
                return <li key={order.id}>
                  <a className="order-row" href="/admin/orders">
                    <span className="order-row-top">
                      <span className="order-no">{order.publicOrderNumber}</span>
                      <span className="order-amount">{money(order.totalMinor, order.currency)}</span>
                    </span>
                    <span className="order-meta">
                      <span className="badge-status" data-tone={orderLabel.tone || undefined}>{orderLabel.label}</span>
                      <span className="badge-status" data-tone={payLabel.tone || undefined}>{payLabel.label}</span>
                      <span>{dateTime(order.createdAt)}</span>
                    </span>
                  </a>
                </li>;
              })}</ul>
            </>}
        </section>

        <section aria-labelledby="tips-title">
          <h2 id="tips-title">操作提示</h2>
          <ul className="wb-tips">
            <li><span className="tip-dot">1</span><span><strong>线下转账：先到账，后确认</strong>
              转账订单在确认收款前不能发货，确认那一刻才释放给仓库拣货。</span></li>
            <li><span className="tip-dot">2</span><span><strong>货到付款：签收时登记收款</strong>
              派送完成后要把现金收款登记进台账，否则订单会一直停在“待收”。</span></li>
            <li><span className="tip-dot">3</span><span><strong>已付款订单不能直接取消</strong>
              款已收到时要走售后与退款审批，取消流程只在未收款时可用。</span></li>
          </ul>
        </section>
      </div>
    </>}
  </main>;
}
