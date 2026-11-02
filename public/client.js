export async function request(path, body, method = 'POST') {
  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    response = await fetch(path, {
      method,
      signal: controller.signal,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('连接中断，请检查网络后重试。');
  } finally { clearTimeout(timeout); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof data.error === 'string' ? data.error : data.message || '操作未完成，请重试。');
    error.status = response.status;
    throw error;
  }
  return data;
}

export function connectState(onState, onConnection) {
  let stopped = false;
  let latestVersion = -1;
  const accept = (state) => {
    if (!state || !Array.isArray(state.participants)) return;
    // SSE messages are ordered, but an initial fetch can resolve after a newer event.
    if (typeof state.version === 'number' && state.version < latestVersion) return;
    latestVersion = state.version ?? latestVersion;
    onState(state);
  };
  const source = new EventSource('/api/events');
  source.addEventListener('state', (event) => {
    try { accept(JSON.parse(event.data)); onConnection(true); } catch { /* Wait for next complete snapshot. */ }
  });
  source.onopen = () => onConnection(true);
  source.onerror = () => onConnection(false);
  const offline = () => onConnection(false);
  const refresh = () => request('/api/state', undefined, 'GET').then((state) => {
    if (!stopped) accept(state);
  }).catch(() => { if (!stopped) onConnection(false); });
  window.addEventListener('offline', offline);
  window.addEventListener('online', refresh);
  refresh();
  return () => {
    stopped = true;
    source.close();
    window.removeEventListener('offline', offline);
    window.removeEventListener('online', refresh);
  };
}

export async function prepareImage(file, { size = 256, transparent = false } = {}) {
  if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片。');
  if (file.size > 10 * 1024 * 1024) throw new Error('原图不能超过 10 MB，请选择较小的图片。');
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('无法读取这张图片，请更换图片。'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    if (transparent) {
      const scale = Math.min(1, size / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    } else {
      canvas.width = canvas.height = size;
      const context = canvas.getContext('2d');
      const crop = Math.min(image.naturalWidth, image.naturalHeight);
      context.drawImage(image, (image.naturalWidth - crop) / 2, (image.naturalHeight - crop) / 2, crop, crop, 0, 0, size, size);
    }
    let result = canvas.toDataURL(transparent ? 'image/png' : 'image/jpeg', 0.85);
    if (result.length * 0.75 > 256 * 1024 && transparent) result = canvas.toDataURL('image/webp', 0.85);
    if (result.length * 0.75 > 256 * 1024) throw new Error('处理后的图片仍然过大，请更换图片。');
    return result;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (!copied) throw new Error('复制失败，请手动选择并复制链接。');
  }
}

export const phaseLabel = (phase) => ({ waiting: '等待伙伴加入', countdown: '启动倒计时', launched: '已正式启动' }[phase] || '同步中');
