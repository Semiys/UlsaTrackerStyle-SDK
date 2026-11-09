import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Form, Notice, Select } from './components';
import { request, RequestError } from './api';
import { useResource, useSession } from './main';

type Identity = {eventId:string;sessionId:string;occurredAt:string;csrfToken:string};
type Receipt = {eventId:string;eventName:string;observedAt:string;status:string};
type State = {applicationAvailable:boolean;databaseAvailable:boolean;checkedAt:string;total:number|null;lastEvent:Receipt|null};
const localTime = (value:string) => new Date(value).toLocaleString('ru-RU',{timeZoneName:'short'});

export function DemoFrame() {
  const {session}=useSession();
  if(!session.demoMode)return <section><h1>Демонстрация недоступна</h1><Link className="button" to="/console">Мой кабинет</Link></section>;
  return <><nav className="demo-navigation controls" aria-label="Проверка сервиса">{[['/events/new','Отправить событие'],['/dashboard','Статистика'],['/system-state','Состояние системы'],['/error','Пример отказа']].map(([to,label])=><NavLink className="button secondary" key={to} to={to}>{label}</NavLink>)}</nav><Outlet /></>;
}
export function DemoEventForm() {
  const data=useResource<Identity>('/form','demo'),navigate=useNavigate(),location=useLocation();
  const invalid=new URLSearchParams(location.search).get('example')==='invalid';
  if(!data.data)return <section><h1>Отправить событие</h1>{data.error?<><Notice error>{data.error}</Notice><button className="button" onClick={data.retry}>Повторить</button></>:<p role="status">Подготавливаем форму…</p>}</section>;
  const identity=data.data;
  return <section className="console-main narrow"><p className="eyebrow">Приём данных</p><h1>Отправить событие</h1><p className="muted">Событие пройдёт проверку и сохранится в демонстрационном проекте. Затем можно проверить операционный след и графики.</p>
    <Form key={identity.eventId} onSubmit={async values=>{
      try{await request('/events',{scope:'demo',csrf:identity.csrfToken,body:{...identity,...Object.fromEntries(values)}});navigate('/system-state');}
      catch(error){if(error instanceof RequestError && error.status>=400 && error.status<500){navigate('/error',{state:{failure:{status:error.status,reason:error.message,field:error.field,operation:'Сохранить аналитическое событие'}}});return;}throw error;}
    }}>
      <label>Название события<input name="name" defaultValue={invalid?'':'button_click'} maxLength={64} autoComplete="off" /></label><p className="muted small">Например, button_click или screen_view. Пустое название сервер отклонит.</p>
      <label>Экран<input name="screen" defaultValue="collection" maxLength={64} autoComplete="off" /></label><label>Кнопка или действие<input name="detail" defaultValue="open_filters" maxLength={256} autoComplete="off" /></label>
      <button className="button" type="submit">Сохранить событие</button>
    </Form><details className="guide-details"><summary>Идентификатор этой записи</summary><code>{identity.eventId}</code><p className="muted small">При повторной отправке той же формы запись учитывается один раз.</p></details>
  </section>;
}
export function DemoRefusal() {
  const location=useLocation(),data=useResource<{status:number;reason:string;field?:string;operation:string}>('/refusal-example','demo');
  const failure=(location.state as {failure?:{status:number;reason:string;field?:string;operation:string}}|null)?.failure??data.data;
  return <section className="console-main narrow error-panel"><p className="eyebrow">Проверка данных</p><h1>Действие не выполнено</h1>{failure?<><dl className="error-details"><dt>Действие</dt><dd>{failure.operation}</dd><dt>Причина отказа</dt><dd>{failure.reason}</dd>{failure.field&&<><dt>Поле</dt><dd><code>{failure.field}</code></dd></>}<dt>HTTP-статус</dt><dd>{failure.status}</dd></dl><p>Событие не сохранено. Исправьте данные и отправьте форму заново.</p></>:data.error?<Notice error>{data.error}</Notice>:<p role="status">Проверяем правило валидации…</p>}
    <div className="page-actions"><Link className="button" to="/events/new">Исправить данные</Link><Link className="button secondary" to="/events/new?example=invalid">Проверить пустое название</Link></div>
  </section>;
}
export function DemoState() {
  const [state,setState]=useState<State|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  useEffect(()=>{
    let pending=false,closed=false;const abort=new AbortController();
    async function refresh(){
      if(pending||document.hidden)return;pending=true;setBusy(true);
      try{
        const response=await fetch('/api/demo/state',{cache:'no-store',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(8000)])});
        if(![200,503].includes(response.status))throw new Error('Состояние временно недоступно.');
        const next=await response.json() as State;if(typeof next.databaseAvailable!=='boolean'||typeof next.applicationAvailable!=='boolean')throw new Error('Сервис вернул неожиданный ответ.');
        if(!closed){setState(next);setError('');}
      }catch(e){if(!closed)setError((e as Error).message||'Нет соединения с сервисом.');}
      finally{pending=false;if(!closed)setBusy(false);}
    }
    void refresh();const timer=setInterval(refresh,5000),visible=()=>{if(!document.hidden)void refresh();};document.addEventListener('visibilitychange',visible);
    return()=>{closed=true;abort.abort();clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
  },[revision]);
  const last=error?null:state?.lastEvent,available=!error&&state?.databaseAvailable;
  return <div data-system-state><div className="page-heading"><p className="eyebrow">Приём событий</p><h1>Состояние системы</h1><p className="muted">Доступность хранилища и последняя подтверждённая запись демонстрационного проекта.</p></div>
    <section className="state-cards" aria-label="Доступность и приём"><article className="panel"><h2>Приложение</h2><p className="state-chip" data-ok={!error}>{error?'Нет соединения':state?'Отвечает':'Проверяем…'}</p></article><article className="panel"><h2>Хранилище</h2><p className="state-chip" data-ok={available}>{error?'Нет подтверждения':state?(state.databaseAvailable?'Доступно':'Недоступно'):'Проверяем…'}</p></article><article className="panel"><h2>Подтверждено записей</h2><p className="state-number">{error?'—':state?.total??'—'}</p><p className="muted small">В демонстрационном проекте</p></article></section>
    <section className="panel state-receipt"><h2>Последняя запись на сервере</h2>{error?<Notice error>{error}</Notice>:!state?<p role="status">Проверяем последние записи…</p>:!available?<Notice error>Хранилище сейчас недоступно. Последнюю запись подтвердить нельзя.</Notice>:!last?<><p>События ещё не сохранены.</p><p className="muted">Отправьте событие через форму. Здесь появятся его идентификатор, тип и время записи.</p></>:<dl className="state-fields"><div><dt>Результат</dt><dd>Сохранено</dd></div><div><dt>Событие</dt><dd>{last.eventName}</dd></div><div><dt>Идентификатор записи</dt><dd><code>{last.eventId}</code></dd></div><div><dt>Принято сервером</dt><dd><time dateTime={last.observedAt}>{localTime(last.observedAt)}</time></dd></div></dl>}
      <div className="page-actions"><Link className="button" to="/events/new">Отправить событие</Link>{last&&<Link className="button secondary" to={'/dashboard?saved='+last.eventId}>Открыть статистику</Link>}</div>
    </section><div className="page-actions"><button className="button secondary" disabled={busy} onClick={()=>setRevision(n=>n+1)}>Обновить состояние</button><p className="muted small" aria-live="polite">{state&&!error?'Проверено: '+localTime(state.checkedAt)+'. ':''}Автоматическая проверка каждые 5 секунд</p></div>
  </div>;
}

