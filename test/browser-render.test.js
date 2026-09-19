// The browser-side harness this repo has been without (docs/DEFECTS.md).
//
// Why it exists: "nothing refreshes" arrived while the server was demonstrably
// healthy -- /api/state 200 in 9 ms, a dozen SSE snapshot frames in 22 s, on the same
// LAN bind the operator uses. That answer can only lie in code nobody could execute.
// A renderer that throws after the first frame lands produces exactly this symptom:
// data arriving, nothing on screen, no trace on the server.
//
// So: a DOM stub (test/dom-stub.js), a snapshot assembled the way the monitor really
// assembles one (stubbed RPC + real fixture log lines through the real absorb path),
// and every page renderer run under it. It is not a browser -- it cannot see layout,
// CSS or real EventSource behaviour -- but it catches the class that matters: throws,
// and a page that says nothing when it has nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './dom-stub.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(HERE, '..', 'public');

// ---------------------------------------------------------------- snapshots

const { NodeMonitor } = await import('../server/collect/monitor.js');
const { History } = await import('../server/store/history.js');
const { parseLine } = await import('../server/collect/logparse.js');

function monitorWith(rpcFixture, logLines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-render-'));
  const logger = () => {}; logger.child = () => logger;
  const store = { ringCapacity: 500, maxEventLog: 100, retentionHours: 1, snapshotEveryMs: 1e9 };
  const m = new NodeMonitor(
    { id: 'core-main', label: 'Core mainnet (production)', rpcUrl: 'http://127.0.0.1:8331', datadir: dir, chainHint: 'main', logFile: null, color: '#f7931a' },
    { rpc: { maxInFlight: 1, minIntervalMs: 250, timeoutMs: 500, slowLatencyMs: 5000 }, poll: {}, store, log: logger, history: new History(dir, store, { log: logger }) });
  m.callList = async (calls) => new Map(calls.map((c) => [c.method, rpcFixture[c.method]]));
  m.onLogEvents(logLines.map(parseLine).filter(Boolean));
  return m;
}

const FIXTURES = fs.readFileSync(path.join(HERE, 'fixtures', 'log-samples.txt'), 'utf8').split('\n').filter(Boolean);
const BENCH = fs.readFileSync(path.join(HERE, 'fixtures', 'log-samples-bench.txt'), 'utf8').split('\n').filter(Boolean);

const RICH = {
  getblockchaininfo: { chain: 'main', blocks: 966091, headers: 966091, bestblockhash: '00'.repeat(32), difficulty: 1.27e14, mediantime: 1788880000, verificationprogress: 1, initialblockdownload: false, size_on_disk: 767155784813, warnings: '' },
  getmempoolinfo: { size: 4743, bytes: 2400000, usage: 4800000, maxmempool: 300000000, mempoolminfee: 0.00001, minrelaytxfee: 0.00001, unbroadcastcount: 0 },
  getconnectioncount: 17,
  getnettotals: { totalbytesrecv: 0, totalbytessent: 0, timemillis: 1, uploadtarget: { timeframe: 86400, target: 0, target_reached: false, serve_historical_blocks: true, bytes_left_in_cycle: 0, time_left_in_cycle: 0 } },
  uptime: 70620,
  getnetworkinfo: { version: 1, subversion: '/BitcoinMachineCode:0.0.1/', connections: 17, connections_in: 0, connections_out: 17, networks: [], relayfee: 0.00001, incrementalfee: 0.00001, localaddresses: [], warnings: '' },
  getmininginfo: { blocks: 966091, difficulty: 1.27e14, networkhashps: 0, pooledtx: 4743, chain: 'main' },
  getchaintips: [{ height: 966010, hash: 'aa', branchlen: 3, status: 'valid-fork' }],
  estimatesmartfee: { feerate: 0.000024, blocks: 6 },
  getchaintxstats: { time: 1788880000, txcount: 620000, window_tx_count: 3200000, window_block_count: 1440, txrate: 2222.2, diffheight: 966091 },
  gettxoutsetinfo: { height: 966091, txouts: 165336332, total_amount: 19700000, disksize: 32000000000 },
  getindexinfo: { coinstatsindex: { sync_height: 966091 }, txindex: { sync_height: 966091 } },
  getdeploymentinfo: { blockchain: { '8.1759': { status: 'LOCKED_IN', since: 960000 } } },
  getrpcinfo: { activecommands: [] },
  getpeerinfo: [],
  getrawmempool: ['a'.repeat(64), 'b'.repeat(64)],
  getblockstats: { height: 966090, totalfee: 240000, txs: 6600, size: 1400000, weight: 4000000, avgfee: 36, medianfee: 24, maxfee: 9000, feerate_percentiles: [1, 2, 3, 4, 5], time: 1788879000, mediantime: 1788878000, subsidy: 312500000, utxo_increase: 12000, ins: 7000, outs: 8000 },
};

