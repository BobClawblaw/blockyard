// THE STREET MAP, BUILT BY THE MONITOR ITSELF (operator, 2026-10-13: "we need to build this feature into BlockYard. Not
// just one-off shit"). One build at a time, started from Display settings → Weather → Build street map (POST
// /api/weather/map/build, the settings-write gate: admin once accounts are on), cancellable, its progress on
// /api/weather/map while it runs and its outcome kept until the next. The work is server/collect/pmextract.js; the
// file lands in <data>/map/ and http/vtiles.js picks it up on the next tile request -- no restart.
//
// This is the one feature that contacts Protomaps (build-metadata.protomaps.dev, build.protomaps.com), and it does so
// only on that click: the monitor never starts a build by itself.
import path from 'node:path';
import { extract } from './pmextract.js';

export class MapBuilder {
  constructor({ dir, log = () => {}, extractImpl = extract, now = Date.now } = {}) {
    this.dir = dir;
    this.log = log;
    this.extract = extractImpl;
    this.now = now;
    this.ctl = null;
    this.state = { running: false, phase: null, done: 0, total: 0, bytes: 0, estBytes: 0, key: null, startedAt: null, place: null, error: null, result: null, finishedAt: null };
  }
  get running() { return this.state.running; }
  view() {
    const s = this.state;
    const elapsed = s.startedAt ? (this.now() - s.startedAt) / 1000 : 0;
    // an estimate only once a fiftieth is done: the first tiles carry the directories' time and read as hours
    const eta = s.running && s.phase === 'tiles' && s.done >= Math.max(20, s.total / 50) && s.total > s.done ? Math.round((elapsed / s.done) * (s.total - s.done)) : null;
    return { ...s, elapsedSec: Math.round(elapsed), etaSec: eta };
  }
  /** Start a build for a place. Refuses while one runs. Resolves when it has STARTED; the outcome is on view(). */
  start({ lat, lon, radiusKm = 60, maxzoom = 15, name = null }) {
    if (this.state.running) throw new Error('a street map is already being built');
    const la = Number(lat), lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 85 || Math.abs(lo) > 180) throw new Error('not a place on Earth');
    // one file per area and depth: a view's fetch beside the place's build, each found by the server's map set
    const out = path.join(this.dir, `${la.toFixed(2)}_${lo.toFixed(2)}_r${Math.round(radiusKm)}_z${maxzoom}.pmtiles`);
    this.ctl = new AbortController();
    this.state = { running: true, phase: 'index', done: 0, total: 0, bytes: 0, estBytes: 0, key: null, startedAt: this.now(), place: { lat: la, lon: lo, radiusKm, maxzoom, name }, error: null, result: null, finishedAt: null, out };
    this.log({ level: 'info', msg: `street map: building ${radiusKm} km round ${la}, ${lo} to zoom ${maxzoom} -> ${out}` });
    this.extract({
      lat: la, lon: lo, radiusKm, maxzoom, out, signal: this.ctl.signal,
      onProgress: (p) => { Object.assign(this.state, { phase: p.phase, done: p.done, total: p.total, bytes: p.bytes, estBytes: p.estBytes, key: p.key }); },
    }).then((r) => {
      Object.assign(this.state, { running: false, phase: 'done', result: { out: r.out, bytes: r.bytes, tiles: r.tiles, key: r.key, requests: r.requests }, finishedAt: this.now() });
      this.log({ level: 'info', msg: `street map: ${path.basename(r.out)} written, ${(r.bytes / 1e6).toFixed(0)} MB, ${r.tiles} tiles from ${r.key}` });
    }).catch((e) => {
      const msg = String(e?.message ?? e);
      Object.assign(this.state, { running: false, phase: msg === 'cancelled' ? 'cancelled' : 'failed', error: msg === 'cancelled' ? null : msg, finishedAt: this.now() });
      this.log({ level: msg === 'cancelled' ? 'info' : 'warn', msg: `street map: build ${msg === 'cancelled' ? 'cancelled' : `failed: ${msg}`}` });
    }).finally(() => { this.ctl = null; });
    return this.view();
  }
  cancel() {
    if (!this.state.running) return false;
    this.ctl?.abort();
    return true;
  }
}
