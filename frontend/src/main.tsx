import { Component, createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { request, RequestError } from './api';
import { CopyCode, Form, Notice, Select } from './components';
import type { ApplicationData, Application, Project, Session } from './types';
import { Statistics } from './statistics';
import { DemoFrame, DemoEventForm, DemoRefusal, DemoState, DemoSdk } from './demo';
import '../../public/styles.css';
import '../../public/dashboard.css';
import '../../public/pages.css';
import '../../public/console.css';
import '../../public/guide.css';
import '../../public/date-range.css';
import './style.css';

type Context = { session: Session; refresh: () => Promise<void>; post: <T>(path: string, body: object) => Promise<T> };
const SessionContext = createContext<Context | null>(null);
export const useSession = () => useContext(SessionContext)!;
export function useResource<T>(path: string, scope: 'console' | 'demo' = 'console') {
  const sessionContext = useContext(SessionContext);
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setState({});
    request<T>(path, { signal: abort.signal, scope }).then(data => setState({ data })).catch(e => {
      if (!abort.signal.aborted) { setState({ error: e.message }); if (e instanceof RequestError && e.code === 'session_required') void sessionContext?.refresh(); }
    });
    return () => abort.abort();
  }, [path, revision, scope]);
  return { ...state, retry: () => setRevision(v => v + 1) };
}
function Resource({ error, retry }: { error?: string; retry: () => void }) {
  return error ? <section className="console-empty"><Notice error>{error}</Notice><div className="controls"><button className="button secondary" onClick={retry}>Повторить</button><Link className="button secondary" to="/login">Войти в кабинет</Link></div></section> : <p className="loading-state" role="status">Загружаем данные…</p>;
}
function Theme() {
  const [theme, setTheme] = useState(() => { try { const t = localStorage.getItem('ulsatracker.theme'); return t === 'light' || t === 'dark' ? t : 'system'; } catch { return 'system'; } });
  function change(value: string) {
    setTheme(value); if (value === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = value;
    try { localStorage.setItem('ulsatracker.theme', value); } catch { /* Optional. */ }
    document.dispatchEvent(new Event('ulsa-theme-change'));
  }
  return <Select label="Тема" labelHidden value={theme} onChange={change} options={[{ value: 'system', label: 'Системная тема' }, { value: 'light', label: 'Светлая тема' }, { value: 'dark', label: 'Тёмная тема' }]} />;
}
function Layout() {
  const { session } = useSession(), location = useLocation();
  const content = useRef<HTMLElement>(null);
  useEffect(() => {
    const updateTitle = () => { const title = content.current?.querySelector('h1')?.textContent; document.title = (title ? title + ' — ' : '') + 'UlsaTrackerStyle SDK'; };
    updateTitle();
    const observer = new MutationObserver(updateTitle);
    if (content.current) observer.observe(content.current, { childList: true, characterData: true, subtree: true });
    if (pendingKey && location.pathname !== '/console/apps/' + pendingKey.appId) pendingKey = null;
    if (location.hash) requestAnimationFrame(() => document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView());
    else { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); content.current?.focus({ preventScroll: true }); }
    return () => observer.disconnect();
  }, [location.pathname, location.hash]);
  return <div className="layout"><a className="skip-link" href="#content">К содержимому</a><header className="page-header app-header">
    <div><Link className="brand" to="/">UlsaTrackerStyle SDK</Link><p className="muted small">Аналитика приложений и сайтов</p></div>
    <nav className="page-nav" aria-label="Основная навигация">
      <NavLink className="button secondary" to="/" end>Главная</NavLink>
      <NavLink className="button secondary" to="/guide">Подключение SDK</NavLink>
      {session.demoMode && !session.user && <NavLink className="button secondary" to="/dashboard">Демонстрация</NavLink>}
      <NavLink className="button secondary" to={session.user ? '/console' : '/login'}>{session.user ? 'Мой кабинет' : 'Войти'}</NavLink>
    </nav><Theme />
  </header><main ref={content} id="content" tabIndex={-1} className="dashboard-main react-main"><Outlet /></main>
  <footer className="muted small app-footer">UlsaTrackerStyle SDK · Версия {session.version}{session.demoMode && session.labImageVersion && <> · Сборка {session.labImageVersion}</>}</footer></div>;
}
function Protected() {
  const { session } = useSession(), location = useLocation();
  return session.user ? <Outlet /> : <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
}
function Home() {
  const { session } = useSession();
  return <section className="hero panel"><p className="eyebrow">Продуктовая аналитика</p><h1>Понимайте, как используют ваше приложение</h1>
    <p className="description">Открытия экранов, нажатия и успешные действия в одной статистике. Подключите Android-приложение или сайт и проверьте первое событие.</p>
    <div className="page-actions"><Link className="button" to={session.user ? '/console' : '/register'}>{session.user ? 'Открыть проекты' : 'Создать аккаунт'}</Link><Link className="button secondary" to="/guide">Как подключить SDK</Link></div>
    <div className="home-features"><section><h2>Свой проект</h2><p className="muted">Отдельные приложения, ключи и доступ к данным.</p></section><section><h2>Понятная статистика</h2><p className="muted">Периоды, сравнения и выгрузки CSV или JSON.</p></section><section><h2>Android и Web</h2><p className="muted">SDK для подключения в нужных местах вашего продукта.</p></section></div>
  </section>;
}
function Auth({ mode }: { mode: 'login' | 'register' }) {
  const { session, post, refresh } = useSession(), navigate = useNavigate(), location = useLocation();
  const register = mode === 'register';
  if (session.user) return <Navigate to="/console" replace />;
  return <section className="console-main narrow"><p className="eyebrow">Кабинет разработчика</p><h1>{register ? 'Создать аккаунт' : 'Войти в кабинет'}</h1><p className="muted">{register ? 'Создайте проект и получите ключ для своего приложения.' : 'Ваши проекты, приложения и статистика.'}</p>
    <Form key={mode} onSubmit={async form => {
      await post('/' + mode, Object.fromEntries(form)); await refresh();
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from?.startsWith('/console') ? from : '/console', { replace: true });
    }}>
      {register && <label>Имя<input name="name" autoComplete="name" maxLength={80} required /></label>}
      <label>Электронная почта<input type="email" name="email" autoComplete="email" maxLength={254} required /></label>
      <label>Пароль<input type="password" name="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={register ? 12 : undefined} maxLength={128} required /></label>
      {register && <p className="muted small">От 12 до 128 символов. Сохраните пароль в надёжном месте.</p>}
      <button className="button" type="submit">{register ? 'Зарегистрироваться' : 'Войти'}</button>
    </Form><div className="page-actions"><Link className="button secondary" to={register ? '/login' : '/register'}>{register ? 'Уже есть аккаунт' : 'Создать аккаунт'}</Link></div>
  </section>;
}
function Projects() {
  const { session, post, refresh } = useSession(), data = useResource<{ projects: Project[] }>('/projects'), navigate = useNavigate();
  return <div className="console-main"><div className="console-heading"><div><p className="eyebrow">Кабинет разработчика</p><h1>Мои проекты</h1><p className="muted">{session.user?.name}, объединяйте приложения одного продукта в проект.</p></div><Form className="logout-form" onSubmit={async () => { await post('/logout', {}); await refresh(); navigate('/login', { replace: true }); }}><button className="button secondary">Выйти</button></Form></div>
    {!data.data ? <Resource {...data} /> : <>{!data.data.projects.length && <section className="console-empty"><h2>Начните с первого проекта</h2><p className="muted">Добавьте приложение, получите ключ и отправьте первое событие.</p><Link className="button secondary" to="/guide#project">Пошаговая инструкция</Link></section>}
    <div className="console-cards">{data.data.projects.map(p => <Link className="console-card" key={p.id} to={'/console/projects/' + p.id}><p className="eyebrow">{p.archived ? 'В архиве' : 'Проект'}</p><h2>{p.name}</h2><p className="muted">Приложений: {p.applications}</p><span className="console-card-action">Открыть проект</span></Link>)}</div></>}
    <section className="console-section"><h2>Новый проект</h2><Form className="console-form" onSubmit={async form => { const result = await post<{ project: Project }>('/projects', Object.fromEntries(form)); navigate('/console/projects/' + result.project.id); }}>
      <label>Название проекта<input name="name" maxLength={100} placeholder="Название вашего проекта" required /></label><button className="button">Создать проект</button>
    </Form></section></div>;
}
// A raw sending key lives only in memory and is discarded on navigation or reload.
let pendingKey: { appId: string; value: string } | null = null;
function ProjectPage() {
  const { projectId } = useParams(), { post } = useSession(), navigate = useNavigate();
  const data = useResource<{ project: Project; applications: Application[] }>('/projects/' + projectId);
  const [platform, setPlatform] = useState('android');
  if (!data.data) return <div className="console-main"><Resource {...data} /></div>;
  const { project, applications } = data.data;
  return <div className="console-main"><Link className="button secondary" to="/console">Все проекты</Link>
    <div className="console-heading"><div><p className="eyebrow">{project.archived ? 'Проект в архиве' : 'Проект'}</p><h1>{project.name}</h1><p className="muted">Каждое приложение получает собственный ключ и статистику.</p></div></div>
    {project.archived && <Notice>Приём новых событий остановлен. Сохранённая статистика доступна.</Notice>}
    <div className="console-cards">{applications.map(a => <Link key={a.id} className="console-card" to={'/console/apps/' + a.id}><p className="eyebrow">{a.platform.toUpperCase()}</p><h2>{a.name}</h2><p className="muted">{a.identifier}</p><span className="console-card-action">{a.deleting ? 'Завершить удаление' : 'Подключение и статистика'}</span></Link>)}</div>
    {!applications.length && <section className="console-empty"><h2>Добавьте приложение</h2><p className="muted">Для Android нужен package name, для сайта — origin с протоколом и портом.</p></section>}
    {!project.archived && <section className="console-section"><h2>Новое приложение</h2><Form onSubmit={async form => {
      const result = await post<ApplicationData>('/projects/' + project.id + '/apps', Object.fromEntries(form));
      pendingKey = { appId: result.application.id, value: result.rawKey! }; navigate('/console/apps/' + result.application.id);
    }}>
      <label>Название<input name="name" maxLength={100} placeholder="Моё приложение" required /></label>
      <Select name="platform" label="Платформа" value={platform} onChange={setPlatform} options={[{ value:'android',label:'Android — Kotlin SDK' },{ value:'web',label:'Web — JavaScript SDK' },{ value:'ios',label:'iOS — только HTTP API' }]} />
      <label>{platform === 'web' ? 'Origin сайта' : platform === 'android' ? 'Package name' : 'Bundle ID'}<input name="identifier" maxLength={200} placeholder={platform === 'web' ? 'https://example.com' : 'com.example.app'} required /></label>
      {platform === 'ios' && <p className="muted small">Готового iOS-адаптера SDK пока нет.</p>}
      <button className="button">Добавить и получить ключ</button>
    </Form></section>}
    <section className="console-section"><h2>Настройки проекта</h2><Form key={project.name + project.archived} success="Настройки сохранены." onSubmit={async form => { await post('/projects/' + project.id + '/settings', { name: form.get('name'), archived: form.get('archived') === 'on' }); data.retry(); }}>
      <label>Название<input name="name" defaultValue={project.name} maxLength={100} required /></label>
      <label className="console-check"><input type="checkbox" name="archived" defaultChecked={project.archived} />Поместить проект в архив и остановить приём событий</label><button className="button secondary">Сохранить настройки</button>
    </Form></section></div>;
}
function ApplicationRoute() { const { appId } = useParams(); return <ApplicationPage key={appId} />; }
function ApplicationPage() {
  const { appId } = useParams(), { session, post } = useSession(), navigate = useNavigate(), data = useResource<ApplicationData>('/apps/' + appId);
  const [rawKey, setRawKey] = useState(() => pendingKey?.appId === appId ? pendingKey?.value ?? '' : '');
  const [confirm, setConfirm] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false), [deleteIdentifier, setDeleteIdentifier] = useState('');
  useEffect(() => { pendingKey = null; return () => { pendingKey = null; }; }, []);
  if (!data.data) return <div className="console-main"><Resource {...data} /></div>;
  const { application: a, keys } = data.data;
  return <div className="console-main"><Link className="button secondary" to={'/console/projects/' + a.project_id}>{a.project_name}</Link>
    <div className="console-heading"><div><p className="eyebrow">{a.platform.toUpperCase()}</p><h1>{a.name}</h1><p className="muted">{a.identifier}</p></div>{!a.deleting && <Link className="button" to={'/console/apps/' + a.id + '/stats'}>Открыть статистику</Link>}</div>
    {a.deleting && <Notice error>Удаление не завершено. Приём событий остановлен. Повторите удаление ниже.</Notice>}
    {!a.deleting && <>{rawKey && <section className="console-empty"><h2>Сохраните ключ отправки</h2><p className="muted">Он показывается один раз. После закрытия страницы восстановить полный ключ нельзя.</p><CopyCode value={rawKey} label="Ключ отправки" /><button className="button secondary" onClick={() => setRawKey('')}>Я сохранил ключ</button></section>}
    <section className="console-section"><h2>Подключение</h2><p>Адрес сервиса: <code>{session.endpoint}</code></p><div className="page-actions"><Link className="button secondary" to={'/guide#' + (a.platform === 'android' ? 'android' : a.platform === 'web' ? 'javascript' : 'project')}>Пошаговая инструкция</Link>{a.platform === 'web' && <Link className="button secondary" to="/sdk-demo">Проверить JavaScript SDK</Link>}</div>
      {a.platform === 'ios' ? <p className="muted">Готового iOS-адаптера SDK пока нет. Доступен контракт HTTP API v1.</p> : <ApplicationExample a={a} rawKey={rawKey} endpoint={session.endpoint} />}
    </section>
    <section className="console-section"><h2>Ключи отправки</h2><p className="muted">Отзыв или замена останавливает приём по старому ключу. Перед заменой подготовьте обновление клиентов.</p>
      {keys.map(k => <div className="console-key" key={k.id}><div><code>{k.display}</code><p className="muted small">{k.revoked_at ? 'Отозван' : 'Действует'}</p></div>{!k.revoked_at && <button className="button secondary" onClick={() => setConfirm(k.id)}>Отозвать</button>}</div>)}
      {!a.archived && <button className="button secondary" onClick={() => setConfirm('rotate')}>Заменить ключ</button>}
      {confirm && <section className="confirm-panel" aria-label="Подтверждение изменения ключа"><h3>{confirm === 'rotate' ? 'Заменить ключ?' : 'Отозвать ключ?'}</h3><p>Клиенты со старым ключом перестанут отправлять события. Сохранённая статистика останется.</p><div className="controls"><button className="button" disabled={busy} onClick={async () => {
        if (busy) return; setBusy(true); setError('');
        try { const result = await post<ApplicationData>('/apps/' + a.id + '/keys/' + (confirm === 'rotate' ? 'rotate' : confirm + '/revoke'), {}); setRawKey(result.rawKey ?? ''); setConfirm(null); data.retry(); } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
      }}>Подтвердить</button><button className="button secondary" disabled={busy} onClick={() => setConfirm(null)}>Отменить</button></div>{error && <Notice error>{error}</Notice>}</section>}
    </section><section className="console-section"><h2>Проверить соединение</h2><p className="muted">Тест из кабинета проверяет сервер и графики. Сам SDK проверяйте на устройстве или сайте.</p><Link className="button secondary" to={'/console/apps/' + a.id + '/test'}>Отправить тестовое событие</Link></section></>}
    <section className="console-section application-delete"><h2>Удаление приложения</h2>
      <p className="muted">Будут удалены это приложение, все его ключи, панель и накопленные события. Восстановить их в кабинете нельзя. Проект и другие приложения сохранятся.</p>
      {!deleteOpen ? <button className="button danger" onClick={() => { setConfirm(null); setDeleteOpen(true); }}>Удалить приложение</button> :
        <section className="confirm-panel" aria-label="Подтверждение удаления приложения">
          <h3>Удалить «{a.name}»?</h3><p>Идентификатор: <code className="application-identifier">{a.identifier}</code></p>
          <Form onSubmit={async form => {
            try {
              const result = await post<{ projectId: string }>('/apps/' + a.id + '/delete', { confirmation: form.get('confirmation') });
              setRawKey(''); pendingKey = null; navigate('/console/projects/' + result.projectId, { replace: true });
            } catch (e) {
              setRawKey('');
              // A lost success response must not trap the owner on a deleted application.
              try { await request<ApplicationData>('/apps/' + a.id); }
              catch (readError) { if (readError instanceof RequestError && readError.status === 404) { navigate('/console/projects/' + a.project_id, { replace: true }); return; } }
              data.retry(); throw e;
            }
          }}>
            <label>Введите идентификатор приложения для подтверждения<input name="confirmation" value={deleteIdentifier} onChange={e => setDeleteIdentifier(e.target.value)} autoComplete="off" spellCheck={false} maxLength={200} autoFocus required /></label>
            <div className="controls"><button className="button danger" disabled={deleteIdentifier !== a.identifier}>Удалить без возможности восстановления</button><button type="button" className="button secondary" onClick={() => { setDeleteOpen(false); setDeleteIdentifier(''); }}>Отменить</button></div>
          </Form>
        </section>}
    </section>
  </div>;
}
function ApplicationExample({ a, rawKey, endpoint }: { a: Application; rawKey: string; endpoint: string }) {
  const key = rawKey || 'ВАШ_КЛЮЧ_ОТПРАВКИ', http = endpoint.startsWith('http:');
  const source = a.platform === 'android' ? `val tracker = createAndroidTracker(
    context = this,
    config = TrackerConfig(
        endpoint = ${JSON.stringify(endpoint)},
        ingestKey = ${JSON.stringify(key)},
        appVersion = "1.0.0"${http ? ',\n        allowHttp = true // только локальная разработка' : ''}
    )
)
tracker.screen("collection")
tracker.click(button = "add_model", screen = "collection")`
    : `const tracker = UlsaTracker.create({
  endpoint: ${JSON.stringify(endpoint)},
  ingestKey: ${JSON.stringify(key)},
  appVersion: '1.0.0'${http ? ',\n  allowHttp: true // только локальная разработка' : ''}
});
tracker.screen('home');
tracker.click('add_item', 'home');`;
  return <><CopyCode value={source} label={a.platform === 'android' ? 'Kotlin · инициализация' : 'JavaScript · инициализация'} /><p className="muted small">Создайте один экземпляр SDK. Добавляйте вызовы к нужным действиям; автоматического сбора всех нажатий нет.</p></>;
}
function TestEvent() {
  const { appId } = useParams(), data = useResource<ApplicationData>('/apps/' + appId), { post } = useSession();
  if (!data.data) return <div className="console-main"><Resource {...data} /></div>;
  return <section className="console-main narrow"><Link className="button secondary" to={'/console/apps/' + appId}>Подключение</Link><h1>Тестовое событие</h1><p className="muted">Событие будет записано в статистику «{data.data.application.name}». Этот тест выполняется сервером, а не мобильной SDK.</p>
    <Form success="Событие записано. Откройте статистику и обновите панель." onSubmit={async f => { await post('/apps/' + appId + '/test', Object.fromEntries(f)); }}>
      <label>Название события<input name="name" defaultValue="button_click" required maxLength={64} /></label><label>Экран<input name="screen" defaultValue="sdk_test" maxLength={100} /></label><button className="button" disabled={data.data.application.archived}>Отправить событие</button>
    </Form><Link className="button secondary" to={'/console/apps/' + appId + '/stats'}>Открыть статистику</Link></section>;
}
function Guide() {
  const { session } = useSession(), data = useResource<{ endpoint: string; examples: Record<string,string> }>('/guide');
  if (!data.data) return <Resource {...data} />;
  const ex = data.data.examples;
  return <div className="guide-main"><section className="guide-intro"><p className="eyebrow">Первое подключение</p><h1>Создайте проект и подключите SDK</h1><p className="description">Выберите Android или JavaScript. Проект, приложение и ключ создаются одинаково.</p><div className="page-actions"><Link className="button" to={session.user ? '/console' : '/register'}>{session.user ? 'Открыть проекты' : 'Создать аккаунт'}</Link><a className="button secondary" href="#android">Подключить Android</a><a className="button secondary" href="#javascript">Подключить сайт</a></div><p className="muted small">Kotlin SDK 0.2.0 · JavaScript SDK 0.1.1 · iOS-адаптера пока нет.</p></section>
    <div className="guide-layout"><nav className="guide-toc" aria-label="Содержание инструкции"><a href="#project">Проект и приложение</a><a href="#key">Ключ отправки</a><a href="#address">Адрес сервера</a><a href="#android">Android</a><a href="#javascript">JavaScript</a><a href="#verify">Первое событие</a><a href="#event-types">Какие события отправлять</a><a href="#troubleshooting">Если не получилось</a></nav><div className="guide-content">
      <section className="guide-section" id="project"><h2>1. Создайте проект и приложение</h2><ol className="guide-steps"><li>Войдите в кабинет и создайте проект.</li><li>Откройте проект и добавьте приложение.</li><li>Выберите Android с package name или Web с точным origin сайта, включая протокол и порт.</li></ol></section>
      <section className="guide-section" id="key"><h2>2. Сохраните ключ отправки</h2><p>Полный ключ показывается один раз. Он разрешает отправку в своё приложение, но не вход в кабинет и не чтение статистики. Не публикуйте ключи и не храните пароли в репозитории.</p></section>
      <section className="guide-section" id="address"><h2>3. Проверьте адрес сервера</h2><p>Адрес этого сервиса: <code>{session.endpoint}</code>. На телефоне localhost означает сам телефон. Для Wi-Fi используйте доступный IP компьютера и откройте /health с телефона. В гостевой сети устройства могут быть изолированы.</p><p>Для USB укажите в SDK endpoint с хостом localhost и тем же портом, затем выполните ADB reverse:</p><CopyCode value={ex.reverse} label="PowerShell / терминал" /><p className="muted small">Для эмулятора Android адрес компьютера обычно 10.0.2.2. Для публичного сервера используйте HTTPS.</p></section>
      <section className="guide-section" id="android"><h2>4. Подключите Android</h2><p>SDK подключается локально через Gradle composite build. Публичной публикации в Maven пока нет.</p>
        {[['clone','Скачайте исходники'],['settings','settings.gradle.kts'],['dependency','build.gradle.kts модуля'],['application','AnalyticsApplication.kt'],['manifest','AndroidManifest.xml'],...(session.endpoint.startsWith('http:') ? [['debugManifest','src/debug/AndroidManifest.xml · только локальный HTTP']] : []),['compose','HomeScreen.kt · Compose'],['activity','ComponentActivity · onCreate']].map(([key,label]) => <CopyCode key={key} value={ex[key]} label={label} />)}
        <p>Если у приложения уже есть Application, перенесите инициализацию туда. Второй tracker и второй элемент application создавать не нужно. Для ранее подготовленного адаптера можно заполнить параметры ниже и пересобрать APK:</p><CopyCode value={ex.prepared} label="local.properties · только для подготовленного адаптера" />
      </section>
      <section className="guide-section" id="javascript"><h2>5. Подключите сайт</h2><p>Origin Web-приложения должен точно совпадать с origin страницы. Подключите SDK и отдельный файл своего кода.</p><CopyCode value={ex.html} label="HTML-страница" /><CopyCode value={ex.javascript} label="analytics.js" /><details className="guide-details"><summary>Подключение через ES module</summary><CopyCode value={ex.module} label="JavaScript module" /><p>Этот вариант заменяет обычный скрипт. Публичного пакета в npm пока нет.</p></details><p className="muted small">CSP сайта должна разрешать SDK и запросы к серверу. Автоматического сбора всех кликов и содержимого форм нет.</p><Link className="button secondary" to="/sdk-demo">Проверить JavaScript SDK</Link></section>
      <section className="guide-section" id="verify"><h2>6. Найдите первое событие</h2><ol className="guide-steps"><li>Запустите своё приложение или сайт.</li><li>Откройте экран и один раз нажмите отмеченную кнопку.</li><li>В кабинете откройте статистику нужного приложения.</li><li>Подождите до минуты с учётом пакетной отправки и обновления панели. Проверьте названия и время в последних событиях.</li></ol><p>Открытие экрана — screen_view, нажатие — button_click. Два события в этом примере ожидаемы. Сессия не равна уникальному человеку.</p></section>
      <section className="guide-section" id="event-types"><h2>Нажатие и успешное действие</h2><p>button_click вызывается при нажатии, action_success — после подтверждённого результата. Ошибка формы не должна считаться успешным сохранением.</p><CopyCode value={ex.successAndroid} label="Kotlin · после успешного действия" /><CopyCode value={ex.successWeb} label="JavaScript · после успешного действия" /></section>
      <section className="guide-section" id="troubleshooting"><h2>Если событие не появилось</h2><details className="guide-details"><summary>Телефон не видит сервер</summary><p>Проверьте /health с телефона, IP, изоляцию Wi-Fi и правила брандмауэра. После переподключения USB повторите adb reverse.</p></details><details className="guide-details"><summary>Сеть работает, но событий нет</summary><p>Проверьте полный ключ, платформу, выбранное приложение и включён ли сбор в этой сборке APK. После смены настроек пересоберите APK. После офлайна дождитесь повторной отправки.</p></details><details className="guide-details"><summary>Событий больше, чем нажатий</summary><p>Счётчик включает открытия экранов и другие события. Также могли прийти ранее накопленные события. Проверьте время и тип в журнале, единственный экземпляр tracker и отсутствие двойных вызовов.</p></details></section>
    </div></div></div>;
}
function Root() {
  const [session, setSession] = useState<Session | null>(null), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const refresh = async () => { const s = await request<Session>('/session'); setSession(s); };
  useEffect(() => { const abort = new AbortController(); request<Session>('/session', { signal: abort.signal }).then(setSession).catch(e => { if (!abort.signal.aborted) setError(e.message); }); return () => abort.abort(); }, [revision]);
  if (!session) return <div className="layout startup-panel"><h1>UlsaTrackerStyle SDK</h1>{error ? <><Notice error>{error}</Notice><button className="button" onClick={() => { setError(''); setRevision(v => v + 1); }}>Повторить подключение</button></> : <p role="status">Подключаемся к сервису…</p>}</div>;
  const post = async <T,>(path: string, body: object): Promise<T> => {
    try { return await request<T>(path, { body, csrf: session.csrfToken }); }
    catch(e) { if (e instanceof RequestError && e.code === 'session_required') { pendingKey = null; await refresh(); } throw e; }
  };
  return <SessionContext.Provider value={{ session, refresh, post }}><Routes><Route element={<Layout />}>
    <Route index element={<Home />} /><Route path="login" element={<Auth mode="login" />} /><Route path="register" element={<Auth mode="register" />} /><Route path="guide" element={<Guide />} />
    <Route element={<DemoFrame />}><Route path="events/new" element={<DemoEventForm />} /><Route path="dashboard" element={<Statistics demo />} /><Route path="error" element={<DemoRefusal />} /><Route path="system-state" element={<DemoState />} /></Route>
    <Route path="sdk-demo" element={<DemoSdk />} />
    <Route element={<Protected />}><Route path="console" element={<Projects />} /><Route path="console/projects/:projectId" element={<ProjectPage />} /><Route path="console/apps/:appId" element={<ApplicationRoute />} /><Route path="console/apps/:appId/test" element={<TestEvent />} /><Route path="console/apps/:appId/stats" element={<Statistics />} /></Route>
    <Route path="*" element={<section className="console-main"><h1>Страница не найдена</h1><Link className="button" to="/console">Открыть проекты</Link></section>} />
  </Route></Routes></SessionContext.Provider>;
}
class FrontendBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="layout startup-panel"><h1>Не удалось открыть страницу</h1><Notice error>Произошла ошибка интерфейса. Обновите страницу. Уже сохранённые данные останутся на сервере.</Notice><button className="button" onClick={() => window.location.reload()}>Обновить страницу</button></div> : this.props.children; }
}
createRoot(document.getElementById('root')!).render(<FrontendBoundary><BrowserRouter><Root /></BrowserRouter></FrontendBoundary>);