const richSnap = () => monitorWith(RICH, FIXTURES).snapshot({});
const benchSnap = () => monitorWith(
  { ...RICH, getblockchaininfo: { ...RICH.getblockchaininfo, blocks: 391483, headers: 966011, verificationprogress: 0.41, initialblockdownload: true } },
  BENCH,
).snapshot({});

// ------------------------------------------------------------------ harness

const panels = await import('../public/js/panels.js');
const F = await import('../public/js/fmt.js');
const charts = await import('../public/js/charts.js');
panels.setFmt(F);   // app.js does this at boot; a renderer without it fails as null.num

const PAGES = ['chain', 'mempool', 'peers', 'network', 'logs', 'node', 'admin'];
const RENDERER = { chain: 'renderChain', mempool: 'renderMempool', peers: 'renderPeers', network: 'renderNetwork', logs: 'renderLogs', node: 'renderNode', admin: 'renderAdmin' };

function runAllPages(snap, label) {
  // el() creates on demand, exactly like a browser that has the element in the
  // skeleton: charts.js reads canvas.__hasData, so handing it null is a harness bug,
  // not a product bug -- and the first version of this file got that wrong.
  const { el } = installDom();
  const state = { page: 'chain', node: 'core-main', byNode: new Map(), events: [], snap: null, series: {}, cfg: { sources: [] }, user: { role: 'admin' } };
  const h = {
    api: async () => ({}), toast: () => {}, state, fmt: F, charts,
    setText: (id, v) => { el(id).textContent = String(v); },
    canvas: (id) => el(id),
    renderFeed: (id, rows) => { el(id).innerHTML = `feed:${(rows ?? []).length}`; },
    render: () => {}, refreshMempoolDetail: () => {}, renderSyncHero: () => {}, peersDetail: async () => [],
  };
  const errs = [];
  for (const page of PAGES) {
    state.page = page;
    state.snap = snap;
    const fn = RENDERER[page];   // declared outside the try: a catch cannot see a
    try {                        // try-scoped const, and an error report that loses
      panels[fn](snap, state, h); // which page threw is worse than the throw
    } catch (err) {
      errs.push(`${label}/${fn}: ${err.message}`);
    }
  }
  return errs;
}

const mining = await import('../public/js/mining.js');

