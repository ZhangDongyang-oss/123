(function () {
  if (document.body.dataset.loginGate === 'off') return;

  var nextUrl = new URLSearchParams(window.location.search).get('next') || '';
  var CACHE_KEY = 'fc_account_cache';
  var CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  function getCachedAccount() {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var cached = JSON.parse(raw);
      if (!cached || !cached.ts || (Date.now() - cached.ts) > CACHE_TTL_MS) {
        sessionStorage.removeItem(CACHE_KEY);
        return null;
      }
      return cached.info;
    } catch (e) {
      return null;
    }
  }

  function setCachedAccount(info) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), info: info }));
    } catch (e) { /* quota exceeded — ignore */ }
  }

  function clearCachedAccount() {
    try { sessionStorage.removeItem(CACHE_KEY); } catch (e) {}
  }

  function syncAccountName(info) {
    var el = document.getElementById('account-name');
    if (!el || !info) return;
    el.textContent = info.display_name || info.username || '账号';
  }

  function ensureLogoutButton(info) {
    if (!info || !info.logged_in) return;
    if (document.getElementById('logout-btn')) return;
    var meta = document.querySelector('.topbar-meta');
    if (!meta) return;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'logout-btn';
    btn.className = 'tab logout-tab';
    btn.innerHTML = [
      '<svg class="icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">',
      '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',
      '<path d="M16 17l5-5-5-5"/>',
      '<path d="M21 12H9"/>',
      '</svg>',
      '<span>退出</span>'
    ].join('');
    btn.addEventListener('click', function () {
      if (!confirm('确认退出当前 VIIM 账号？')) return;
      btn.disabled = true;
      clearCachedAccount();
      fetch('/api/clear-token', { method: 'POST' })
        .then(function () { location.href = '/account'; })
        .catch(function () { location.href = '/account'; });
    });
    meta.appendChild(btn);
  }

  function createGate() {
    if (document.getElementById('login-gate')) return document.getElementById('login-gate');

    var overlay = document.createElement('div');
    overlay.id = 'login-gate';
    overlay.className = 'login-gate';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'login-gate-title');
    overlay.innerHTML = [
      '<div class="login-gate__card glass-card">',
      '  <div class="login-gate__head">',
      '    <span class="badge badge-auto">登录</span>',
      '    <h2 id="login-gate-title">请先登录 VIIM 账号</h2>',
      '    <p>新设备首次打开需要先连接你的 VIIM 个人访问令牌，登录后才能使用 FC / PQ 功能。</p>',
      '  </div>',
      '  <div class="login-gate__state login-gate__state--prompt" data-role="state">请输入 VIIM 令牌后继续使用。</div>',
      '  <form class="login-gate__form" data-role="form">',
      '    <label class="fc-field">',
      '      <span class="fc-label">VIIM 个人访问令牌</span>',
      '      <input type="password" name="viim_token" data-role="token" placeholder="粘贴你的 VIIM 令牌…" autocomplete="off" required>',
      '    </label>',
      '    <label class="fc-field">',
      '      <span class="fc-label">VIIM 地址</span>',
      '      <input type="text" name="viim_url" data-role="url" value="https://ticket.example.com" autocomplete="url">',
      '    </label>',
      '    <button type="submit" class="btn-primary login-gate__submit" data-role="submit">连接并进入</button>',
      '  </form>',
      '  <div class="login-gate__hint">令牌只保存在当前浏览器会话中。若没有令牌，请在 VIIM 右上角头像中创建个人访问令牌。</div>',
      '</div>'
    ].join('');
    document.body.appendChild(overlay);
    document.body.classList.add('login-gate-open');
    return overlay;
  }

  function closeGate() {
    var overlay = document.getElementById('login-gate');
    if (overlay) overlay.remove();
    document.body.classList.remove('login-gate-open');
  }

  function bootGate() {
    var overlay = createGate();
    if (!overlay) return;

    var stateEl = overlay.querySelector('[data-role="state"]');
    var form = overlay.querySelector('[data-role="form"]');
    var tokenInput = overlay.querySelector('[data-role="token"]');
    var urlInput = overlay.querySelector('[data-role="url"]');
    var submitBtn = overlay.querySelector('[data-role="submit"]');

    form.style.display = 'grid';

    function setState(text, mode) {
      stateEl.textContent = text;
      stateEl.className = 'login-gate__state' + (mode ? ' login-gate__state--' + mode : '');
    }

    function setLoading(loading) {
      submitBtn.disabled = loading;
      submitBtn.textContent = loading ? '验证中…' : '连接并进入';
      tokenInput.disabled = loading;
      urlInput.disabled = loading;
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var token = (tokenInput.value || '').trim();
      var url = (urlInput.value || '').trim();
      if (!token) {
        setState('请先粘贴 VIIM 个人访问令牌。', 'error');
        tokenInput.focus();
        return;
      }

      setLoading(true);
      setState('正在验证令牌…', 'prompt');

      var fd = new FormData();
      fd.append('viim_token', token);
      fd.append('viim_url', url || 'https://ticket.example.com');

      fetch('/api/set-token', { method: 'POST', body: fd })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.ok) {
            syncAccountName(data);
            ensureLogoutButton({ logged_in: true, display_name: data.display_name, username: data.username });
            setCachedAccount({ logged_in: true, display_name: data.display_name, username: data.username });
            setState('登录成功，正在进入…', 'success');
            setTimeout(function () { location.href = nextUrl || location.pathname || '/'; }, 450);
            return;
          }
          setState('登录失败：' + ((data && data.error) || '未知错误'), 'error');
          setLoading(false);
          tokenInput.focus();
        })
        .catch(function () {
          setState('网络错误，请重试。', 'error');
          setLoading(false);
          tokenInput.focus();
        });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        setState('登录后才能继续使用，当前窗口不能关闭。', 'prompt');
      }
    });

    tokenInput.focus();
  }

  // Check cache first, then fetch from server if needed
  var cached = getCachedAccount();
  if (cached && cached.logged_in) {
    syncAccountName(cached);
    ensureLogoutButton(cached);
    closeGate();
    return;
  }

  fetch('/api/account', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (info) {
      if (info && info.logged_in) {
        setCachedAccount(info);
        syncAccountName(info);
        ensureLogoutButton(info);
        closeGate();
        return;
      }
      clearCachedAccount();
      bootGate();
    })
    .catch(function () {
      bootGate();
    });
})();
