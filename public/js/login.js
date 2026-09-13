// Login page. Separate file because the page's CSP is script-src 'self' -- an
// inline <script> would simply not run, and "the button does nothing" is a
// miserable bug to chase over HTTP.
const err = document.getElementById('err');
const form = document.getElementById('f');
const btn = document.getElementById('go');
const sub = document.getElementById('sub');

function show(msg, locked = false) {
  err.textContent = msg;
  err.classList.remove('hidden');
  err.classList.toggle('locked', locked);
}
function hide() { err.classList.add('hidden'); }

async function api(path, opt = {}) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opt });
  let data = null;
  try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data };
}

// Already signed in? Skip the form rather than showing a second login.
api('/api/me').then((r) => {
  if (r.status === 200) window.location.replace('/');
});

api('/api/health').then(({ data }) => {
  if (!data || !Array.isArray(data.nodes)) return;
  const online = data.nodes.filter((n) => n.online).length;
  sub.innerHTML = `Bitcoin node monitor · <span class="${online ? 'ok' : 'bad'}">${online}/${data.nodes.length}</span> node(s) answering`;
});

let countdown = null;
function lockCountdown(seconds) {
  clearInterval(countdown);
  let left = seconds;
  btn.disabled = true;
  const tick = () => {
    show(`too many failed attempts; retry in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`, true);
    if (left-- <= 0) { clearInterval(countdown); btn.disabled = false; hide(); }
  };
  tick();
  countdown = setInterval(tick, 1000);
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  hide();
  btn.disabled = true;
  btn.textContent = 'signing in…';
  const body = JSON.stringify({
    username: document.getElementById('u').value.trim(),
    password: document.getElementById('p').value,
  });
  try {
    const r = await api('/api/login', { method: 'POST', body });
    if (r.status === 429) {
      const secs = Math.ceil((Number(/(\d+)ms/.exec(r.data?.error?.message ?? ''))?.[1] ?? 600000) / 1000);
      lockCountdown(Number.isFinite(secs) ? Math.min(secs, 900) : 600);
      return;
    }
    if (r.status !== 200 || !r.data?.ok) {
      show(r.data?.error?.message ?? 'sign-in failed');
      btn.disabled = false;
      btn.textContent = 'sign in';
      return;
    }
    // The server set two cookies: the HttpOnly session id, and `blockyard_csrf`,
    // readable here on purpose. Mutating calls must echo that value in an
    // X-CSRF-Token header -- reading it is the thing a cross-origin page cannot
    // do, which is what makes the check mean anything.
    void /(?:^|;\s*)blockyard_csrf=/.test(document.cookie);
    const back = new URLSearchParams(location.search).get('next');
    window.location.replace(back && back.startsWith('/') ? back : '/');
  } catch (e) {
    show(`cannot reach the server: ${e.message}`);
    btn.disabled = false;
    btn.textContent = 'sign in';
  }
});

document.getElementById('u').focus();