/** A snapshot carrying attribution, shaped exactly as /api/mining returns it. */
const snapWithMining = (base) => {
  const s = base;
  s.attribution = {
    recent: [
      { height: 966259, poolKey: 'antpool971', poolLabel: 'AntPool', poolLabelKey: 'antpool', matchedTag: 'Mined By AntPool', tagText: 'Mined by AntPool971', tagSource: 'push', weight: 3993638, size: 1579815, txs: 5631, totalfee: 1328314, avgFeerate: 1 },
      { height: 966258, poolKey: 'foundry usa', poolLabel: 'Foundry USA', poolLabelKey: 'foundry usa', matchedTag: 'Foundry USA Pool', tagText: '/Foundry USA Pool #dropgold/', tagSource: 'scan', weight: 3992913, size: 1481000, txs: 4085, totalfee: 900000, avgFeerate: 2 },
      { height: 966257, poolKey: 'unknown:811c9d', poolLabel: null, tagText: '', tagSource: null, weight: 3991000, size: 1400000, txs: 300, totalfee: 1000, avgFeerate: 1 },
    ],
    pools: [], byPool: [
      { poolKey: 'antpool', label: 'AntPool', name: 'AntPool', labelled: true, blocks: 1, sharePct: 33.3, medianFeeRate: 1, avgWeight: 3993638, tags: ['Mined by AntPool971'] },
      { poolKey: 'unknown:811c9d', label: null, name: 'unknown:811c9d', labelled: false, blocks: 1, sharePct: 33.3, medianFeeRate: null, avgWeight: 3991000, tags: [] },
    ],
    windowBlocks: 3, windowHeights: { from: 966257, to: 966259 },
    labelSource: { source: 'pools-v2.json', sha256: '0491a15f88db', fetchedAt: '2026-09-09T19:13:11.024Z' },
    fetched: 3, skippedIbd: 0, lastError: null, enabled: true,
    nextBlock: {
      height: 966265, txCount: 1496, weight: 1630838, weightLimit: 4000000, weightPct: 40.8,
      totalFeesSat: 790578, coinbaseSat: 313322914, ms: 1312, at: Date.now(),
      feeRate: { min: 0.1, p50: 1.6, p75: 2.4, p90: 4.0, max: 74.3 },
      feeRateHistogram: [{ lo: 0, hi: 1, n: 300 }, { lo: 1, hi: 2, n: 700 }, { lo: 2, hi: 4, n: 380 }, { lo: 4, hi: 1000, n: 116 }],
      packages: {
        total: 1475, multiTx: 19, txsInPackages: 40, largest: 3, cpfpCandidates: 6,
        sizeHistogram: { 1: 1456, 2: 16, 3: 3 },
        top: [{ size: 3, feesSat: 5122, weight: 1874, packageFeeRate: 10.93, childRate: 38.1, parentRate: 0.5, cpfp: true, txids: ['aa', 'bb', 'cc'] }],
      },
      note: 'assembled here from getrawmempool(true); it costs the node no extra call',
      assembledLocally: true, source: 'getrawmempool', poolSize: 30768, poolAgeMs: 2276,
    },
  };
  return s;
};

function runMining(snap, label) {
  const { el } = installDom();
  const state = { page: 'mining', node: 'core-main', byNode: new Map(), events: [], snap, series: {}, cfg: { sources: [] } };
  const h = {
    api: async () => ({}), toast: () => {}, state, fmt: F, charts,
    setText: (id, v) => { el(id).textContent = String(v); },
    canvas: (id) => el(id),
    renderFeed: () => {}, render: () => {}, refreshMempoolDetail: () => {}, renderSyncHero: () => {}, peersDetail: async () => [],
  };
  const errs = [];
  for (const [name, fn] of [['renderMining', mining.renderMining], ['renderMiningOverview', mining.renderMiningOverview]]) {
    try { fn(snap, state, h); } catch (err) { errs.push(`${label}/${name}: ${err.message}`); }
  }
  return { errs, el };
}

// -------------------------------------------------------------------- tests

test('every page renderer survives a fully-populated production snapshot', () => {
  const errs = runAllPages(richSnap(), 'rich');
  assert.deepEqual(errs, [], `renderers threw:\n${errs.join('\n')}`);
});

test('every page renderer survives a mid-IBD snapshot', () => {
  const errs = runAllPages(benchSnap(), 'ibd');
  assert.deepEqual(errs, [], `renderers threw:\n${errs.join('\n')}`);
});

test('every page renderer survives an all-null snapshot', () => {
  // The shape a node produces while it is refusing RPC: nothing missing, nothing
  // present. A renderer that assumes a field is there throws here and blanks a page.
  const blank = { id: 'core-main', label: 'x', sync: { node: 'core-main', status: 'unknown' }, online: false, health: {}, log: { ibd: {} }, peers: {}, net: {}, mempool: {}, chainInfo: null, blocks: { recent: [] }, fees: {}, mining: {}, utxo: {}, indexes: null, tips: [], deployments: null, rpcInfo: null, series: {} };
  const errs = runAllPages(blank, 'blank');
  assert.deepEqual(errs, [], `renderers threw:\n${errs.join('\n')}`);
});

