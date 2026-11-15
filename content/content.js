/**
 * 内容脚本：页面里所有与视频倍速有关的逻辑集中在这里。
 *
 * 贯穿全局的几条约定：
 * - 不缓存 video 引用，每次操作时重新查找。SPA 换页、播放器重建都不需要额外处理。
 * - 只挂 window 捕获阶段的 keydown，且只在真的要接管时才 preventDefault / stopPropagation，
 *   站点已经处理过（defaultPrevented）的按键一律让位，不跟站点抢键。
 * - 倍速偏好按 hostname 存在 chrome.storage.local，视频重新加载时自动套用。
 * - 本帧没有视频时，把按键意图 postMessage 给父子 frame，覆盖「播放器在 iframe 里」的情况。
 */
(() => {
  // 扩展被重新加载后 popup 会补注入一次，避免重复绑定事件
  if (window.__vscLoaded) return;
  window.__vscLoaded = true;

  /** 倍速下限 / 上限 / 单次步进 */
  const MIN = 0.1;
  const MAX = 16;
  const STEP = 0.1;
  /** 数字键多位输入的等待时间（ms） */
  const DIGIT_DELAY = 800;
  /** 视频列表缓存时长（ms）：按住 C 连发时不必每次都遍历 DOM */
  const SCAN_TTL = 500;

  const clamp = n => Math.min(MAX, Math.max(MIN, n));
  /** 抹掉浮点累积误差（1.2 + 0.1 = 1.3000000000000003） */
  const tidy = n => Math.round(n * 1000) / 1000;
  const fmt = n => `${Math.round(n * 100) / 100}x`;

  /* ------------------------------ 偏好存储 ------------------------------ */

  const RATE_KEY = `vsc:rate:${location.hostname}`;
  const DIGITS_KEY = 'vsc:digits';

  /** 本页记住的倍速，null 表示没记住过 */
  let savedRate = null;
  /** 数字键是否直接设速（关闭后改成 Alt + 数字） */
  let digitsOn = true;

  // 读档放在 initPrefs 里、由 IIFE 末尾统一调用：回调里会用到下面才声明的函数与状态
  function initPrefs() {
    chrome.storage.local.get([RATE_KEY, DIGITS_KEY], res => {
      const rate = res[RATE_KEY];
      if (typeof rate === 'number' && rate > 0) {
        savedRate = clamp(rate);
        // 扩展刚装好 / 刚重载时，页面里的视频早已加载完，补一次
        const video = pick();
        if (video) applyRate(video, savedRate, false);
      }
      digitsOn = res[DIGITS_KEY] !== false;
    });

    // 在面板里切换开关后，已打开的页面立即生效
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && DIGITS_KEY in changes) {
        digitsOn = changes[DIGITS_KEY].newValue !== false;
      }
    });
  }

  function remember(rate) {
    savedRate = rate;
    chrome.storage.local.set({ [RATE_KEY]: rate });
  }

  /* ------------------------------ 视频发现 ------------------------------ */

  let scanCache = { at: 0, list: [] };

  function collectVideos(root, out) {
    for (const video of root.querySelectorAll('video')) out.push(video);
    // 播放器可能被包在 shadow DOM 里，这里穿一层；querySelectorAll 本身不跨 shadow 边界
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) collectVideos(el.shadowRoot, out);
    }
  }

  /** 收集本帧所有视频（含 shadow DOM）。结果为空时不缓存，保证新插入的视频能立刻被找到 */
  function findVideos() {
    if (scanCache.list.length && performance.now() - scanCache.at < SCAN_TTL) {
      return scanCache.list;
    }
    const list = [];
    collectVideos(document, list);
    scanCache = { at: performance.now(), list };
    return list;
  }

  /**
   * 挑出用户最可能在看的那个视频：全屏中的 > 正在播放的 > 可见面积最大的。
   * 比「第一个 video」可靠 —— 页面上常驻的广告 / 预览小窗不会再把主播放器顶掉。
   */
  function pick() {
    const list = findVideos();
    if (!list.length) return null;

    const fullscreenEl = document.fullscreenElement;
    let best = null;
    let bestScore = -1;
    for (const video of list) {
      const rect = video.getBoundingClientRect();
      // 量级要拉开：4K 面积也才 8.3e6，所以「正在播放」必须比面积权重高一档
      const score =
        (fullscreenEl && fullscreenEl.contains(video) ? 1e9 : 0) +
        (video.paused ? 0 : 1e8) +
        Math.max(0, rect.width * rect.height);
      if (score > bestScore) {
        bestScore = score;
        best = video;
      }
    }
    return best;
  }

  /**
   * 写入倍速
   * @param {HTMLVideoElement} video 目标视频
   * @param {number} rate 目标倍速，越界会被夹到 0.1 ~ 16
   * @param {boolean} notify 是否弹提示并写入存储；初始化补写时传 false
   */
  function applyRate(video, rate, notify = true) {
    const target = clamp(tidy(rate));
    try {
      video.playbackRate = target;
    } catch {
      // 少数播放器把 playbackRate 定义成只读或会抛异常，忽略即可
      return;
    }
    if (!notify) return;
    toast(fmt(video.playbackRate));
    remember(target);
  }

  /* ------------------------------ 提示浮层 ------------------------------ */

  let toastHost = null;
  let toastBox = null;
  let hideTimer = 0;

  /**
   * 显示倍速提示
   * @param {string} text 文案
   * @param {number} duration 自动消失时间（ms），0 表示等后续操作再收起
   *
   * 放在 shadow DOM 里，站点样式穿不进来；每次显示前重新挂到当前全屏元素下，
   * 全屏播放时也能看到。
   */
  function toast(text, duration = 1200) {
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.id = '__vsc_toast';
      // all:initial 先清掉站点可能命中的继承样式，后面的定位才会稳定生效
      toastHost.style.cssText =
        'all:initial;position:fixed!important;top:16px;left:16px;z-index:2147483647;pointer-events:none;';
      const root = toastHost.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
        .box{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
          font-size:13px;font-weight:600;line-height:1;color:#fff;white-space:nowrap;
          background:rgba(17,17,19,.86);border:1px solid rgba(255,255,255,.14);border-radius:8px;
          padding:8px 10px;box-shadow:0 6px 20px rgba(0,0,0,.28);
          -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);
          opacity:0;transform:translateY(-4px);transition:opacity .16s ease,transform .16s ease}
        .box.on{opacity:1;transform:none}
      </style><div class="box"></div>`;
      toastBox = root.querySelector('.box');
    }

    // <video> 自身全屏时子节点不渲染，退回 documentElement，避免往 video 里塞无意义的 DOM
    const fsEl = document.fullscreenElement;
    const parent = fsEl && fsEl.tagName !== 'VIDEO' ? fsEl : document.documentElement;
    if (toastHost.parentNode !== parent) parent.appendChild(toastHost);

    toastBox.textContent = text;
    toastBox.classList.add('on');
    clearTimeout(hideTimer);
    if (duration > 0) {
      hideTimer = setTimeout(() => toastBox.classList.remove('on'), duration);
    }
  }

  /* ------------------------------ 快捷键 ------------------------------ */

  let digitBuffer = '';
  let digitTimer = 0;

  const TEXT_INPUT_TYPES =
    /^(?:text|search|email|url|tel|password|number|date|datetime-local|month|week|time)$/;

  /**
   * 焦点是否在可输入元素里。
   * 走 composedPath 而不是只看 e.target，这样 shadow DOM 里的编辑器也能识别。
   */
  function isTyping(e) {
    if (document.designMode === 'on') return true;
    for (const node of e.composedPath()) {
      if (node.nodeType !== 1) continue;
      const tag = node.tagName;
      if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (tag === 'INPUT') return TEXT_INPUT_TYPES.test((node.type || 'text').toLowerCase());
      if (node.isContentEditable) return true;
    }
    return false;
  }

  /**
   * 把按键翻译成动作，返回 null 表示这个键不归我们管。
   * 数字键用 e.code 识别：macOS 上 Option+数字 的 e.key 是 ¡™£ 之类的符号，只有 code 稳定。
   */
  function resolveAction(e) {
    if (!e.shiftKey) {
      const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code || '');
      if (digit) {
        // digitsOn 时裸按生效、Alt+数字 让位；关闭后反过来，把 0-9 还给站点
        const allowed = digitsOn ? !e.altKey : e.altKey;
        return allowed ? { kind: 'digit', value: Number(digit[1]) } : null;
      }
    }
    if (e.altKey) return null;
    if (e.key === 'Enter' && digitBuffer) return { kind: 'commit' };

    switch (e.key.length === 1 ? e.key.toLowerCase() : '') {
      case 'z':
        return { kind: 'step', delta: -STEP };
      case 'c':
        return { kind: 'step', delta: STEP };
      case 'x':
        return { kind: 'reset' };
      default:
        return null;
    }
  }

  function clearDigits() {
    if (!digitBuffer) return;
    clearTimeout(digitTimer);
    digitBuffer = '';
    toastBox.classList.remove('on');
  }

  function commitDigits() {
    clearTimeout(digitTimer);
    const value = parseInt(digitBuffer, 10);
    digitBuffer = '';
    // 输入的是 0：沿用「取消」语义，把停留住的预览换成会自动消失的提示
    if (!value) {
      toast('取消', 900);
      return;
    }
    const video = pick();
    if (video) applyRate(video, value);
  }

  /**
   * 执行动作
   * @returns {boolean} 本帧是否接管了这次按键；false 表示已转发出去，不该拦事件
   */
  function perform(action) {
    const video = pick();
    if (!video) {
      relay(action);
      return false;
    }

    if (action.kind === 'digit') {
      digitBuffer += action.value;
      const value = parseInt(digitBuffer, 10);
      // duration=0：等用户继续输入，不自动消失；实时显示夹紧后的结果，避免「15」到底是 1.5 还是 15 的歧义
      toast(value > 0 ? fmt(clamp(value)) : '取消', 0);
      clearTimeout(digitTimer);
      digitTimer = setTimeout(commitDigits, DIGIT_DELAY);
      return true;
    }
    if (action.kind === 'commit') {
      commitDigits();
      return true;
    }

    const base = tidy(video.playbackRate);
    applyRate(video, action.kind === 'reset' ? 1 : base + action.delta);
    return true;
  }

  function onKeyDown(e) {
    // 站点已经 preventDefault 的键让位；输入法组合中、带 Cmd/Ctrl 的组合一律不管
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    if (e.ctrlKey || e.metaKey) return;

    const action = resolveAction(e);
    if (!action) {
      clearDigits();
      return;
    }
    if (isTyping(e)) return;

    if (perform(action)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  window.addEventListener('keydown', onKeyDown, true);

  /* ------------------------- 跨 frame 转发按键 ------------------------- */

  const RELAY = '__vscRelay';

  /**
   * 本帧没有视频时，把动作转发给父子 frame。
   * 只转发不二次转发（收到消息的帧只做本地应用），因此不会形成回环。
   */
  function relay(action) {
    const message = { [RELAY]: true, action };
    for (const frame of document.querySelectorAll('iframe, frame')) {
      try {
        frame.contentWindow.postMessage(message, '*');
      } catch {
        // 跨域访问 contentWindow 可能抛错，忽略
      }
    }
    if (window.parent !== window) {
      try {
        window.parent.postMessage(message, '*');
      } catch {}
    }
  }

  window.addEventListener('message', e => {
    const data = e.data;
    if (!data || data[RELAY] !== true || !data.action) return;
    const video = pick();
    if (video) perform(data.action);
  });

  /* --------------------------- 新视频自动套用 --------------------------- */

  // media 事件不冒泡，但捕获阶段仍然经过 document，可以借此覆盖所有（含后插入的）video。
  // 只在「元数据加载完成」时套用：既覆盖刷新 / 换站点 / SPA 换视频，又不会和站点自带的倍速选择器互相打架。
  document.addEventListener(
    'loadedmetadata',
    e => {
      const video = e.target;
      if (!savedRate || !video || video.tagName !== 'VIDEO') return;
      if (Math.abs(video.playbackRate - savedRate) < 0.01) return;
      try {
        video.playbackRate = savedRate;
      } catch {}
    },
    true,
  );

  /* ------------------------------ 面板通信 ------------------------------ */
  // 只有真正持有视频的帧才回应 get / set，避免「某个空 frame 先应答」把面板显示成「未检测到视频」

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (!msg || msg.__vsc !== true) return false;

    if (msg.type === 'ping') {
      respond({ ok: true });
      return false;
    }

    const video = pick();
    if (!video) return false;

    if (msg.type === 'get') {
      respond({ ok: true, rate: tidy(video.playbackRate) });
    } else if (msg.type === 'set') {
      applyRate(video, msg.rate);
      respond({ ok: true, rate: tidy(video.playbackRate) });
    }
    return false;
  });

  initPrefs();
})();
