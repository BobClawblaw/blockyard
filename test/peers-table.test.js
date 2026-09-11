// The Peers page shows what getpeerinfo publishes (operator, 2026-09-11: "Doesn't the
// bmc rpc pull more info for peers now?"). Addresses here are documentation ranges.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as fmt from '../public/js/fmt.js';

const { withPeerRates } = await import('../server/collect/monitor.js');
const { peerTableHtml } = await import('../public/js/panels.js');

test('per-peer rates come from successive samples of the same peer', () => {
  const t0 = 1_000_000;
  let r = withPeerRates([{ id: 1, bytesrecv: 1000, bytessent: 500 }, { id: 2, bytesrecv: 10, bytessent: 10 }], undefined, t0);
  assert.equal(r.rows[0].recvRate, null, 'a peer seen once has no rate yet: null, not zero');
  r = withPeerRates([{ id: 1, bytesrecv: 16000, bytessent: 2000 }, { id: 3, bytesrecv: 5, bytessent: 5 }], r.prev, t0 + 15000);
  assert.equal(r.rows[0].recvRate, 1000, '15,000 bytes in 15 s');
  assert.equal(r.rows[0].sentRate, 100);
  assert.equal(r.rows[1].recvRate, null, 'a new peer starts without one');
  const quick = withPeerRates([{ id: 1, bytesrecv: 16100, bytessent: 2010 }], r.prev, t0 + 15200);
  assert.equal(quick.rows[0].recvRate, 1000, 'a second read within a second keeps the last rate');
  r = withPeerRates([{ id: 1, bytesrecv: 50, bytessent: 50 }], r.prev, t0 + 30000);
  assert.equal(r.rows[0].recvRate, null, 'a counter that went backwards (the id reused) has no rate');
});

test('the Peers page draws the table the node publishes, most bytes received first', () => {
  const now = 2_000_000_000_000;
  const sec = now / 1000;
  const rows = [
    { id: 1, addr: '203.0.113.7:8333', network: 'ipv4', subver: '/Satoshi:27.0.0/', version: 70016, inbound: false, conntime: sec - 3600, lastrecv: sec - 2, lastsend: sec - 5,
      bytesrecv: 5e6, bytessent: 1e6, recvRate: 1200, sentRate: 300, synced_blocks: 100, synced_headers: 100, timeoffset: 0, relaytxes: true, permissions: [] },
    { id: 2, addr: '198.51.100.9:8333', network: 'ipv4', subver: '/Satoshi:26.0.0/', version: 70016, inbound: true, conntime: sec - 60, lastrecv: sec - 1, lastsend: sec - 1,
      bytesrecv: 9e6, bytessent: 2e6, recvRate: null, sentRate: null, synced_blocks: 95, synced_headers: 100, timeoffset: -1, relaytxes: false, permissions: ['noban'] },
  ];
  const html = peerTableHtml(rows, fmt, { now, tip: 100 });
  assert.ok(html.indexOf('198.51.100.9') < html.indexOf('203.0.113.7'), 'most bytes received first');
  for (const s of ['Satoshi:27.0.0', '1h 0m', '1.2 KB/s', '5.0 MB', '>tip<', '−5', 'blocks only', 'noban', '>in<', '>out<', '2s']) assert.ok(html.includes(s), `shows ${s}`);
  assert.equal(peerTableHtml([], fmt), '', 'nothing to draw, no table');
  // this build answers synced_* -1: the height at connect stands in, with the blocks since
  const live = peerTableHtml([{ ...rows[0], synced_blocks: -1, synced_headers: -1, startingheight: 966502, servicesnames: ['NETWORK', 'WITNESS', 'COMPACT_FILTERS', 'NETWORK_LIMITED', 'P2P_V2'] }], fmt, { now, tip: 966527 });
  for (const s of ['966,502', '+25', '>v2<', '>filters<', '>pruned<']) assert.ok(live.includes(s), `shows ${s}`);
  assert.ok(!live.includes('>network<') && !live.includes('WITNESS'), 'and not the services every peer has');
});

test('the rows are fetched every 15 s onto state, not keyed on the 1 s snapshot', () => {
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.ok(!/__peerRows/.test(app), 'no rows riding the snapshot (keying on it re-fetched /api/peers every frame)');
  assert.match(app, /Date\.now\(\) - peersFetchedAt >= 15_000/);
  assert.match(app, /state\.peerRows = d\.rpcPeers \?\? \[\]/);
});

test('the Peers page is one strip and then the table, so peers are on screen without scrolling', () => {
  // (operator, 2026-09-11: "We need to really compress the panels in this screen to show more
  // data. I don't want to have to scroll down to see the primary information for that tab")
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const at = html.indexOf('<section class="page" data-page="peers">');
  const sec = html.slice(at, html.indexOf('</section>', at));
  assert.equal((sec.match(/<canvas/g) || []).length, 1, 'one history chart, not two of the same 24 h');
  assert.equal((sec.match(/>Connections </g) || []).length, 1, 'one Connections card, not two with the same count');
  assert.ok(sec.indexOf('class="prtop"') < sec.indexOf('id="prTable"'), 'the strip, then the table');
  assert.equal((sec.match(/<div/g) || []).length, (sec.match(/<\/div>/g) || []).length, 'and every div closed (the old grid never was)');
  const panels = readFileSync(new URL('../public/js/panels.js', import.meta.url), 'utf8');
  assert.match(panels, /\.filter\(\(\[, v\]\) => v != null\)/, 'the budget lists only what the node reports');
});
