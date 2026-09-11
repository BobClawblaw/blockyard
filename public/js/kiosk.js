// THE KIOSK (operator, 2026-09-11: "I want a kiosk tab that has the 3d Markets viewer in one
// panel, and the block space panel beside it"). The two boards side by side, filling the screen,
// and a full-screen button -- nothing else to read, so it can run on a wall. Both panels are the
// same renderers their own tabs use (markets.js renderMarketsBoard, mining.js poolViewer): the
// same data, the same camera, the Block space panel's mode switch and refresh countdown.
import { poolViewer, blockFlow, flowArgs, applyMiningStyles } from './mining.js';
import { renderMarketsBoard, renderPriceInfo } from './markets.js';

let bound = false;

export function renderKiosk(s, state, h) {
  h.mempoolDetail?.();
  const mk = renderMarketsBoard('kMarkets', h);
  const lab = document.getElementById('kMkLabel');
  const text = mk?.label ?? 'asking the exchanges…';
  if (lab && lab.textContent !== text) lab.textContent = text;
  renderPriceInfo('kPrice', h);
  const sp = document.getElementById('kSpace');
  if (sp) poolViewer(sp, s, state);
  // THE CHAIN (operator, 2026-09-11: "There is absolutely no block chain/tip information in the
  // kiosk ... Add a block flow panel below block space panel"): the same Block flow the Overview
  // draws -- projected blocks, the block being built, the tip and the chain behind it
  h.nextBlock?.();
  const train = document.getElementById('kTrain');
  if (train) { blockFlow(train, flowArgs(s, state), h.fmt); applyMiningStyles(train); }
  if (!bound) {
    const btn = document.getElementById('kFull'), box = document.getElementById('kiosk');
    if (btn && box) {
      bound = true;
      btn.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen?.();
        else box.requestFullscreen?.().catch(() => h.toast?.('the browser refused full screen', 'bad'));
      });
    }
  }
}
