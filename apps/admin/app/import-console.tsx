"use client";
import { useEffect, useRef, useState } from 'react';

/**
 * 商品批量导入（M05）后台页。
 *
 * 五步：选文件 → 直传对象存储 → 建任务 → 预检（只读）→ 确认执行。
 * 预检内容行是要给操作员看的证据：哪一行会新建、哪一行会被更新、哪一行被拒以及为什么。
 * 执行只认预检回传的三个值（文件摘要 / 映射版本 / 有效行数），前端无法拼出"绕过预检"的执行请求。
 */

const TARGETS = [
  'product_key', 'base_sku', 'category_path', 'brand', 'market_codes',
  'name_zh_HK', 'slug_zh_HK', 'name_zh_CN', 'slug_zh_CN', 'name_en', 'slug_en',
  'short_zh_HK', 'short_zh_CN', 'short_en', 'desc_zh_HK', 'desc_zh_CN', 'desc_en',
  'variant_sku', 'option1_name', 'option1_value', 'option2_name', 'option2_value',
  'price_hkd', 'compare_at_hkd', 'currency', 'stock_qty', 'variant_status',
  'image_urls', 'alt_zh_HK', 'attr_1_name', 'attr_1_value', 'publish_now',
];
const REQUIRED = ['product_key', 'variant_sku', 'price_hkd'];
const LOCALES = [['zh-HK', '繁體中文'], ['zh-CN', '简体中文'], ['en', 'English']] as const;

type Session = { permissionCodes: string[]; csrfToken: string };
type Target = { objectKey: string; uploadUrl: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string; maxSizeBytes: number };
type Job = { id: string; status: string; totalRows: number; validRows: number; invalidRows: number;
  createdCount: number; updatedCount: number; skippedCount: number; failedCount: number; createdAt: string; completedAt: string | null };
type PreviewRow = { rowNumber: number; sku: string | null; action: string; errors: { field: string; code: string; message: string }[]; warnings: string[] };
type Preview = { jobId: string; fileSha256: string; mappingVersion: number; totalRows: number; validRows: number;
  invalidRows: number; newCount: number; updateCount: number; skipCount: number; previewRows: PreviewRow[] };

const STATUS_LABEL: Record<string, string> = {
  uploaded: '待校验', validating: '校验中', ready: '待执行', processing: '执行中',
  completed: '已完成', completed_with_errors: '部分完成', failed: '失败', cancelled: '已取消',
};
const ACTION_LABEL: Record<string, string> = { create: '新建', update: '更新', skip: '跳过', reject: '拒绝' };

async function sha256(file: File) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** 只读表头行做列映射：表头名与模板一致就直连目标列，否则要求操作员改名（不自作聪明猜列）。 */
function mapHeaders(text: string) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const headers = firstLine.split(',').map(value => value.replace(/^"|"$/g, '').trim()).filter(Boolean);
  const mapping: Record<string, string> = {};
  const unknown: string[] = [];
  for (const header of headers) {
    if ((TARGETS as readonly string[]).includes(header)) mapping[header] = header;
    else unknown.push(header);
  }
  const missing = REQUIRED.filter(target => !Object.values(mapping).includes(target));
  return { headers, mapping, unknown, missing };
}

