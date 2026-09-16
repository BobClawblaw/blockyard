# Plan: one sky per board — Galaxy or Earth

Operator, 2026-09-16: "The skybox settings are not clear in the preferences, for which sky settings
apply to which panel. eg: I want the sky for Scorched Yard to be the Earth Sky. The Galaxy view
should be the default background for all other 3D backgrounds."

## 1. Why it is confusing today

The settings describe the sky twice, from two directions, and neither says which board it is
talking about.

* **One global choice.** Display settings → Sky → *Sky* picks Space or Living sky **for every
  board at once**. Wanting Earth over the artillery and the galaxy behind the candles is not a
  thing the sheet can say.
* **Six scattered "Star field" switches.** Block space, Markets, Tetrust, Blockout, Blockanoid and
  Scorched Yard each carry a `stars` toggle in their own tab. It reads as "stars on or off", but
  under the Living sky it means "draw the day or draw nothing" — which is the black-sky report
  from earlier today.
* **Four private galaxy switches.** The games each carry a `galaxy` and a `galaxyAt` of their own,
  beside the Sky tab's galaxy and galaxyAt, so the same spiral is switched in five places.
* **Nothing joins them up.** No page says "Block space: Space · Scorched Yard: Earth". The player
  has to hold the mapping in their head, and the mapping is one global switch plus six local ones.

## 2. The shape it should have

**Two skies, named as things; each board picks one: Galaxy or Earth.**

(Operator, later the same day: "Space is too confusing with 'Block Space' — let's rename it
'Galaxy'." So the star-field sky is the **Galaxy** sky throughout, and the word "space" is not a
sky anywhere in the sheet. The one thing it collides with is the Galaxy sky's own *Spiral galaxy*
toggle, which lays the stars on arms or scatters them: that row becomes **Spiral arms**, and its
placement row **Arms centre**.)

* The **Sky** tab becomes a catalogue with a summary at the top:

  ```
  WHICH SKY, WHERE
  Block space ·········· Galaxy     (also the Kiosk's left panel)
  Markets & Price ······ Galaxy     (also the Kiosk's right panel)
  Tetrust ·············· Galaxy
  Blockout ············· Galaxy
  Blockanoid ··········· Galaxy
  Scorched Yard ········ Earth
  ```

  Every row is a select: **Galaxy · Earth · None**. Changing it here is the same as changing it in
  the board's own tab. This table is the whole answer to "which settings apply to which panel".

* Below it, **two titled sections**, each describing one sky and nothing else:
  * **Galaxy** — the star field, its density and brightness, the spiral arms and where their
    centre sits, nebulae, dust lanes, clusters, distant galaxies, colours, glints.
  * **Earth** — the clock (real, a day every 24 minutes, a fixed hour), the weather, cloud cover,
    latitude, sun rays, rainbow, shooting stars.

  Neither section is ever dimmed: a sky's controls are always live, because some board may be
  using it. The dimming added this morning goes away, since it was compensating for the global
  switch.

* Each **board tab** carries exactly one sky control: **Sky: Galaxy / Earth / None**, first in its
  group, with a hint that points at the Sky tab for the make-up. Its `stars`, `galaxy` and
  `galaxyAt` rows are gone. The arms' placement stays a property of the Galaxy sky, set once.

* The games' **panel switches** follow: the `stars` and `galaxy` buttons on Tetrust, Blockout,
  Blockanoid and Scorched Yard become one **sky** button that cycles Galaxy → Earth → None and shows
  which it is on.

* **"Living sky" is renamed "Earth sky"** everywhere, which is what the operator calls it and is
  shorter.

## 3. Defaults

Galaxy for every board — it is BlockYard's signature — except **Scorched Yard, which ships with
Earth**: an artillery duel wants a day and a horizon, and it already turns each round to its
own hour. Nothing else changes look by default.

## 4. What existing settings become

The stored shape today is one `sky.type` plus six `<board>.stars`. The new shape is one
`<board>.sky` per board, with values `galaxy | earth | none`. The mapping that preserves exactly
what every installation draws right now:

| stored today | becomes |
|---|---|
| `<board>.stars: false` | `<board>.sky: 'none'` |
| `<board>.stars: true` and `sky.type: 'space'` | `<board>.sky: 'galaxy'` |
| `<board>.stars: true` and `sky.type: 'living'` | `<board>.sky: 'earth'` |
| `<board>.galaxy`, `<board>.galaxyAt` (the games') | dropped; `sky.galaxy` / `sky.galaxyAt` stand |
| `sky.type` | dropped |

Because settings stored on the server carry no schema version, a migration there runs on **every
boot** — so this one is written to be idempotent: it acts only when the old key is present and the
new one is absent, and then removes the old key. A store already in the new shape is untouched.
(The same fact is why the wind mode was not migrated this morning; here the transform is a rename,
which is safe to repeat.)

The operator's own installation comes forward as: every board Galaxy except Scorched Yard, which
has `stars: false` under `type: 'living'` today — that would become `none`, which is not what was
asked for. The migration special-cases nothing; the sheet's new table makes it a one-click change,
and the plan's landing note will say so.

## 5. Where the code changes

* `public/js/settings.js` — DEFAULTS: `sky.type` out, `<board>.sky` in; the games' galaxy keys out.
  PANEL_GROUPS: the Sky group rebuilt as summary + two sections (the summary is a new row kind,
  `skymap`, that app.js renders as the table); each board group gets its `sky` choice row.
  `skyFor(n, board)` replaces `skyExtras` + the per-board `stars` plumbing: it answers `{ stars,
  skyType, ...earth, ...deepSky }` for a board, and the seven option builders call it. Migration
  `MIGRATIONS[5]`, idempotent as above; `SCHEMA_VERSION` 6.
* `public/js/app.js` — renders the `skymap` row as the table of selects, wired to the same
  `data-cfgset` path as any choice, so a change in either place is one change.
* `public/js/details3d.js` — reads `skyType === 'earth'` (accepting `'living'` for one release);
  the star field is drawn for `'galaxy'` (and `'space'` for one release).
* The boards — `mining.js`, `markets.js`, `kiosk.js`, `tetrust.js`, `blockout.js`, `blockanoid.js`,
  `scorchedyard.js`: take their sky from `skyFor`; the games' panel switch becomes the cycle
  button; `index.html` loses the four `stars` / `galaxy` buttons and gains four `sky` buttons.
* Docs — USER-GUIDE's Sky section rewritten around the table; CONFIGURATION's settings keys;
  CHANGELOG.
* Tests — `settings.test.js` (shape, defaults, the migration on all four stored combinations, and
  that it is idempotent when run twice), `finish.test.js` (each option builder's `stars`/`skyType`
  for each value), the games' page-wiring tests (the switch ids), `viewer-canvas-rules` unchanged.
  A test also holds the sheet to never labelling a sky "Space": the word belongs to Block space.

## 6. Size and order

About a day's change across settings, the seven boards and their tests; no renderer work beyond
the one rename. Landing order: schema and migration first (with the tests that prove nothing
changes on screen), then the Sky tab, then the boards one at a time, then the panel switches and
the rename, then the docs. Each step leaves the suite green and the boards drawing what they drew.

## 7. What is deliberately not in this

* No per-board Earth parameters (a different hour for the candles than for the artillery). One
  Earth, one Space; a board chooses between them. Scorched Yard's per-round hour is the game's own
  business and stays.
* No third sky. The catalogue shape makes adding one a section and a value, later.
* The internal option name `space` on the Block space board (its deck texture and floor style) is
  not renamed: it is a board style, not a sky, and nothing in the sheet shows the word.
