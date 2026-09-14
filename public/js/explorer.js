// THE EXPLORER (operator, 2026-09-11: "we need to completely rip off the mempool space block and
// transaction explorers. I want us to be a complete superior replacement for mempool space"; then,
// with our page beside theirs: "Surely we can make our display look at least as good as mempool.
// Do better. Make it beautiful").
//
// Our own pages over this node's RPC (server/http/explorer.js); no mempool.space code (AGPL --
// decided 2026-09-11), their layout ideas in our own light: a big title with the id beside it and
// a status pill; two panels of roomy rows; solid feature badges; dollar figures in green (a spot
// price the server attaches, when it has one within 1.5 s); a flow whose bands curve into one
// narrow glowing trunk; inputs and outputs as clean columns with arrow buttons to where the coins
// came from and went. Every page is a link, because the route lives in the URL:
//   #explorer                                  search + the latest blocks
//   #explorer/block/<height|hash>[/<page>]     header, statistics, the transactions a page at a time
//   #explorer/tx/<txid>                         fee, rate, features, flow, inputs, outputs, spent-by
//   #explorer/address/<address>[/<page>]        balance, received, the transactions newest first
// The page renderers are pure (data in, HTML out) so the tests can hold them; renderExplorer
// fetches once per route and repaints only when what it would draw changed, so the once-a-second
// frame never resets a half-typed search. No inline styles anywhere (the CSP forbids them).

const X = { key: null, data: null, error: null, loading: false, shown: null, bound: false };

export function parseRoute(r) {
  const [kind, id, page] = String(r ?? '').split('/').filter((x) => x !== '').map((x) => decodeURIComponent(x));
  if ((kind === 'block' || kind === 'address') && id) return { kind, id, page: Math.max(0, Math.floor(Number(page) || 0)) };
  if (kind === 'tx' && id) return { kind, id };
  return { kind: 'home' };
}

const enc = encodeURIComponent;
const mid = (s, a = 14, b = 8) => (String(s).length > a + b + 1 ? `${String(s).slice(0, a)}…${String(s).slice(-b)}` : String(s));
const blockLink = (id, label) => `<a href="#explorer/block/${enc(id)}">${label}</a>`;
const txLink = (fmt, txid, label = null) => `<a class="xmono" href="#explorer/tx/${enc(txid)}">${label ?? fmt.esc(fmt.hash(txid, 8))}</a>`;
const addrLink = (fmt, a, short = false) => `<a class="xmono xaddr" href="#explorer/address/${enc(a)}" title="${fmt.esc(a)}">${fmt.esc(short ? mid(a) : a)}</a>`;
const sats = (fmt, s) => (s == null ? '–' : `${fmt.num(s)} <small>sats</small>`);
const btcv = (fmt, s) => (s == null ? '–' : `${fmt.btc(s)} <small>BTC</small>`);
const usdOf = (s, usd) => (s == null || !usd ? null : (s / 1e8) * usd);
const dollars = (v) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2));
const usdFmt = (v) => (v == null ? '' : `<b class="xusd">$${dollars(v)}</b>`);
const rate = (v) => (v == null ? '–' : `${v >= 10 ? Math.round(v) : v.toFixed(2)} <small>sat/vB</small>`);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const FEAT = { segwit: 'SegWit', taproot: 'Taproot', rbf: 'RBF', consolidation: 'Consolidation', op_return: 'OP_RETURN' };
const feats = (list) => (list ?? []).map((f) => `<span class="xf xf-${f}">${FEAT[f] ?? f}</span>`).join('');
const when = (fmt, t) => (t ? `${new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16)} <small>UTC</small><span class="xago">${fmt.ago(t * 1000)}</span>` : '–');
const panel = (rows) => `<div class="xpanel">${rows.filter(Boolean).map(([k, v]) => `<div class="xrow"><span class="xk">${k}</span><span class="xv">${v}</span></div>`).join('')}</div>`;
const cards = (left, right) => `<div class="xcards">${panel(left)}${panel(right)}</div>`;
const ICON_COPY = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.6"/><path d="M11 3.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h.5"/></svg>';
const ARROW = '<svg class="xico" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9.5"/><path d="M5.5 10h8M10 6l4 4-4 4"/></svg>';
const copyBtn = (fmt, v) => `<button type="button" class="xcopy" data-copy="${fmt.esc(v)}" title="copy" aria-label="copy">${ICON_COPY}</button>`;
const hero = (title, sub, pill = '') => `<div class="xhero"><h1>${title}</h1>${sub}<span class="xgrow"></span>${pill}</div>`;
const section = (title, extra = '') => `<div class="xsect"><h2>${title}</h2>${extra}</div>`;
const confPill = (fmt, n) => (n > 0 ? `<span class="xpill ok">${plural(fmt.num(n), 'confirmation').replace(/^(\S+) confirmations?$/, (m) => m)}</span>` : n < 0 ? '<span class="xpill warn">Stale — off the best chain</span>' : '<span class="xpill warn">Unconfirmed</span>');
const pager = (base, page, pages) => (pages > 1 ? `<div class="xpager">
  ${page > 0 ? `<a href="#explorer/${base}/${page - 1}">‹ newer</a>` : '<span class="xdim">‹ newer</span>'}
  <span class="xdim">page ${page + 1} of ${pages}</span>
  ${page + 1 < pages ? `<a href="#explorer/${base}/${page + 1}">older ›</a>` : '<span class="xdim">older ›</span>'}</div>` : '');

