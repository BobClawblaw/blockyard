// THE ABOUT PAGE (operator, 2026-09-12: "We need to add an about menu. include the github logo
// graphic, link to our github page for the project. show current version number. system info. os
// info version. bitcoin node version. Add a closing line ... have the spiral galaxy in the
// background for the about page"; and "Make clicking the BlockYard icon the About page then").
//
// Reached by clicking the monogram in the header, not by a tab of its own -- the nav is already
// full enough that it wraps to its own row below 2000 px, and About is a place you visit once.
//
// The sky is the same board3d star field every other panel draws, with the galaxy forced ON:
// this page has no data to obscure, so it is the one place the galaxy is the point rather than
// the backdrop. It is a separate canvas behind the text, at maxDpr 1, so a page nobody is
// watching costs one cheap repaint rather than a megapixel one.
import { board3d } from './details3d.js';
import { loadSettings, spaceOptions } from './settings.js';

const SKY = {
  gridW: 24, gridH: 16,
  oblique: { ox: 0.10, oy: 0.30, headroom: 3, flight: 0 },
  dome: 0, space: false, grid: false,
  background: 'rgba(0,0,0,1)',
  idleFx: false, shadows: false, still: true,
  transition: { rise: 0, travel: 1, drop: 0 },
  maxDpr: 1,
};

const S = { host: null, asked: false };

/** Draw the galaxy behind the text. Its make-up comes from the Sky settings, like every board. */
function drawSky() {
  const c = document.getElementById('abSky');
  if (!c) return;
  const sky = spaceOptions(loadSettings());
  board3d(c, [], {
    ...SKY,
    stars: true, galaxy: true, galaxyAt: 'center',
    starDensity: sky.starDensity, starBrightness: sky.starBrightness,
    nebulae: sky.nebulae, galaxies: sky.galaxies, dust: sky.dust, clusters: sky.clusters,
    starColours: sky.starColours, starGlints: sky.starGlints,
  });
}

const row = (k, v) => `<div class="abrow"><span>${k}</span><b>${v ?? '–'}</b></div>`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * The page. Three blocks of fact and one line of credit.
 *
 * Every figure is something the monitor already knows, or one cheap call: the build and version
 * from /api/build (which recomputes the digest per request, so this is the code on disk, not the
 * code at boot), the host from /api/about, and the node's own version string from the snapshot
 * that every other page is already using.
 */
export function renderAbout(s, state, h) {
  drawSky();

  // one fetch, once -- the host's OS does not change while the page is open
  if (!S.asked) {
    S.asked = true;
    h.api('/api/about').then((d) => { S.host = d; h.render?.(); }).catch(() => { S.host = { error: true }; });
  }

  const app = document.getElementById('abApp');
  const host = document.getElementById('abHost');
  const node = document.getElementById('abNode');
  const ver = document.getElementById('ver')?.textContent ?? '';

  if (app) {
    const b = S.host ?? {};
    const html = row('version', esc(b.version ?? ver.replace(/^v/, '').split(' · ')[0] ?? '–'))
      + row('build', esc(b.build ?? '–'))
      + row('licence', 'Apache-2.0')
      + row('dependencies', 'none');
    if (app.__h !== html) { app.innerHTML = html; app.__h = html; }
  }

  if (host) {
    const b = S.host;
    const html = !b ? '<div class="abrow"><span>reading the host…</span><b></b></div>'
      : b.error ? '<div class="abrow"><span>host details</span><b>unavailable</b></div>'
      : row('operating system', `${esc(b.platform)} ${esc(b.release)}`)
        + row('architecture', esc(b.arch))
        + row('processors', b.cpus != null ? `${b.cpus}${b.cpuModel ? ` × ${esc(b.cpuModel)}` : ''}` : '–')
        + row('memory', b.totalMemGb != null ? `${b.totalMemGb} GB` : '–')
        + row('runtime', `Node.js ${esc(b.node)}`)
        + row('monitor uptime', b.uptimeSec != null ? `${Math.floor(b.uptimeSec / 3600)} h ${Math.floor((b.uptimeSec % 3600) / 60)} m` : '–');
    if (host.__h !== html) { host.innerHTML = html; host.__h = html; }
  }

  if (node) {
    const n = s?.network ?? null;
    const html = row('node', esc(s?.label ?? '–'))
      + row('version', esc(n?.subversion ?? '–'))
      + row('protocol', n?.protocol ?? '–')
      + row('chain', esc(s?.chain ?? '–'))
      + row('height', s?.tip?.height != null ? h.fmt.num(s.tip.height) : '–');
    if (node.__h !== html) { node.innerHTML = html; node.__h = html; }
  }
}
