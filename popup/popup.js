/**
 * 面板脚本：读取当前标签页的视频状态，把点击结果写回页面。
 *
 * 与页面统一走 chrome.tabs.sendMessage（带 __vsc 标记），不再各自 executeScript：
 * 消息会被广播到标签页里的所有 frame，谁真的有视频谁处理，iframe 里的播放器也能控。
 * 页面里没有内容脚本时（例如扩展刚重载完，标签页是旧的）补注入一次，不必手动刷新。
 */

const MSG = { __vsc: true };
const DIGITS_KEY = 'vsc:digits';

let tabId = null;

const $ = id => document.getElementById(id);

async function send(type, extra) {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, { ...MSG, type, ...extra });
  } catch {
    // 没有接收方时 Chrome 会 reject，这里等价于「页面没响应」
    return null;
  }
}

/** 补注入内容脚本；浏览器内部页面、应用商店等不允许注入的位置会失败 */
async function injectInto(id) {
  const tab = await chrome.tabs.get(id);
  if (!/^(https?|file):/i.test(tab.url || '')) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: id, allFrames: true },
      files: ['content/content.js'],
    });
  } catch {
    return false;
  }
  return true;
}

/**
 * 渲染当前倍速
 * @param {number|undefined} rate 页面回报的倍速，undefined 表示页面里没有视频
 */
function renderRate(rate) {
  const hasRate = typeof rate === 'number' && Number.isFinite(rate);
  const pill = $('speed');
  pill.textContent = hasRate ? `${Math.round(rate * 100) / 100}x` : '未检测到视频';
  pill.classList.toggle('muted', !hasRate);

  // 浮点直接比会失配（1.2000000000000002 !== 1.2），留一点容差
  for (const button of document.querySelectorAll('button[data-rate]')) {
    button.classList.toggle(
      'active',
      hasRate && Math.abs(Number(button.dataset.rate) - rate) < 0.005,
    );
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.local.get(DIGITS_KEY);
  const digitToggle = $('digits');
  digitToggle.checked = stored[DIGITS_KEY] !== false;
  digitToggle.addEventListener('change', () => {
    chrome.storage.local.set({ [DIGITS_KEY]: digitToggle.checked });
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  tabId = tab.id;

  let alive = await send('ping');
  if (!alive && (await injectInto(tabId))) alive = await send('ping');

  if (!alive) {
    $('speed').textContent = '此页面不可用';
    $('speed').classList.add('muted');
    document.body.classList.add('disabled');
    return;
  }

  const state = await send('get');
  renderRate(state && state.rate);

  for (const button of document.querySelectorAll('button[data-rate]')) {
    button.addEventListener('click', async () => {
      const result = await send('set', { rate: Number(button.dataset.rate) });
      renderRate(result && result.rate);
    });
  }
});
