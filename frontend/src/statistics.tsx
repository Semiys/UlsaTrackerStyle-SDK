import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { request } from './api';
import { Notice } from './components';
import { useResource } from './main';
import type { Application, Selection } from './types';
import { PRESETS, readSelection, resolveRange, rangeQuery, rangeLabel, formatLocal, parseLocal, validateRange, browserTimeZone, timeZoneLabel, dayStart, addDays, monthStart, addMonth, monthCells } from '../../public/date-range.js';

const presets = PRESETS as { id: string; label: string; duration: number | null }[];
const all = (s: Selection) => s.kind === 'relative' && s.id === 'all';

function PeriodPicker({ value, onApply }: { value: Selection; onApply: (s: Selection) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false), [draft, setDraft] = useState<Selection>(value), [dirty, setDirty] = useState(false);
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [error, setError] = useState(''), [anchor, setAnchor] = useState<number | null>(null);
  const [month, setMonth] = useState(monthStart(Date.now()));
  const monthName = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' });
  const dayName = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long' });
  function update(s: Selection) { const range = resolveRange(s); setDraft(s); setFrom(formatLocal(range.from)); setTo(formatLocal(range.to)); setDirty(false); setError(''); }
  function close() { setOpen(false); trigger.current?.focus(); }
  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); if (!open) dialog.current?.close(); }, [open]);
  const range = dirty ? { from: parseLocal(from), to: parseLocal(to) } : resolveRange(draft);
  const start = dayStart(range.from), end = dayStart(range.to), entire = all(draft) && !dirty;
  function submit(e: FormEvent) {
    e.preventDefault(); const selection: Selection = dirty ? { kind: 'absolute', from: parseLocal(from), to: parseLocal(to) } : draft;
    const r = resolveRange(selection), message = all(selection) ? '' : validateRange(r.from, r.to);
    if (message) { setError(message); return; } onApply(selection); close();
  }
  function pick(day: number) {
    if (anchor === null) { setAnchor(day); update({ kind:'absolute',from:day,to:Math.min(addDays(day,1)-1,Date.now()) }); }
    else { update({ kind:'absolute',from:Math.min(day,anchor),to:Math.min(addDays(Math.max(day,anchor),1)-1,Date.now()) }); setAnchor(null); }
  }
  return <><section className="analytics-toolbar" aria-label="Настройки статистики"><button className="button secondary range-trigger" ref={trigger} aria-haspopup="dialog" aria-expanded={open} onClick={() => {
    update(value); const r = resolveRange(value); setMonth(monthStart(r.from) === monthStart(r.to) && !window.matchMedia('(max-width:720px)').matches ? addMonth(monthStart(r.from),-1) : monthStart(r.from)); setAnchor(null); setOpen(true);
  }}>Период: {rangeLabel(value)}</button><p className="muted small">{timeZoneLabel()} · обновление каждые 30 с</p></section>
  <dialog className="range-dialog" ref={dialog} aria-labelledby="range-title" onCancel={e => { e.preventDefault(); close(); }} onClick={e => {
    if (e.target !== dialog.current) return; const b = dialog.current.getBoundingClientRect(); if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) close();
  }}><form onSubmit={submit} noValidate><header className="range-heading"><h2 id="range-title">Период статистики</h2><span className="muted small">Часовой пояс: {browserTimeZone()}</span></header>
    <div className="range-inputs"><label>Начало<input value={entire ? 'С первого события' : from} disabled={entire} aria-invalid={!!error} aria-describedby="range-error" onChange={e => { setFrom(e.target.value); setDirty(true); }} placeholder="ДД.ММ.ГГГГ ЧЧ:ММ:СС" /></label><label>Окончание<input value={entire ? 'Текущий момент' : to} disabled={entire} aria-invalid={!!error} aria-describedby="range-error" onChange={e => { setTo(e.target.value); setDirty(true); }} placeholder="ДД.ММ.ГГГГ ЧЧ:ММ:СС" /></label></div>
    <div className="range-body"><div className="range-calendar-area"><div className="range-navigation"><button className="range-month-nav text" type="button" onClick={() => setMonth(addMonth(month,-1))}>Раньше</button><p className="small muted" aria-live="polite">{anchor === null ? 'Выберите начало периода' : 'Выберите окончание периода'}</p><button className="range-month-nav text" type="button" onClick={() => setMonth(addMonth(month,1))}>Позже</button></div>
      <div className="range-calendars">{[month,addMonth(month,1)].map(m => <section className="range-month" key={m}><h3>{monthName.format(m)}</h3><div className="range-weekdays">{['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d => <span key={d}>{d}</span>)}</div><div className="range-grid">{monthCells(m).map((day: number | null, i: number) => day === null ? <span key={'empty'+i} /> : <button key={day} type="button" className={'range-day' + (!entire && day >= start && day <= end ? ' in-range' : '') + (!entire && day === start ? ' range-start' : '') + (!entire && day === end ? ' range-end' : '')} data-day={day} aria-label={dayName.format(day)} aria-pressed={!entire && day >= start && day <= end} disabled={day > dayStart(Date.now()) || day < 0} onClick={() => pick(day)} onKeyDown={e => {
        const offsets: Record<string,number> = { ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7 };
        if (!(e.key in offsets)) return; const target = addDays(day,offsets[e.key]);
        if (target < 0 || target > dayStart(Date.now())) return; e.preventDefault();
        if (monthStart(target) !== monthStart(day)) setMonth(monthStart(target));
        requestAnimationFrame(() => dialog.current?.querySelector<HTMLButtonElement>('[data-day="' + target + '"]')?.focus());
      }}>{new Date(day).getDate()}</button>)}</div></section>)}</div></div>
      <div className="range-presets" role="group" aria-label="Быстрый выбор периода">{presets.map(p => <button key={p.id} type="button" className="range-preset" aria-pressed={!dirty && draft.kind === 'relative' && draft.id === p.id} onClick={() => { update({kind:'relative',id:p.id}); setAnchor(null); }}>{p.label}</button>)}</div>
    </div><p id="range-error" className="range-error" role="alert" hidden={!error}>{error}</p><footer className="range-footer"><span className="muted small">Ручной период — до 366 дней. Вся история доступна отдельным пунктом.</span><div className="controls"><button className="button secondary" type="button" onClick={close}>Отменить</button><button className="button">Применить</button></div></footer>
  </form></dialog></>;
}
function ExportDialog({ scopeBase, selection }: { scopeBase: string; selection: Selection }) {
  const [format, setFormat] = useState<'csv'|'json'|null>(null), [status, setStatus] = useState(''), [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), abort = useRef<AbortController | null>(null), trigger = useRef<HTMLButtonElement | null>(null);
  const revision = useRef(0), lock = useRef(false);
  useEffect(() => { if (format) dialog.current?.showModal(); else dialog.current?.close(); }, [format]);
  useEffect(() => () => { revision.current++; abort.current?.abort(); }, []);
  function close() { revision.current++; abort.current?.abort(); lock.current = false; setBusy(false); setFormat(null); trigger.current?.focus(); }
  async function download(kind: string) {
    if (lock.current || !format) return; lock.current = true; setBusy(true); setStatus('Готовим ' + format.toUpperCase() + '…');
    abort.current = new AbortController(); const current = ++revision.current;
    try {
      const range = resolveRange(selection), params = new URLSearchParams({ to:String(range.to),timezone:browserTimeZone(),kind });
      if (all(selection)) params.set('period','all'); else params.set('from',String(range.from));
      const response = await fetch(scopeBase + '/export.' + format + '?' + params, { credentials:'same-origin',cache:'no-store',signal:abort.current.signal,redirect:'error' });
      if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(body?.error?.message ?? 'Не удалось скачать файл. Проверьте вход в кабинет.'); }
      const expected = format === 'json' ? 'application/json' : 'text/csv';
      if (!response.headers.get('content-type')?.startsWith(expected)) throw new Error('Неожиданный ответ. Войдите в кабинет и повторите.');
      const blob = await response.blob(); if (current !== revision.current) return;
      const link = document.createElement('a'), url = URL.createObjectURL(blob); link.href = url;
      link.download = response.headers.get('content-disposition')?.match(/filename="([a-z0-9.-]+)"/i)?.[1] ?? 'ulsa-export.' + format;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url),1000);
      setStatus(format.toUpperCase() + ' подготовлен. Записей данных: ' + (response.headers.get('x-export-rows') ?? '—') + '. Файл сохранится в загрузках браузера.');
    } catch(e) { if (current === revision.current && (e as Error).name !== 'AbortError') setStatus((e as Error).message); }
    finally { if (current === revision.current) { lock.current = false; setBusy(false); } }
  }
  return <>{(['csv','json'] as const).map(f => <button className="button secondary" key={f} onClick={e => { trigger.current = e.currentTarget; setStatus(''); setFormat(f); }}>Скачать {f.toUpperCase()}</button>)}
    <dialog className="csv-dialog" ref={dialog} aria-labelledby="export-title" onCancel={e => { e.preventDefault(); close(); }}><h2 id="export-title">Скачать {format?.toUpperCase()}</h2><p className="muted small">{rangeLabel(selection)} · {timeZoneLabel()}</p>
      <section className="csv-choice"><h3>Сводка</h3><p className="muted small">Счётчики по событиям, экранам и действиям. Подходит для первого анализа.</p><button className="button" disabled={busy} onClick={() => download('summary')}>Скачать сводку</button></section>
      <section className="csv-choice"><h3>Подробные события</h3><p className="muted small">Отдельные записи со временем и свойствами. Проверьте содержимое перед передачей другим сервисам.</p><button className="button secondary" disabled={busy} onClick={() => download('events')}>Скачать события</button></section>
      <p className="muted small">До 10 000 записей и 8 МиБ. {format === 'json' ? 'JSON сохраняет структуру и типы значений.' : 'CSV открывается в табличных редакторах.'}</p><p className="export-status" role="status">{status}</p><button className="button secondary" onClick={close}>{busy ? 'Отменить скачивание' : 'Закрыть'}</button>
    </dialog></>;
}
export function Statistics({ demo = false }: { demo?: boolean }) {
  const location = useLocation(), appId = location.pathname.split('/')[3];
  const scopeBase = demo ? '/dashboard' : '/console/apps/' + appId;
  const data = useResource<{ application: Application; dashboardUrl: string }>(demo ? '/statistics' : '/apps/' + appId + '/statistics', demo ? 'demo' : 'console');
  const [params, setParams] = useSearchParams();
  const selection = readSelection(params) as Selection, identity = JSON.stringify(selection);
  const [frameUrl, setFrameUrl] = useState(''), [status, setStatus] = useState(''), [tick, setTick] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null), sequence = useRef(0);
  useEffect(() => {
    const theme = () => setTick(t => t + 1), media = matchMedia('(prefers-color-scheme: dark)');
    document.addEventListener('ulsa-theme-change',theme); media.addEventListener('change',theme);
    return () => { document.removeEventListener('ulsa-theme-change',theme); media.removeEventListener('change',theme); };
  }, []);
  useEffect(() => {
    if (!data.data) return;
    const abort = new AbortController(), seq = ++sequence.current;
    async function open(background = false) {
      if (!background) { setStatus('Загружается панель статистики…'); }
      let first: number | null = null;
      if (all(selection)) {
        if (!background) setFrameUrl('');
        try {
          const response = await fetch(scopeBase + '/range', { cache:'no-store',credentials:'same-origin',signal:abort.signal,redirect:'error' });
          if (!response.ok) throw new Error();
          first = (await response.json()).firstEventAt;
          if (first !== null && (!Number.isSafeInteger(first) || first < 0 || first > Date.now())) throw new Error();
          first ??= dayStart(Date.now());
        } catch { if (!abort.signal.aborted && sequence.current === seq) setStatus('Не удалось загрузить весь период. Нажмите «Обновить панель».'); return; }
      }
      if (abort.signal.aborted || sequence.current !== seq) return;
      const range = rangeQuery(selection,first), url = new URL(data.data!.dashboardUrl,window.location.origin);
      const theme = document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      url.search = new URLSearchParams({ theme,timezone:browserTimeZone(),refresh:'30s',from:range.from,to:range.to,kiosk:'1' }).toString();
      if (background && frame.current?.getAttribute('src') === url.href) { setStatus(''); return; }
      setFrameUrl(url.href);
    }
    open();
    const timer = setInterval(() => { if (all(selection) && document.visibilityState === 'visible') open(true); },30000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [data.data,identity,tick,appId,scopeBase]);
  function apply(value: Selection) { const p = new URLSearchParams(params); ['days','period','from','to'].forEach(k => p.delete(k)); if (value.kind === 'relative') p.set('period',value.id); else { p.set('from',String(value.from));p.set('to',String(value.to)); } setParams(p,{replace:true}); }
  if (!data.data) return data.error ? <Notice error>{data.error}</Notice> : <p role="status">Загружаем статистику…</p>;
  const a = data.data.application, full = frameUrl ? new URL(frameUrl) : null; full?.searchParams.delete('kiosk');
  return <div className="grafana-main"><section className="stats-header"><div><p className="eyebrow">{a.project_name}</p><h1>{a.name}</h1><p className="muted">Статистика приложения · местное время</p></div><div className="controls">{demo ? <Link className="button secondary" to="/system-state">Состояние системы</Link> : <Link className="button secondary" to={'/console/apps/' + a.id}>Подключение</Link>}<ExportDialog scopeBase={scopeBase} selection={selection} /><button className="button secondary" onClick={() => { if (frame.current && frameUrl) { setStatus('Обновляем панель…'); frame.current.src = frameUrl; } setTick(v => v + 1); }}>Обновить панель</button>{full && <a className="button secondary" href={full.href} target="_blank" rel="noopener">На весь экран</a>}</div></section>
    <PeriodPicker value={selection} onApply={apply} />
    <p className="muted small">{all(selection) ? 'Показана вся сохранённая история. До начала этой истории предыдущий период не содержит событий.' : 'Сравнение показывает предыдущий отрезок той же длительности.'} Переходы учитываются внутри одной сессии. Сессии не равны числу уникальных пользователей.</p>
    {status && <p className="muted small frame-error" role="status">{status}</p>}
    {frameUrl && <div className="grafana-frame-wrap"><iframe ref={frame} className="grafana-frame" src={frameUrl} title={'Статистика приложения ' + a.name} onLoad={() => { setStatus(''); }} /></div>}
  </div>;
}
