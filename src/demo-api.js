import { Router, json } from 'express';
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { validateBatch } from './events.js';
import { ApiError } from './errors.js';
import { SERVER_VERSION } from './version.js';

export function demoApiRouter({config,store,metrics}) {
  const router=Router(),secret=randomBytes(32);
  const scalar=(body,key)=>typeof body?.[key]==='string'?body[key]:'';
  const sign=body=>createHmac('sha256',secret).update(JSON.stringify(['eventId','sessionId','occurredAt'].map(k=>scalar(body,k)))).digest('hex');
  router.use((req,res,next)=>{
    res.set('Cache-Control','no-store');
    if(!config.demoMode)return next(new ApiError(404,'not_found','Демонстрационный режим недоступен.'));
    next();
  });
  router.get('/form',(req,res)=>{const identity={eventId:randomUUID(),sessionId:randomUUID(),occurredAt:new Date().toISOString()};res.json({...identity,csrfToken:sign(identity)});});
  router.post('/events',(req,res,next)=>{
    if(!req.is('application/json'))return next(new ApiError(415,'unsupported_media_type','Требуется Content-Type: application/json.'));
    next();
  },json({limit:'8kb',strict:true}),async(req,res)=>{
    const token=scalar(req.body,'csrfToken'),expected=sign(req.body);
    if(!/^[a-f0-9]{64}$/.test(token)||!timingSafeEqual(Buffer.from(token),Buffer.from(expected)))throw new ApiError(403,'invalid_form','Форма устарела. Откройте её заново. Событие не сохранено.');
    const name=scalar(req.body,'name').trim(),detail=scalar(req.body,'detail').trim();
    const events=validateBatch({schemaVersion:1,events:[{eventId:scalar(req.body,'eventId'),sessionId:scalar(req.body,'sessionId'),occurredAt:scalar(req.body,'occurredAt'),name,screen:scalar(req.body,'screen').trim()||null,platform:'web',appVersion:SERVER_VERSION,properties:detail?{[name==='button_click'?'button':name==='action_success'?'action':'detail']:detail}:{}}]});
    const result=await store.ingest(config.projectId,events);metrics?.ingested(result);
    res.json({eventId:events[0].eventId,...result});
  });
  router.get('/statistics',(req,res)=>res.json({application:{id:config.projectId,name:'Демонстрационная статистика',project_name:'Демонстрация',platform:'web',identifier:config.publicUrl,archived:false,deleting:false,project_id:config.projectId},dashboardUrl:'/grafana/d/ulsatracker/events'}));
  router.get('/recent',async(req,res)=>res.json({events:await store.recent(config.projectId)}));
  router.get('/refusal-example',(req,res)=>{
    let reason,field;
    try{validateBatch({schemaVersion:1,events:[{eventId:randomUUID(),sessionId:randomUUID(),occurredAt:new Date().toISOString(),name:'',screen:'collection',platform:'web',appVersion:SERVER_VERSION}]});}
    catch(error){if(!(error instanceof ApiError))throw error;reason=error.message;field=error.field;}
    res.json({status:400,reason,field,operation:'Сохранить событие с пустым названием'});
  });
  router.get('/state',async(req,res)=>{
    if(typeof store.operationalState!=='function')throw new ApiError(503,'observation_unavailable','Наблюдение доступно на стенде с ClickHouse.');
    const checkedAt=new Date().toISOString();
    try{res.json({applicationAvailable:true,databaseAvailable:true,checkedAt,...await store.operationalState(config.projectId)});}
    catch{res.status(503).json({applicationAvailable:true,databaseAvailable:false,checkedAt,total:null,lastEvent:null});}
  });
  router.use((req,res,next)=>next(new ApiError(404,'not_found','Маршрут демонстрации не найден.')));
  return router;
}