export function blockHtml(d, fmt) {
  const b = d.block, st = d.stats ?? {}, usd = d.usd ?? null;
  const pct = Array.isArray(st.feerate_percentiles) ? st.feerate_percentiles : null;
  const prev = b.height > 0 ? `<a class="xnav" href="#explorer/block/${b.height - 1}" title="previous block">‹</a>` : '';
  const next = d.tip != null && b.height < d.tip ? `<a class="xnav" href="#explorer/block/${b.height + 1}" title="next block">›</a>` : '';
  const reward = st.subsidy != null && st.totalfee != null ? st.subsidy + st.totalfee : null;
  const left = [
    ['Hash', `<span class="xid sm">${fmt.esc(mid(b.hash, 18, 18))}</span>${copyBtn(fmt, b.hash)}`],
    ['Timestamp', when(fmt, b.time)],
    ['Size', `${fmt.bytes(b.size)} <span class="xdim">· ${b.weight != null ? `${(b.weight / 1e6).toFixed(2)} MWU` : '–'}</span>`],
    ['Transactions', fmt.num(b.nTx)],
    ['Miner', fmt.esc(d.pool?.label ?? d.pool?.tag ?? '–')],
    ['Merkle root', `<span class="xmono xdim">${fmt.esc(mid(b.merkleroot ?? '–', 12, 12))}</span>`],
  ];
  const right = [
    ['Median fee rate', pct ? rate(pct[2]) : '–'],
    ['Fee span', st.minfeerate != null ? `${st.minfeerate} – ${st.maxfeerate} <small>sat/vB</small>` : '–'],
    ['Total fees', `${btcv(fmt, st.totalfee)}${usdFmt(usdOf(st.totalfee, usd))}`],
    ['Subsidy + fees', `${btcv(fmt, reward)}${usdFmt(usdOf(reward, usd))}`],
    ['Difficulty', `${b.difficulty != null ? fmt.short(b.difficulty) : '–'} <span class="xdim">· nonce ${b.nonce ?? '–'}</span>`],
    ['Version · bits', `<span class="xmono">${fmt.esc(b.versionHex ?? String(b.version ?? '–'))}</span> <span class="xdim">· ${fmt.esc(b.bits ?? '–')}</span>`],
  ];
  const txRows = d.txs.map((t) => (t.missing
    ? `<tr><td>${txLink(fmt, t.txid)}</td><td colspan="6" class="xdim">not decoded</td></tr>`
    : `<tr><td>${txLink(fmt, t.txid)}</td>
      <td class="r">${t.coinbase ? '<span class="xf xf-cb">coinbase</span>' : rate(t.feerate)}</td>
      <td class="r">${t.fee == null ? '–' : sats(fmt, t.fee)}</td>
      <td class="r">${fmt.num(t.vsize)} <small>vB</small></td>
      <td class="r">${btcv(fmt, t.outSat)}</td>
      <td class="r">${t.inCount} → ${t.outCount}</td>
      <td>${feats(t.features)}</td></tr>`)).join('');
  return `${hero(`Block ${prev}<span class="xh">${fmt.num(b.height)}</span>${next}`, '', confPill(fmt, b.confirmations))}
    ${cards(left, right)}
    ${section('Transactions', `<span class="xdim">${fmt.num(b.nTx)}</span>`)}
    <div class="xtablecard"><table class="xtable"><thead><tr><th>transaction</th><th class="r">fee rate</th><th class="r">fee</th><th class="r">size</th><th class="r">value out</th><th class="r">in → out</th><th>features</th></tr></thead><tbody>${txRows}</tbody></table></div>
    ${pager(`block/${b.height}`, d.page, d.pages)}`;
}

