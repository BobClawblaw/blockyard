// A stand-in for the Bitcoin node: enough of the JSON-RPC surface, plus a log file in
// the node's own format, so the monitor can be developed, demoed and tested
// without pointing a browser at a mainnet node that is syncing real blocks.
//
// It is honest about being synthetic: `fake:true`, chain "regtest-ish", and it
// answers the same field sets the real node was observed to return (getpeerinfo
// [] while getconnectioncount is non-zero, getnettotals all-zero, mempool
// entries with vsize/weight/time/fees.base and nothing else). Those quirks are
// the interesting part of the integration, so a fake that "worked better" than
// the real thing would test nothing.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SYNTH_TIP = 900000;

export class FakeNode {
  constructor(opts = {}) {
    this.port = opts.port ?? 18331;
    this.host = opts.host ?? '127.0.0.1';
    this.authUser = opts.authUser ?? 'fake';
    this.authPass = opts.authPass ?? 'fake';
    this.logFile = opts.logFile ?? null;
    // IBD mode: start well behind the tip and advance, so the sync bar is seen
    // moving instead of pinned at a boring 100%.
    this.ibd = opts.ibd ?? true;
    this.catchupBlocksPerSec = opts.catchupBlocksPerSec ?? 12;
    this.headers = SYNTH_TIP;
    this.blocks = this.ibd ? Math.floor(SYNTH_TIP * 0.42) : SYNTH_TIP;
    this.startedAt = Date.now();
    this.realBlockTime = 1788826793;
    this.mempool = seedMempool(1200);
    this.bytesSent = 0;
    this.bytesRecv = 0;
    this.prevHash = '0'.repeat(64);
    this.logTimer = null;
    this.requests = 0;
    this.batchRequests = 0;
  }