type Tracker = {screen:(name:string)=>boolean;click:(button:string,screen?:string)=>boolean;flush:()=>Promise<unknown>;getStatus:()=>{queued:number;accepted:number;lastStatus:string;paused:string;dropped:number;rejected:number};close:()=>void};
export function DemoSdk() {
  const {session}=useSession(),tracker=useRef<Tracker|null>(null),[connected,setConnected]=useState(false),[status,setStatus]=useState('SDK пока не подключена.');
  useEffect(()=>{const timer=setInterval(()=>{if(tracker.current){const s=tracker.current.getStatus();setStatus(`В очереди: ${s.queued}. Подтверждено: ${s.accepted}. Потеряно: ${s.dropped}. Отклонено: ${s.rejected}. ${s.paused||s.lastStatus}`);}},1000);return()=>{clearInterval(timer);tracker.current?.close();};},[]);
  return <section className="console-main narrow"><p className="eyebrow">JavaScript SDK</p><h1>Проверка подключения сайта</h1><p className="muted">В кабинете создайте Web-приложение с origin <code>{window.location.origin}</code>. Вставьте его ключ отправки. Ключ хранится только в памяти этой страницы.</p><Form onSubmit={async values=>{
    const modulePath='/sdk/index.mjs';const module=await import(/* @vite-ignore */ modulePath) as {createTracker:(options:object)=>Tracker};
    tracker.current?.close();tracker.current=module.createTracker({endpoint:session.endpoint,ingestKey:String(values.get('key')??'').trim(),appVersion:'web-check',allowHttp:session.endpoint.startsWith('http:')});setConnected(true);setStatus('Подключено. Отправьте тестовый экран или нажатие.');
  }}><label>Ключ отправки<input name="key" type="password" autoComplete="off" spellCheck={false} required /></label><button className="button">Подключить SDK</button></Form><div className="page-actions"><button className="button secondary" disabled={!connected} onClick={()=>{tracker.current?.screen('sdk_web_check');void tracker.current?.flush();}}>Открытие тестового экрана</button><button className="button secondary" disabled={!connected} onClick={()=>{tracker.current?.click('verify_delivery','sdk_web_check');void tracker.current?.flush();}}>Тестовое нажатие</button></div><p className="muted" role="status">{status}</p><div className="page-actions"><Link className="button secondary" to="/console">Открыть проекты</Link><Link className="button secondary" to="/guide#javascript">Инструкция</Link></div></section>;
}