export function txHtml(d, fmt) {
  const t = d.tx, usd = d.usd ?? null;
  const inBlock = t.confirmations > 0
    ? (t.height != null ? blockLink(t.height, fmt.num(t.height)) : blockLink(t.blockhash, fmt.esc(fmt.hash(t.blockhash, 8))))
    : null;
  const left = [
    ['Status', inBlock ? `Confirmed in block ${inBlock}` : 'In the mempool'],
    ['Timestamp', when(fmt, t.time)],
    ['Features', feats(t.features) || '<span class="xdim">none</span>'],
    ['Size', `${fmt.num(t.vsize)} <small>vB</small> <span class="xdim">· ${fmt.num(t.size)} B · ${fmt.num(t.weight)} WU</span>`],
  ];
  const right = t.coinbase ? [
    ['Block reward', `${btcv(fmt, t.outSat)}${usdFmt(usdOf(t.outSat, usd))}`],
    ['Fee', '<span class="xdim">none — a coinbase pays the miner</span>'],
    ['Inputs → outputs', `${fmt.num(t.vin.length)} → ${fmt.num(t.vout.length)}`],
    ['Version · locktime', `${t.version ?? '–'} · ${t.locktime ?? 0}`],
  ] : [
    ['Fee', `${sats(fmt, t.fee)}${usdFmt(usdOf(t.fee, usd))}`],
    ['Fee rate', rate(t.feerate)],
    ['Total in → out', `${btcv(fmt, t.inSat)} <span class="xdim">→</span> ${btcv(fmt, t.outSat)}`],
    ['Version · locktime', `${t.version ?? '–'} · ${t.locktime ?? 0}`],
  ];
  const ins = t.vin.map((v) => (v.coinbase
    ? `<div class="xitem"><span class="xico-wrap cb" title="new coins">${ARROW}</span><span class="xlabel"><span class="xf xf-cb">coinbase</span> new coins</span><span class="xamt">${btcv(fmt, t.outSat)}</span></div>`
    : `<div class="xitem"><a class="xico-wrap in" href="#explorer/tx/${enc(v.txid)}" title="spends ${fmt.esc(v.txid)}:${v.vout}">${ARROW}</a>`
      + `<span class="xlabel">${v.address ? addrLink(fmt, v.address, true) : `<span class="xdim">${fmt.esc(v.type ?? 'unknown script')}</span>`}</span>`
      + `<span class="xamt">${btcv(fmt, v.value)}</span></div>`)).join('');
  const shown = Math.min(t.vout.length, d.outputsShown ?? t.vout.length);
  const outs = t.vout.slice(0, shown).map((o) => '<div class="xitem">'
    + `<span class="xlabel">${o.address ? addrLink(fmt, o.address, true) : `<span class="xdim">${o.type === 'nulldata' ? 'OP_RETURN · unspendable' : fmt.esc(o.type ?? '–')}</span>`}</span>`
    + `<span class="xamt">${btcv(fmt, o.value)}</span>`
    + (o.spentBy ? `<a class="xico-wrap out xspent" href="#explorer/tx/${enc(o.spentBy.txid)}" title="spent by ${fmt.esc(o.spentBy.txid)}">${ARROW}</a>`
      : o.type === 'nulldata' ? '<span class="xico-wrap none" title="unspendable"></span>'
        : '<span class="xico-wrap unspent" title="unspent"><i></i></span>')
    + '</div>').join('');
  const totUsd = usdOf(t.outSat, usd);
  return `${hero('Transaction', `<span class="xid">${fmt.esc(t.txid)}</span>${copyBtn(fmt, t.txid)}`, confPill(fmt, t.confirmations))}
    ${cards(left, right)}
    ${section('Flow', `<span class="xdim">${plural(t.vin.length, 'input')} → ${plural(t.vout.length, 'output')}</span>`)}
    <div class="xflowcard">${flowSvg(t, fmt)}</div>
    ${section('Inputs &amp; Outputs')}
    <div class="xiocard">
      <div class="xio2">
        <div class="xiocol"><div class="xiohead">Inputs <span>${fmt.num(t.vin.length)}</span></div>${ins}</div>
        <div class="xiocol"><div class="xiohead">Outputs <span>${fmt.num(t.vout.length)}</span></div>${outs}${shown < t.vout.length ? `<div class="xdim xmore">the first ${fmt.num(shown)} of ${fmt.num(t.vout.length)}</div>` : ''}</div>
      </div>
      <div class="xtotals"><span class="xtot">${t.coinbase ? 'a coinbase: new coins' : `fee ${sats(fmt, t.fee)}`}</span><span class="xtotpill">${btcv(fmt, t.outSat)}${totUsd != null ? `<span class="xtotusd">$${dollars(totUsd)}</span>` : ''}</span></div>
    </div>`;
}