export function ImportConsole() {
  const session = useRef<Session | null>(null);
  const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [progress, setProgress] = useState('');
  const [file, setFile] = useState<File | null>(null); const [hash, setHash] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [mode, setMode] = useState('create_or_update_by_sku'); const [commitMode, setCommitMode] = useState('valid_rows');
  const [locales, setLocales] = useState<string[]>(['zh-HK', 'zh-CN', 'en']);
  const [job, setJob] = useState<Job | null>(null); const [preview, setPreview] = useState<Preview | null>(null);

  async function request<T>(path: string, method = 'GET', body?: object, headers: Record<string, string> = {}): Promise<T> {
    const response = await fetch(`/api/v1/admin/${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-CSRF-Token': session.current?.csrfToken ?? '' } : {}),
      ...headers,
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 401) { location.assign('/admin/login'); throw new Error('会话已失效，请重新登录。'); }
    if (!response.ok) {
      const codes: Record<number, string> = {
        403: '当前账号没有执行此操作所需的权限。',
        404: '任务不存在。',
        409: '状态已变化（可能已被别人执行或取消），请刷新后重试。',
        422: '文件或字段不符合要求，请检查列名、币种与语言。',
        429: '操作过于频繁，请稍后重试。',
        503: '服务尚未就绪（导入需要对象存储）。',
      };
      throw new Error(codes[response.status] ?? '操作未完成，请稍后重试。');
    }
    return (await response.json()).data as T;
  }

  useEffect(() => {
    void (async () => {
      try {
        const current = await request<Session>('auth/session');
        session.current = { permissionCodes: current.permissionCodes, csrfToken: current.csrfToken };
        if (!current.permissionCodes.includes('catalog.import')) setError('当前账号没有批量导入权限（catalog.import）。');
      } catch (reason) { setError(reason instanceof Error ? reason.message : '加载失败。'); }
      finally { setReady(true); }
    })();
  }, []);

  async function pick(selected: File | null) {
    setError(''); setNotice(''); setJob(null); setPreview(null); setHash('');
    setFile(selected);
    if (!selected) return;
    if (!selected.name.toLowerCase().endsWith('.csv')) { setFile(null); setError('只支持 CSV 文件。'); return; }
    const text = await selected.text();
    const parsed = mapHeaders(text);
    setMapping(parsed.mapping);
    setHash(await sha256(selected));
    if (parsed.missing.length) setError(`表头缺少必需列：${parsed.missing.join('、')}。请按交付模板命名，或先改表头。`);
    else if (parsed.unknown.length) setNotice(`以下列不会被导入：${parsed.unknown.join('、')}（保留原样，不影响其他列）。`);
  }

  async function run(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '请求未完成。'); }
    finally { setBusy(false); setProgress(''); }
  }

  function upload() {
    void run(async () => {
      if (!file) throw new Error('请先选择 CSV 文件。');
      setProgress('正在申请上传目标…');
      const target = await request<Target>('import-files', 'POST', {});
      if (file.size > target.maxSizeBytes) throw new Error('文件超过 10 MB 上限，请拆分后导入。');
      setProgress('正在上传文件…');
      const sent = await fetch(target.uploadUrl, { method: target.method, headers: target.headers, body: file });
      if (!sent.ok) throw new Error(`上传失败（${sent.status}），请重新选择文件。`);
      setProgress('正在创建导入任务…');
      const created = await request<Job>('import-jobs', 'POST', {
        fileObjectKey: target.objectKey, fileSha256: hash, format: 'csv', mode, commitMode,
        columnMapping: mapping, localeSet: locales,
      });
      setJob(created);
      setNotice('任务已创建。下一步是预检——预检只读，不会写入任何商品。');
    });
  }

  function validateJob() {
    void run(async () => {
      if (!job) return;
      setProgress('正在解析并预检…');
      const result = await request<Preview>(`import-jobs/${job.id}/validate`, 'POST', {});
      setPreview(result);
      setJob({ ...job, status: 'ready', validRows: result.validRows, invalidRows: result.invalidRows });
      setNotice(`预检完成：${result.newCount} 行新建、${result.updateCount} 行更新、${result.skipCount} 行跳过、${result.invalidRows} 行拒绝。`);
    });
  }

  function execute() {
    void run(async () => {
      if (!job || !preview) return;
      if (preview.invalidRows > 0 && commitMode === 'atomic') throw new Error('原子模式下只要有一行被拒就不能执行；请修正后重新预检，或改用"有效行"模式。');
      setProgress('正在写入商品…');
      const result = await request<Job>(`import-jobs/${job.id}/execute`, 'POST', {
        confirmedFileSha256: preview.fileSha256, confirmedMappingVersion: preview.mappingVersion, expectedValidRows: preview.validRows,
      }, { 'Idempotency-Key': `${job.id}:${preview.fileSha256.slice(0, 12)}` });
      setJob(result);
      setNotice(`执行结束：新建 ${result.createdCount}、更新 ${result.updatedCount}、跳过 ${result.skippedCount}、失败 ${result.failedCount}。`);
    });
  }

  function cancel() {
    void run(async () => {
      if (!job) return;
      await request(`import-jobs/${job.id}/cancel`, 'POST', { reason: '操作员在后台取消' });
      setJob({ ...job, status: 'cancelled' });
      setNotice('任务已取消；已写入的商品不会回滚（有效行模式）。');
    });
  }

  async function downloadErrors() {
    if (!job) return;
    void run(async () => {
      const report = await request<Record<string, unknown>>(`import-jobs/${job.id}/error-report`);
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = `import-errors-${job.id}.json`; link.click();
      URL.revokeObjectURL(url);
    });
  }

  const canImport = ready && (session.current?.permissionCodes.includes('catalog.import') ?? false);

  return (
    <div className="console">
      <header className="detail-head">
        <div>
          <p className="eyebrow">商品目录</p>
          <h1>批量导入商品</h1>
          <p className="lede">按交付模板整理 CSV，先生成预检报告，确认无误后再写入。预检不写库，执行后才产生商品。</p>
        </div>
        <a className="btn-ghost" href="/admin/catalog">返回商品列表</a>
      </header>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}
      {progress && <p className="lede">{progress}</p>}

      <section className="card">
        <h2>1. 选择文件与规则</h2>
        <input type="file" accept=".csv,text/csv" disabled={!canImport || busy} onChange={event => void pick(event.target.files?.[0] ?? null)} />
        {file && <p className="lede">{file.name} · {(file.size / 1024).toFixed(1)} KB · sha256 {hash.slice(0, 12)}…</p>}

        <div className="actions">
          <label>匹配方式
            <select value={mode} onChange={event => setMode(event.target.value)}>
              <option value="create_or_update_by_sku">SKU 存在则更新，否则新建</option>
              <option value="create_only">只新建（已存在则跳过）</option>
              <option value="update_only">只更新（不存在则跳过）</option>
            </select>
          </label>
          <label>提交方式
            <select value={commitMode} onChange={event => setCommitMode(event.target.value)}>
              <option value="valid_rows">有效行逐条提交（部分成功）</option>
              <option value="atomic">全部成功或全部回滚</option>
            </select>
          </label>
        </div>

        <div className="actions">
          {LOCALES.map(([code, label]) => <label key={code}>
            <input type="checkbox" checked={locales.includes(code)} disabled={busy}
              onChange={event => setLocales(current => event.target.checked
                ? [...current, code].sort() : current.filter(item => item !== code))} /> {label}
          </label>)}
        </div>
        <p className="lede">启用的语言必须每种都有商品名与 slug，否则整件商品会被拒绝（不是只跳过一个语言）。</p>

        <div className="actions">
          <button type="button" disabled={!canImport || busy || !file || locales.length === 0} onClick={upload}>上传并创建任务</button>
        </div>
      </section>

      {job && (
        <section className="card">
          <h2>2. 任务与预检</h2>
          <p className="lede">任务 {job.id} · 状态 <span className="badge-status" data-tone={job.status === 'completed' ? 'ok' : job.status === 'failed' ? 'bad' : 'warn'}>{STATUS_LABEL[job.status] ?? job.status}</span></p>
          <div className="kpi-grid">
            <div className="kpi"><p className="kpi-label">总行数</p><p className="kpi-value">{job.totalRows}</p></div>
            <div className="kpi"><p className="kpi-label">有效行</p><p className="kpi-value">{job.validRows}</p></div>
            <div className="kpi"><p className="kpi-label">拒绝行</p><p className="kpi-value">{job.invalidRows}</p></div>
            <div className="kpi"><p className="kpi-label">已新建 / 更新</p><p className="kpi-value">{job.createdCount} / {job.updatedCount}</p></div>
          </div>
          <div className="actions">
            <button type="button" disabled={busy} onClick={validateJob}>开始预检</button>
            <button type="button" disabled={busy || !preview} onClick={execute}>确认执行</button>
            <button type="button" className="btn-ghost" disabled={busy} onClick={cancel}>取消任务</button>
            {job.status === 'completed_with_errors' && <button type="button" className="btn-ghost" disabled={busy} onClick={() => void downloadErrors()}>下载错误报告</button>}
          </div>
          {preview && <p className="lede">预检：新建 {preview.newCount} · 更新 {preview.updateCount} · 跳过 {preview.skipCount} · 拒绝 {preview.invalidRows}（映射版本 {preview.mappingVersion}）</p>}
        </section>
      )}

      {preview && (
        <section className="card">
          <h2>3. 预检明细（前 {preview.previewRows.length} 行）</h2>
          {preview.previewRows.length === 0 ? <p className="empty">没有可展示的行。</p> : (
            <table>
              <thead><tr><th>行</th><th>SKU</th><th>动作</th><th>问题</th></tr></thead>
              <tbody>
                {preview.previewRows.map(row => (
                  <tr key={row.rowNumber}>
                    <td>{row.rowNumber}</td>
                    <td>{row.sku ?? '—'}</td>
                    <td><span className="badge-status" data-tone={row.action === 'reject' ? 'bad' : row.action === 'skip' ? 'warn' : 'ok'}>{ACTION_LABEL[row.action] ?? row.action}</span></td>
                    <td>
                      {row.errors.length === 0 && row.warnings.length === 0 && '—'}
                      {row.errors.map((entry, index) => <p key={`e${index}`} className="error">{entry.field}：{entry.message}（{entry.code}）</p>)}
                      {row.warnings.map((warning, index) => <p key={`w${index}`} className="lede">{warning}</p>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
