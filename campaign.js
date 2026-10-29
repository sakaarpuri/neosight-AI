/* Only confirmed API responses may change participation totals or show success. */
(() => {
  const form = document.getElementById('pledgeForm');
  const button = document.getElementById('submitBtn');
  const name = document.getElementById('userName');
  const state = document.getElementById('userState');
  const consent = document.getElementById('pledgeCheck');
  const status = document.getElementById('pledgeStatus');
  const retrySecurity = document.getElementById('retrySecurity');
  const statsStatus = document.getElementById('statsStatus');
  const storageKey = 'neosight_pledge_v1';
  let busy = false;
  let widgetId = null;
  let token = '';
  let pending = null;
  let lastSaveAt = 0;
  let statsBusy = false;
  let initializingSecurity = false;
  let submissionError = '';
  const startedAt = Date.now();
  const readStorage = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
  const writeStorage = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* The API deduplicates even when storage is blocked. */ } };

  function validateForm() {
    button.disabled = busy || !token || !consent.checked || !name.value.trim() || !state.value;
  }
  form.addEventListener('input', validateForm);
  form.addEventListener('change', validateForm);

  async function api(path, options = {}) {
    const result = await fetch(path, { ...options, signal: AbortSignal.timeout(15000) });
    const body = await result.json().catch(() => null);
    if (!result.ok || !body?.success) throw new Error(body?.error || 'The service is temporarily unavailable. Please try again.');
    return body;
  }

  function validStats(data) {
    return Number.isSafeInteger(data.total) && data.total >= 0 && Array.isArray(data.by_state)
      && data.by_state.every(row => typeof row.state === 'string' && Number.isSafeInteger(row.count) && row.count > 0)
      && data.by_state.reduce((sum, row) => sum + row.count, 0) === data.total;
  }

  function renderStats(data) {
    if (!validStats(data)) throw new Error('Pledge totals are temporarily unavailable.');
    document.getElementById('totalCount').textContent = data.total.toLocaleString();
    const leaderboard = document.getElementById('leaderboardRows');
    leaderboard.replaceChildren();
    if (!data.by_state.length) {
      const empty = document.createElement('p');
      empty.textContent = 'Be the first to pledge for your state.';
      leaderboard.append(empty);
    }
    for (const [index, item] of data.by_state.slice(0, 15).entries()) {
      const row = document.createElement('div');
      row.className = 'lb-row';
      for (const [className, value] of [['rank', index + 1], ['state', item.state], ['count', item.count.toLocaleString()]]) {
        const span = document.createElement('span');
        span.className = className;
        span.textContent = String(value);
        row.append(span);
      }
      leaderboard.append(row);
    }
    // The graphic is explicitly illustrative. Only states with real pledges get dots.
    for (const dot of document.querySelectorAll('[data-state-dot]')) {
      const count = data.by_state.find(row => row.state === dot.dataset.stateDot)?.count || 0;
      dot.hidden = !count;
      dot.style.display = count ? '' : 'none';
      dot.setAttribute('r', String(count ? Math.min(12, 4 + Math.log2(count + 1)) : 0));
    }
    statsStatus.textContent = data.total ? 'Saved pledges. Totals refresh about once a minute.' : 'No pledges yet. Yours can be the first.';
    document.getElementById('retryStats').hidden = true;
  }

  async function loadStats() {
    if (statsBusy) return;
    statsBusy = true;
    try {
      const data = await api('/api/stats');
      // A cached GET started before our save must not undo the confirmed POST total.
      if (!lastSaveAt || Date.parse(data.updated_at) >= lastSaveAt) renderStats(data);
    } catch {
      statsStatus.textContent = 'Could not refresh pledge totals. Please try again.';
      document.getElementById('retryStats').hidden = false;
    } finally { statsBusy = false; }
  }
  document.getElementById('retryStats').addEventListener('click', loadStats);

  function showSaved(receipt) {
    form.hidden = true;
    const success = document.getElementById('successMsg');
    success.style.display = 'block';
    success.focus({ preventScroll: true });
    writeStorage(storageKey, { requestId: receipt.requestId, state: receipt.state });
  }

  async function initSecurity() {
    if (initializingSecurity) return;
    initializingSecurity = true;
    retrySecurity.hidden = true;
    status.textContent = 'Loading the security check…';
    try {
      const config = await api('/api/client-config');
      if (!config.pledgeTurnstileSiteKey) throw new Error('Pledge signup is not available yet. Please check back shortly.');
      if (!window.turnstile) {
        await new Promise((resolve, reject) => {
          const old = document.getElementById('pledgeTurnstileScript');
          old?.remove();
          const script = document.createElement('script');
          script.id = 'pledgeTurnstileScript';
          script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
          script.async = true;
          const timeout = setTimeout(() => reject(new Error('The security check could not load. Please try again.')), 10000);
          script.onload = () => { clearTimeout(timeout); resolve(); };
          script.onerror = () => { clearTimeout(timeout); reject(new Error('The security check could not load. Please try again.')); };
          document.head.append(script);
        });
      }
      if (widgetId !== null) window.turnstile.remove(widgetId);
      widgetId = window.turnstile.render('#pledgeSecurity', {
        sitekey: config.pledgeTurnstileSiteKey, theme: 'dark', action: 'pledge', size: 'compact',
        callback: value => { token = value; status.textContent = submissionError; validateForm(); },
        'expired-callback': () => { token = ''; status.textContent = submissionError || 'The security check expired. Please complete it again.'; validateForm(); },
        'error-callback': () => { token = ''; status.textContent = submissionError || 'The security check could not complete. Please try again.'; retrySecurity.hidden = false; validateForm(); },
      });
    } catch (error) {
      token = '';
      status.textContent = error.message || 'The security check is temporarily unavailable.';
      retrySecurity.hidden = false;
      validateForm();
    } finally { initializingSecurity = false; }
  }
  retrySecurity.addEventListener('click', initSecurity);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !token || !form.reportValidity()) return;
    const details = {
      name: name.value.trim(), state: state.value,
      city: document.getElementById('userCity').value.trim(), pledgeAccepted: consent.checked,
    };
    // Preserve the id for retries, but use a new one if the visitor edits their details.
    const signature = JSON.stringify(details);
    if (!pending || pending.signature !== signature) pending = { signature, requestId: crypto.randomUUID() };
    busy = true;
    submissionError = '';
    validateForm();
    form.setAttribute('aria-busy', 'true');
    status.textContent = 'Saving your pledge…';
    try {
      const data = await api('/api/submit', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...details, requestId: pending.requestId, website: document.getElementById('pledgeWebsite').value,
          startedAt, turnstileToken: token }) });
      // Storage succeeded even if stats are unavailable/malformed; never tell a saved user they failed.
      lastSaveAt = Date.parse(data.updated_at) || Date.now();
      if (validStats(data)) renderStats(data);
      else { statsStatus.textContent = 'Your pledge is saved. Totals are temporarily unavailable.'; document.getElementById('retryStats').hidden = false; }
      showSaved({ requestId: pending.requestId, state: data.state || details.state });
    } catch (error) {
      submissionError = error.name === 'TimeoutError' || error.name === 'AbortError'
        ? 'We could not confirm the response. Please retry with the same details; you will only be counted once.'
        : error.message;
      status.textContent = submissionError;
      token = '';
      if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
      retrySecurity.hidden = false;
    } finally {
      busy = false;
      form.removeAttribute('aria-busy');
      validateForm();
    }
  });

  const saved = readStorage(storageKey);
  if (saved && typeof saved.requestId === 'string'
      && /^[0-9a-f-]{36}$/i.test(saved.requestId)
      && Array.from(state.options).some(option => option.value && option.value === saved.state)) showSaved(saved);
  else initSecurity();
  loadStats();
  setInterval(() => { if (!document.hidden) loadStats(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadStats(); });
})();
