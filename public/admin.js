import { request, connectState, prepareImage, copyText, phaseLabel } from '/client.js';

const $ = (id) => document.getElementById(id);
let state;
let info;
let authenticated = false;
let formInitialized = false;
let formDirty = false;
let pendingLogo;
let busy = false;
let serverOffset = 0;
let toastTimer;
let previousEvent;
let displayDraft = null, displaySaving = false, displayTimer;
const isDemoGuest = (person) => person.isDemo === true;
const settingsInputs = ['title', 'subtitle', 'launch-text', 'countdown-seconds', 'theme', 'public-url'];

function toast(text, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = text;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 7000 : 4000);
}
function setAuthenticated(value) {
  authenticated = value;
  $('login-view').hidden = value;
  $('console-view').hidden = !value;
  if (!value) {
    $('password').value = '';
    $('password').focus();
    formInitialized = false;
  }
}
async function perform(callback, success) {
  if (busy) return;
  busy = true;
  renderButtons();
  try {
    await callback();
    if (success) toast(success);
    return true;
  } catch (error) {
    if (error.status === 401) {
      setAuthenticated(false);
      $('login-error').textContent = '登录已过期，请重新输入主持口令。';
      $('login-error').hidden = false;
    } else toast(error.message, true);
    return false;
  } finally { busy = false; renderButtons(); }
}
function renderButtons() {
  const waiting = state?.phase === 'waiting';
  for (const id of ['launch-button', 'demo-button']) $(id).disabled = busy || !waiting;
  for (const id of ['reset-button', 'clear-button', 'save-button', 'logout-button']) $(id).disabled = busy;
  // Settings are frozen during a running countdown to keep the ceremony predictable.
  $('save-button').disabled ||= !waiting;
}
function showLogo(src) {
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = '活动 Logo';
    $('logo-preview').replaceChildren(img);
  } else $('logo-preview').textContent = '✦';
}
function fillSettings() {
  if (!state) return;
  const s = state.settings;
  $('title').value = s.title;
  $('subtitle').value = s.subtitle;
  $('launch-text').value = s.launchText;
  $('countdown-seconds').value = s.countdownSeconds;
  $('theme').value = s.theme;
  $('public-url').value = s.publicUrl || '';
  showLogo(s.logoUrl);
  pendingLogo = undefined;
  formInitialized = true;
  formDirty = false;
  $('save-state').textContent = '已与现场同步';
}
function renderDisplay() {
  if (!state) return;
  const values = displayDraft || state.settings;
  $('stage-qr-size').value = values.stageQrSize ?? 26;
  $('stage-qr-top').value = values.stageQrTop ?? 54;
  $('stage-qr-size-value').value = $('stage-qr-size').value + '%';
  $('stage-qr-top-value').value = $('stage-qr-top').value + '%';
}
async function saveDisplay() {
  if (!displayDraft || displaySaving || !authenticated) return;
  const submitted = displayDraft;
  displaySaving = true;
  $('display-save-state').textContent = '正在同步到大屏…';
  $('display-retry').hidden = true;
  try {
    const next = await request('/api/admin/display', submitted);
    if (!state || next.version >= state.version) state = next;
    if (displayDraft === submitted) {
      displayDraft = null;
      $('display-save-state').textContent = '已与大屏同步';
      renderDisplay();
    }
  } catch (error) {
    if (error.status === 401) setAuthenticated(false);
    $('display-save-state').textContent = '同步失败，请重试';
    $('display-retry').hidden = false;
    toast(error.message, true);
  } finally {
    displaySaving = false;
    if (displayDraft && displayDraft !== submitted) saveDisplay();
  }
}
function queueDisplay() {
  displayDraft = { stageQrSize: Number($('stage-qr-size').value), stageQrTop: Number($('stage-qr-top').value) };
  renderDisplay();
  $('display-save-state').textContent = '等待同步…';
  clearTimeout(displayTimer);
  displayTimer = setTimeout(saveDisplay, 200);
}
for (const id of ['stage-qr-size', 'stage-qr-top']) $(id).addEventListener('input', queueDisplay);
$('display-reset').addEventListener('click', () => {
  $('stage-qr-size').value = 26; $('stage-qr-top').value = 54; queueDisplay();
});
$('display-retry').addEventListener('click', saveDisplay);
async function refreshInfo() {
  if (!authenticated) return;
  try {
    info = await request('/api/admin/info', undefined, 'GET');
    $('join-url').value = info.joinUrl;
    $('join-qr').src = `/api/qr.svg?text=${encodeURIComponent(info.joinUrl)}`;
    $('open-stage').href = info.stageUrl || '/stage.html';
    $('service-address').textContent = new URL(info.joinUrl).origin;
  } catch (error) { if (error.status === 401) setAuthenticated(false); else toast(error.message, true); }
}
function renderPhase() {
  if (!state) return;
  let label = phaseLabel(state.phase);
  if (state.phase === 'countdown') {
    const left = Math.max(0, Math.ceil((state.countdownStartedAt + state.settings.countdownSeconds * 1000 - Date.now() - serverOffset) / 1000));
    label = left > 0 ? `启动倒计时 ${left}` : '正在揭幕';
  }
  $('ceremony-phase').textContent = label;
  $('launch-status').textContent = phaseLabel(state.phase);
  $('phase-detail').textContent = state.phase === 'waiting' ? '手机端开放加入中' : state.phase === 'countdown' ? '已暂停接收新嘉宾' : '复位后可再次启动';
  $('launch-button').firstChild.textContent = state.phase === 'launched' ? '本轮已正式启动 ' : state.phase === 'countdown' ? '倒计时进行中… ' : '开始启动倒计时 ';
}
function renderGuests() {
  if (!state) return;
  const keyword = $('search-guests').value.trim().toLocaleLowerCase();
  const demoCount = state.participants.filter(isDemoGuest).length;
  $('guest-summary').textContent = `真实嘉宾 ${state.participantCount - demoCount} · 演示嘉宾 ${demoCount}`;
  $('list-count').textContent = state.participantCount;
  const matches = state.participants.filter((person) => person.nickname.toLocaleLowerCase().includes(keyword));
  const displayed = matches.slice(-120).reverse();
  const fragment = document.createDocumentFragment();
  for (const person of displayed) {
    const card = document.createElement('div');
    card.className = 'guest';
    const image = document.createElement('img');
    image.src = person.avatarUrl;
    image.alt = '';
    image.loading = 'lazy';
    const detail = document.createElement('div');
    detail.className = 'guest-info';
    const name = document.createElement('strong');
    name.textContent = person.nickname;
    name.title = person.nickname;
    const meta = document.createElement('small');
    const isDemo = isDemoGuest(person);
    meta.textContent = isDemo ? '演示嘉宾 · 彩排数据' : '现场嘉宾';
    meta.classList.toggle('demo', isDemo);
    detail.append(name, meta);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.disabled = busy || state.phase !== 'waiting';
    remove.textContent = '×';
    remove.title = `移除 ${person.nickname}`;
    remove.setAttribute('aria-label', `移除 ${person.nickname}`);
    remove.addEventListener('click', async () => {
      if (await confirmAction('移除这位嘉宾？', `将从活动大屏中移除“${person.nickname}”。`, '确认移除')) {
        await perform(() => request(`/api/admin/participants/${encodeURIComponent(person.id)}`, undefined, 'DELETE'), '嘉宾已移除');
      }
    });
    card.append(image, detail, remove);
    fragment.append(card);
  }
  $('guest-list').replaceChildren(fragment);
  $('empty-state').hidden = displayed.length > 0;
  $('empty-state').textContent = keyword ? '没有找到匹配的嘉宾。' : '让嘉宾扫描二维码，第一份力量即将汇聚。';
  $('list-note').textContent = matches.length > 120 ? `共 ${matches.length} 位匹配嘉宾，当前显示最近加入的 120 位。可通过昵称搜索。` : '';
}
function render() {
  if (!state || !authenticated) return;
  $('guest-count').textContent = state.participantCount;
  $('capacity').textContent = state.maxParticipants;
  $('duration').textContent = state.settings.countdownSeconds;
  $('preview-title').textContent = state.settings.title;
  $('preview-subtitle').textContent = state.settings.subtitle;
  renderDisplay();
  if (!formInitialized || (!formDirty && !document.activeElement?.closest('#settings-form'))) fillSettings();
  renderPhase();
  renderButtons();
  renderGuests();
}
function confirmAction(title, copy, button) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-copy').textContent = copy;
  $('confirm-ok').textContent = button;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}