test('a page with nothing to show says so, rather than rendering silence', () => {
  const { el } = installDom();
  const state = { page: 'chain', node: 'core-main', byNode: new Map(), events: [], snap: null, series: {}, cfg: { sources: [] } };
  const h = { api: async () => ({}), toast: () => {}, state, fmt: F, charts, setText: () => {}, canvas: (id) => el(id), renderFeed: () => {}, render: () => {}, renderSyncHero: () => {}, peersDetail: async () => [] };
  assert.doesNotThrow(() => panels.renderChain(null, state, h));
  assert.doesNotThrow(() => panels.renderNode(null, state, h));

  // The app's own offline banner must carry words in both no-data cases. A red bar
  // that opens with nothing in it is the failure this whole file exists to prevent.
  const app = fs.readFileSync(path.join(PUB, 'js', 'app.js'), 'utf8');
  assert.match(app, /} else if \(!s\) \{/, 'a null snapshot needs its own branch');
  assert.match(app, /No data from /, 'and that branch must write text into the banner');
  assert.match(app, /getElementById\('offline'\)\.innerHTML = /, 'the banner is written, not merely toggled');
});

test('renderers survive a snapshot whose log-derived half is absent', () => {
  // RPC answering, log silent: every log-backed figure must be absent, not zero.
  const m = monitorWith(RICH, []);
  const snap = m.snapshot({});
  assert.equal(snap.net.inBps ?? null, null, 'no log means no invented bandwidth');
  const errs = runAllPages(snap, 'no-log');
  assert.deepEqual(errs, [], `renderers threw:\n${errs.join('\n')}`);
});

test('the mining page renders without throwing, with data and without it', () => {
  const withData = runMining(snapWithMining(richSnap()), 'mining-data');
  assert.deepEqual(withData.errs, [], 'the mining renderers must not throw on a real-shaped snapshot');
  const empty = runMining(richSnap(), 'no-mining');
  assert.deepEqual(empty.errs, [], 'and not throw when attribution has produced nothing yet');
});

test('THE TELEMETRY PANEL NEVER BLANKS A FIGURE IT ALREADY KNEW', () => {
  // (operator, 2026-09-13: "This section shows info, then it disappears. Can we not make info go
  // away, and just have it updated?")
  //
  // Every figure was re-derived from the frame being painted, so any frame without `app.self` --
  // the first paint before the stream answers, a reconnect, a paused stream -- rewrote the whole
  // block as seven dashes. The numbers were not stale, they were erased, which reads as the panel
  // breaking rather than waiting. A figure must only change when there is a NEW figure.
  const { el } = installDom();
  const state = { page: 'node', node: 'main', byNode: new Map(), events: [], snap: null, series: {}, cfg: { sources: [] } };
  const h = {
    api: async () => ({}), toast: () => {}, state, fmt: F, charts,
    setText: (id, v) => { el(id).innerHTML = String(v); },
    canvas: (id) => el(id),
    renderFeed: () => {}, render: () => {}, renderSyncHero: () => {}, peersDetail: async () => [],
  };
  const frame = (self) => ({
    label: 'n', chain: 'main', rpc: { url: '' },
    app: { uptimeSec: 120, sseClients: 3, ...(self ? { self } : {}) },
  });
  panels.renderNode(frame({ t: 1, rssMb: 88.4, heapMb: 41.2, cpuPct: 2.5, usersActive: 1, eventRate: 0.7 }), state, h);
  const first = el('ndSelf').innerHTML;
  assert.match(first, /88\.4 MB/, 'a good frame shows the reading');
  assert.match(first, /41\.2 MB/);
  assert.match(first, /2\.5%/);

  // THE FRAME THAT USED TO WIPE IT
  panels.renderNode(frame(null), state, h);
  const after = el('ndSelf').innerHTML;
  assert.match(after, /88\.4 MB/, 'a frame with no app.self keeps the last resident reading');
  assert.match(after, /41\.2 MB/, 'and the last heap');
  assert.match(after, /2\.5%/, 'and the last cpu');
  assert.equal(/–/.test(after.replace(/<[^>]*>/g, '')), false, 'and shows no dash where a figure was known');

  // persistence must not mean frozen: a fresh reading still replaces the old one
  panels.renderNode(frame({ t: 2, rssMb: 91, heapMb: 43, cpuPct: 3.1, usersActive: 2, eventRate: 1.4 }), state, h);
  const updated = el('ndSelf').innerHTML;
  assert.match(updated, /91 MB/, 'a fresh reading updates the figure');
  assert.equal(/88\.4 MB/.test(updated), false, 'and the old one is gone');
});

