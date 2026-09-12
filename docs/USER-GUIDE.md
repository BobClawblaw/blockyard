# bmcmonitor user guide

This guide covers what you see after opening bmcmonitor in a browser: what each tab
shows, how to read it, and which controls do what. For installation, configuration
and the security posture, see the [README](../README.md).

bmcmonitor is read-only. Nothing in this guide changes your node. The only exceptions
are node actions, which are off unless an operator explicitly enables them (see
[Admin](#admin)).

- [The first five minutes](#the-first-five-minutes)
- [The header](#the-header)
- [Overview](#overview)
- [Block space](#block-space)
- [Chain & Sync](#chain--sync)
- [Mempool](#mempool)
- [Explorer](#explorer)
- [Markets](#markets)
- [Kiosk](#kiosk)
- [Peers](#peers)
- [Network](#network)
- [Mining](#mining)
- [Events](#events)
- [Node & RPC](#node--rpc)
- [Admin](#admin)
- [Reading the data honestly](#reading-the-data-honestly)
- [Links, URLs and keyboard tips](#links-urls-and-keyboard-tips)

---

## The first five minutes

1. **Check the header.** The `stream` badge should say **live**. Next to it, `rpc`
   shows how long the node took to answer the last call, and `up` shows how long the
   monitor has been running. If the badge says `reconnecting` or `stale`, the numbers
   on screen are not current. See [The header](#the-header).
2. **Read the sync strip** at the top of Overview. It names the node, gives its state
   (Synced, Initial block download, Catching up, Stalled, Reorganising, Unknown) and
   shows one progress figure. If the node is syncing, the strip shows the throughput
   and an ETA that states which measurement window it came from.
3. **Look at Block flow and Block space**, the two panels at the top of Overview.
   Block flow is the chain as a row of cards: projected blocks, the block being built,
   then the blocks already mined. Block space is a 3D picture of what the next block
   would contain if a miner took the best-paying transactions right now.
4. **Hover over things.** Most cards, cubes, candles and chart points have a tooltip
   with the exact figures behind them.
5. **Click a block height.** Heights in Block flow, the Last blocks table and elsewhere
   open the block in the [Explorer](#explorer), and every explorer page has its own
   URL you can share.

![The Overview tab](images/overview.jpg)

---

## The header

| Item | What it tells you |
|---|---|
| **bmcmonitor v… · build** | The version and build this tab is running. |
| **Tabs** | One button per page. The Admin tab appears only when accounts are enabled and you are signed in as an admin. |
| **Node picker** | With one node configured, this is the node's name, with a dot coloured by its state. With several, it is a drop-down listing every node with its sync percentage, so you can see which one needs attention before you pick it. On first load the monitor opens on a node that is syncing, if there is one, and otherwise on the primary node. |
| **stream** | The live link to the server. `connecting` on load, then `live`. `reconnecting` means the link dropped and the browser is retrying. `stale` means the link is up but no fresh data has arrived for more than 90 seconds. |
| **rpc** | The node's last RPC round-trip time. It turns red when the average climbs above five seconds. |
| **up** | How long the monitor process has been running. |
| **open access** | Shown when the monitor runs without accounts. Anyone who can reach it reads it as a viewer. Hover for details. |
| **stale build — reload** | Shown when the server has been updated since you loaded the page. Reload to run the current code. |
| **pause / resume** | Freezes live updates so you can read a moving figure. Charts and panels stop updating and the Block space countdown shows `refresh paused`. **Shift-click** also freezes the event feed. Click again to resume. |
| **sign out** | Only present when accounts are enabled. |

A red bar under the header means the node is not answering RPC, or nothing has
arrived for the selected node. It says which, and makes clear that everything below
it is the last state received, not current data.

### The sync strip

The sync strip appears at the top of Overview and Chain & Sync. It has one row of
figures and a thin progress bar.

- **The bar's fill** is *blocks held ÷ announced headers*. It is the only figure that
  drives the fill.
- **The marker on the bar** is the node's own `verificationprogress`, which is
  difficulty-weighted. The two figures measure different things, so they are shown
  separately and never averaged.
- **The ETA** comes with the measured rate it was computed from. During initial block
  download there is no fallback based on the ten-minute block cadence, and a window
  with less than 60 seconds of history is refused. When the measurement windows
  disagree, the ETA is given as a range.
- **`detail`** expands the full derivation: height, headers, blocks behind, every rate
  window, the ETA and its basis, tip age, chain size, and every caveat in full.
  **`N notes · show`** does the same.
- **`also syncing`** buttons appear when another configured node is syncing. Click
  one to switch to it.

---

## Overview

The landing page. It shows the most important panels from the other tabs in two
columns.

| Panel | What it shows |
|---|---|
| **Block flow** | The chain as a row of cards. See [Reading Block flow](#reading-block-flow). |
| **Block space** | The 3D block-space viewer: the same viewer as the [Block space](#block-space) tab, in a square panel. |
| **Mempool** | Transaction count, bytes and memory used against the limit, a one-hour sparkline, and the queue measured in blocks: "≈ N blocks at the average size of the last M mined". It divides by blocks actually mined, not by an assumed size. |
| **Fees** | `estimatesmartfee` targets for 1, 2, 6, 24 and 144 blocks, the pool's minimum fee, and a history chart. A target the estimator has no answer for reads `unset`. |
| **Last blocks** | Height (links to the explorer), age, the gap since the previous block (amber over 20 minutes, red over an hour), transaction count, size, vsize, fees, minimum fee rate, and the peer that served the block when that is known. |
| **Monitor events** | The newest events this monitor observed. These are the monitor's own observations, not node log lines. The full feed is on [Events](#events). |
| **Mined by** | Blocks in the recent window grouped by pool, from coinbase text and a curated label map. See [Mining](#mining). |
| **What this panel cannot tell you** | Every known data gap for this node, stated. If there are none, it says so. |

### Reading Block flow

Block flow reads left to right, from the future into the past.

![Block flow and the block-space viewer](images/overview.jpg)

- **Projected blocks** (far left, dashed, labelled `+1`, `+2` …) are the mempool
  sorted by fee rate, with the block currently being built skipped and the rest cut
  into 1,000,000 vB blocks. Each card shows the median fee rate, the fee range, total
  fees, transaction count and an ETA from the measured average block interval. The
  last card (`+N…`) is the rest of the pool. These cards are inference, which is why
  they are dashed and flat. A child paying for its parent can show up one block late,
  because this node's mempool carries no ancestor data.
- **The block being built** sits just left of the divider. It shows the template's
  height, its age and how long the node took to answer, and a 40-segment meter that
  fills as weight is selected. Each lit segment is coloured by the fee rate of the
  transactions at that point in the block, richest first. The card also shows the
  transaction count, how full the block is, fees, free space, median and maximum
  fee rate, and chips for the marginal fee rate, the spill and how much of the pool
  fits. A **coloured ring** shows how long this block has been accumulating: green
  within the chain's measured average interval, amber beyond it, red once a block is
  due (1.5 times the average). The legend under the row gives the thresholds and the
  minutes since the last block. If the template is behind the tip, the card says
  `stale template`.
- **The divider** (`pending ⇆ done`) separates work in progress from work the network
  has accepted.
- **The chain tip and history** run to the right, linked like a chain, because every
  block commits to the one before it. Each card shows the pool, the height (click it
  to open the block in the explorer), how far behind the tip it is, when it was mined
  and the gap before it, size, transactions, fees, sats per transaction, average and
  median fee rate, and a fill bar against the 4,000,000 WU cap. A light block is
  visibly shorter than a full one. The tip has the accent-coloured ring. Hover a card
  for the coinbase text, the label that matched, the hash, and more.
- A card reading **`awaiting attribution`** or **`not attributed`** is a height whose
  coinbase has not been read yet. Attribution reads one block per poll, so it trails
  the tip. These cards are drawn as placeholders rather than skipped.

On first load the row scrolls so that the nearest projected blocks, the block being
built and the divider are all on screen. After that it keeps wherever you scroll it.
With `prefers-reduced-motion` set, the numbers stay and nothing animates.

---

## Block space

The block-space viewer at full size. Next to it are the block being built, the chain
tip and a colour legend.

![Block space, Simple](images/block-space-mode1.jpg)

### What the board shows

The board shows **the next block's worth of the mempool**: the best-paying
transactions, up to one block (1,000,000 vB), laid out richest first on a 3D grid.

- **Area is vbytes.** Every transaction is a square whose side is a whole number of
  grid units, packed first-fit, richest first.
- **Colour is fee rate**, in 128 bands from under 0.1 to 2,000 sat/vB and over: sky blue for the
  cheapest, through teal, green, yellow, orange and red, to purple. The **Feerate** legend in
  the side panel gives the bands in sat/vB, from under 0.1 up to 500 and over.
- **Hover a block** for its transaction id, size and fee rate. Hover works when the
  board is at rest. While blocks are moving, their positions do not match their
  footprints, so the tooltip stays hidden instead of naming the wrong transaction.

### Refreshes and the control bar

The board refreshes every **30 seconds**, and a refresh is animated rather than
redrawn. Blocks rise off the grid, move to their new places in separate height lanes
so they never collide, and fall back under gravity with a few bounces. The board and
the camera stay fixed, so the view itself never moves. If a new layout arrives while
the animation is still running, it waits until the current one has landed.

The control bar in the corner of the panel has:

- **The countdown**: `next refresh m:ss`, with a fill that shows how much of the wait
  has passed. It shows `refreshing…` while a fetch is under way and `refresh paused`
  while updates are paused.
- **refresh now**: fetches immediately. It is enabled only when the board is at rest,
  updates are not paused and no refresh is already running. Hover it to see why it
  is disabled.
- **The mode switch**: see below.

### Viewer modes

| Mode | What it draws |
|---|---|
| **Simple** | The richest ~400 transactions as cubes, as tall as they are wide, with the rest of the block as equal smaller pieces. The best view for seeing which transactions dominate. |
| **Detailed** | Every transaction in the next block, one square each on a 96-unit grid, drawn as low slabs so that thousands of them stay readable. The best view for the block's texture. |

![Block space, Detailed](images/block-space-mode2.jpg)

Your choice is remembered in this browser and applies to every Block space viewer:
Overview, Block space, Mempool, Mining and Kiosk. When you switch to Detailed, the Simple
picture stays on screen until the first full read arrives. Transactions present in
both modes move to their new places rather than disappearing and reappearing.

### Idle effects

While the board is at rest, an effect plays every few seconds, with the first one
about a second after the board lands. The effects include ripples across the grid,
scan lines, outlines, a tide, a cascade in fee-rate order, twinkles, a TRON-style
light-cycle race in blue and orange, and a lightning ball that enters from off-screen,
runs along the grid lines and lights the cubes it passes. They are decoration only,
so they carry no data, they never play during a refresh, and they are switched off
under `prefers-reduced-motion`.

### The side panel

- **Being built**: the template's height and a clock showing minutes since the last
  block (coloured like the Block flow ring), the 40-segment meter, the percentage
  full, the marginal fee rate, transactions, fees, weight, median and maximum fee
  rate, the queued bytes, the queue depth in blocks, and the template's age and cost.
- **Chain tip**: the pool that mined it and when, a fill bar, the percentage full,
  size, transactions, fees, average and median fee rate, the gap before it and the
  chain's average gap.
- **Feerate**: the colour legend.

---

## Chain & Sync

The chain in detail. The sync strip is at the top, followed by charts and state
cards three to a row.

| Panel | What it shows |
|---|---|
| **Block interval** | Seconds between blocks over the last 24 hours, with the 10-minute target marked. The note gives the median and how many gaps exceeded 20 minutes. |
| **Block size** | `getblockstats` `total_size`, the sum of transaction sizes, not the serialized block. The note says which basis applies. |
| **Fees per block**, **Transactions per block** | One point per block. |
| **Transaction rate** | `getchaintxstats` tx/s, with the window size, transactions in the window and the all-time count. |
| **Tip progression** | Blocks applied against announced headers. Once the node is synced this is a flat line. |
| **Chain state** | Chain, height, headers, best hash, tip time and age, progress, size on disk, pruned, chain work, IBD flag. |
| **UTXO set** | Coins, height, total amount and muhash, with a history chart. |
| **Difficulty & work** | Difficulty, estimated network hash rate, average interval and reorgs seen. During initial block download the hash rate is withheld and the card gives the reason. |
| **Block drill-down** | Type a height or block hash, or leave the box blank for the tip, and press **inspect** or Enter. It shows the header and statistics plus the block's txids as buttons. Click one to decode that transaction. Both views link into the explorer. |
| **Indexes** | Each index the node keeps, its height, and whether it is synced. |
| **Chain tips** | `getchaintips`: height, branch length, status. |

---

## Mempool

| Panel | What it shows |
|---|---|
| **Pool usage** | A gauge of memory used against `maxmempool`, next to the transaction count, serialized bytes, memory, limit, pool fees, minimum fee rate, minimum relay fee, unbroadcast count and the OP_RETURN size limit. |
| **Mempool size** | Transaction count (left axis) and memory (right axis) over time. |
| **Fee rate distribution** | A histogram of waiting transactions by sat/vB on a log scale. The green bar marks the pool's minimum fee rate. The note gives the median, 90th percentile and maximum. |
| **Block space** | The same viewer as the Block space tab, smaller, with the same modes and countdown. |
| **Fee rate vs age** | A sampled scatter of fee rate (log) against time in the pool. Dot area is proportional to vsize. Transactions reporting no entry time are left out and counted in the note. |
| **Age distribution** | How long transactions have been waiting. |
| **Fee estimates over time** | Estimates for 1, 2, 6, 24 and 144 blocks, and the pool minimum. |
| **Fields this node does not report** | The Core `getrawmempool` fields this node leaves out. They are listed by name, and not drawn as empty charts. |

---

## Explorer

A block, transaction and address explorer that reads directly from your node. Every
page has its own URL, so it can be bookmarked or shared.

| Route | Page |
|---|---|
| `#explorer` | Search box and the latest blocks |
| `#explorer/block/<height or hash>` | A block. Add `/<page>` for later pages of its transactions. |
| `#explorer/tx/<txid>` | A transaction |
| `#explorer/address/<address>` | An address. Add `/<page>` for later pages. |

### Search and the home page

Type a **block height, block hash, transaction id or address** and press Enter or
**Search**. If nothing matches, a message says so.

The home page shows the latest blocks as a row of **cubes coloured by median fee
rate**. Each cube shows the median and fee range, size, transaction count, age and the
pool that mined it. Below the cubes is a table of recent blocks with height, time
mined, pool, transactions, weight and fees. Click a cube or a height to open the
block.

![Explorer home](images/explorer-home.jpg)

### Transaction page

![A transaction](images/explorer-tx.jpg)

- **Title and status pill**: the txid with a copy button. The pill reads
  `N confirmations`, `Unconfirmed`, or `Stale — off the best chain`.
- **Summary panels**: status (the confirming block, which links to it, or "In the
  mempool"), timestamp, feature badges, size in vB, bytes and weight units, the fee
  and **fee rate**, total in and out, version and locktime. When the server has a
  recent spot price, dollar values appear next to BTC amounts **in green**. A coinbase
  transaction shows the block reward instead of a fee.
- **Feature badges**: **SegWit**, **Taproot**, **RBF**, **Consolidation**,
  **OP_RETURN**, and **coinbase** where it applies.
- **Flow**: a diagram of where the value came from and where it went. Each input is a
  band as thick as its share of the value, and the inputs merge into one trunk that
  fans out to the outputs. The fee leaves the trunk as a thin **gold stream**. A
  coinbase input glows gold, and an OP_RETURN output is a grey sliver. Each input band
  links to the transaction that created it, and each output band links to its address.
  Hover a band for its amount. A side with more than 24 entries folds the rest into
  one "N more" band.
- **Inputs & Outputs**: two columns. Each input has an **arrow button** to the
  transaction whose output it spends. Each output has an arrow button to the
  transaction that **spent** it, or a **glowing dot** if it is still unspent. OP_RETURN
  outputs are marked unspendable. A very large transaction lists its first outputs and
  says how many there are in total. The bar underneath gives the fee and total output.

### Block page

![A block](images/explorer-block.jpg)

- **Header**: `Block <height>` with **‹** and **›** arrows to the previous and next
  block, and a confirmations pill.
- **Stats**: hash (with copy button), timestamp, size and weight, transaction count,
  miner, merkle root, median fee rate, fee span, total fees, subsidy plus fees (with
  dollar values when available), difficulty and nonce, version and bits.
- **Transactions**: a paged table with each transaction's fee rate, fee, size, value
  out, input and output counts, and feature badges. Use the pager at the bottom to
  move through the pages.

### Address page

The address with a copy button, its type, transaction count and unspent outputs, then
**balance**, **total received** and **total sent**. Below that, its **transactions,
newest first**, with the block each one was confirmed in (or "mempool") and the
**change** it made to the balance, green for money in and red for money out.

**Requirements:** transaction and address pages rely on the node's transaction index
and address index. Without the address index, the address page shows the node's
error in place of the missing figures.

---

## Markets

The BTC/USD price from five exchanges' public APIs. The server fetches market data
**only while someone has the Markets or Kiosk tab open**, and stops about ten minutes
after the last viewer leaves. If no one opens these tabs, the monitor makes no
exchange requests at all.

![Markets](images/markets.jpg)

### The 3D price chart

The first panel is the selected exchange's **hourly candles** drawn on the same 3D
engine as Block space, from a low camera looking at the chart from the side.

- Each hour is a candle **floating at its price**. The body runs from open to close
  (green if the hour closed up, red if down) and a thin wick runs from the hour's low
  to its high.
- A steady **neon-yellow line** joins each hour's close.
- The **volume** band runs along the bottom.
- **Price levels and hours are labelled on the board**, with the last price
  highlighted.
- The background is a star field. The lighting comes from the front right, so the
  newest hours are brightest and older hours are dimmer.
- **Hover a candle** for its exchange, hour, open, high, low, close, change and volume.
- The legend beside the board gives the price range from floor to top.

The board shows at most the last 72 hours. The flat chart below covers the full
selected range.

### Controls and summary

- **Exchange buttons**: Coinbase, Kraken, Bitstamp, Bitfinex, OKX. Only exchanges
  with candle data are listed. The selected exchange provides the candles, and the
  others appear on the flat chart as lines.
- **Range**: **24 h**, **48 h** or **7 d**.
- **Summary strip**: the **USD median** across books, the **spread across
  exchanges**, **24 h volume**, and how many USD books are reporting.

### The flat candlestick chart

A conventional price chart with the price axis on the right, the time axis in UTC
(midnights carry the date), candles, volume, and a dashed line at the last price.
The other exchanges are thin coloured close lines, named at the top right. Move the
pointer over it for a **crosshair** and an **OHLC readout** of that hour at the top
left. The readout shows the latest hour when the pointer is elsewhere.

### The exchange table

One row per exchange: pair, **last**, **bid**, **ask**, **spread** (in dollars and
basis points), **24 h change**, 24 h low–high **range**, 24 h **volume**, and when it
last updated, or the exchange's **error** if it did not answer.

### Order book depth

Cumulative order-book depth against price, read every 30 seconds while the tab is
open.

- **Bids** (green) accumulate downward from the best bid. **Asks** (red) accumulate
  upward from the best ask. Each exchange's book is a faint line, and the **total**
  across all books is the bright line.
- The **dashed line** is the total as it stood N minutes ago.
- **Change bars** show how much was added (blue) or pulled (orange) at each price
  since then, on a **symmetric-log** axis on the right.
- **Pickers**: `change bars for the last` **1m / 5m / 10m / 30m / 1h**, and `price
  window` **±1% / ±2.5% / ±5% / ±10%**.
- **Shallow books** end where the exchange's book ends, marked `<exchange> ends`.
  Beyond that point the total still counts what that book had reached, so the total
  there is a **lower bound** and is drawn **dotted**. The readout says "at least".
- With the pointer off the chart, the readout at the top gives the mid price and the
  bids and asks within 1% and 5%. Move the pointer to read the cumulative depth,
  the change at that price, and each exchange's figure there.
- Until a snapshot of the chosen age exists, the note says the change bars are
  waiting.

**OKX quotes USDT, not USD**, so it is left out of the USD median and the
cross-exchange spread. It is included in the depth total.

---

## Kiosk

A wall display. Three panels fill the screen: the **3D Markets board**, a **Price**
panel, and the **Block space** board.

![Kiosk](images/kiosk.jpg)

- **Markets** is the same 3D board as the Markets tab. Its title names the exchange,
  pair, hours shown and last price.
- **Price** shows the **USD median** in neon yellow with its 24 h change, the 24 h
  high, low and volume, the spread across books, a row for each exchange (last, 24 h
  change, spread), and how recently the data updated.
- **Block space** is the same viewer as everywhere else, with its countdown,
  **refresh now** button and mode switch.
- **full screen** in the corner puts the kiosk into browser full screen. Press it
  again or Esc to leave.

Having the Kiosk open counts as viewing Markets, so exchange data keeps flowing while
it is on screen.

---

## Peers

| Panel | What it shows |
|---|---|
| **Connections** | The current count, split into inbound and outbound, plus any connection budget and ban figures the node reports. Anything it does not report is labelled as such. |
| **Connection history** | Inbound, outbound, total and relaying peers over 24 hours. |
| **Peers** | The `getpeerinfo` table, refreshed every 15 seconds while the tab is open and sorted by bytes received, most first. Columns: direction, address and network, client (user agent, protocol version, and service badges such as `v2`, `filters`, `pruned`, `bloom`), time connected, last receive and send, bytes received and sent with their current rates, height, clock offset, and whether the peer relays transactions or only blocks. |

If the node reports connections but `getpeerinfo` returns no rows, the page says so.
Peer identity is not guessed from another source.

---

## Network

| Panel | What it shows |
|---|---|
| **Throughput** | Network-in and disk-write rates with a chart. |
| **Upload** | What the node reports about its byte counters. If a direction is not measured, the card says so and explains why, rather than charting a zero. |
| **Traffic accounting** | Cumulative received and written totals, averages since start, and the chain's size on disk. |
| **Where each number comes from** | The source table for every panel. |

---

## Mining

The block under construction and who has been mining.

| Panel | What it shows |
|---|---|
| **Block flow** | The same Block flow as on Overview. |
| **Packages in the block being built** | The ancestor graph from `getblocktemplate`: a histogram of package sizes, then a table of the top packages with fees, weight, package fee rate, child and parent fee rates, and a small picture of the package's shape. Rows with a child paying at least twice its parent's rate are highlighted as child-pays-for-parent. If every transaction stands alone, the panel says so. That is a real reading, not a missing chart. |
| **Feerate landscape** | The template's transactions bucketed by sat/vB, with green buckets well above the block's median and red ones below it. |
| **Pools in this window** | Blocks per pool, share, median fee rate, average weight, and the coinbase tags seen. A pool the curated label map does not recognise is marked `unlabelled` and shown by its raw tag. |
| **Mempool space** | The Block space viewer, with a note giving how many transactions are drawn and how long ago the pool was read. |
| **Attribution** | How many blocks have been attributed, the height window, how many labels matched, where the label map came from, and the cost of the block template. |
| **Detailed** (click to expand) | What this node can and cannot answer about mining, and why. |

The block template is requested only while a page that shows it is open, because
answering it takes the node over a second of its single RPC thread.

---

## Events

The monitor's own event stream: what it observed and decided, such as blocks stored,
reorgs, stalls and nodes becoming unreachable. Node log lines are not shown here.

- **Filter text** matches the event text, tag, kind and address.
- **Severity** (`info`, `warn`, `error`) and **kind** drop-downs narrow the list.
- **clear** empties the local buffer. This affects only your browser, not the server.
- The count shows how many events match out of how many are buffered.

---

## Node & RPC

How the monitor treats your node, and where every number comes from.

| Panel | What it shows |
|---|---|
| **RPC etiquette** | The endpoint, calls per second, totals, batches, latency (last, average, slowest), how busy the RPC lane is, errors and timeouts, polls dropped as stale, circuit-breaker trips, and the queue. The monitor keeps one request in flight at a time, because the node's RPC server handles one connection at a time. |
| **Poll cadence** | Each polling tier's configured interval against its actual interval. If the node is slow, tiers deliberately poll less often and the page says **Cadence is stretched**. |
| **Data quality** | Every known gap, with when it was flagged. |
| **Monitor self-telemetry** | The monitor's own memory, CPU and client counts. |
| **Log tail** | Whether the node's log is being followed, how far it has been read, the lag, and the share of lines matched. It also shows when new bytes last arrived, which distinguishes a quiet node from the monitor following the wrong file. |
| **Panel sources** | The provenance table: each panel, the RPC method or log source behind it, and why that source was chosen. |
| **RPC console** | Enter a method and, optionally, a JSON array of parameters (for example `[6]`), then press **call** or Enter. Only read-only methods on an allowlist are accepted. Mutating, wallet and peer-control methods are refused regardless of what the node would allow. |

---

## Admin

Visible only when accounts are enabled (`BMC_MON_AUTH=1`) and you are signed in as an
admin.

- **Users**: every account with its role, creation date and last login, with buttons
  to change the role or disable the account. **generate password** creates a user
  with a random password, which is shown once and never stored in readable form.
- **Node actions**: the node actions that exist and whether each is enabled for you.
  They are all disabled unless the operator enables them explicitly.
- **Audit log**: sign-ins, denials and actions, without any credentials, plus how
  much of the log's disk budget is used.
- **Change own password**: changing it signs out every session, including your own.

---

## Reading the data honestly

bmcmonitor never shows a number it did not measure, and it tells you when a figure is
old or missing.

**Stale is marked, not hidden.** If a chart already has data and fresh samples stop
arriving, the chart stays on screen and gets a small **amber `no fresh data · <age>`
pill** in its corner. It is never blanked, and never presented as current. The same
applies elsewhere:

- `stream` changes from `live` to `reconnecting` or `stale`.
- A red bar under the header appears when the node stops answering or nothing has
  arrived.
- Block space viewers say when the last pool read failed and the picture may be old.
- Block flow marks a template that is behind the tip as a `stale template`.
- The Markets table shows each exchange's age, or its error.

**Absent is not zero.** A dash (`–`) means *not reported* or *not measured yet*. It
never means zero. A chart that has never had data shows a sentence explaining what it
is waiting for, such as "need two blocks to measure an interval" or "the fee estimator
has no data yet", rather than a flat line at zero. When the node genuinely reports
zero or nothing, the page says so in words. For example, the mempool is empty, a
template contains no packages, or `getpeerinfo` returns no rows while connections
exist.

**Unreported fields are listed, not drawn.** Where this node's RPC omits something
another node implementation provides, the page names the missing field. See *Fields
this node does not report* on Mempool, the Upload card on Network, and *What this
panel cannot tell you* on Overview.

**Inference looks different from measurement.** Projected blocks in Block flow are
dashed and flat, and the depth chart draws a lower-bound total as a dotted line.

**Check provenance on Node & RPC.** *Panel sources* lists the source of every panel,
and *Data quality* lists every known gap with a timestamp. When a figure surprises
you, check there first. The README has a longer
[explanation of which number came from where](../README.md#which-number-came-from-where).

**Switching nodes wipes the charts.** The pixels on screen belong to the node you were
looking at, so they are cleared when you pick another. Returning to a node you have
already viewed restores its charts from the page's cache.

---

## Links, URLs and keyboard tips

**Every tab is a URL.** The page you are on is kept in the address bar's hash, so you
can bookmark it or send it to someone who can reach the same monitor:

| Tab | Hash |
|---|---|
| Overview | `#overview` |
| Block space | `#space` |
| Chain & Sync | `#chain` |
| Mempool | `#mempool` |
| Explorer | `#explorer`, `#explorer/block/<height or hash>[/<page>]`, `#explorer/tx/<txid>`, `#explorer/address/<address>[/<page>]` |
| Markets | `#markets` |
| Kiosk | `#kiosk` |
| Peers | `#peers` |
| Network | `#network` |
| Mining | `#mining` |
| Events | `#logs` |
| Node & RPC | `#node` |
| Admin | `#admin` |

The browser's back and forward buttons move between explorer pages as you would
expect. The selected node is not part of the URL: a shared link opens on whichever
node the recipient's monitor picks by default.

**Keyboard and pointer:**

- **Enter** submits the explorer search, the block drill-down and the RPC console.
- **Shift-click pause** freezes the event feed as well as the charts.
- **Hover** almost anything for exact figures: Block flow cards, Block space cubes
  (once the board is at rest), 3D candles, chart points, flow bands in the explorer,
  and the depth chart.
- **Esc** leaves Kiosk full screen.
- The **copy** buttons in the explorer copy a hash, txid or address. They also work
  when the monitor is served over plain HTTP.

**Motion:** if your system is set to reduce motion, Block flow stops animating and
the Block space idle effects are switched off. Every number stays.


## Display settings

The gear in the header opens **Display settings**. They are kept in your browser (nothing is sent to
the server, and no account is needed), they apply as soon as you change them, and **reset** puts
every one back to the shipped default.

They change how the pages are *drawn*, never what is measured: every figure on the page reads the
same whatever you choose here.

### Block space

The 3D board on Overview, Block space, Mempool and Kiosk. If the board is heavy on your machine,
these are the settings that buy it back, roughly most expensive first:

| setting | what it does |
|---|---|
| **Shadows** | Cubes casting shadows on the board and on each other. The costliest single effect on a full board: one shadow per resting stone, more in flight. |
| **Level of detail** | *Full* draws every facet and crown. *Simple cubes* draws those extras only on much larger stones. *Flat tiles* drops them, and the seams, entirely. |
| **Refresh animation** | *Full flight* is the 20-second choreography of blocks lifting, travelling and landing. *Quick* is about six seconds. *None* lands the new layout at once. |
| **Idle effects** | The ripples, scans, light cycles and lightning ball that play while the board rests. |
| **Stone edges** | The dark seam drawn around each stone. |
| **Neon grid** | The glowing grid on the board. |
| **Star field** | Off by default here: the stars twinkle, so the board keeps repainting while they are on. |
| **Board curve** | How far the board bows toward you. 0 is flat. |

### Markets & Price

The candle board on Markets and Kiosk: the **star field** on or off, its **density** (0.2x to 3x the
shipped number of stars) and **brightness**, and the **grid glow** under the neon lines.
