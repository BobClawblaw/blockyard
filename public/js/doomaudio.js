// THE DOOM SPEAKERS: an AudioWorklet that plays what the emulated Sound Blaster produced
// (public/js/soundcard.js, running in doomworker.js). The worker sends interleaved stereo chunks
// straight to this processor over a MessagePort; the page's thread never touches a sample.
//
// A queue with a ceiling: the machine's clock and the audio clock are both wall time, so they agree
// on average, but a stall on either side leaves one ahead. Too little queued plays silence until the
// next chunk; too much (over a quarter of a second) drops the oldest, so a hitch costs a click, not
// a delay that grows for the rest of the game.
class DoomSpeakers extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.pos = 0;
    this.queued = 0;
    this.port.onmessage = (e) => {
      if (e.data?.port) { e.data.port.onmessage = (m) => this.take(m.data); return; }
      if (e.data?.flush) { this.chunks = []; this.pos = 0; this.queued = 0; }
    };
  }

  take(chunk) {
    if (!(chunk instanceof Float32Array) || chunk.length < 2) return;
    this.chunks.push(chunk);
    this.queued += chunk.length / 2;
    const ceiling = sampleRate / 4;
    while (this.queued > ceiling && this.chunks.length > 1) {
      const old = this.chunks.shift();
      this.queued -= (old.length - this.pos) / 2;
      this.pos = 0;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const l = out[0], r = out[1] ?? out[0];
    for (let i = 0; i < l.length; i++) {
      const c = this.chunks[0];
      if (!c) { l[i] = 0; r[i] = 0; continue; }
      l[i] = c[this.pos]; r[i] = c[this.pos + 1];
      this.pos += 2;
      this.queued--;
      if (this.pos >= c.length) { this.chunks.shift(); this.pos = 0; }
    }
    return true;
  }
}

registerProcessor('doom-speakers', DoomSpeakers);
