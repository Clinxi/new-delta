import { request, prepareImage, phaseLabel } from '/client.js';

const $ = (id) => document.getElementById(id);
let snapshot;
let currentEvent = new URLSearchParams(location.search).get('event');
let saved = currentEvent ? storageRead(currentEvent) : null;
let statusRequest = 0;
let refreshing = false;
let avatarDataUrl;
let editing = false;
let busy = false;
let connected = false;

function storageRead(eventId) {
  try {
    const value = JSON.parse(localStorage.getItem(`ceremony:${eventId}`) || 'null');
    return value?.participant?.id && typeof value.participantToken === 'string' ? value : null;
  } catch { return null; }
}
function storageWrite(eventId, data) {
  try { localStorage.setItem(`ceremony:${eventId}`, JSON.stringify(data)); } catch { /* Joining works even when storage is disabled. */ }
}
function message(text) {
  $('form-message').textContent = text;
  $('form-message').hidden = !text;
}
function avatarPreview(src) {
  if (!src) return;
  const img = document.createElement('img');
  img.alt = '头像预览';
  img.src = src;
  $('avatar-preview').replaceChildren(img);
}
function render() {
  if (!snapshot) return;
  const stale = currentEvent !== snapshot.eventId;
  const mine = !stale && saved && snapshot.participants.find((p) => p.id === saved.participant.id);
  const waiting = snapshot.phase === 'waiting';
  const success = !!mine && (!editing || !waiting);
  $('join-card').hidden = success || !waiting || stale;
  $('success-card').hidden = !success;
  $('closed-card').hidden = success || (waiting && !stale);
  $('event-title').textContent = snapshot.settings.title;
  $('event-subtitle').textContent = snapshot.settings.subtitle;
  $('participant-count').textContent = snapshot.participantCount;
  $('phase-label').textContent = phaseLabel(snapshot.phase);
  $('join-button').disabled = busy || !connected || !waiting || stale;
  $('join-button').firstElementChild.textContent = busy ? '正在加入…' : mine ? '保存我的资料' : '加入启动仪式';
  $('edit-profile').hidden = !waiting;
  if (success) {
    $('success-avatar').src = mine.avatarUrl;
    $('success-name').textContent = mine.nickname;
    $('success-title').textContent = snapshot.phase === 'launched' ? 'DELTA SPACE 正式启动！' : snapshot.phase === 'countdown' ? '共同见证，即将启动' : '已加入，等待共同启动';
    $('success-copy').textContent = snapshot.phase === 'waiting' ? '抬头看看大屏，你的头像正在那里闪耀。' : '请看向大屏，一起见证属于我们的时刻。';
  }
  if (stale) {
    $('closed-title').textContent = '本场次链接已更新';
    $('closed-copy').textContent = '请重新扫描现场大屏上的二维码参与新场次。';
  } else {
    $('closed-title').textContent = snapshot.phase === 'launched' ? 'DELTA SPACE 已正式启动' : '启动仪式正在进行';
    $('closed-copy').textContent = '本轮已结束加入，请看向大屏，共同见证启动时刻。';
  }
  if (saved && !mine && !stale) {
    saved = null;
    editing = false;
    storageWrite(currentEvent, null);
    message('你的参与记录已被移除，可重新填写资料加入。');
  }
}

function setConnection(online) {
  connected = online && navigator.onLine;
  $('connection').classList.toggle('online', connected);
  $('connection').lastElementChild.textContent = connected ? '已连接现场 · 状态同步中' : '连接中断，正在自动重连';
  render();
}
async function refreshStatus(force = false) {
  if (refreshing && !force) return;
  const requestId = ++statusRequest;
  refreshing = true;
  try {
    const participantId = saved?.participant.id;
    let state = await request(`/api/status${participantId ? `?participantId=${encodeURIComponent(participantId)}` : ''}`, undefined, 'GET');
    if (requestId !== statusRequest) return;
    if (!snapshot) {
      currentEvent ||= state.eventId;
      saved ||= storageRead(currentEvent);
      // Direct visits have no event query. Load the stored record before deciding
      // whether the participant was removed, then request only that record.
      if (saved?.participant && participantId !== saved.participant.id) {
        state = await request(`/api/status?participantId=${encodeURIComponent(saved.participant.id)}`, undefined, 'GET');
        if (requestId !== statusRequest) return;
      }
      if (saved?.participant) {
        $('nickname').value = saved.participant.nickname;
        $('consent').checked = true;
        avatarPreview(saved.participant.avatarUrl);
      }
    }
    snapshot = state;
    setConnection(true);
  } catch { if (requestId === statusRequest) setConnection(false); }
  finally { if (requestId === statusRequest) refreshing = false; }
}
refreshStatus();
setInterval(refreshStatus, 2000);
window.addEventListener('online', () => refreshStatus(true));
window.addEventListener('offline', () => setConnection(false));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(true); });

$('avatar-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  busy = true;
  render();
  try {
    avatarDataUrl = await prepareImage(file);
    avatarPreview(avatarDataUrl);
    message('');
  } catch (error) { message(error.message); }
  finally { busy = false; render(); }
});

$('join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !snapshot || !connected) return;
  const nickname = $('nickname').value.trim();
  if (Array.from(nickname).length < 2 || Array.from(nickname).length > 20) return message('昵称需为 2–20 个字符。');
  busy = true;
  render();
  try {
    const result = await request('/api/join', {
      eventId: currentEvent,
      nickname,
      avatarDataUrl,
      consent: $('consent').checked,
      participantToken: saved?.participantToken,
    });
    const alreadyJoined = !!saved;
    ++statusRequest; // Invalidate a status response that began before this join.
    refreshing = false;
    saved = result;
    storageWrite(currentEvent, result);
    editing = false;
    avatarDataUrl = undefined;
    message('');
    // Keep the accepted result visible even if the next network read fails.
    const participants = snapshot.participants.filter((p) => p.id !== result.participant.id);
    participants.push(result.participant);
    snapshot = { ...snapshot, participants, participantCount: snapshot.participantCount + (alreadyJoined ? 0 : 1) };
    render();
    await refreshStatus(true);
  } catch (error) { message(error.message); }
  finally { busy = false; render(); }
});

$('edit-profile').addEventListener('click', () => {
  editing = true;
  const mine = snapshot.participants.find((p) => p.id === saved?.participant.id);
  if (mine) {
    $('nickname').value = mine.nickname;
    avatarPreview(mine.avatarUrl);
  }
  render();
  $('nickname').focus();
});