export function addressHtml(d, fmt) {
  const bal = d.balance ?? {}, usd = d.usd ?? null;
  const sent = bal.received != null && bal.balance != null ? bal.received - bal.balance : null;
  // WHAT THIS NODE CANNOT ANSWER, SAID ONCE AND PLAINLY. Core has no address index -- measured on
  // both configured nodes, getaddressbalance and getaddresstxids return "Method not found" -- so
  // balance, history and totals have no source here. Printing the raw refusal where a balance
  // belongs, or a count of 0 where nothing was counted, both read as "this address is unused".
  const noIndex = d.indexed === false;
  const unknown = '<span class="xdim">not indexed</span>';
  // THE LOCAL INDEX (server/chain/index/) answers history and balance but keeps no UTXO list, and it
  // covers the chain up to the block it was built at -- both said on the page, never implied away
  const local = d.source === 'local-index';
  const left = [
    ['Type', fmt.esc(d.type ?? '–')],
    ['Transactions', noIndex ? unknown : fmt.num(d.txCount)],
    ['Unspent outputs', bal.utxos != null ? fmt.num(bal.utxos) : local ? `<span class="xdim">${fmt.esc(d.utxoNote ?? 'not tracked')}</span>` : unknown],
  ];
  const right = [
    ['Balance', bal.balance != null ? `${btcv(fmt, bal.balance)}${usdFmt(usdOf(bal.balance, usd))}` : unknown],
    ['Total received', bal.received != null ? btcv(fmt, bal.received) : unknown],
    ['Total sent', sent != null ? btcv(fmt, sent) : unknown],
  ];
  const txRows = d.txs.map((t) => (t.missing
    ? `<tr><td>${txLink(fmt, t.txid)}</td><td colspan="3" class="xdim">not decoded</td></tr>`
    : `<tr><td>${txLink(fmt, t.txid)}</td>
      <td>${t.height != null ? blockLink(t.height, fmt.num(t.height)) : '<span class="xdim">mempool</span>'}</td>
      <td class="r ${t.delta > 0 ? 'xpos' : t.delta < 0 ? 'xneg' : ''}">${t.delta > 0 ? '+' : ''}${fmt.btc(t.delta)} <small>BTC</small></td>
      <td class="r">${t.coinbase ? '<span class="xf xf-cb">coinbase</span>' : rate(t.feerate)}</td></tr>`)).join('');
  return `${hero('Address', `<span class="xid">${fmt.esc(d.address)}</span>${copyBtn(fmt, d.address)}`)}
    ${cards(left, right)}
    ${section('Transactions', '<span class="xdim">newest first</span>')}
    ${local && d.index.stale ? `<div class="caveat bad tiny"><b>The address index has stopped following the chain.</b> ${fmt.esc(d.index.stale)}</div>` : ''}
    ${local && d.index.postTip ? `<div class="caveat tiny"><b>${fmt.num(d.index.postTip)} transaction${d.index.postTip === 1 ? '' : 's'} in blocks the node no longer has</b> are left out of the figures: the chain reorganised and the index is catching up.</div>` : ''}
    ${local ? `<div class="note tiny">From the local address index, complete through block ${blockLink(d.index.tip, fmt.num(d.index.tip))}${d.index.behind ? ` — <b>${fmt.num(d.index.behind)} newer block${d.index.behind === 1 ? '' : 's'} not yet included</b>${d.index.following ? ', catching up' : ''}` : ''}. Unconfirmed transactions are not included. Received and sent add up each transaction's net effect on this address.</div>` : ''}
    ${noIndex && d.indexBuilding ? `<div class="note tiny"><b>The address index is being built</b>: ${fmt.esc(d.indexBuilding.phase ?? 'starting')}${d.indexBuilding.total ? ` ${fmt.num(d.indexBuilding.done)} of ${fmt.num(d.indexBuilding.total)} (${Math.round((100 * d.indexBuilding.done) / d.indexBuilding.total)}%)` : ''}${d.indexBuilding.rows ? `, ${fmt.num(d.indexBuilding.rows)} rows so far` : ''}${d.indexBuilding.eta ? `, about ${fmt.esc(d.indexBuilding.eta)} left` : ''}. The Overview shows its progress, and a notification says when it is done; this page fills in then.</div>` : ''}
    ${noIndex && !d.indexBuilding ? `<div class="note tiny">This node keeps <b>no address index</b>, so an address's balance and history have no source here — the address above is confirmed valid and nothing more is claimed. Bitcoin Core has never had <span class="mono">getaddressbalance</span> or <span class="mono">getaddresstxids</span>; they belong to insight-style forks. Transaction and block lookups are unaffected: those use the node's <span class="mono">txindex</span>, which is synced.</div>` : ''}
    <div class="xtablecard"><table class="xtable"><thead><tr><th>transaction</th><th>block</th><th class="r">change</th><th class="r">fee rate</th></tr></thead><tbody>${txRows || `<tr><td colspan="4" class="xdim">${noIndex ? 'no address index on this node — history cannot be listed' : 'no transactions for this address'}</td></tr>`}</tbody></table></div>
    ${noIndex ? '' : pager(`address/${enc(d.address)}`, d.page, d.pages)}
    ${Array.isArray(d.utxos) ? `${section('Unspent outputs', `<span class="xdim">${fmt.num(d.utxos.length)} · as the node's UTXO set has them, less what the mempool already spends</span>`)}
    <div class="xtablecard"><table class="xtable"><thead><tr><th>output</th><th>block</th><th class="r">value</th></tr></thead><tbody>${d.utxos.length
    ? d.utxos.map((u) => `<tr><td>${txLink(fmt, u.txid)}<span class="xdim">:${u.n}</span></td><td>${u.height != null ? blockLink(u.height, fmt.num(u.height)) : '<span class="xdim">–</span>'}</td><td class="r">${fmt.btc(u.value)} <small>BTC</small></td></tr>`).join('')
    : '<tr><td colspan="3" class="xdim">nothing unspent</td></tr>'}</tbody></table></div>` : ''}`;
}

// the fee band a block's median rate falls in, for its cube's colour (no inline styles: classes)
export const feeBand = (r) => (r == null ? 0 : r < 2 ? 1 : r < 4 ? 2 : r < 8 ? 3 : r < 16 ? 4 : r < 32 ? 5 : r < 64 ? 6 : 7);

export function homeHtml(s, fmt) {
  const recent = s?.blocks?.recent ?? [];
  const pools = new Map((s?.attribution?.recent ?? []).map((r) => [r.height, r.poolLabel ?? r.tagText ?? null]));
  const med = (b) => (Array.isArray(b.p) ? b.p[2] : b.avgFeerate ?? null);
  const cubes = recent.slice(0, 8).map((b) => `<a class="xblk f${feeBand(med(b))}" href="#explorer/block/${b.height}">
      <span class="xblk-h">${fmt.num(b.height)}</span>
      <span class="xblk-face"><b>~${med(b) ?? '–'} sat/vB</b>${Array.isArray(b.p) ? `<small>${b.p[0]} – ${b.p[4]} sat/vB</small>` : '<small></small>'}<em>${b.size != null ? fmt.bytes(b.size, 1) : '–'}</em><small>${fmt.num(b.txs)} transactions</small><small>${b.time ? fmt.ago(b.time * 1000) : ''}</small></span>
      <span class="xblk-pool">${fmt.esc(pools.get(b.height) ?? '')}</span></a>`).join('');
  const rows = recent.slice(0, 15).map((b) => `<tr><td>${blockLink(b.height, fmt.num(b.height))}</td>
    <td>${b.time ? fmt.ago(b.time * 1000) : '–'}</td><td>${fmt.esc(pools.get(b.height) ?? '–')}</td>
    <td class="r">${fmt.num(b.txs)}</td><td class="r">${b.weight != null ? `${(b.weight / 1e6).toFixed(2)} <small>MWU</small>` : '–'}</td>
    <td class="r">${b.totalfee != null ? btcv(fmt, b.totalfee) : '–'}</td></tr>`).join('');
  return `${hero('Latest blocks', '')}
    <div class="xblocks">${cubes}</div>
    <div class="xtablecard"><table class="xtable"><thead><tr><th>height</th><th>mined</th><th>pool</th><th class="r">transactions</th><th class="r">weight</th><th class="r">fees</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="xdim">no blocks seen yet</td></tr>'}</tbody></table></div>`;
}

export function errorHtml(d, fmt) {
  return `<div class="caveat bad"><b>${fmt.esc(d?.error?.message ?? 'the node refused')}</b>${d?.hint ? `<div class="tiny">${fmt.esc(d.hint)}</div>` : ''}</div>`;
}

// Copy an id. The monitor is served over plain http on the LAN, where navigator.clipboard does
// not exist (it needs a secure context), so the old select-and-copy path is kept as the fallback.
function copyText(text) {
  if (globalThis.navigator?.clipboard && globalThis.isSecureContext) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'xclip';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.('copy');
    ta.remove();
    if (ok) resolve(); else reject(new Error('copy refused'));
  });
}

