// Pins the Display setting `appearance.renderer` to Software for the file that imports this FIRST.
//
// Simple ('2.5d') ships since 2026-10-08, and a board drawn without a `renderer` option follows the
// setting (details3d.js rendererOf). The files that import this test the full picture -- skies, effects,
// flights, finishes -- which Simple switches off by design, so they keep the renderer they were written
// against. Node has no localStorage; an in-memory one stands in, for this process only (node --test runs
// each file in its own).
import { seedSettings } from '../../public/js/settings.js';

if (!globalThis.localStorage) {
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
  };
}
seedSettings({ appearance: { renderer: 'software' } });