test('an unlabelled block is shown as unlabelled, not as a pool', () => {
  const { el } = runMining(snapWithMining(richSnap()), 'labels');
  const html = el('mnPools').innerHTML + el('ovMiningPools').innerHTML;
  assert.match(html, /unlabelled/, 'the raw tag with no curated match says so');
  assert.match(html, /pools-v2\.json/, 'and the label source travels with the table');
  assert.match(html, /Mined by AntPool971/, 'the coinbase text a pool chose is still on screen');
});

test('no mining data produces words, not a blank card', () => {
  const { el } = runMining(richSnap(), 'no-mining');
  assert.match(el('mnPools').innerHTML, /No blocks attributed yet|attribution/i, 'the empty state explains itself');
});

test('the mining page shows the block being built and names the child-pays-for-parent shape', () => {
  const { el } = runMining(snapWithMining(richSnap()), 'nextblock');
  const flow = el('mnFlow').innerHTML + el('ovTrain').innerHTML;
  assert.match(flow, /being built/, 'the template gets its own card, to the right of the tip');
  // 2026-09-11 the card went compact (operator: "Takes up way too much vertical
  // space"): the fill is a labelled cell of its two-column grid now
  assert.match(flow, /<i>full<\/i><span>40\.8%/, 'and the card says how full the block under construction already is');
  assert.match(flow, /assembled in \d+ms/, 'the card says what assembling it cost, not what the node spent -- it spends nothing now');
  const pkgs = el('mnPackages').innerHTML;
  assert.match(pkgs, /3 tx/, 'the largest package is listed');
  assert.match(pkgs, /10\.93/, 'package feerate is the number that means something for CPFP');
  assert.match(pkgs, /class="cpfp"/, 'the subsidy pattern is marked as such');
  assert.match(pkgs, /getrawmempool/, 'and the panel says which endpoint the graph came from');
  assert.equal(/getblocktemplate/.test(pkgs), false,
    'and no longer names a call this software does not make -- the panel used to tell the operator that getrawmempool carries no depends, which is where the graph now comes from');
});
test('a node in initial sync still draws its block charts, from the blocks it applied', () => {
  // Operator, 2026-09-18, the Core oracle at 99.7% with blocks three weeks old: "Why is this
  // missing data?" The four block charts read the last 24 h of history by block time, which a
  // syncing node does not have; the latest blocks it applied (blocks.recent) carry every figure.
  const { el } = installDom();
  const texts = new Map();
  const state = { page: 'chain', node: 'core-nvme', byNode: new Map(), events: [], snap: null, series: { blocks: {}, node: {} }, cfg: { sources: [] } };
  const h = { api: async () => ({}), toast: () => {}, state, fmt: F, charts, setText: (id, v) => texts.set(id, v), canvas: (id) => el(id), renderFeed: () => {}, render: () => {}, renderSyncHero: () => {}, peersDetail: async () => [] };
  const t0 = Date.now() - 20 * 86400_000;
  const recent = Array.from({ length: 5 }, (_, i) => ({ height: 964_693 - i, t: t0 - i * 600_000, time: (t0 - i * 600_000) / 1000, gapSec: 600, size: 1.5e6, totalfee: 1e6, txs: 6000, sizeBasis: 'total_size' }));
  panels.renderChain({ id: 'core-nvme', sync: {}, tip: { height: 964_693, headers: 967_590 }, blocks: { recent }, series: {} }, state, h);
  for (const id of ['chGapChart', 'chSizeChart', 'chFeeChart', 'chTxChart']) assert.ok(el(id).__hasData, `${id} drew`);
  assert.match(String(texts.get('chSizeSrc')), /latest 5 blocks applied/, 'and says what it is drawing');
});

