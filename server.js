import express from 'express';
import QRCode from 'qrcode';
import { imageSize } from 'image-size';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SETTINGS = {
  title: 'DELTA SPACE', subtitle: 'DELTA SPACE 启动日活动',
  launchText: '正式启动', theme: 'aurora', publicUrl: '', countdownSeconds: 5, logoUrl: '',
  stageQrSize: 26, stageQrTop: 54
};
const hash = value => createHash('sha256').update(String(value)).digest();
const equalSecret = (left, right) => timingSafeEqual(hash(left), hash(right));
const escapeXml = text => String(text).replace(/[<>&"']/g, ch => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;' }[ch]));
const token = () => randomBytes(32).toString('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });

export function localAddresses(port = 3000) {
  const addresses = Object.values(networkInterfaces()).flat().filter(x => x && x.family === 'IPv4' && !x.internal);
  return [...new Set(addresses.map(x => `http://${x.address}:${port}`))];
}
function validPublicUrl(value) {
  if (!value) return '';
  let url;
  try { url = new URL(String(value)); } catch { throw fail(400, '请输入完整的 http:// 或 https:// 服务器网址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw fail(400, '服务器网址须为 http(s) 根网址，不带路径、参数或账号密码');
  }
  return url.origin;
}
function cleanText(value, min, max, label) {
  if (typeof value !== 'string') throw fail(400, `${label}格式错误`);
  const result = value.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  if ([...result].length < min || [...result].length > max) throw fail(400, `${label}需为 ${min}–${max} 个字`);
  return result;
}
function initialAvatar(nickname, id) {
  const colors = ['#23445a', '#4c3023', '#28475b', '#2b3445', '#4e382d', '#233c52'];
  const color = colors[parseInt(createHash('sha256').update(id).digest('hex').slice(0, 2), 16) % colors.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="64" fill="${color}"/><circle cx="195" cy="35" r="90" fill="white" opacity=".15"/><text x="128" y="136" text-anchor="middle" dominant-baseline="middle" fill="white" font-family="system-ui,sans-serif" font-size="88" font-weight="600">${escapeXml([...nickname].slice(0, 2).join(''))}</text></svg>`;
}
function decodeImage(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > 360000) throw fail(400, '图片过大，请选择或压缩至 256KB 内');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw fail(400, '仅支持 PNG、JPEG、WebP 图片');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > 256 * 1024 || bytes.toString('base64') !== match[2]) throw fail(400, '图片内容无效或超过 256KB');
  const type = match[1];
  const valid = type === 'png' ? bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : type === 'jpeg' ? bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.length >= 16 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
  if (!valid) throw fail(400, '图片格式与实际内容不匹配');
  try {
    const size = imageSize(bytes);
    if (!size.width || !size.height || size.width > 4096 || size.height > 4096 || size.width * size.height > 16_000_000) {
      throw new Error('图片尺寸过大');
    }
  } catch { throw fail(400, '无法读取图片，或尺寸超过 4096 像素，请重新选择图片'); }
  return { bytes, ext: type === 'jpeg' ? 'jpg' : type };
}

/** Single process app. All durable mutations complete before broadcasting. */
export function createApp(options = {}) {
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || join(ROOT, 'data'));
  const uploadDir = join(dataDir, 'uploads');
  const statePath = join(dataDir, 'state.json');
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  const maxParticipants = Number(options.maxParticipants ?? process.env.MAX_PARTICIPANTS ?? 1000);
  const joinRateLimit = Number(options.joinRateLimit ?? process.env.JOIN_RATE_LIMIT ?? 2000);
  if (!Number.isInteger(maxParticipants) || maxParticipants < 1 || maxParticipants > 5000) throw new Error('MAX_PARTICIPANTS 必须为 1–5000');
  if (!Number.isInteger(joinRateLimit) || joinRateLimit < 1) throw new Error('JOIN_RATE_LIMIT 必须为正整数');
  const adminPassword = options.adminPassword || process.env.ADMIN_PASSWORD || token().slice(0, 24);
  const generatedPassword = !(options.adminPassword || process.env.ADMIN_PASSWORD);
  mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  let state;
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, 'utf8'));
      if (!state.eventId || !Array.isArray(state.participants) || !['waiting','countdown','launched'].includes(state.phase)) throw new Error('结构无效');
      state.settings = { ...DEFAULT_SETTINGS, ...state.settings };
      // Upgrade only complete historical defaults; one customized field preserves all copy.
      const legacyCopies = [
        ['聚力 · 共启新程', '每一份力量，点亮共同的未来', '启动成功'],
        ['向新而生 · 共创未来', 'Delta Space 孵化器开幕仪式', '正式启幕']
      ];
      if (legacyCopies.some(([title, subtitle, launchText]) => state.settings.title === title
        && state.settings.subtitle === subtitle && state.settings.launchText === launchText)) {
        for (const key of ['title', 'subtitle', 'launchText']) state.settings[key] = DEFAULT_SETTINGS[key];
      }
    } catch (error) { throw new Error(`活动数据读取失败。请保留 ${statePath} 并从备份恢复：${error.message}`); }
  } else {
    state = { eventId: randomUUID(), version: 0, settings: { ...DEFAULT_SETTINGS, publicUrl: validPublicUrl(options.publicUrl || process.env.PUBLIC_URL || '') }, phase: 'waiting', countdownStartedAt: null, launchedAt: null, participants: [] };
  }
  const envPublicUrl = validPublicUrl(options.publicUrl || process.env.PUBLIC_URL || '');
  const app = express();
  const clients = new Set();
  const sessions = new Map();
  const attempts = new Map();
  let launchTimer;
  let broadcastTimer;
  let lastSavedState = JSON.stringify(state);
  let closed = false;
  app.disable('x-powered-by');
  if (options.trustProxy ?? process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use((req,res,next) => {
    res.set({ 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'same-origin', 'X-Frame-Options':'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
    if (req.path.startsWith('/api/')) res.set('Cache-Control','no-store');
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.get('origin')) {
      try {
        if (new URL(req.get('origin')).origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({error:'请求来源不匹配，请从本站页面操作'});
      } catch { return res.status(403).json({error:'无效的请求来源'}); }
    }
    next();
  });
  app.use(express.json({ limit: '400kb' }));
  const persist = () => {
    const temp = `${statePath}.tmp`;
    const serialized = JSON.stringify(state);
    writeFileSync(temp, serialized, { mode: 0o600 });
    renameSync(temp, statePath);
    lastSavedState = serialized;
  };
  const snapshot = () => ({
    eventId: state.eventId, version: state.version, serverTime: Date.now(),
    settings: { ...state.settings, publicUrl: envPublicUrl || state.settings.publicUrl },
    phase: state.phase, countdownStartedAt: state.countdownStartedAt, launchedAt: state.launchedAt,
    participants: state.participants.map(({ participantHash, ...participant }) => participant),
    participantCount: state.participants.length, maxParticipants
  });
  const commit = () => {
    state.version++;
    try { persist(); } catch (error) {
      state = JSON.parse(lastSavedState);
      console.error('活动数据写入失败，已回滚内存状态:', error.message);
      throw fail(503, '数据未能保存，请检查服务器磁盘空间和目录权限后重试');
    }
    // Joining bursts share one snapshot; phones use the lightweight status endpoint.
    if (!broadcastTimer && clients.size) broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      const message = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;
      for (const client of clients) {
        if (client.writableLength > 2 * 1024 * 1024) { client.destroy(); clients.delete(client); }
        else client.write(message);
      }
    }, 150);
  };
  const scheduleLaunch = () => {
    clearTimeout(launchTimer);
    if (state.phase !== 'countdown') return;
    const remaining = state.countdownStartedAt + state.settings.countdownSeconds * 1000 - Date.now();
    if (remaining <= 0) {
      state.phase = 'launched';
      state.launchedAt = state.countdownStartedAt + state.settings.countdownSeconds * 1000;
      try { commit(); } catch {
        launchTimer = setTimeout(scheduleLaunch, 1000);
        launchTimer.unref();
      }
    } else {
      launchTimer = setTimeout(scheduleLaunch, remaining);
      launchTimer.unref();
    }
  };
  persist();
  scheduleLaunch();
  const limit = (kind, count, windowMs) => (req,res,next) => {
    const key = `${kind}:${req.ip}`;
    const now = Date.now();
    let entry = attempts.get(key);
    if (!entry || entry.until < now) { entry = { count: 0, until: now + windowMs }; attempts.set(key,entry); }
    entry.count++;
    if (entry.count > count) { res.set('Retry-After',String(Math.ceil((entry.until-now)/1000))); return res.status(429).json({error:'操作过于频繁，请稍后重试'}); }
    next();
  };
  const cookieToken = req => (req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith('launch_admin='))?.slice(13);
  const authenticated = req => {
    const session = sessions.get(cookieToken(req));
    return !!session && session > Date.now();
  };
  const requireAdmin = (req,res,next) => authenticated(req) ? next() : res.status(401).json({error:'请先登录主持控制台'});
  const mustWait = () => { if (state.phase !== 'waiting') throw fail(409, '启动已开始，请先在控制台重置后再操作'); };
  const saveImage = dataUrl => {
    const {bytes,ext} = decodeImage(dataUrl);
    const name = `${randomUUID()}.${ext}`;
    writeFileSync(join(uploadDir,name), bytes, {mode:0o600});
    return `/uploads/${name}`;
  };
  const saveInitial = (nickname,id) => {
    const name = `${id}.svg`;
    writeFileSync(join(uploadDir,name),initialAvatar(nickname,id),{mode:0o600});
    return `/uploads/${name}`;
  };
  const cleanupUploads = () => {
    const retained = new Set([...state.participants.map(p => p.avatarUrl.split('/').pop()), state.settings.logoUrl?.split('/').pop()]);
    let names;
    try { names = readdirSync(uploadDir); }
    catch(error) { console.error('旧图片清理延后:',error.message); return; }
    for (const name of names) if (!retained.has(name) && /^[a-f0-9-]+\.(png|jpg|webp|svg)$/.test(name)) {
      try { unlinkSync(join(uploadDir,name)); } catch { /* later cleanup can retry */ }
    }
  };
  app.get('/api/state',(_req,res)=>res.json(snapshot()));
  app.get('/api/status',(req,res)=>{
    const view = snapshot();
    view.participants = typeof req.query.participantId === 'string'
      ? view.participants.filter(participant => participant.id === req.query.participantId)
      : [];
    res.json(view);
  });
  app.get('/api/events',(req,res)=>{
    if (clients.size >= 3000) return res.status(503).json({error:'实时连接已满，请稍后刷新'});
    res.status(200).set({ 'Content-Type':'text/event-stream', 'Connection':'keep-alive', 'X-Accel-Buffering':'no' });
    res.flushHeaders();
    res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close',()=>clients.delete(res));
  });
  app.post('/api/join',limit('join',joinRateLimit,60_000),(req,res)=>{
    mustWait();
    const {eventId,nickname,avatarDataUrl,consent,participantToken} = req.body || {};
    if (eventId !== state.eventId) throw fail(409,'本活动已重置，请重新扫码加入');
    if (consent !== true) throw fail(400,'请先同意将昵称和头像展示在活动大屏');
    const name = cleanText(nickname,2,20,'昵称');
    let participant;
    if (participantToken) {
      // Compare the stored hash directly, without storing participant credentials in snapshots.
      participant = state.participants.find(p => p.participantHash && equalSecret(hash(participantToken).toString('hex'),p.participantHash));
      if (!participant) throw fail(403,'参与凭证已失效，请清除本机参与记录后重新加入');
    } else if (state.participants.length >= maxParticipants) throw fail(409,'参与人数已达上限，请联系现场工作人员');
    const id = participant?.id || randomUUID();
    const avatarUrl = avatarDataUrl ? saveImage(avatarDataUrl) : (participant?.avatarUrl || saveInitial(name,id));
    const participantSecret = participantToken || token();
    if (participant) Object.assign(participant,{nickname:name,avatarUrl});
    else {
      participant = {id,nickname:name,avatarUrl,joinedAt:Date.now(),isDemo:false,participantHash:hash(participantSecret).toString('hex')};
      state.participants.push(participant);
    }
    commit();
    cleanupUploads();
    const {participantHash,...publicParticipant} = participant;
    res.status(200).json({participant:publicParticipant,participantToken:participantSecret});
  });
  app.get('/api/admin/session',(req,res)=>res.json({authenticated:authenticated(req)}));
  app.post('/api/admin/login',limit('login',10,15*60_000),(req,res)=>{
    if (typeof req.body?.password !== 'string' || !equalSecret(req.body.password,adminPassword)) throw fail(401,'控制台密码不正确');
    const sessionToken = token();
    sessions.set(sessionToken, Date.now()+12*60*60_000);
    res.set('Set-Cookie',`launch_admin=${sessionToken}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=43200${req.secure?'; Secure':''}`);
    res.json({authenticated:true});
  });
  app.post('/api/admin/logout',(req,res)=>{
    sessions.delete(cookieToken(req));
    res.set('Set-Cookie','launch_admin=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0');
    res.json({authenticated:false});
  });
  app.use('/api/admin',requireAdmin);
  app.get('/api/admin/info',(_req,res)=>{
    const localUrls=localAddresses(port);
    const base=envPublicUrl || state.settings.publicUrl || localUrls[0] || `http://localhost:${port}`;
    res.json({joinUrl:`${base}/join.html?event=${state.eventId}`,stageUrl:`${base}/stage.html`,adminUrl:`${base}/admin.html`,localUrls});
  });
  app.get('/api/info',(_req,res)=>{
    const base=envPublicUrl || state.settings.publicUrl || localAddresses(port)[0] || `http://localhost:${port}`;
    res.json({joinUrl:`${base}/join.html?event=${state.eventId}`,stageUrl:`${base}/stage.html`});
  });
  app.post('/api/admin/display',(req,res)=>{
    const { stageQrSize, stageQrTop } = req.body || {};
    if (!Number.isInteger(stageQrSize) || stageQrSize < 18 || stageQrSize > 34
      || !Number.isInteger(stageQrTop) || stageQrTop < 38 || stageQrTop > 66) {
      throw fail(400, '二维码大小需为 18–34%，顶部位置需为 38–66%');
    }
    state.settings = { ...state.settings, stageQrSize, stageQrTop };
    commit(); res.json(snapshot());
  });
  app.post('/api/admin/settings',(req,res)=>{
    mustWait();
    const updates = {};
    for (const [key,min,max,label] of [['title',1,40,'活动标题'],['subtitle',0,80,'副标题'],['launchText',1,20,'启动文案']]) {
      if (Object.hasOwn(req.body||{},key)) updates[key]=cleanText(req.body[key],min,max,label);
    }
    if (Object.hasOwn(req.body||{},'theme')) {
      if (!['aurora','gold','crimson'].includes(req.body.theme)) throw fail(400,'未知主题');
      updates.theme=req.body.theme;
    }
    if (Object.hasOwn(req.body||{},'publicUrl')) updates.publicUrl=validPublicUrl(req.body.publicUrl);
    if (Object.hasOwn(req.body||{},'countdownSeconds')) {
      const seconds=Number(req.body.countdownSeconds);
      if (!Number.isInteger(seconds)||seconds<3||seconds>15) throw fail(400,'倒计时需为 3–15 秒');
      updates.countdownSeconds=seconds;
    }
    if (Object.hasOwn(req.body||{},'logoDataUrl')) updates.logoUrl=req.body.logoDataUrl ? saveImage(req.body.logoDataUrl) : '';
    state.settings={...state.settings,...updates};
    commit(); cleanupUploads(); res.json(snapshot());
  });
  app.post('/api/admin/launch',(_req,res)=>{
    mustWait();
    state.phase='countdown'; state.countdownStartedAt=Date.now(); state.launchedAt=null;
    commit(); scheduleLaunch(); res.json(snapshot());
  });
  app.post('/api/admin/reset',(req,res)=>{
    if (typeof req.body?.clearParticipants !== 'boolean') throw fail(400,'请指定是否清空参与者');
    state.phase='waiting'; state.countdownStartedAt=null; state.launchedAt=null;
    if (req.body.clearParticipants) { state.participants=[]; state.eventId=randomUUID(); }
    commit(); clearTimeout(launchTimer); cleanupUploads(); res.json(snapshot());
  });
  app.post('/api/admin/demo',(req,res)=>{
    mustWait();
    const count=Number(req.body?.count ?? 60);
    if (!Number.isInteger(count)||count<1||count>200) throw fail(400,'每次演示人数需为 1–200');
    if(state.participants.length+count>maxParticipants) throw fail(409,'演示人数超过上限');
    for(let i=0;i<count;i++) {
      const id=randomUUID(); const nickname=`演示嘉宾 ${state.participants.length+1}`;
      state.participants.push({id,nickname,avatarUrl:saveInitial(nickname,id),joinedAt:Date.now(),isDemo:true,participantHash:hash(token()).toString('hex')});
    }
    commit(); res.json(snapshot());
  });
  app.delete('/api/admin/participants/:id',(req,res)=>{
    mustWait();
    const index=state.participants.findIndex(p=>p.id===req.params.id);
    if(index<0) throw fail(404,'参与者不存在');
    state.participants.splice(index,1); commit(); cleanupUploads(); res.json(snapshot());
  });
  app.get('/api/qr.svg',async(req,res)=>{
    const text=req.query.text;
    if(typeof text!=='string'||text.length>1500) throw fail(400,'二维码网址过长或无效');
    let url; try {url=new URL(text);} catch {throw fail(400,'二维码必须是完整网址');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password) throw fail(400,'二维码仅支持 http(s) 网址');
    const svg=await QRCode.toString(text,{type:'svg',errorCorrectionLevel:'M',margin:2,width:320});
    res.type('image/svg+xml').send(svg);
  });
  app.use('/uploads',express.static(uploadDir,{dotfiles:'deny',index:false,maxAge:'1d',immutable:true}));
  app.use(express.static(join(ROOT,'public'),{dotfiles:'deny',index:'index.html',maxAge:0}));
  app.use('/api',(_req,res)=>res.status(404).json({error:'接口不存在'}));
  app.use((error,_req,res,_next)=>{
    if(error.type==='entity.too.large') return res.status(413).json({error:'提交内容过大，请压缩图片至 256KB 内'});
    if(error instanceof SyntaxError && error.status===400) return res.status(400).json({error:'请求 JSON 格式错误'});
    if(error.status) return res.status(error.status).json({error:error.message});
    console.error('请求失败:',error.message); res.status(500).json({error:'服务暂时不可用，请联系现场工作人员'});
  });
  const heartbeat=setInterval(()=>{
    for(const client of clients) client.write(`: heartbeat ${Date.now()}\n\n`);
    for(const [key,value] of sessions) if(value<Date.now()) sessions.delete(key);
    for(const [key,value] of attempts) if(value.until<Date.now()) attempts.delete(key);
  },15000);
  heartbeat.unref();
  return {app,adminPassword,generatedPassword,snapshot,close(){
    if(closed)return; closed=true; clearTimeout(launchTimer);clearTimeout(broadcastTimer);clearInterval(heartbeat);
    for(const client of clients)client.end(); clients.clear();
  }};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const instance=createApp();
  const port=Number(process.env.PORT||3000);
  const server=instance.app.listen(port,process.env.HOST||'0.0.0.0',(error)=>{
    if(error)return;
    console.log(`\n启动仪式已运行\n本机入口：http://localhost:${port}\n控制台：http://localhost:${port}/admin.html\n大屏：http://localhost:${port}/stage.html`);
    for(const address of localAddresses(port))console.log(`局域网入口：${address}`);
    if(instance.generatedPassword)console.log(`本次临时控制台密码：${instance.adminPassword}\n请设置 .env 中的 ADMIN_PASSWORD 以固定密码。`);
    else console.log('控制台密码：使用 ADMIN_PASSWORD 配置值');
    console.log('手机必须能访问二维码指向的网址；公网活动请配置 HTTPS 和 PUBLIC_URL。\n');
    process.send?.({type:'ready'});
  });
  server.on('error',error=>{console.error(`启动失败：${error.message}`);instance.close();process.exitCode=1;});
  const shutdown=()=>{instance.close();server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),5000).unref();};
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