connectState((snapshot) => {
  serverOffset = snapshot.serverTime - Date.now();
  state = snapshot;
  if (previousEvent && previousEvent !== state.eventId) refreshInfo();
  previousEvent = state.eventId;
  render();
}, (online) => {
  const connected = online && navigator.onLine;
  $('connection-dot').classList.toggle('online', connected);
  $('connection-label').textContent = connected ? '现场实时连接中' : '正在重新连接';
});
setInterval(renderPhase, 250);

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-button').disabled = true;
  $('login-error').hidden = true;
  try {
    await request('/api/admin/login', { password: $('password').value });
    setAuthenticated(true);
    $('password').value = '';
    render();
    await refreshInfo();
  } catch (error) {
    $('login-error').textContent = error.message;
    $('login-error').hidden = false;
  } finally { $('login-button').disabled = false; }
});
$('logout-button').addEventListener('click', async () => {
  if (await perform(() => request('/api/admin/logout', {}))) setAuthenticated(false);
});
$('copy-join').addEventListener('click', async () => {
  if (!info) return;
  try { await copyText(info.joinUrl); toast('参与链接已复制'); } catch (error) { toast(error.message, true); }
});
$('open-stage').addEventListener('click', (event) => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const stage = window.open($('open-stage').href, 'launch-stage', 'popup=yes,width=1440,height=900');
  if (stage) { stage.opener = null; event.preventDefault(); }
});
$('launch-button').addEventListener('click', async () => {
  if (!state || state.phase !== 'waiting') return;
  const demos = state.participants.filter(isDemoGuest).length;
  const detail = `当前共有 ${state.participantCount} 位嘉宾${demos ? `，其中 ${demos} 位为演示嘉宾` : ''}。\n确认后立即进入 ${state.settings.countdownSeconds} 秒倒计时，手机端将暂停接收新嘉宾。`;
  if (await confirmAction('开启这一刻？', detail, '开始启动')) await perform(() => request('/api/admin/launch', {}), '倒计时已开始，请看向大屏');
});
$('reset-button').addEventListener('click', async () => {
  if (await confirmAction('复位本轮仪式？', '将停止当前动画并回到等待状态，已加入的嘉宾继续保留，手机端重新开放加入。', '确认复位')) await perform(() => request('/api/admin/reset', { clearParticipants: false }), '已复位，嘉宾已保留');
});
$('clear-button').addEventListener('click', async () => {
  if (await confirmAction('清空并新建场次？', '当前全部嘉宾和演示数据将被清空，参与链接与二维码会更新。请确保已保存所需资料，并让新场次嘉宾扫描新二维码。', '清空并新建')) await perform(async () => { await request('/api/admin/reset', { clearParticipants: true }); await refreshInfo(); }, '新场次已准备好，二维码已更新');
});
$('demo-button').addEventListener('click', async () => {
  await perform(() => request('/api/admin/demo', { count: 60 }), '已加入演示嘉宾，正式活动前请清空并新建场次');
});
function markDirty() {
  formDirty = true;
  $('save-state').textContent = '有未保存的修改';
}
settingsInputs.forEach((id) => $(id).addEventListener('input', markDirty));
$('logo-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  await perform(async () => {
    pendingLogo = await prepareImage(file, { size: 480, transparent: true });
    showLogo(pendingLogo);
    markDirty();
  });
});
$('remove-logo').addEventListener('click', () => { pendingLogo = ''; showLogo(''); markDirty(); });
$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await perform(async () => {
    await request('/api/admin/settings', {
      title: $('title').value.trim(), subtitle: $('subtitle').value.trim(), launchText: $('launch-text').value.trim(),
      countdownSeconds: Number($('countdown-seconds').value), theme: $('theme').value, publicUrl: $('public-url').value.trim(),
      ...(pendingLogo === undefined ? {} : { logoDataUrl: pendingLogo }),
    });
    state = await request('/api/state', undefined, 'GET');
    fillSettings();
    render();
    await refreshInfo();
  }, '活动配置已同步到大屏');
});
$('search-guests').addEventListener('input', renderGuests);
window.addEventListener('beforeunload', (event) => {
  if (authenticated && (formDirty || displayDraft)) { event.preventDefault(); event.returnValue = ''; }
});

try {
  const session = await request('/api/admin/session', undefined, 'GET');
  setAuthenticated(!!session.authenticated);
  if (authenticated) { render(); await refreshInfo(); }
} catch { setAuthenticated(false); }