test('a syncing node draws the blocks sampled across its whole sync, by height, with nothing inferred', () => {
  // Operator, 2026-09-19, run 27 mid-IBD: "Can't we infer the missing data so the graphs are
  // complete?" The 40 newest blocks were two clusters days of block time apart, drawn with a line
  // across the gap. The monitor holds thousands of real blocks from the sync; the charts draw an
  // even sample of those, against height.
  const m = monitorWith(RICH, []);
  m.state.blocks.clear();
  for (let h = 700_000; h < 700_600; h += 3) m.state.blocks.set(h, { height: h, time: 1.6e9 + h, size: h, totalfee: 2 * h, txs: 3, gapSec: null });
  const got = m.blockSamples(50);
  assert.equal(got.held, 200);
  assert.deepEqual([got.from, got.to], [700_000, 700_597]);
  assert.equal(got.points.length, 50, 'evenly spread, no repeats');
  assert.equal(got.points[0].height, 700_000);
  assert.equal(got.points.at(-1).height, 700_597, 'the newest held block is always included');
  assert.ok(got.points.every((p) => p.size === p.height && p.totalfee === 2 * p.height), 'every value is the stored block\'s own');

  const { el } = installDom();
  const texts = new Map();
  const state = { page: 'chain', node: 'bmc', byNode: new Map(), events: [], snap: null, series: { blocks: {}, node: {} }, cfg: { sources: [] }, blockSamples: { node: 'bmc', ...got } };
  const h = { api: async () => ({}), toast: () => {}, state, fmt: F, charts, setText: (id, v) => texts.set(id, v), canvas: (id) => el(id), renderFeed: () => {}, render: () => {}, renderSyncHero: () => {}, peersDetail: async () => [] };
  panels.renderChain({ id: 'bmc', ibd: true, sync: {}, tip: { height: 700_597, headers: 967_000 }, blocks: { recent: [] }, series: {} }, state, h);
  assert.ok(el('chSizeChart').__hasData, 'the size chart drew the samples');
  assert.match(String(texts.get('chSizeSrc')), /50 of 200 blocks sampled · heights 700,000–700,597/);
  // samples for another node are not drawn under this one
  state.blockSamples = { node: 'other', ...got };
  panels.renderChain({ id: 'bmc', ibd: true, sync: {}, tip: { height: 700_597, headers: 967_000 }, blocks: { recent: [] }, series: {} }, state, h);
  assert.doesNotMatch(String(texts.get('chSizeSrc')), /sampled/, 'another node\'s samples are ignored');
});

test('a syncing node samples the whole chain once, behind everything else, and keeps it', async () => {
  // After a restart the live block map is empty, and it evicts oldest-first, so a sync's chart
  // would start at the restart. Once, heights spread from 1 to the tip are asked for.
  const m = monitorWith(RICH, []);
  m.state.blocks.clear();
  m.lastTip = 777_400;
  const asked = [];
  m.rpc.batch = async (calls, opts) => {
    asked.push({ n: calls.length, opts });
    return calls.map((c) => ({ ok: true, result: { height: c.params[0], time: 1.2e9 + c.params[0], total_size: 1000 + c.params[0], totalfee: 7, txs: 2 } }));
  };
  await m.sampleChainHistory(25);
  assert.equal(m.chainSamples.size, 25);
  const hs = [...m.chainSamples.keys()].sort((a, b) => a - b);
  assert.deepEqual([hs[0], hs.at(-1)], [1, 777_400], 'from the first block to the tip');
  assert.ok(asked.every((a) => a.n <= 12 && a.opts.priority === 9 && a.opts.maxWaitMs >= 60_000), 'batched, last in line, not dropped as stale');
  const got = m.blockSamples(300);
  assert.equal(got.held, 25);
  assert.equal(got.points.find((p) => p.height === 1).size, 1001, 'the node\'s own figure for that block');
  asked.length = 0;
  await m.sampleChainHistory(25);
  assert.equal(asked.length, 0, 'and a height it holds is not asked again');
});
