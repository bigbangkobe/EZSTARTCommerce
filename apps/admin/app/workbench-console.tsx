"use client";
import { useEffect, useState } from 'react';

type RecentOrder = { id: string; publicOrderNumber: string; orderStatus: string; paymentStatus: string;
  currency: string; totalMinor: number; createdAt: string };
type Summary = { generatedAt: string;
  orders: { awaitingConfirmation: number; awaitingDispatch: number; prepaidUnsettled: number };
  aftersales: { open: number } | null;
  inventory: { lowStock: number } | null;
  recentOrders: RecentOrder[] };

const ORDER_STATUS: Record<string, string> = {
  pending_payment: '待付款', awaiting_confirmation: '待确认', confirmed: '已确认', processing: '处理中',
  partially_shipped: '部分发货', shipped: '已发货', completed: '已完成', cancelled: '已取消', on_hold: '已挂起',
};
const PAYMENT_STATUS: Record<string, string> = {
  created: '待支付', requires_action: '待完成', processing: '处理中', succeeded: '已支付', failed: '支付失败',
  cancelled: '已取消', unknown: '状态未知', cod_due: '货到付款待收', collected: '已收款', rejected: '已拒付', returned: '已退款',
};
function money(minor: number, currency: string) {
  try {
    return new Intl.NumberFormat('zh-HK', { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100);
  } catch { return `${currency} ${(minor / 100).toFixed(2)}`; }
}
function when(iso: string) {
  const date = new Date(iso); const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function WorkbenchConsole() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/v1/admin/workbench', { credentials: 'same-origin', cache: 'no-store' });
        if (response.status === 401) { location.assign('/admin/login'); return; }
        if (response.status === 403) { setError('当前角色没有查看工作台的权限（需要订单读取）。'); return; }
        if (!response.ok) { setError('工作台数据加载失败，请稍后刷新。'); return; }
        setData((await response.json()).data);
      } catch { setError('网络异常，工作台数据加载失败。'); }
    })();
  }, []);

  const cards = data ? [
    { key: 'confirm', label: '待确认订单', value: data.orders.awaitingConfirmation, href: '/admin/orders',
      hint: '线下转账待核，确认后才进入拣货' },
    { key: 'dispatch', label: '待发货', value: data.orders.awaitingDispatch, href: '/admin/orders',
      hint: '已确认但尚未完成发货' },
    { key: 'prepaid', label: '预付未收款', value: data.orders.prepaidUnsettled, href: '/admin/orders',
      hint: '未收到款前发货会被拦截' },
    ...(data.aftersales ? [{ key: 'aftersales', label: '待处理售后', value: data.aftersales.open, href: '/admin/aftersales',
      hint: '受理、审批、退换货处理中' }] : []),
    ...(data.inventory ? [{ key: 'stock', label: '低库存规格', value: data.inventory.lowStock, href: '/admin/inventory',
      hint: '可售数已到或低于阈值' }] : []),
  ] : [];

  const today = new Date();
  return <main className="console workbench">
    <header><div><p className="eyebrow">店铺管理</p><h1>工作台</h1>
      <p className="lede">{today.getFullYear()} 年 {today.getMonth() + 1} 月 {today.getDate()} 日
        {data && ` · 数据截至 ${when(data.generatedAt)}`}</p></div></header>
    {error && <p role="alert" className="error">{error}</p>}
    {!data && !error && <p>正在汇总今日待办…</p>}
    {data && <>
      <section aria-label="待办概览"><div className="stat-grid">
        {cards.map(card => <a className={`stat${card.value > 0 ? ' hot' : ''}`} key={card.key} href={card.href}>
          <span className="stat-label">{card.label}</span>
          <strong className="stat-value">{card.value}</strong>
          <small>{card.hint}</small>
        </a>)}
      </div></section>
      <section aria-labelledby="recent-title"><h2 id="recent-title">最新订单</h2>
        {data.recentOrders.length === 0 ? <p>还没有订单。</p>
          : <table className="table"><thead><tr><th>订单号</th><th>下单时间</th><th>订单状态</th><th>收款状态</th><th className="num">金额</th></tr></thead>
            <tbody>{data.recentOrders.map(order => <tr key={order.id}>
              <td><a href="/admin/orders">{order.publicOrderNumber}</a></td>
              <td>{when(order.createdAt)}</td>
              <td>{ORDER_STATUS[order.orderStatus] ?? order.orderStatus}</td>
              <td>{PAYMENT_STATUS[order.paymentStatus] ?? order.paymentStatus}</td>
              <td className="num">{money(order.totalMinor, order.currency)}</td>
            </tr>)}</tbody></table>}
      </section>
    </>}
  </main>;
}
