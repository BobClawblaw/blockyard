// SPDX-License-Identifier: Apache-2.0
//
// zmq.js -- a ZeroMQ SUB socket over plain TCP, enough to read a Bitcoin node's notifications
// (operator, 2026-09-30: "How do we get more granularity, like mempool does over websocket, pushing
// changes" -- then "go ahead, bmc first"). Zero dependencies, so this speaks ZMTP 3.0 itself:
//
//   greeting   64 bytes: signature FF 00*8 7F, version 3.0, mechanism "NULL" padded to 20, as-server 0,
//              31 bytes of filler -- the same both ways
//   handshake  a READY command carrying Socket-Type = SUB; the peer sends its own READY
//   subscribe  a MESSAGE frame whose body is 0x01 + the topic (ZMTP 3.0's form; a 3.1 peer such as
//              libzmq accepts it from a peer that announced 3.0)
//   frames     flags (bit 0 MORE, bit 1 LONG size, bit 2 COMMAND), then a 1- or 8-byte size, then the body
//
// A node publishes each notification as three frames: the topic, the body, and a 4-byte
// little-endian counter per topic that goes up by one each message -- how a subscriber knows it
// missed one. That counter is handed on as `seq`; what to do about a gap is the caller's business.
//
// The socket reconnects by itself (1 s, doubling to 30 s) and says so through `onState`.
import net from 'node:net';

const GREETING = (() => {
  const g = Buffer.alloc(64);
  g[0] = 0xff; g[9] = 0x7f;       // signature
  g[10] = 3; g[11] = 0;           // version 3.0
  g.write('NULL', 12, 'ascii');   // mechanism, zero-padded to 20
  return g;                       // as-server 0 and the filler are zeros
})();

function frame(body, { command = false, more = false } = {}) {
  const long = body.length > 255;
  const head = Buffer.alloc(long ? 9 : 2);
  head[0] = (more ? 1 : 0) | (long ? 2 : 0) | (command ? 4 : 0);
  if (long) head.writeBigUInt64BE(BigInt(body.length), 1); else head[1] = body.length;
  return Buffer.concat([head, body]);
}

/** The READY command a SUB socket sends: name, then each property as name-length, name, value-length (BE32), value. */
export function readyCommand(socketType = 'SUB') {
  const name = Buffer.from('READY', 'ascii');
  const key = Buffer.from('Socket-Type', 'ascii');
  const val = Buffer.from(socketType, 'ascii');
  const vlen = Buffer.alloc(4); vlen.writeUInt32BE(val.length);
  return frame(Buffer.concat([Buffer.from([name.length]), name, Buffer.from([key.length]), key, vlen, val]), { command: true });
}
export function subscribeFrame(topic) { return frame(Buffer.concat([Buffer.from([1]), Buffer.from(topic, 'ascii')])); }

/**
 * Split a byte stream into frames. Returns { frames, rest }: the whole frames found, and the bytes
 * of a frame not yet complete, to be prefixed to the next chunk. Pure.
 */
export function parseFrames(buf) {
  const frames = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const flags = buf[i];
    const long = (flags & 2) !== 0;
    const headLen = long ? 9 : 2;
    if (i + headLen > buf.length) break;
    const size = long ? Number(buf.readBigUInt64BE(i + 1)) : buf[i + 1];
    if (i + headLen + size > buf.length) break;
    frames.push({ more: (flags & 1) !== 0, command: (flags & 4) !== 0, body: buf.subarray(i + headLen, i + headLen + size) });
    i += headLen + size;
  }
  return { frames, rest: buf.subarray(i) };
}

/**
 * A Bitcoin node's `sequence` notification body: the 32-byte hash, a label -- A (added to the mempool),
 * R (removed, for any reason but a block), C (block connected), D (block disconnected) -- and for A and
 * R the mempool's own sequence number, 8 bytes little-endian. The hash arrives in the order RPC prints
 * it (verified against getrawmempool on bmc and Core, 2026-09-30). Null when the body is not one.
 */
export function parseSequence(body) {
  if (!body || body.length < 33) return null;
  const hash = Buffer.from(body.subarray(0, 32)).toString('hex');
  const label = String.fromCharCode(body[32]);
  if (!'ARCD'.includes(label)) return null;
  const mempoolSeq = (label === 'A' || label === 'R') && body.length >= 41 ? Number(body.readBigUInt64LE(33)) : null;
  return { hash, label, mempoolSeq };
}

/**
 * Subscribe to `topics` at `address` ("tcp://127.0.0.1:28334"). `onMessage(topic, body, seq)` for
 * each notification; `onState({ up, error })` when the connection comes or goes. Returns { close }.
 */
export function subscribe(address, topics, { onMessage, onState = () => {}, connect = net.connect, minDelay = 1000, maxDelay = 30_000 } = {}) {
  const m = /^tcp:\/\/([^:]+):(\d+)$/.exec(String(address));
  if (!m) throw new Error(`not a tcp:// address: ${address}`);
  const host = m[1], port = Number(m[2]);
  let sock = null, closed = false, timer = null, delay = minDelay;
  const open = () => {
    if (closed) return;
    let buf = Buffer.alloc(0), greeted = false, ready = false, parts = [];
    const s = connect({ host, port });
    sock = s;
    s.setNoDelay?.(true);
    s.on('connect', () => { s.write(GREETING); s.write(readyCommand('SUB')); });
    s.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      if (!greeted) {
        if (buf.length < 64) return;
        if (buf[0] !== 0xff || buf[9] !== 0x7f || buf[10] < 3) { s.destroy(new Error('not a ZMTP 3 peer')); return; }
        greeted = true;
        buf = buf.subarray(64);
      }
      const { frames, rest } = parseFrames(buf);
      buf = Buffer.from(rest);
      for (const f of frames) {
        if (f.command) {
          const nameLen = f.body[0];
          const name = f.body.subarray(1, 1 + nameLen).toString('ascii');
          if (name === 'READY' && !ready) {
            ready = true;
            delay = minDelay;
            for (const t of topics) s.write(subscribeFrame(t));
            onState({ up: true });
          } else if (name === 'ERROR') {
            s.destroy(new Error(`peer error: ${f.body.subarray(2 + nameLen).toString('ascii')}`));
          }
          continue;
        }
        parts.push(f.body);
        if (f.more) continue;
        const [topic, body, seqBuf] = parts;
        parts = [];
        if (!topic || !body) continue;
        const seq = seqBuf && seqBuf.length === 4 ? seqBuf.readUInt32LE(0) : null;
        try { onMessage(topic.toString('ascii'), body, seq); } catch { /* a handler's fault must not drop the socket */ }
      }
    });
    const down = (err) => {
      if (sock !== s) return;
      sock = null;
      if (ready) onState({ up: false, error: err?.message ?? 'closed' });
      else onState({ up: false, error: err?.message ?? 'closed before the handshake' });
      if (closed) return;
      timer = setTimeout(open, delay);
      timer.unref?.();
      delay = Math.min(maxDelay, delay * 2);
    };
    s.on('error', down);
    s.on('close', () => down(null));
  };
  open();
  return { close() { closed = true; clearTimeout(timer); sock?.destroy(); sock = null; } };
}
