import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';

const password = 'integration-test-password-2026';
async function boot(options = {}) {
  const dataDir = options.dataDir || mkdtempSync(join(tmpdir(),'ceremony-test-'));
  const instance = createApp({ dataDir, adminPassword:password, publicUrl:'https://event.example.com', ...options });
  const server = await new Promise(resolve => { const value = instance.app.listen(0,'127.0.0.1',()=>resolve(value)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path,body,cookie,method = body === undefined ? 'GET' : 'POST',headers = {}) => fetch(base+path,{
    method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  const login = async () => {
    const response=await request('/api/admin/login',{password});
    assert.equal(response.status,200);
    const cookie=response.headers.get('set-cookie');
    assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
    return cookie.split(';')[0];
  };
  const close = async (remove=true) => {
    instance.close();
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    if(remove)rmSync(dataDir,{recursive:true,force:true});
  };
  return {instance,server,base,dataDir,request,login,close};
}

test('join, avatar upload, private credential, self edit and persistence',async t=>{
  const app=await boot();t.after(()=>app.close());
  const initial=await (await app.request('/api/state')).json();
  assert.equal(initial.phase,'waiting');
  const joined=await app.request('/api/join',{eventId:initial.eventId,nickname:'小明同学',consent:true});
  assert.equal(joined.status,200);
  const record=await joined.json();assert.ok(record.participantToken);assert.match(record.participant.avatarUrl,/\.svg$/);
  const saved=await (await app.request('/api/state')).json();
  assert.equal(saved.participants[0].nickname,'小明同学');
  assert.equal(saved.participantCount,1);assert.ok(!JSON.stringify(saved).includes(record.participantToken));
  assert.ok(!JSON.stringify(saved).includes('participantHash'));
  assert.equal((await fetch(app.base+record.participant.avatarUrl)).status,200);
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=';
  const edited=await app.request('/api/join',{eventId:initial.eventId,nickname:'新名字',consent:true,participantToken:record.participantToken,avatarDataUrl:png});
  assert.equal(edited.status,200);assert.equal((await edited.json()).participant.id,record.participant.id);
  assert.equal((await app.instance.snapshot()).participantCount,1);
  const data=JSON.parse(readFileSync(join(app.dataDir,'state.json'),'utf8'));
  assert.equal(data.participants[0].nickname,'新名字');assert.ok(data.participants[0].participantHash);
});

test('moderation requires login, rejects cross-origin, and preserves safe URLs',async t=>{
  const app=await boot();t.after(()=>app.close());
  assert.equal((await app.request('/api/admin/launch',{})).status,401);
  assert.equal((await app.request('/api/admin/login',{password:'bad'})).status,401);
  assert.equal((await app.request('/api/admin/login',{password},undefined,'POST',{Origin:'https://evil.example'})).status,403);
  assert.equal((await app.request('/api/admin/login',{password},undefined,'POST',{Origin:app.base.replace('http:','https:')})).status,403);
  assert.equal((await app.request('/api/admin/login',{password},undefined,'POST',{Origin:app.base})).status,200);
  const cookie=await app.login();
  assert.equal((await (await app.request('/api/admin/session',undefined,cookie)).json()).authenticated,true);
  assert.equal((await app.request('/api/admin/settings',{publicUrl:'https://host.example/a'},cookie)).status,400);
  assert.equal((await app.request('/api/admin/settings',{title:'现场启动',theme:'gold',countdownSeconds:3},cookie)).status,200);
  const info=await (await app.request('/api/info')).json();
  assert.ok(info.joinUrl.startsWith('https://event.example.com/join.html?event='));
  assert.equal(info.stageUrl,'https://event.example.com/stage.html');
  assert.equal((await app.request('/api/qr.svg?text='+encodeURIComponent(info.joinUrl))).status,200);
  assert.equal((await app.request('/api/qr.svg?text=javascript:alert(1)')).status,400);
  assert.equal((await app.request('/api/admin/logout',{},cookie)).status,200);
  assert.equal((await app.request('/api/admin/demo',{count:3},cookie)).status,401);
});

test('SSE delivers initial state and live join updates',async t=>{
  const app=await boot();t.after(()=>app.close());
  const controller=new AbortController();
  const stream=await fetch(app.base+'/api/events',{signal:controller.signal});
  assert.equal(stream.status,200);assert.match(stream.headers.get('content-type'),/text\/event-stream/);
  const reader=stream.body.getReader();const decoder=new TextDecoder();
  const initial=decoder.decode((await reader.read()).value);
  assert.match(initial,/event: state/);assert.match(initial,/"participantCount":0/);
  await app.request('/api/join',{eventId:app.instance.snapshot().eventId,nickname:'在线嘉宾',consent:true});
  const changed=decoder.decode((await reader.read()).value);
  assert.match(changed,/"participantCount":1/);assert.match(changed,/在线嘉宾/);
  controller.abort();await reader.cancel().catch(()=>{});
});

test('display adjustments require login, broadcast, persist and preserve the ceremony',async t=>{
  let app=await boot();const dir=app.dataDir;
  t.after(()=>app.close());
  assert.equal(app.instance.snapshot().settings.stageQrSize,26);
  assert.equal(app.instance.snapshot().settings.stageQrTop,54);
  assert.equal((await app.request('/api/admin/display',{stageQrSize:30,stageQrTop:48})).status,401);
  const cookie=await app.login();
  for (const invalid of [{stageQrSize:35,stageQrTop:48},{stageQrSize:26,stageQrTop:37},{stageQrSize:'26',stageQrTop:54},{}]) {
    assert.equal((await app.request('/api/admin/display',invalid,cookie)).status,400);
  }
  const before=app.instance.snapshot();
  const controller=new AbortController();
  const stream=await fetch(app.base+'/api/events',{signal:controller.signal});
  const reader=stream.body.getReader();await reader.read();
  const response=await app.request('/api/admin/display',{stageQrSize:30,stageQrTop:48},cookie);
  assert.equal(response.status,200);
  const changed=new TextDecoder().decode((await reader.read()).value);
  assert.match(changed,/"stageQrSize":30/);assert.match(changed,/"stageQrTop":48/);
  controller.abort();await reader.cancel().catch(()=>{});
  const after=await response.json();
  assert.equal(after.eventId,before.eventId);assert.equal(after.phase,before.phase);
  assert.deepEqual(after.participants,before.participants);
  assert.equal(after.settings.title,before.settings.title);
  await app.close(false);app=await boot({dataDir:dir});
  assert.equal(app.instance.snapshot().settings.stageQrSize,30);
  assert.equal(app.instance.snapshot().settings.stageQrTop,48);
  const resumedCookie=await app.login();
  await app.request('/api/admin/launch',{},resumedCookie);
  assert.equal((await app.request('/api/admin/display',{stageQrSize:26,stageQrTop:54},resumedCookie)).status,200);
  assert.equal(app.instance.snapshot().phase,'countdown');
});

test('countdown is server-owned, closes joining, survives restart and can reset',async t=>{
  let app=await boot();const dir=app.dataDir;
  t.after(()=>app.close());
  const cookie=await app.login();
  await app.request('/api/admin/settings',{countdownSeconds:3},cookie);
  const eventId=app.instance.snapshot().eventId;
  await app.request('/api/join',{eventId,nickname:'保留嘉宾',consent:true});
  const launched=await app.request('/api/admin/launch',{},cookie);
  assert.equal(launched.status,200);assert.equal((await launched.json()).phase,'countdown');
  assert.equal((await app.request('/api/admin/launch',{},cookie)).status,409);
  assert.equal((await app.request('/api/join',{eventId,nickname:'迟到嘉宾',consent:true})).status,409);
  await app.close(false);
  app=await boot({dataDir:dir});
  assert.equal(app.instance.snapshot().phase,'countdown');
  await new Promise(resolve=>setTimeout(resolve,3150));
  assert.equal(app.instance.snapshot().phase,'launched');assert.ok(app.instance.snapshot().launchedAt);
  const newCookie=await app.login();
  await app.request('/api/admin/reset',{clearParticipants:false},newCookie);
  assert.equal(app.instance.snapshot().phase,'waiting');assert.equal(app.instance.snapshot().participantCount,1);
  await app.request('/api/admin/reset',{clearParticipants:true},newCookie);
  assert.equal(app.instance.snapshot().participantCount,0);assert.notEqual(app.instance.snapshot().eventId,eventId);
  assert.equal((await app.request('/api/join',{eventId,nickname:'旧活动嘉宾',consent:true})).status,409);
});

test('validation, capacity, deletion and rate limit',async t=>{
  const app=await boot({maxParticipants:2,joinRateLimit:10});t.after(()=>app.close());
  const eventId=app.instance.snapshot().eventId;
  assert.equal((await app.request('/api/join',{eventId,nickname:'一个人',consent:false})).status,400);
  assert.equal((await app.request('/api/join',{eventId,nickname:'字',consent:true})).status,400);
  assert.equal((await app.request('/api/join',{eventId,nickname:'测试上传',consent:true,avatarDataUrl:'data:image/png;base64,SGVsbG8='})).status,400);
  assert.equal((await app.request('/api/join',{eventId,nickname:'测试凭证',consent:true,participantToken:'bad-token'})).status,403);
  const cookie=await app.login();
  assert.equal((await app.request('/api/admin/demo',{count:2},cookie)).status,200);
  assert.equal((await app.request('/api/join',{eventId,nickname:'上限嘉宾',consent:true})).status,409);
  const person=app.instance.snapshot().participants[0];
  assert.equal((await app.request('/api/admin/participants/'+person.id,undefined,cookie,'DELETE')).status,200);
  assert.equal((await fetch(app.base+person.avatarUrl)).status,404);
  assert.equal((await app.request('/api/join',{eventId,nickname:'新嘉宾',consent:true})).status,200);
  for(let i=0;i<5;i++)await app.request('/api/join',{eventId,nickname:'限流嘉宾',consent:true});
  const limited=await app.request('/api/join',{eventId,nickname:'限流嘉宾',consent:true});
  assert.equal(limited.status,429);assert.ok(limited.headers.get('retry-after'));
});

test('trusted proxy identifies HTTPS and sets secure administrator cookie',async t=>{
  const app=await boot({trustProxy:true});t.after(()=>app.close());
  const response=await app.request('/api/admin/login',{password},undefined,'POST',{
    Origin:app.base.replace('http:','https:'),'X-Forwarded-Proto':'https'
  });
  assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/; Secure/);
});

test('failed disk write does not expose or keep uncommitted activity settings',async t=>{
  const app=await boot();t.after(()=>app.close());
  const cookie=await app.login();
  const before=app.instance.snapshot();
  const blockedTemp=join(app.dataDir,'state.json.tmp');mkdirSync(blockedTemp);
  const failed=await app.request('/api/admin/settings',{title:'尚未保存的标题'},cookie);
  assert.equal(failed.status,503);
  assert.equal(app.instance.snapshot().settings.title,before.settings.title);
  assert.equal(app.instance.snapshot().version,before.version);
  assert.equal(JSON.parse(readFileSync(join(app.dataDir,'state.json'),'utf8')).settings.title,before.settings.title);
  rmSync(blockedTemp,{recursive:true});
  assert.equal((await app.request('/api/admin/settings',{title:'成功保存的标题'},cookie)).status,200);
});

test('oversized image dimensions are rejected before storing an avatar',async t=>{
  const app=await boot();t.after(()=>app.close());
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=','base64');
  bytes.writeUInt32BE(65535,16);bytes.writeUInt32BE(65535,20);
  const response=await app.request('/api/join',{eventId:app.instance.snapshot().eventId,nickname:'过大头像',consent:true,avatarDataUrl:`data:image/png;base64,${bytes.toString('base64')}`});
  assert.equal(response.status,400);assert.equal(app.instance.snapshot().participantCount,0);
});

test('shared event Wi-Fi supports more than fifty joins from one IP by default',async t=>{
  const app=await boot();t.after(()=>app.close());
  const eventId=app.instance.snapshot().eventId;
  for(let i=0;i<55;i++) {
    const response=await app.request('/api/join',{eventId,nickname:`共享网络嘉宾 ${i+1}`,consent:true});
    assert.equal(response.status,200);
  }
  assert.equal(app.instance.snapshot().participantCount,55);
});

test('mobile status includes only the requested participant and preserves the global count',async t=>{
  const app=await boot();t.after(()=>app.close());
  const cookie=await app.login();
  await app.request('/api/admin/demo',{count:3},cookie);
  const result=await (await app.request('/api/join',{eventId:app.instance.snapshot().eventId,nickname:'真实参与者',consent:true})).json();
  assert.equal(result.participant.isDemo,false);
  assert.ok(app.instance.snapshot().participants.slice(0,3).every(p=>p.isDemo));
  const anonymous=await (await app.request('/api/status')).json();
  assert.equal(anonymous.participantCount,4);assert.deepEqual(anonymous.participants,[]);
  const selected=await (await app.request('/api/status?participantId='+result.participant.id)).json();
  assert.equal(selected.participantCount,4);assert.equal(selected.participants.length,1);
  assert.equal(selected.participants[0].id,result.participant.id);
  assert.ok(!JSON.stringify(selected).includes('participantHash'));
  const absent=await (await app.request('/api/status?participantId=missing')).json();
  assert.deepEqual(absent.participants,[]);
});

test('brand migration updates complete historical defaults and preserves custom copy, settings and existing avatars',()=>{
  const originalCopies=[
    {title:'聚力 · 共启新程',subtitle:'每一份力量，点亮共同的未来',launchText:'启动成功'},
    {title:'向新而生 · 共创未来',subtitle:'Delta Space 孵化器开幕仪式',launchText:'正式启幕'}
  ];
  const newCopy={title:'DELTA SPACE',subtitle:'DELTA SPACE 启动日活动',launchText:'正式启动'};
  const extras={theme:'gold',logoUrl:'/uploads/custom-logo.png',countdownSeconds:9,publicUrl:'https://my-event.example'};
  for(const originalCopy of originalCopies) for(const customizedKey of [null,'title','subtitle','launchText']) {
    const dir=mkdtempSync(join(tmpdir(),'ceremony-migration-'));
    let instance;
    try {
      const copy={...originalCopy};
      if(customizedKey)copy[customizedKey]='我的自定义文案';
      const participants=[{id:'existing-person',nickname:'已有用户',avatarUrl:'/uploads/existing-avatar.svg',joinedAt:123456}];
      const fixture={eventId:'existing-event',version:7,settings:{...copy,...extras},phase:'waiting',countdownStartedAt:null,launchedAt:null,participants};
      mkdirSync(join(dir,'uploads'));
      const oldAvatar='<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#b8ccd1" width="256" height="256"/></svg>';
      writeFileSync(join(dir,'uploads/existing-avatar.svg'),oldAvatar);
      writeFileSync(join(dir,'state.json'),JSON.stringify(fixture));
      instance=createApp({dataDir:dir,adminPassword:password});
      const saved=JSON.parse(readFileSync(join(dir,'state.json'),'utf8'));
      assert.deepEqual(saved.settings,{...(customizedKey?copy:newCopy),...extras,stageQrSize:26,stageQrTop:54});
      assert.deepEqual(saved.participants,participants);
      assert.equal(readFileSync(join(dir,'uploads/existing-avatar.svg'),'utf8'),oldAvatar);
      assert.equal(saved.eventId,fixture.eventId);assert.equal(saved.version,7);
      for(const [key,value] of Object.entries(customizedKey?copy:newCopy))assert.equal(instance.snapshot().settings[key],value);
    } finally {instance?.close();rmSync(dir,{recursive:true,force:true});}
  }
});
