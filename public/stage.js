'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const MAX_VISIBLE = 180;
  let state = null, serverOffset = 0, timeAnchor = 0, perfAnchor = 0, nodes = [], lastTick = '', lastVersion = -1;
  let joinBase = '', rotation = 0, lastRotation = performance.now(), source, audio, soundOn = false, previousPhase = null;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const viewport = $('stageViewport');
  let viewW = innerWidth, viewH = innerHeight, toolsTimer, avatarBaseSize = 50;
  function toast(message) { $('notice').textContent = message; $('notice').style.display = 'block'; setTimeout(() => $('notice').style.display = 'none', 4500); }
  function showTools() { document.body.classList.add('tools-visible'); clearTimeout(toolsTimer); toolsTimer = setTimeout(() => document.body.classList.remove('tools-visible'), 2600); }
  document.addEventListener('pointermove', showTools); document.addEventListener('pointerdown', showTools); showTools();
  async function fullscreen() { try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen(); else await document.exitFullscreen(); } catch { toast('请使用浏览器菜单进入全屏'); } }
  $('fullscreen').onclick = fullscreen;
  function tone(freq, duration = .12, volume = .06, delay = 0) {
    if (!soundOn || !audio || audio.state !== 'running') return;
    const osc = audio.createOscillator(), gain = audio.createGain(), start = audio.currentTime + delay;
    osc.type = 'sine'; osc.frequency.setValueAtTime(freq, start); gain.gain.setValueAtTime(.0001, start); gain.gain.exponentialRampToValueAtTime(volume, start + .015); gain.gain.exponentialRampToValueAtTime(.0001, start + duration); osc.connect(gain).connect(audio.destination); osc.start(start); osc.stop(start + duration + .03);
  }
  async function toggleSound() {
    try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); await audio.resume(); soundOn = !soundOn; $('sound').textContent = soundOn ? '关闭声效' : '开启声效'; $('sound').setAttribute('aria-pressed', String(soundOn)); if (soundOn) tone(660); } catch { toast('当前浏览器无法开启声效'); }
  }
  $('sound').onclick = toggleSound;
  document.addEventListener('keydown', e => { if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return; if (e.key.toLowerCase() === 'f') fullscreen(); if (e.key.toLowerCase() === 'm') toggleSound(); showTools(); });
  function serverNow() { return timeAnchor + (performance.now() - perfAnchor); }
  function online(value) { $('connection').textContent = value ? '实时连接' : '连接中断 · 正在重连'; $('connection').className = 'connection ' + (value ? 'online' : 'offline'); }
  async function updateQR() {
    try { const res = await fetch('/api/info'); if (!res.ok) throw Error(); const info = await res.json(); joinBase = info.joinUrl; }
    catch { joinBase = new URL('/join.html', location.origin).href; }
    if (!state) return;
    const url = new URL(joinBase, location.origin); url.searchParams.set('event', state.eventId);
    for (const img of document.querySelectorAll('.join-qr')) img.src = '/api/qr.svg?text=' + encodeURIComponent(url.href);
  }
  function renderAvatars() {
    if (!state) return;
    const participants = state.participants || [];
    const selected = participants.length > MAX_VISIBLE ? Array.from({length:MAX_VISIBLE},(_,i) => participants[(i + rotation) % participants.length]) : participants;
    const old = new Map(nodes.map(n => [n.person.id,n]));
    nodes = selected.map((person, i) => {
      let node = old.get(person.id);
      if (!node) {
        const el = document.createElement('div'), img = document.createElement('img'), name = document.createElement('span');
        el.className = 'avatar'; img.alt = ''; img.decoding = 'async'; name.textContent = person.nickname; el.append(img,name); $('avatars').append(el);
        node = {el,img,name,person,index:i};
      }
      node.person = person; node.index = i; if (node.img.getAttribute('src') !== person.avatarUrl) node.img.src = person.avatarUrl; node.name.textContent = person.nickname; old.delete(person.id); return node;
    });
    for (const node of old.values()) node.el.remove();
    if (nodes.length) avatarBaseSize = parseFloat(getComputedStyle(nodes[0].el).width) || 50;
    $('participantCount').textContent = state.participantCount;
    $('emptyHint').hidden = participants.length > 0;
    $('rotationNote').textContent = participants.length > MAX_VISIBLE ? `此刻 ${MAX_VISIBLE} / ${participants.length} 位伙伴 · 头像轮换中` : '从一个想法，到无限可能';
  }
  function apply(next) {
    if (!next || !Array.isArray(next.participants)) return;
    timeAnchor = next.serverTime; perfAnchor = performance.now(); serverOffset = next.serverTime - Date.now();
    if (state && next.eventId === state.eventId && next.version < lastVersion) return;
    const old = state; state = next; lastVersion = next.version;
    document.body.dataset.theme = state.settings.theme;
    const title = state.settings.title, segments = title.split(/\s*[·｜|]\s*/);
    $('eventTitle').replaceChildren();
    const isDeltaWordmark = title.trim().replace(/\s+/g,' ').toUpperCase() === 'DELTA SPACE';
    $('eventTitle').classList.toggle('has-wordmark', isDeltaWordmark);
    if (isDeltaWordmark) {
      $('eventTitle').append($('wordmarkTemplate').content.cloneNode(true)); $('eventTitle').setAttribute('aria-label',title);
    } else if (segments.length === 2 && segments.every(s => s.length > 0 && [...s].length <= 10)) {
      segments.forEach((part,i) => { if(i) $('eventTitle').append(document.createElement('br')); $('eventTitle').append(document.createTextNode(part)); });
      $('eventTitle').setAttribute('aria-label',title);
    } else { $('eventTitle').textContent = title; $('eventTitle').removeAttribute('aria-label'); }
    document.querySelector('.event-copy').dataset.titleSize = [...title].length > 24 ? 'extended' : [...title].length > 12 ? 'long' : 'normal';
    document.body.dataset.titleSize = document.querySelector('.event-copy').dataset.titleSize;
    $('eventSubtitle').textContent = state.settings.subtitle;
    $('launchText').textContent = state.settings.launchText; $('revealTitle').textContent = state.settings.title;
    document.body.dataset.launchSize = [...state.settings.launchText].length > 8 ? 'long' : 'normal';
    $('revealLogo').hidden = !state.settings.logoUrl; if (state.settings.logoUrl) $('revealLogo').src = state.settings.logoUrl;
    document.title = 'DELTA SPACE · ' + state.settings.title;
    if (!old || old.eventId !== state.eventId || old.settings.publicUrl !== state.settings.publicUrl) updateQR();
    renderAvatars();
    layoutJoinPanel();
  }
  function connect() {
    source = new EventSource('/api/events');
    source.addEventListener('state', e => { try { apply(JSON.parse(e.data)); online(true); } catch { toast('暂时无法读取活动状态'); } });
    source.onopen = () => { online(true); fetchState(); }; source.onerror = () => online(false);
  }
  async function fetchState() { try { const res = await fetch('/api/state', {cache:'no-store'}); if (res.ok) apply(await res.json()); } catch { online(false); } }
  let lastFrame = 0;
  function frame(ts) {
    requestAnimationFrame(frame); if (ts - lastFrame < (reducedMotion ? 120 : 30)) return; lastFrame = ts;
    if (!state) return;
    const now = serverNow(), start = state.countdownStartedAt, end = (start || 0) + state.settings.countdownSeconds * 1000;
    // The timestamp also completes the visual if SSE drops exactly at zero.
    const phase = state.phase === 'countdown' && now >= end ? 'launched' : state.phase;
    const launchedAt = state.launchedAt || end, elapsed = phase === 'launched' ? Math.max(0,(now-launchedAt)/1000) : 0;
    if (previousPhase !== phase) {
      document.body.dataset.phase = phase; $('phaseLabel').textContent = phase === 'waiting' ? 'DELTA COMMUNITY / 共创者集结中' : phase === 'countdown' ? 'READY TO LAUNCH / 共同见证启动' : 'DELTA SPACE / 正式启动';
      $('sceneStep').textContent = phase === 'waiting' ? '01 / 共创者集结' : phase === 'countdown' ? '02 / 共同启动' : '03 / 正式启动';
      if (phase === 'launched' && previousPhase === 'countdown') { $('burst').classList.remove('play'); void $('burst').offsetWidth; $('burst').classList.add('play'); [261.63,329.63,392,523.25,659.25].forEach((n,i)=>tone(n,1.8,.025,i*.18)); }
      if (phase === 'waiting') { $('burst').classList.remove('play'); $('reveal').classList.remove('visible'); lastTick = ''; }
      previousPhase = phase;
    }
    const count = phase === 'countdown' ? String(Math.max(1,Math.ceil((end-now)/1000))) : '';
    if (lastTick !== count) { $('countdown').textContent = count; $('countdown').classList.remove('tick'); void $('countdown').offsetWidth; if(count){ $('countdown').classList.add('tick'); tone(440,.18); } lastTick = count; }
    $('reveal').classList.toggle('visible',phase === 'launched' && elapsed >= 1.1);
    $('joinLabel').textContent = phase === 'waiting' ? '扫码加入，共同启动 DELTA SPACE' : '本轮加入已结束'; $('joinStatus').textContent = phase === 'waiting' ? '上传头像 · 留下名字 · 见证启动' : '请与我们，共同见证启动时刻';
    const t = reducedMotion ? 0 : ts*.000035, radius = Math.min(viewW*.20,viewH*.22), width = viewW < 800 ? viewW*.35 : viewW*.205, height = viewW < 800 ? Math.min(viewH*.14,viewW*.26) : Math.min(viewH*.18,viewW*.14);
    const progress = phase === 'countdown' ? Math.max(0,Math.min(1,(now-start)/(end-start))) : phase === 'launched' ? 1 : 0;
    for (const node of nodes) {
      const i = node.index, n = nodes.length, phi = Math.acos(1-2*(i+.5)/Math.max(1,n)), theta = i*2.399963 + t;
      const sx = radius*Math.sin(phi)*Math.cos(theta), sy = radius*Math.cos(phi), sz = radius*Math.sin(phi)*Math.sin(theta);
      const columns = Math.max(1, Math.ceil(Math.sqrt(n*1.65))), rows = Math.ceil(n/columns), row = Math.floor(i/columns), col = i%columns;
      const drift = n>100 ? 1 : 3;
      const fx = columns===1 ? 0 : (col-(columns-1)/2)/(columns-1)*width*2 + Math.sin(i*1.7+t)*drift;
      const fy = rows===1 ? 0 : (row-(rows-1)/2)/(rows-1)*height*2 + Math.cos(i*.8+t)*drift;
      let x = fx*(1-progress)+sx*progress, y = fy*(1-progress)+sy*progress, z = (Math.sin(i*.7+t)*65)*(1-progress)+sz*progress;
      let opacity = .84 + .16*(z+radius)/(2*radius), scale = (.76+.30*(z+radius)/(2*radius)) * (n>100 ? .72 : n>60 ? .88 : 1);
      const spacing = Math.min(columns>1 ? width*2/(columns-1) : Infinity, rows>1 ? height*2/(rows-1) : Infinity);
      const matrixCap = Math.max(.25,Math.min(1,(spacing-drift*2-3)/avatarBaseSize));
      scale = Math.min(scale,matrixCap*(1-progress)+progress);
      if (phase === 'launched') { const p = Math.min(1,elapsed/1.2); x*=1-p; y*=1-p; scale*=1-p*.8; opacity*=1-p; }
      node.el.style.transform = `translate(-50%,-50%) translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) scale(${scale.toFixed(3)})`;
      node.el.style.opacity = opacity.toFixed(2); node.el.style.zIndex = String(Math.round(z+radius)); node.name.style.display = n>20 || phase!=='waiting' ? 'none' : '';
    }
    if (phase === 'waiting' && state.participantCount > MAX_VISIBLE && ts-lastRotation > 12000) { rotation=(rotation+60)%state.participantCount; lastRotation=ts; renderAvatars(); }
  }
  const canvas = $('stars'), ctx = canvas.getContext('2d'); let stars=[];
  function layoutJoinPanel() {
    if (!state || innerWidth <= 800) return;
    const panel = document.querySelector('.join-panel');
    const copy = document.querySelector('.event-copy');
    const footer = document.querySelector('.stage-footer');
    const size = state.settings.stageQrSize ?? 26;
    viewport.style.setProperty('--stage-qr-size', size);
    // Keep the enlarged square and its copy clear of the title and screen edge.
    const minTop = copy.offsetTop + copy.offsetHeight + 24;
    const maxBottom = footer.offsetTop - 28;
    const maxSize = Math.max(100, maxBottom - minTop - 34);
    viewport.style.setProperty('--stage-qr-size', Math.min(size, maxSize / viewH * 100));
    const maxTop = Math.max(minTop, maxBottom - panel.offsetHeight);
    panel.style.top = Math.max(minTop, Math.min(maxTop, viewH * (state.settings.stageQrTop ?? 54) / 100)) + 'px';
  }
  function resize() {
    const mobile = innerWidth <= 800;
    // Use one design coordinate system for CSS, avatars and animation. Every
    // element scales together when the window moves to a different display.
    viewW = mobile ? innerWidth : 1920;
    viewH = mobile ? innerHeight : Math.max(800, Math.min(1440, viewW * innerHeight / innerWidth));
    const scale = Math.min(innerWidth / viewW, innerHeight / viewH);
    viewport.style.width = viewW + 'px'; viewport.style.height = viewH + 'px';
    viewport.style.setProperty('--stage-scale', scale);
    if (mobile) document.querySelector('.join-panel').style.removeProperty('top');
    layoutJoinPanel();
    if(nodes.length) avatarBaseSize=parseFloat(getComputedStyle(nodes[0].el).width)||50;
    const ratio=Math.min((devicePixelRatio||1)*scale,2);
    canvas.width=viewW*ratio; canvas.height=viewH*ratio; ctx.setTransform(ratio,0,0,ratio,0,0);
    stars=Array.from({length:45},()=>({x:Math.random()*viewW,y:Math.random()*viewH,r:Math.random()*1.4+.4,p:Math.random()*6.28}));
  }
  let starFrame=0; function drawStars(ts) {requestAnimationFrame(drawStars);if(ts-starFrame<100)return;starFrame=ts;ctx.clearRect(0,0,viewW,viewH);ctx.fillStyle='#bfdcff';for(const s of stars){ctx.globalAlpha=.10+(.5+.5*Math.sin(s.p+(reducedMotion?0:ts*.00025)))*.13;ctx.beginPath();ctx.arc(s.x,s.y,s.r*.6,0,Math.PI*2);ctx.fill();}ctx.globalAlpha=1;}
  addEventListener('resize',resize); resize(); requestAnimationFrame(drawStars); requestAnimationFrame(frame);
  setInterval(()=>{$('clock').textContent=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(Date.now()+serverOffset);},1000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)fetchState();}); setInterval(fetchState,30000); fetchState(); connect();
})();