  start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    return new Promise((resolve, reject) => {
      this.server.once('error', (err) => reject(new Error(
        err.code === 'EADDRINUSE'
          ? `fake node could not bind ${this.host}:${this.port} - something is already listening there (set FAKE_PORT=<port> to pick another)`
          : `fake node could not bind ${this.host}:${this.port}: ${err.message}`,
      )));
      this.server.listen(this.port, this.host, () => resolve(this));
    });
  }

  stop() {
    if (this.logTimer) clearInterval(this.logTimer);
    return new Promise((resolve) => (this.server ? this.server.close(resolve) : resolve()));
  }

  get url() { return `http://${this.host}:${this.port}`; }

  handle(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      this.requests += 1;
      const auth = req.headers.authorization ?? '';
      const want = Buffer.from(`${this.authUser}:${this.authPass}`).toString('base64');
      if (!auth.endsWith(want)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fake"' });
        return res.end('unauthorized');
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ result: null, error: { code: -32700, message: 'parse error' }, id: null }));
      }
      const isBatch = Array.isArray(body);
      if (isBatch) this.batchRequests += 1;
      const items = isBatch ? body : [body];
      const replies = items.map((it) => this.reply(it));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(isBatch ? replies : replies[0]));
    });
  }

  reply(it) {
    if (it.method === 'estimatesmartfee') {
      // The targets all arrive as separate batch elements; answer per element.
      const t = it.params?.[0] ?? 6;
      const base = { 1: 0.000032, 2: 0.0000215, 6: 0.00001506, 24: 0.00000921, 144: 0.00000605 }[t] ?? 0.00001;
      return { result: { feerate: jitter(base, 0.06), blocks: t }, error: null, id: it.id };
    }
    const fn = this.methods[it.method];
    if (!fn) return { result: null, error: { code: -32601, message: `Method not found: ${it.method}` }, id: it.id };
    try {
      return { result: fn.call(this, ...(it.params ?? [])), error: null, id: it.id };
    } catch (err) {
      return { result: null, error: { code: err.code ?? -1, message: err.message }, id: it.id };
    }
  }

  /**
   * Height from a height or a hash.
   *
   * hashFor() is one-way, so the reverse lookup is a bounded scan of the recent
   * chain -- 3,000 hash computations, which is nothing next to what it buys: the
   * drill-down (/api/block?hash=…) and its tests need hash -> height to work
   * against the fake without the fake keeping a table of every block it invented.
   */
  resolveHeight(heightOrHash) {
    if (typeof heightOrHash === 'number' && Number.isFinite(heightOrHash)) return heightOrHash;
    const want = String(heightOrHash ?? '');
    if (!/^[0-9a-fA-F]{64}$/.test(want)) return null;
    const from = Math.max(0, this.blocks - 3000);
    for (let h = this.blocks; h >= from; h--) if (hashFor(h) === want) return h;
    return null;
  }

  /** The same txid list getblock() reports for this height, derived identically. */
  txidsOf(h) {
    if (!Number.isFinite(h) || h < 1 || h > this.blocks) return [];
    const seed = hashFor(h);
    const rnd = mulberry(seedNum(seed));
    const txCount = Math.min(600, 2500 + Math.floor(rnd() * 5000));
    return Array.from({ length: txCount }, (_, i) => hashFor(seedNum(seed) * 1009 + i * 31 + 7));
  }

  get methods() {
    const self = this;
    return {
      help() { return { fake: true, methods: Object.keys(self.methods).sort() }; },
      uptime() { return Math.floor((Date.now() - self.startedAt) / 1000) + 51321; },
      getconnectioncount() { return 13; },
      getblockchaininfo() {
        return {
          chain: 'regtest',
          blocks: self.blocks,
          headers: self.headers,
          bestblockhash: hashFor(self.blocks),
          bits: '207fffff',
          difficulty: 127450789715843.1,
          time: self.realBlockTime - (self.headers - self.blocks) * 600,
          mediantime: self.realBlockTime - (self.headers - self.blocks) * 600 - 3100,
          verificationprogress: Math.min(1, self.blocks / self.headers * 0.999 + 0.001),
          initialblockdownload: self.blocks < self.headers,
          chainwork: '0'.repeat(24) + (self.blocks * 2).toString(16).padStart(8, '0'),
          size_on_disk: 767108807210 - (self.headers - self.blocks) * 1_000_000,
          pruned: false,
          warnings: [],
          fake: true,
        };
      },
      getmempoolinfo() {
        const bytes = self.mempool.reduce((a, t) => a + t.vsize, 0);
        const usage = bytes * 3.2;
        return {
          loaded: true, size: self.mempool.length, bytes, usage: Math.round(usage),
          total_fee: +(self.mempool.reduce((a, t) => a + t.feeBtc, 0)).toFixed(8),
          maxmempool: 314572800, mempoolminfee: 0.000001, minrelaytxfee: 0.000001,
          incrementalrelayfee: 0.000001, unbroadcastcount: 0, permitbaremultisig: true,
          maxdatacarriersize: 100000,
        };
      },
      getrawmempool(verbose = false) {
        if (!verbose) return self.mempool.map((t) => t.txid);
        // Exactly the field set the real node returns -- no depends, no
        // ancestorcount, no modifiedfees.
        return Object.fromEntries(self.mempool.map((t) => [t.txid, {
          vsize: t.vsize, weight: t.vsize * 4, time: t.time, fees: { base: t.feeBtc },
        }]));
      },
      getnetworkinfo() {
        return {
          version: 1, subversion: '/BitcoinMachineCode:0.0.1/fake/', protocolversion: 70016,
          localservices: '0000000000000009', localservicesnames: ['NETWORK', 'WITNESS'],
          localrelay: true, timeoffset: 0, networkactive: true,
          connections: 13, connections_in: 0, connections_out: 13,
          networks: [
            { name: 'ipv4', limited: false, reachable: true, proxy: '', proxy_randomize_credentials: false },
            { name: 'ipv6', limited: false, reachable: false, proxy: '', proxy_randomize_credentials: false },
            { name: 'onion', limited: false, reachable: false, proxy: '', proxy_randomize_credentials: false },
            { name: 'i2p', limited: false, reachable: false, proxy: '', proxy_randomize_credentials: false },
            { name: 'cjdns', limited: false, reachable: true, proxy: '', proxy_randomize_credentials: false },
          ],
          relayfee: 0.000001, incrementalfee: 0.000001, localaddresses: [], warnings: [],
        };
      },
      getmininginfo() {
        return { blocks: self.blocks, bits: '207fffff', difficulty: 127450789715843.1, networkhashps: 8.519e20, pooledtx: self.mempool.length, chain: 'regtest', warnings: [] };
      },
      getnettotals() {
        // Deliberately all-zero, like the live node: this is the quirk that
        // forces the bandwidth panel to rely on the log.
        return {
          totalbytesrecv: 0, totalbytessent: 0, timemillis: Date.now(),
          uploadtarget: { timeframe: 86400, target: 0, target_reached: false, serve_historical_blocks: true, bytes_left_in_cycle: 0, time_left_in_cycle: 0 },
        };
      },
      // The real node answers [] here while reporting 13 connections. Keep that.
      getpeerinfo() { return []; },
      getchaintips() { return [{ height: self.blocks, hash: hashFor(self.blocks), branchlen: 0, status: 'active' }]; },
      getindexinfo() {
        return {
          txindex: { synced: true, best_block_height: self.blocks },
          'basic block filter index': { synced: false, best_block_height: self.blocks - 1634 },
          coinstatsindex: { synced: false, best_block_height: self.blocks - 80 },
        };
      },
      gettxoutsetinfo() {
        return {
          height: self.blocks - 73, bestblock: hashFor(self.blocks - 73), txouts: 165316904 + Math.floor(Math.random() * 4000),
          bogosize: 12950262954, muhash: '9ddbf44fac20436426429fa6cd260dc8fd11a8603c101d8e2bd88af8f683282a',
          total_amount: 20080751.13288641,
        };
      },
      getchaintxstats(nblocks = 120) {
        return {
          time: self.realBlockTime, txcount: 1434232299 + self.blocks,
          window_final_block_hash: hashFor(self.blocks), window_final_block_height: self.blocks,
          window_block_count: nblocks, window_tx_count: 600000 + Math.floor(Math.random() * 40000),
          window_interval: nblocks * 600, txrate: +(2.4 + Math.random() * 0.8).toFixed(4),
        };
      },
      getdeploymentinfo() {
        return {
          hash: hashFor(self.blocks), height: self.blocks,
          deployments: {
            bip34: { active: true, height: 1, signalling_since: null },
            segwit: { active: true, height: 830000, signalling_since: 481824 },
            taproot: { active: true, height: 709632, signalling_since: 709632 },
          },
        };
      },
      getrpcinfo() {
        return { active_commands: [{ method: 'getrpcinfo', duration: 0 }], logpath: '/tmp/fake-bitcoind.log' };
      },
      getblockstats(heightOrHash) {
        const h = self.resolveHeight(heightOrHash);
        if (h > self.blocks || h < 1) { const e = new Error(`No such block (height ${h})`); e.code = -8; throw e; }
        const seed = hashFor(h);
        const rnd = mulberry(seedNum(seed));
        const txs = 2500 + Math.floor(rnd() * 5000);
        const size = 300000 + Math.floor(rnd() * 1400000);
        const totalfee = 200000 + Math.floor(rnd() * 2500000);
        return {
          avgfee: Math.round(totalfee / txs), avgfeerate: Math.round(totalfee / (size / 1000)),
          avgtxsize: Math.round(size / txs),
          blockhash: seed, height: h,
          ins: Math.floor(txs * 1.2), maxfee: totalfee, maxfeerate: 40 + Math.floor(rnd() * 400),
          maxtxsize: Math.round(size / 40), medianfee: 40 + Math.floor(rnd() * 60),
          mediantime: self.realBlockTime - (self.blocks - h) * 600, mediantxsize: 220,
          minfee: 14, minfeerate: 0, mintxsize: 150,
          outs: Math.floor(txs * 2.1), subsidy: 312500000,
          swtotal_size: Math.floor(size * 0.98), swtotal_weight: Math.floor(size * 4.6), swtxs: Math.floor(txs * 0.98),
          time: self.realBlockTime - (self.blocks - h) * 600,
          total_out: 4.26e11, total_size: size, total_weight: Math.floor(size * 2.49),
          totalfee, txs, utxo_increase: Math.floor(txs * 0.96), utxo_size_inc: 400000,
          feerate_percentiles: [0, 1, 1, Math.round(rnd() * 4), Math.round(2 + rnd() * 60)],
        };
      },
      getblockhash(h) {
        if (h < 1 || h > self.blocks) { const e = new Error('Block height out of range'); e.code = -8; throw e; }
        return hashFor(h);
      },
      /**
       * getblock, verbosity 0 and 1 only.
       *
       * verbosity 2 deliberately REFUSES, in the same spirit as the zeroed
       * getnettotals: the real node answers ~11 MB of hex for one block (MEASUREMENTS
       * §6), so a fake that answered it politely would let a caller get away with the
       * most expensive call in this API. A test can now prove the monitor never asks.
       */
      getblock(hash, verbosity = 1) {
        const h = self.resolveHeight(hash);
        if (h == null || h < 1 || h > self.blocks) { const e = new Error(`Block not found (hash ${String(hash).slice(0, 16)}…)`); e.code = -5; throw e; }
        if (verbosity >= 2) { const e = new Error('verbosity 2 is not simulated: the real node returns ~11 MB of hex per block and omits fee/deltafee anyway'); e.code = -8; throw e; }
        const seed = hashFor(h);
        const rnd = mulberry(seedNum(seed));
        const txCount = Math.min(600, 2500 + Math.floor(rnd() * 5000));
        const tx = Array.from({ length: txCount }, (_, i) => hashFor(seedNum(seed) * 1009 + i * 31 + 7));
        const time = self.realBlockTime - (self.blocks - h) * 600;
        if (verbosity === 0) return seed;
        return {
          hash: seed, confirmations: self.blocks - h + 1, height: h, version: 548044800, versionHex: '20aa8000',
          merkleroot: hashFor(seedNum(seed) * 977 + 3), time, mediantime: time - 600,
          nonce: 187462942, bits: '207fffff', difficulty: 1,
          chainwork: '0'.repeat(64), nTx: tx.length,
          previousblockhash: h > 1 ? hashFor(h - 1) : undefined,
          size: 300000 + Math.floor(rnd() * 1400000), weight: Math.floor((300000 + Math.floor(rnd() * 1400000)) * 4),
          tx,
        };
      },
      /**
       * getrawtransaction with verbosity 1: the mempool first, then the block the
       * caller names (matching Core, which needs the block hash for anything that has
       * left the pool). Unknown ids fail the way Core fails, with -5.
       */
      getrawtransaction(txid, verbose = false, blockHash = null) {
        const inPool = self.mempool.find((t) => t.txid === txid);
        const h = blockHash ? self.resolveHeight(blockHash) : null;
        const blockTx = h != null ? self.txidsOf(h).includes(txid) : false;
        if (!inPool && !blockTx) {
          const e = new Error('Transaction not found'); e.code = -5; throw e;
        }
        const seed = seedNum(txid);
        const rnd = mulberry(seed);
        const vin = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, i) => ({
          txid: i === 0 && blockTx ? '00'.repeat(32) : hashFor(seed * 7 + i),
          vout: i,
          sequence: 4294967293,
          scriptSig: { asm: '', hex: '' },
          txinwitness: ['30440220' + txid.slice(0, 56), '02' + txid.slice(0, 62)],
        }));
        const vout = Array.from({ length: 2 + Math.floor(rnd() * 3) }, (_, i) => ({
          value: +(rnd() * 0.5).toFixed(8), n: i,
          scriptPubKey: { asm: `OP_DUP OP_HASH160 ${txid.slice(0, 40)} OP_EQUALVERIFY OP_CHECKSIG`, hex: '76a914' + txid.slice(0, 40) + '88ac', reqSigs: 1, type: 'pubkeyhash', addresses: [`bc1q${txid.slice(0, 38)}`] },
        }));
        const decoded = {
          txid, hash: txid, version: 2, size: 110 + vin.length * 40 + vout.length * 34, vsize: 92 + vin.length * 26 + vout.length * 31,
          weight: 400 + vin.length * 104 + vout.length * 124, locktime: 0, vin, vout,
        };
        if (blockTx) {
          decoded.blockhash = blockHash;
          decoded.height = h;
          decoded.confirmations = self.blocks - h + 1;
          decoded.blocktime = self.realBlockTime - (self.blocks - h) * 600;
          decoded.time = decoded.blocktime;
        }
        return verbose ? decoded : 'rawhex';
      },
      getblockheader(h) {
        const hh = typeof h === 'number' ? h : self.blocks;
        return { hash: hashFor(hh), confirmations: 1, height: hh, version: 548044800, versionHex: '20aa8000', merkleroot: hashFor(hh + 1), time: self.realBlockTime, mediantime: self.realBlockTime - 3000, nonce: 1, bits: '207fffff', target: '7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', difficulty: 1, chainwork: '0'.repeat(32), nTx: 1, previousblockhash: hashFor(hh - 1) };
      },
      sendrawtransaction(hexstring) {
        if (self.sentRefuse) { const e = new Error('Transaction rejected'); e.code = -25; throw e; }
        if (typeof hexstring !== 'string' || hexstring.length < 20) { const e = new Error('TX decode failed'); e.code = -22; throw e; }
        return hashFor(crc32(hexstring));
      },
      testmempoolaccept(rawtxs = []) {
        return rawtxs.map((hex) => ({ txid: hashFor(crc32(hex)), wtxid: hashFor(crc32(hex) + 1), vsize: 140, fees: { base: 0.000002 }, 'allowed-tools': [], allowed: true }));
      },
      savemempool() { return null; },
      estimatesmartfee(target = 6) { return { feerate: 0.00001506, blocks: target }; },
    };
  }

  // Drive the chain forward and emit node-shaped log lines, so the tailer, the
  // parsers and the sync bar all have something live to chew on.
  startTicker({ intervalMs = 1000, logEveryMs = 2000 } = {}) {
    let lastTick = Date.now();
    let carryBlocks = 0;
    let lastLog = 0;
    let totalNet = 0;
    let totalDisk = 0;
    const peers = ['136.38.88.88:8333', '193.223.81.8:8333', '186.226.151.18:8333', '208.161.116.211:8333', '46.172.230.198:8333', '69.9.138.92:8333'];
    this.timer = setInterval(() => {
      const now = Date.now();
      const dt = (now - lastTick) / 1000;
      lastTick = now;
      if (this.blocks < this.headers) {
        carryBlocks += this.catchupBlocksPerSec * dt;
        const step = Math.floor(carryBlocks);
        if (step > 0) { carryBlocks -= step; this.blocks = Math.min(this.headers, this.blocks + step); }
      }
      churnMempool(this.mempool);
      if (now - lastLog >= logEveryMs) {
        lastLog = now;
        const rate = this.blocks < this.headers ? 380_000 + Math.random() * 90_000 : 220 + Math.random() * 900;
        const tickBytes = rate * (logEveryMs / 1000);
        totalNet += tickBytes;
        totalDisk += tickBytes * 0.98;
        const lines = [];
        lines.push(`[dlc] -- network recv this tick: ${human(tickBytes)} (${human(rate)}/s) | total recv: ${human(totalNet)} || disk write this tick: ${human(tickBytes * 0.98)} (${human(rate * 0.98)}/s) | total written: ${human(totalDisk)} --`);
        lines.push(`[dlc] -- peers banned this run: ${Math.floor(Math.random() * 3)} of ${100 + Math.floor(Math.random() * 20)} --`);
        lines.push(`[tx_accept] last ${Math.round(logEveryMs / 1000)}s: +${Math.floor(Math.random() * 30)} accepted (mempool ${this.mempool.length}) | rejected: ${Math.floor(Math.random() * 40)} missing-inputs, 0 invalid, ${Math.floor(Math.random() * 6)} policy | 0 already confirmed`);
        const legs = peers.slice(0, 4 + Math.floor(Math.random() * 2)).map((p, i) => `${i}:${p} +${1 + Math.floor(Math.random() * 25)}`).join(', ');
        lines.push(`[txrelay] last ${Math.round(logEveryMs / 1000)}s: +${Math.floor(Math.random() * 90)} tx accepted via legs [${legs}] (mempool ${this.mempool.length})`);
        if (Math.random() < 0.18) lines.push(`[dial] ${randAddr()} connected over v2`);
        // The identity lines. They are the only place this node's user agent, protocol
        // version and peer-side height appear at all (getpeerinfo answers [] on the
        // deployed build), and the peers page now has a table for them -- so the fake
        // has to print them or that table is exercised by nobody.
        if (Math.random() < 0.25) {
          const p = peers[Math.floor(Math.random() * peers.length)];
          const n = 1 + Math.floor(Math.random() * 8);
          lines.push(`[dl] outbound ${n} = ${p.replace(/:\d+$/, ':8333')} (fd ${60 + n}) proto=70016 services=0xc49 ua="/Satoshi:3${1 + Math.floor(Math.random() * 4)}.0.0/" height=${this.headers - Math.floor(Math.random() * 5)} addrv2=1`);
        }
        if (Math.random() < 0.12) lines.push(`[dl:2] ${randAddr()}:8333 connection dropped (revents 0x11); re-dialing`);
        this.log(lines.join('\n') + '\n');
      }
      this.emitHeartbeat();
    }, intervalMs);
    this.timer.unref?.();
    return this;
  }

  emitHeartbeat() {
    if (!this.logFile) return;
    const up = Math.floor((Date.now() - this.startedAt) / 1000) + 51321;
    this.log(`[dl] heartbeat: tip=${this.blocks} peers=12/16 txouts=165335351 uptime=${fmtUptime(up)}\n`);
  }

  log(line) {
    if (!this.logFile) return;
    try {
      const stamp = new Date().toISOString().replace('T', ' ').slice(0, 23);
      fs.appendFileSync(this.logFile, line.trimEnd().split('\n').map((l) => `${stamp} ${l}`).join('\n') + '\n');
    } catch { /* the monitor must not die because a fixture could not be written */ }
  }

  // Advance one block on demand, for tests that need a deterministic tip change.
  mine(count = 1) {
    this.blocks = Math.min(this.headers, this.blocks + count);
    return this.blocks;
  }
}

