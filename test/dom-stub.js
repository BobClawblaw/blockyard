// A minimal DOM/window stub, shared by the front-end tests.
//
// Why it exists: `node --check` only parses, and a missing `import` name parses
// perfectly. The browser's real failure -- a ReferenceError while the module is still
// evaluating, before login, before the stream, before a single pixel -- was invisible
// to every check this repo had until it blanked the whole page. Node evaluates the
// same ESM graph, so importing the app under this stub reproduces the browser's
// structural check without a browser.
export function installDom({ withNetwork = false } = {}) {
  let rafNow = 0;
  const ctxProxy = () => new Proxy({}, {
    get: (_t, k) => {
      if (k === 'measureText') return () => ({ width: 40 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k === 'canvas') return { width: 900, height: 220 };
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (k === 'createPattern') return () => ({});
      return () => {};
    },
    set: () => true,
  });

  const mkEl = (id = '') => ({
    id, textContent: '', value: '', checked: false, hidden: false, style: {}, dataset: {}, attrs: {},
    _html: '', _kids: [], children: [], scrollTop: 0, scrollHeight: 0, width: 900, height: 220,
    // A real <select> has .options and accepts insertAdjacentHTML; panels.js guards on
    // `kindSel.options.length`, so a stub without them invents a crash.
    options: [], insertAdjacentHTML() {}, insertAdjacentElement() {}, disabled: false,
    classList: {
      add() {}, remove() {}, toggle() {}, contains: () => false,
    },
    appendChild() {}, removeChild() {}, remove() {}, setAttribute() {}, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, focus() {}, blur() {}, click() {},
    get innerHTML() { return this._html; },
    // The setter parses data-* attributes out of the injected markup. That is the
    // minimum needed to assert behaviour instead of text: "the fill's width is set
    // from data-w through the CSSOM" is only checkable if the stub has a CSSOM and
    // a querySelectorAll that can find the element the renderer just injected.
    // It is a parser of the tags this app itself writes, not an HTML parser --
    // malformed markup may parse differently here than in a browser, and nothing in
    // these tests should depend on it agreeing about anything exotic.
    set innerHTML(v) {
      this._html = String(v);
      this._kids = parseDataEls(this._html);
    },
    querySelector: (sel) => el(String(sel).replace(/[#.]/g, '') || 'sub'),
    querySelectorAll(sel) {
      const parts = String(sel ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      // Document order, like the real thing: a comma selector must not reorder the
      // matches, or a test that destructures the result passes for the wrong reason.
      return (this._kids ?? []).filter((kid) => parts.some((p) => {
        const attr = /^\[data-([a-zA-Z0-9-]+)\]$/.exec(p);
        return attr ? kid.dataset[camel(attr[1])] !== undefined : true;
      }));
    },
    closest: () => null,
    getBoundingClientRect: () => ({ width: 900, height: 220, left: 0, top: 0, right: 900, bottom: 220 }),
    getContext: () => ctxProxy(),
  });

  function camel(s) {
    return String(s).replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase());
  }

  function parseDataEls(html) {
    const out = [];
    const tagRe = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
    let m;
    while ((m = tagRe.exec(html))) {
      const [, tag, attrs] = m;
      const node = mkEl();
      node.tagName = tag;
      for (const a of String(attrs).matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*"([^"]*)"/g)) {
        const key = a[1];
        const val = a[2];
        node.attrs[key] = val;
        if (/^data-/i.test(key)) node.dataset[camel(key.slice(5))] = val;
        else if (key === 'class') node.className = val;
        else if (key === 'id') node.id = val;
      }
      out.push(node);
    }
    return out;
  }

  const els = new Map();
  function el(id) { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); }

  globalThis.document = {
    getElementById: el, createElement: () => mkEl(), querySelector: (s) => el(String(s).replace(/[#.]/g, '') || 'sub'),
    querySelectorAll: () => [], addEventListener() {}, body: mkEl('body'), head: mkEl('head'),
    documentElement: mkEl('html'), createTextNode: () => ({}), visibilityState: 'visible', hidden: false,
  };
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1400, innerHeight: 900,
    location: { href: 'http://192.0.2.10:8088/', protocol: 'http:', host: '192.0.2.10:8088', pathname: '/', hash: '' },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    // A clock that advances per callback, so an animation loop actually progresses here
    // instead of seeing the same timestamp forever. It is still called inline -- the code
    // under test must not depend on that either way; a rAF that recursed forever against
    // an inline stub was the animation loop's bug, not the stub's.
    requestAnimationFrame: (fn) => { rafNow += 16; fn(rafNow); return 1; },
    cancelAnimationFrame() {}, scrollTo() {},
  };
  globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'harness' }, configurable: true });
  } catch { /* Node's own read-only navigator stays */ }

  if (withNetwork) {
    // Enough for app.js to run its boot() path to completion: api() only needs a
    // status and a JSON body. Anything it renders, it renders against the stub above.
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
    globalThis.EventSource = class {
      constructor() { this.readyState = 0; }
      addEventListener() {} close() {}
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    };
  }
  return { el, els };
}