function bindSearch(h) {
  if (X.bound) return;
  const form = document.getElementById('xSearch');
  const input = document.getElementById('xQuery');
  const body = document.getElementById('xBody');
  if (!form || !input) return;
  X.bound = true;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    const node = h.state.node ? `&node=${enc(h.state.node)}` : '';
    try {
      const d = await h.api(`/api/x/search?q=${enc(q)}${node}`);
      if (d.ok) { location.hash = `#explorer/${d.type}/${enc(d.id)}`; input.value = ''; }
      else h.toast?.(d.error?.message ?? 'nothing found', 'bad');
    } catch (err) { h.toast?.(err.message, 'bad'); }
  });
  body?.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-copy]');
    if (!btn) return;
    copyText(btn.dataset.copy)
      .then(() => { btn.classList.add('done'); setTimeout(() => btn.classList.remove('done'), 1200); h.toast?.('copied', 'ok'); })
      .catch(() => h.toast?.('the browser refused to copy', 'bad'));
  });
}

async function load(route, key, h) {
  X.loading = true; X.key = key; X.data = null; X.error = null;
  const node = h.state.node ? `&node=${enc(h.state.node)}` : '';
  const url = route.kind === 'block' ? `/api/x/block?id=${enc(route.id)}&page=${route.page}${node}`
    : route.kind === 'tx' ? `/api/x/tx?txid=${enc(route.id)}${node}`
      : `/api/x/address?addr=${enc(route.id)}&page=${route.page}${node}`;
  try {
    const d = await h.api(url);
    if (X.key !== key) return;            // a newer route took over while this one was out
    if (d.ok) X.data = d; else X.error = d;
  } catch (err) {
    if (X.key === key) X.error = { error: { message: err.message } };
  } finally {
    if (X.key === key) X.loading = false;
    h.render();
  }
}