// ---------------------------------------------------------------- fixtures

function seedMempool(n) {
  const out = [];
  const now = Math.floor(Date.now() / 1000);
  let rnd = mulberry(12345);
  for (let i = 0; i < n; i++) {
    // A long-tailed feerate distribution, because that is what a real pool looks
    // like and a uniform one would make the log histogram look wrong.
    const u = rnd();
    const feerate = 0.5 * Math.exp(u * Math.log(1200));
    const vsize = 100 + Math.floor(rnd() * 900);
    out.push({
      txid: hexn(64, i * 7919 + Math.floor(rnd() * 1e6)),
      vsize,
      feeBtc: +(feerate * vsize / 1e8).toFixed(8),
      time: now - Math.floor(Math.pow(rnd(), 2) * 3 * 86400),
    });
  }
  return out;
}

function churnMempool(pool) {
  const now = Math.floor(Date.now() / 1000);
  const add = Math.floor(Math.random() * 25);
  for (let i = 0; i < add; i++) {
    const vsize = 100 + Math.floor(Math.random() * 900);
    const feerate = 0.5 * Math.exp(Math.random() * Math.log(1500));
    pool.push({ txid: hexn(64, Date.now() + i * 31 + Math.floor(Math.random() * 1e6)), vsize, feeBtc: +(feerate * vsize / 1e8).toFixed(8), time: now });
  }
  const drop = Math.floor(Math.random() * 20);
  for (let i = 0; i < drop && pool.length > 200; i++) pool.splice(Math.floor(Math.random() * pool.length), 1);
  if (pool.length > 6000) pool.splice(0, pool.length - 6000);
}

