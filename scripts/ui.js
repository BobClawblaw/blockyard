// THE INSTALLER'S TERMINAL DRESS (scripts/setup.js, scripts/check.js): colour that steps aside when
// there is no terminal or NO_COLOR is set, a banner, numbered steps, marks for check results, a
// spinner, a progress bar that redraws in place, and a box for the summary. Pure formatting,
// exported so the pieces with arithmetic in them (the bar, the ETA) are tested without a terminal.
import { stdout } from 'node:process';

export const COLOUR = !!((stdout.isTTY || process.env.FORCE_COLOR) && !process.env.NO_COLOR && process.env.TERM !== 'dumb');
const wrap = (open, close) => (s) => (COLOUR ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const c = {
  bold: wrap('1', '22'), dim: wrap('2', '22'), italic: wrap('3', '23'),
  accent: wrap('38;5;214', '39'), ok: wrap('38;5;78', '39'), warn: wrap('38;5;221', '39'), bad: wrap('38;5;203', '39'),
  cyan: wrap('38;5;80', '39'), white: wrap('97', '39'),
};

export const MARK = {
  ok: () => c.ok('✓'), warn: () => c.warn('!'), fail: () => c.bad('✗'), info: () => c.dim('·'),
};

// THE MONOGRAM, IN PIXELS (operator, 2026-09-14: "I want the installer to have amazing ANSI Art here
// for the BY logo"). The same tile the favicon is: a rounded orange tile shaded light to dark
// across the diagonal, a dark B and Y with uprights two cells wide (a cell is twice as tall as it is
// wide, so a two-cell upright and a one-row crossbar are the same thickness on screen -- operator:
// "The black letters need to be thicker"), and three courses of blocks along the foot. One character
// cell per pixel, painted as a background colour, from the 256-colour table -- solid in every
// terminal font; without colour it falls back to three lines of box drawing.
const ART = [
  '  ......................  ',
  ' ........................ ',
  '...#######...##......##...',
  '...##....##..##......##...',
  '...##....##...##....##....',
  '...#######.....##..##.....',
  '...##....##.....####......',
  '...##....##......##.......',
  '...##....##......##.......',
  '...#######.......##.......',
  ' .ooooooo.oooooo.ooooooo. ',
  '  ......................  ',
];
const TILE = [223, 222, 215, 214, 208, 172, 166];   // light to dark, the favicon's gradient in 256 colours
const INK = 233;
function pixel(ch, x, y) {
  if (ch === ' ') return null;
  const t = (x / (ART[0].length - 1) + y / (ART.length - 1)) / 2;
  const tone = TILE[Math.min(TILE.length - 1, Math.floor(t * TILE.length))];
  if (ch === '#') return INK;
  if (ch === 'o') return TILE[Math.min(TILE.length - 1, Math.floor(t * TILE.length) + 1)];
  return tone;
}
export function monogram() {
  if (!COLOUR) return [`${c.accent('▗▄▖')}`, `${c.accent('▐BY')}`, `${c.accent('▝▀▘')}`];
  // ONE CELL PER PIXEL, painted as a background colour under a space. The first cut used the
  // half-block (two pixels per row) and the Mac's Terminal drew every seam between them
  // (operator: "What is this garbage?!"): a font decides how a half-block glyph sits in its cell,
  // and a background colour fills the cell whatever the font.
  return ART.map((row, y) => {
    let line = '', open = null;
    for (let x = 0; x < row.length; x++) {
      const tone = pixel(row[x], x, y);
      if (tone !== open) { line += open == null ? '' : '\x1b[49m'; line += tone == null ? '' : `\x1b[48;5;${tone}m`; open = tone; }
      line += ' ';
    }
    return line + (open == null ? '' : '\x1b[49m');
  });
}

/** The banner: the monogram beside the name, the version and what this is; below it when narrow. */
export function banner(version, what = 'setup', width = cols()) {
  const art = monogram();
  const head = `${c.bold('Block')}${c.accent(c.bold('Yard'))}  ${c.dim(version)}   ${c.dim('·')}   ${c.bold(what)}`;
  // every line fits beside the tile in 80 columns (operator: "It needs to fit in 80 character space. Standard CRT")
  const about = ['Live monitor, block explorer, markets and 3D', 'block-space viewer for Bitcoin Core.', '', 'Zero dependencies, self-hosted, read-only.', 'Apache-2.0.'].map((l) => c.dim(l));
  if (!COLOUR) return `\n${art.map((r, i) => `${r} ${i === 0 ? head : i === 1 ? about[0] : i === 2 ? about[1] : ''}`).join('\n')}\n`;
  const artW = strip(art[0]).length;
  const beside = width >= artW + 3 + 49 + 2;   // 26 + 3 + 49 + 2 = 80
  if (!beside) return '\n' + art.map((r) => `  ${r}`).join('\n') + `\n\n  ${head}\n  ${about.join('\n  ')}\n`;
  const text = ['', '', head, ...about];
  return '\n' + art.map((row, i) => `  ${row}   ${text[i] ?? ''}`).join('\n') + '\n';
}

/** A numbered step heading with a rule out to the right. */
export function step(n, total, title, width = cols()) {
  const head = `  ${c.accent(c.bold(`${n}`))}${c.dim(`/${total}`)}  ${c.bold(title)}  `;
  const plain = `  ${n}/${total}  ${title}  `;
  return `\n${head}${c.dim('─'.repeat(Math.max(4, width - plain.length - 2)))}\n`;
}

/** One check result, as a line. */
export function checkLine(status, name, detail, width = cols()) {
  const mark = (MARK[status] ?? MARK.info)();
  const label = status === 'fail' ? c.bad(name) : status === 'warn' ? c.warn(name) : status === 'info' ? c.dim(name) : name;
  const room = Math.max(20, width - 26);
  return `    ${mark} ${label.padEnd(name.length > 18 ? 0 : 18 + (label.length - name.length))} ${wrapText(detail, room, 25)}`;
}

/** Wrap a detail string so continuation lines sit under its first character. */
export function wrapText(text, width, indent) {
  const words = String(text).split(' ');
  const lines = [];
  let line = '';
  // widths are measured on what is seen, not on the colour codes around it
  for (const w of words) {
    if (line && strip(line).length + 1 + strip(w).length > width) { lines.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.join('\n' + ' '.repeat(indent));
}

/** Text in a rounded box. */
export function box(lines, { title = null, pad = 1, width = null, max = cols() - 6 } = {}) {
  // NOTHING WIDER THAN THE TERMINAL (operator, 2026-09-14, of a box whose one long line broke its
  // frame on an 80-column Mac): a line past the room is cut with an ellipsis -- a body line keeps
  // its start, a title (a path) keeps its end
  const room = Math.max(20, max - pad * 2);
  const cut = (l, keepEnd) => { const r = strip(l); if (r.length <= room) return l; return keepEnd ? `…${r.slice(r.length - room + 1)}` : `${r.slice(0, room - 1)}…`; };
  lines = lines.map((l) => cut(l, false));
  if (title != null) title = cut(title, true);
  const raw = lines.map((l) => strip(l));
  const inner = width ?? Math.max(...raw.map((l) => l.length), title ? strip(title).length + 2 : 0) + pad * 2;
  const top = title ? `╭─ ${title} ${'─'.repeat(Math.max(0, inner - strip(title).length - 3))}╮` : `╭${'─'.repeat(inner)}╮`;
  const body = lines.map((l, i) => `│${' '.repeat(pad)}${l}${' '.repeat(Math.max(0, inner - pad - raw[i].length))}│`);
  return [c.dim(top[0]) + top.slice(1, -1) + c.dim(top.slice(-1)), ...body.map((b) => c.dim('│') + b.slice(1, -1) + c.dim('│')), c.dim(`╰${'─'.repeat(inner)}╯`)].join('\n');
}

export function strip(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }
export function cols() { return Math.min(100, Math.max(60, stdout.columns ?? 80)); }

/** A spinner on a TTY; a single line otherwise. stop() erases it. */
export function spinner(text) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0, timer = null;
  if (stdout.isTTY) {
    const draw = () => stdout.write(`\r    ${c.accent(frames[i++ % frames.length])} ${text}`);
    draw(); timer = setInterval(draw, 80);
  } else stdout.write(`    … ${text}\n`);
  return { stop() { if (timer) { clearInterval(timer); stdout.write(`\r${' '.repeat(text.length + 8)}\r`); } } };
}

const HMS = (s) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const G = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} k` : String(n));

/**
 * One line of a progress bar: `phase ████░░ done/total · rows · rate · ETA`. `elapsed` in seconds
 * since the phase began; the ETA assumes the rate so far holds. Pure, so it is tested.
 */
export function progressLine({ phase, done, total, rows = null, elapsed = 0 }, width = cols()) {
  const frac = total > 0 ? Math.min(1, done / total) : 0;
  const barW = Math.max(10, Math.min(30, width - 62));
  const filled = Math.round(frac * barW);
  const bar = c.accent('█'.repeat(filled)) + c.dim('░'.repeat(barW - filled));
  const rate = elapsed > 0 && done > 0 ? done / elapsed : 0;
  const eta = rate > 0 && total > done ? HMS((total - done) / rate) : null;
  const bits = [`${String(done).padStart(String(total).length)}/${total}`, `${Math.round(frac * 100)}%`];
  if (rows != null) bits.push(`${G(rows)} rows`);
  if (eta) bits.push(`about ${eta} left`);
  else if (frac >= 1) bits.push(`done in ${HMS(elapsed)}`);
  return `  ${c.bold(phase.padEnd(7))} ${bar}  ${c.dim(bits.join(' · '))}`;
}

/** Draws progress lines in place on a TTY; on a pipe, one line each time the percentage moves. */
export function progress() {
  let lastPct = -1, lastPhase = null;
  return {
    update(p) {
      const line = progressLine(p);
      if (stdout.isTTY) { stdout.write(`\r\x1b[2K${line}`); return; }
      const pct = p.total > 0 ? Math.floor((p.done / p.total) * 20) : 0;
      if (p.phase !== lastPhase || pct !== lastPct) { lastPhase = p.phase; lastPct = pct; stdout.write(`${strip(line)}\n`); }
    },
    done(line) { if (stdout.isTTY) stdout.write(`\r\x1b[2K`); if (line) stdout.write(`${line}\n`); },
  };
}

export const fmt = { hms: HMS, big: G };