export function renderExplorer(s, state, h) {
  const body = document.getElementById('xBody');
  if (!body) return;
  bindSearch(h);
  const route = parseRoute(state.xroute);
  const key = `${route.kind}|${route.id ?? ''}|${route.page ?? 0}|${state.node ?? ''}`;
  if (route.kind !== 'home' && X.key !== key && !(X.loading && X.key === key)) load(route, key, h);
  const fmt = h.fmt;
  const html = route.kind === 'home' ? homeHtml(s, fmt)
    : X.key === key && X.data ? (route.kind === 'block' ? blockHtml(X.data, fmt) : route.kind === 'tx' ? txHtml(X.data, fmt) : addressHtml(X.data, fmt))
      : X.key === key && X.error ? errorHtml(X.error, fmt)
        : '<div class="note">asking the node…</div>';
  if (html !== X.shown) { body.innerHTML = html; X.shown = html; }
}

// THE FLOW. Where the value came from and where it went, drawn the way the eye wants it: every
// input a band as thick as its share of the value, running in straight from the left edge (its
// tail notched like an arrow's fletching), curving into ONE narrow trunk where they merge, and
// fanning out again to the outputs, each ending in an arrow tip. One gradient runs across the
// whole picture -- violet at the edges, electric blue in the trunk -- so the bands read as one
// current. The fee leaves the trunk as a thin gold stream that rises toward the top right and
// fades out; a coinbase input glows gold; an OP_RETURN output is a grey sliver. SVG rather than
// canvas so every band is a link (an input to the transaction that made it, an output to its
// address) with its own tooltip. Past FLOW_MAX bands a side folds the rest into one "N more" band.
// Pure: summary in, markup out.
export const FLOW_MAX = 24;
const r1 = (v) => Math.round(v * 10) / 10;