function jitter(v, pct) { return +(v * (1 + (Math.random() - 0.5) * 2 * pct)).toFixed(8); }

function human(bytes) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i += 1; }
  return i === 0 ? `${Math.round(v)}${u[i]}` : `${v.toFixed(1)}${u[i]}`;
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [d, h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
}

function randAddr() {
  return `${Math.floor(Math.random() * 223) + 1}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 254) + 1}`;
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedNum(hex) {
  let n = 0;
  for (let i = 0; i < Math.min(8, hex.length); i++) n = (n * 33 + hex.charCodeAt(i)) >>> 0;
  return n;
}

function hexn(len, seed) {
  const rnd = mulberry(seed >>> 0);
  let out = '';
  while (out.length < len) out += Math.floor(rnd() * 16).toString(16);
  return out.slice(0, len);
}

function hashFor(height) {
  // Deterministic per height, and leading-zero shaped like a real hash so the UI
  // looks like it is talking to a node.
  const body = hexn(58, (height >>> 0) * 2654435761);
  return `0000000000${body}`.slice(0, 64);
}

function crc32(str) {
  let c = 0xffffffff;
  for (let i = 0; i < str.length; i++) {
    c ^= str.charCodeAt(i);
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

export async function startFakeNode(opts) {
  const n = new FakeNode(opts);
  if (n.logFile) {
    try { fs.mkdirSync(path.dirname(n.logFile), { recursive: true }); } catch { /* exists */ }
  }
  await n.start();
  n.startTicker();
  return n;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const port = Number(process.env.FAKE_PORT || 18331);
  const logFile = process.env.FAKE_LOG || '/tmp/blockyard-fake/bitcoin.main.log';
  const node = await startFakeNode({ port, logFile, ibd: process.env.FAKE_IBD !== '0' });
  process.stdout.write(`fake node on ${node.url} (cookie ${node.authUser}:${node.authPass}; log ${logFile}; ibd=${node.ibd})\n`);
  const bye = () => node.stop().then(() => process.exit(0));
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
