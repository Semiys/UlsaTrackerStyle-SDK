import { useEffect, useId, useRef, useState, type ReactNode, type FormEvent } from 'react';
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <p className={error ? 'console-error' : 'success-message'} role={error ? 'alert' : 'status'}>{children}</p>;
}
export function Form({ onSubmit, children, className = 'console-form', success }: { onSubmit: (form: FormData) => Promise<void>; children: ReactNode; className?: string; success?: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState(false);
  const lock = useRef(false), form = useRef<HTMLFormElement>(null);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setDone(false);
    try { await onSubmit(new FormData(form.current!)); setDone(true); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось выполнить действие.'); }
    finally { lock.current = false; setBusy(false); }
  }
  return <form className={className} ref={form} onSubmit={submit} aria-busy={busy}>
    <fieldset disabled={busy}>{children}</fieldset>
    {busy && <p className="muted small" role="status">Выполняем запрос…</p>}
    {error && <Notice error>{error}</Notice>}{done && success && <Notice>{success}</Notice>}
  </form>;
}
export function Select({ label, value, onChange, options, name, labelHidden = false }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; name?: string; labelHidden?: boolean }) {
  const id = useId(), wrap = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false), [index, setIndex] = useState(0);
  const chosen = Math.max(0, options.findIndex(o => o.value === value));
  useEffect(() => { const click = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', click); return () => document.removeEventListener('mousedown', click); }, []);
  const pick = (i: number) => { onChange(options[i].value); setOpen(false); trigger.current?.focus(); };
  return <div className="select-wrap" ref={wrap}><span id={id + '-label'} className={labelHidden ? "visually-hidden" : "small"}>{label}</span>
    {name && <input type="hidden" name={name} value={value} />}
    <button ref={trigger} type="button" className="select-trigger" role="combobox" aria-labelledby={id + '-label'} aria-expanded={open} aria-controls={id} aria-activedescendant={open ? id + '-' + index : undefined} onClick={() => { setIndex(chosen); setOpen(!open); }} onKeyDown={e => {
      if (e.key === 'Escape') { setOpen(false); return; }
      if (e.key === 'Tab') { setOpen(false); return; }
      if (['ArrowDown','ArrowUp','Home','End'].includes(e.key)) { e.preventDefault(); setOpen(true); setIndex(i => !open ? chosen : e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length); }
      if (open && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick(index); }
    }}>{options[chosen].label}<span aria-hidden="true" className="select-mark" /></button>
    {open && <ul className="select-options" id={id} role="listbox" aria-labelledby={id + '-label'}>{options.map((o, i) => <li key={o.value} id={id + '-' + i} role="option" aria-selected={o.value === value} data-highlight={i === index} onMouseDown={e => e.preventDefault()} onMouseEnter={() => setIndex(i)} onClick={() => pick(i)}>{o.label}</li>)}</ul>}
  </div>;
}
export function CopyCode({ value, label = 'Код подключения' }: { value: string; label?: string }) {
  const [status, setStatus] = useState('');
  return <div className="code-block"><div className="code-label"><span>{label}</span><button className="button secondary" type="button" onClick={async () => {
    try { await navigator.clipboard.writeText(value); setStatus('Скопировано'); } catch { setStatus('Выделите и скопируйте текст вручную'); }
  }}>Скопировать</button></div><pre className="console-code" tabIndex={0}><code>{value}</code></pre><p className="small muted" role="status">{status}</p></div>;
}