function flowDefs(W) {
  const g = (id, stops, x1 = 0, x2 = W) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="0" x2="${x2}" y2="0">${stops.map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join('')}</linearGradient>`;
  return `<defs>${[
    g('xg-flow', [[0, '#3b1a78', 0.25], [0.06, '#8f3cf2'], [0.3, '#6a4cf6'], [0.5, '#1d8fff'], [0.7, '#6a4cf6'], [0.94, '#9a45f5'], [1, '#b56cff']]),
    g('xg-cb', [[0, '#6b4a00', 0.3], [0.06, '#f5b400'], [0.3, '#e0913a'], [0.5, '#1d8fff']]),
    g('xg-nul', [[0.5, '#1d8fff'], [0.75, '#6c7686'], [1, '#8a93a1']]),
    g('xg-more', [[0, '#39414d', 0.3], [0.08, '#6c7686'], [0.5, '#1d8fff'], [0.92, '#6c7686'], [1, '#8a93a1']]),
    g('xg-fee', [[0, '#1d8fff'], [0.45, '#ffb13d'], [1, '#ffb13d', 0]], W / 2, W * 0.97),
  ].join('')}</defs>`;
}

export function flowSvg(t, fmt, W = 1000) {
  const fold = (items) => (items.length <= FLOW_MAX ? items : [...items.slice(0, FLOW_MAX - 1), {
    kind: 'more', value: items.slice(FLOW_MAX - 1).reduce((a, x) => a + (x.value ?? 0), 0),
    title: `${fmt.num(items.length - FLOW_MAX + 1)} more`,
  }]);
  const left = fold(t.vin.map((v) => (v.coinbase
    ? { kind: 'cb', value: t.outSat, title: 'coinbase: the subsidy and the block\'s fees' }
    : { kind: 'in', value: v.value, href: `#explorer/tx/${enc(v.txid)}`, title: `${v.address ?? v.type ?? 'input'} · ${fmt.btc(v.value)} BTC` })));
  const right = fold(t.vout.map((o) => ({
    kind: o.type === 'nulldata' ? 'nul' : 'out', value: o.value,
    href: o.address ? `#explorer/address/${enc(o.address)}` : null,
    title: `${o.address ?? (o.type === 'nulldata' ? 'OP_RETURN' : o.type ?? 'output')} · ${fmt.btc(o.value)} BTC`,
  })));
  const fee = !t.coinbase && t.fee > 0 ? { kind: 'fee', value: t.fee, title: `fee · ${fmt.num(t.fee)} sat` } : null;

  const T = 150, MIN = 2, GAP = 14, PAD = 16;
  const known = [...left, ...right].every((x) => Number.isFinite(x.value));
  const total = known ? Math.max(1, left.reduce((a, x) => a + x.value, 0), right.reduce((a, x) => a + x.value, 0) + (fee?.value ?? 0)) : 1;
  const thick = (x, n) => Math.max(MIN, known ? (x.value / total) * T : T / n);
  const sum = (xs) => xs.reduce((a, x) => a + x.h, 0);
  const L0 = left.map((x) => ({ ...x, h: thick(x, left.length) }));
  const R0 = right.map((x) => ({ ...x, h: thick(x, right.length) }));
  const F0 = fee ? { ...fee, h: Math.max(1.5, known ? (fee.value / total) * T : 2) } : null;

  // ONE RIVER, TWO BANKS THE SAME HEIGHT (operator, 2026-09-13: "how do we fix that broken seam in
  // the middle so it smoothly transitions").
  //
  // The two halves of the trunk meet at x = W/2, and each used to be centred on its OWN total --
  // the left on sum(L), the right on sum(R) + the fee. Those totals are equal in VALUE (in = out +
  // fee, which is what `total` above is built from) but not in PIXELS, because MIN floors every
  // band to 2px. Measured on the reported transaction -- one fat input, three dust outputs of
  // 0.006px each floored to 2px -- the right bank gained 5.98px of padding the left never got, the
  // two centre lines fell 3.7px apart, and the trunk stepped at the join on both edges.
  //
  // The clamp has to stay: a 0.006px band is invisible, and a dust output is still an output. So
  // the surplus is spread instead of stepped. Each side is scaled to the same trunk height, which
  // restores the invariant the picture is meant to show -- both banks of one river are the same
  // height -- and makes the seam flush by construction rather than by luck. The distortion is the
  // clamp's, not this: rescaling only stops one side carrying it alone.
  const sumL0 = sum(L0), sumR0 = sum(R0) + (F0?.h ?? 0);
  const trunk = Math.max(sumL0, sumR0);
  const kL = sumL0 > 0 ? trunk / sumL0 : 1, kR = sumR0 > 0 ? trunk / sumR0 : 1;
  const L = L0.map((x) => ({ ...x, h: x.h * kL }));
  const Rt = R0.map((x) => ({ ...x, h: x.h * kR }));
  const F = F0 ? { ...F0, h: F0.h * kR } : null;
  const span = (xs) => sum(xs) + GAP * Math.max(0, xs.length - 1);
  const feeRoom = F ? F.h + GAP * 2 : 0;
  const H = Math.ceil(Math.max(span(L), span(Rt) + feeRoom, T + 40) + PAD * 2);

  const xm = W / 2, xb = W * 0.44, xa = W * 0.17, xb2 = W * 0.56, xa2 = W * 0.83;
  const cxL = (xa + xb) / 2, cxR = (xb2 + xa2) / 2;
  const band = (x, d, fill) => {
    const path = `<path class="xb-${x.kind}" d="${d}" fill="${fill}"><title>${fmt.esc(x.title)}</title></path>`;
    return x.href ? `<a href="${x.href}">${path}</a>` : path;
  };
  const fillOf = (k) => (k === 'cb' ? 'url(#xg-cb)' : k === 'nul' ? 'url(#xg-nul)' : k === 'more' ? 'url(#xg-more)' : 'url(#xg-flow)');

  // inputs: straight in from the edge, curving into the left half of the trunk
  // both banks start at the SAME trunk top, so the halves meet flush at x = W/2
  let y = (H - span(L)) / 2, c = (H - trunk) / 2;
  const ins = L.map((x) => {
    const n = Math.min(14, x.h / 2 + 3);
    const d = `M0 ${r1(y)}L${r1(xa)} ${r1(y)}C${r1(cxL)} ${r1(y)} ${r1(cxL)} ${r1(c)} ${r1(xb)} ${r1(c)}L${r1(xm)} ${r1(c)}`
      + `L${r1(xm)} ${r1(c + x.h)}L${r1(xb)} ${r1(c + x.h)}C${r1(cxL)} ${r1(c + x.h)} ${r1(cxL)} ${r1(y + x.h)} ${r1(xa)} ${r1(y + x.h)}`
      + `L0 ${r1(y + x.h)}L${r1(n)} ${r1(y + x.h / 2)}Z`;
    y += x.h + GAP; c += x.h;
    return band(x, d, fillOf(x.kind));
  }).join('');

  // the right half of the trunk: the fee on top, then the outputs
  let cr = (H - trunk) / 2;                 // the same top edge as the inputs: no step at the seam
  let feePath = '';
  if (F) {
    const top = PAD, xe = W * 0.97;
    const d = `M${r1(xm)} ${r1(cr)}L${r1(xb2)} ${r1(cr)}C${r1(W * 0.7)} ${r1(cr)} ${r1(W * 0.72)} ${r1(top)} ${r1(xe)} ${r1(top)}`
      + `L${r1(xe)} ${r1(top + F.h)}C${r1(W * 0.72)} ${r1(top + F.h)} ${r1(W * 0.7)} ${r1(cr + F.h)} ${r1(xb2)} ${r1(cr + F.h)}L${r1(xm)} ${r1(cr + F.h)}Z`;
    feePath = band(F, d, 'url(#xg-fee)');
    cr += F.h;
  }
  let yr = PAD + feeRoom + ((H - PAD * 2 - feeRoom) - span(Rt)) / 2;
  const outs = Rt.map((x) => {
    const tip = Math.min(22, x.h / 2 + 4);
    const d = `M${r1(xm)} ${r1(cr)}L${r1(xb2)} ${r1(cr)}C${r1(cxR)} ${r1(cr)} ${r1(cxR)} ${r1(yr)} ${r1(xa2)} ${r1(yr)}`
      + `L${r1(W - tip)} ${r1(yr)}L${r1(W)} ${r1(yr + x.h / 2)}L${r1(W - tip)} ${r1(yr + x.h)}L${r1(xa2)} ${r1(yr + x.h)}`
      + `C${r1(cxR)} ${r1(yr + x.h)} ${r1(cxR)} ${r1(cr + x.h)} ${r1(xb2)} ${r1(cr + x.h)}L${r1(xm)} ${r1(cr + x.h)}Z`;
    yr += x.h + GAP; cr += x.h;
    return band(x, d, fillOf(x.kind));
  }).join('');

  return `<svg class="xflow" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" height="${H}" role="img" aria-label="${fmt.esc(`${t.vin.length} inputs to ${t.vout.length} outputs`)}">`
    + `${flowDefs(W)}${ins}${feePath}${outs}</svg>`;
}
