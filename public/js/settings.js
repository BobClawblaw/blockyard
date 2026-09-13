// SETTINGS THE VIEWER KEEPS (operator, 2026-09-12: "We need to add a configuration panel, allow
// persistent settings for our app ... tweaking the visual effects of the Block space. eg: remove
// shadows, simple cubes, lower level of detail etc... anything to make it run faster ... settings
// that affect the star field").
//
// Every switch here maps to an option the renderer already honours, or to one added for it
// (`shadows`, `starDensity`, `starBrightness`). Nothing in this file draws: it holds the values,
// clamps them, persists them per browser, and hands the renderers their options. A setting that
// did not change what is drawn would be a lie told in a checkbox.
//
// Stored per browser under `blockyard.settings` (like `blockyard.viewerMode`), because these are view
// preferences, not node state: a kiosk screen and a laptop looking at the same monitor want
// different answers, and neither should need an account to have one.
//
// THE STORE IS VERSIONED (operator, 2026-09-12: "Scope an improved durable settings menu", and
// the choice to build the foundation first). Regrouping a key used to be unaffordable: normalise
// dropped what it did not recognise and setSetting ignored what it could not place, so any move
// silently discarded the operator's stored choice. A version and a migration chain make a move
// survivable, and `sky` below is the first one to take it.

export const SETTINGS_KEY = 'blockyard.settings';
export const SCHEMA_VERSION = 3;

export const DEFAULTS = Object.freeze({
  space: Object.freeze({
    // OFF by default (operator, 2026-09-12: "make simple cubes the default, disable shadows by
    // default"). Shadows are the costliest single thing the board draws -- one per resting stone
    // and more in flight -- and the board is the first thing most people open.
    shadows: false,       // cube-on-cube and resting shadows (blockscene3d shadowOps)
    idleFx: true,         // the effects at rest: ripples, light cycles, the lightning ball
    edges: true,          // the dark seam around each stone
    grid: true,           // the neon grid on the board
    // ITS COLOUR AND ITS BRIGHTNESS (operator, 2026-09-12: "Also add a color selector and
    // brightness setting for the grid lighting for blockspace"). One hex drives the core, the
    // halo, the glow and the bright edge line together -- see gridColours() for why it cannot be
    // a single value. The shipped pair reproduces the hand-tuned green exactly, so the board does
    // not change appearance until someone changes it.
    gridColour: '#32be7d',
    gridBrightness: 1,
    // THE FINISH (operator, 2026-09-12: "consider neon-izing each of teh blocks, and adding an
    // optional specular metallic sheen to the blocks. Have it toggle. I want to be able to apply
    // the sheen onto simple cube mode if I want. think maximum configuration options"). Both
    // opt-in: the shipped look is the deliberate one, these are finishes laid over it, and they
    // work at every level of detail -- a Simple cube takes the sheen as well as a full one.
    neon: false,          // the edges of every block stroked in its own colour, lit
    // THE NEON TUBES TUNED (operator, 2026-09-12: "preferences for tuning the neon outline colors
    // ... Slider for brightness, color selection, realtime preview ... optionally have the neon
    // color tied to the block temperature"): the tube takes the block's feerate colour, or one
    // colour of the operator's choosing, at a brightness of their choosing
    neonSource: 'temperature',   // 'temperature' (the block's own colour) | 'colour' (neonColour)
    neonColour: '#3d8bff',       // the one colour, when chosen
    neonBrightness: 1,           // multiplies the tubes' alpha and width (0.2 .. 2)
    sheen: false,         // a metallic highlight along the lit edge of each top face
    // ON (operator, 2026-09-13: "the current settings I have saved out should be the shipping
    // defaults"). It was opt-in because a twinkling field means the board never stops repainting.
    // That cost is now paid deliberately rather than avoided: it is the look that was chosen.
    stars: true,
    dome: 5,              // how far the board bows toward the viewer, 0 = flat
    light: 'overhead',    // where the lamp is (operator, 2026-09-12: "directly above the board centered")
    detail: 'simple',     // 'full' | 'simple' | 'flat' -- facet and crown thresholds below; simple by default
    motion: 'full',       // 'full' | 'quick' | 'still' -- the refresh choreography
  }),
  // THE SKY IS ONE SKY. density and brightness lived under `markets` and were passed only to the
  // markets board, so the Block space star field -- the same stars, drawn by the same code -- had
  // no density or brightness control at all. Whether each board shows stars stays per board
  // (space.stars, markets.stars); what the stars LOOK like belongs to neither.
  sky: Object.freeze({
    density: 3,           // multiplies the star count (0.2 .. 3) -- the shipped look sits at the top of the range
    brightness: 1,        // multiplies each star's alpha (0.2 .. 1.5)
    galaxy: true,         // the same stars laid on spiral arms, turning once a quarter hour
    galaxyAt: 'bottom-left',   // where its middle sits: behind the board, or any of the corners
    // THE LAYERS OF THE SKY, each its own switch (operator, 2026-09-12: "We should have toggles for
    // all these sub-options in preferences"). All on: they were asked for, and a feature shipped
    // behind an off switch is not shipped.
    nebulae: true,        // gas clouds on the arms
    galaxies: true,       // distant galaxies in the deep field behind everything
    dust: true,           // dark lanes along the inner edge of each arm
    clusters: true,       // tight knots of stars out in the halo
    colours: true,        // stars coloured by population: warm bulge, blue-white arms
    glints: true,         // the halo and cross glint on the brightest stars
  }),
  // `glow` was here and is gone (operator, 2026-09-12: "on markets and price. we should never show
  // the grid glow. that's just terrible"). Never-show makes the switch a control nobody may use,
  // and a control that must stay off is worse than no control: the board forces it off now.
  markets: Object.freeze({
    stars: true,
    effects: true,        // the idle effects and the flight when the candles refresh
    // THE TOOLBAR REMEMBERS (operator, 2026-09-12: "We need to remember the user settings for the
    // Markets page"). Which exchange and how many hours were a click that survived until the tab
    // was closed; they are preferences, and they live here now. Strings, because a <select> hands
    // back a string and a number that arrives as "24" must still match its own control.
    exchange: 'coinbase',
    range: '24',
    // ONE VIEW OR THE OTHER, never both (operator, 2026-09-12: "For markets page, have a selector
    // for either the 3D view or 2D view for price. Not both at the same time. Too much waste of
    // space for that screen"). The page drew the 3D board AND the flat candlestick chart on every
    // render, one above the other, which is two tall panels of the same hours. A string for the
    // same reason `range` is one: a control hands back a string, and a remembered choice has to
    // match what its own control offers.
    // 2D by default (operator, 2026-09-12: "make 2D view the default"): the flat chart is the one
    // that answers "what is the price doing" at a glance, with axes and a crosshair. The board is
    // the showpiece, and it is one click away.
    priceView: '2d',     // '2d' (the flat chart) | '3d' (the candle board)
    // THE SUMMARY LINE ON OVERVIEW (operator, 2026-09-13: "We really need to squeeze this line into
    // the top of the Overview, between Sync status and Block Flow").
    //
    // OFF by default, and that is the whole point of it being a setting. Those four figures come
    // from the full exchange feed, which is deliberately parked unless someone is on Markets or
    // Kiosk -- and Overview is the page the app OPENS on. Defaulting this true would mean every
    // deployment starts talking to five exchanges the moment anyone looks at it, which is exactly
    // what docs/SECURITY.md promises it does not do. On, it is the operator's deliberate choice,
    // and the outbound table says Overview counts as watching.
    overviewSummary: false,
  }),
  // EVERY EFFECT ITS OWN SWITCH (operator, 2026-09-12: "at least 25 total different effects, all
  // toggleable"). The keys are exactly details3d's FX_KINDS -- a test asserts the two lists match,
  // so an effect cannot ship without a switch or a switch outlive its effect. All on: they were
  // asked for, and the board picks among whatever is left on (scheduleFx). Turn them all off and
  // the board simply rests, which `idleFx` also does in one click.
  effects: Object.freeze({
    ripple: true, outline: true, tide: true, cascade: true, twinkle: true, scan: true,
    lightcycle: true, ball: true, pulse: true,
    shockwave: true, nova: true, firework: true, flare: true, wave: true, quake: true,
    rain: true, sparkle: true, checker: true, radar: true, vortex: true, laser: true,
    powerup: true, combo: true, aurora: true, plasma: true, glitch: true,
  }),
  // BLOCKOUT (operator, 2026-09-12: "take the classic Atari Breakout game, and make a clone of it,
  // in another tab, using our engine"). The same shape as the Tetrust group: the game says whether
  // there is a sky and a galaxy; what the sky is MADE of comes from the Sky group.
  blockout: Object.freeze({
    stars: true,
    galaxy: true,
    galaxyAt: 'center',
    neon: false,          // the bricks as dim bodies under lit tubes
    neonSource: 'brick',  // 'brick' (each row's own colour) | 'colour'
    neonColour: '#3d8bff',
    neonBrightness: 1,
    // the grid under the court, its own now rather than the engine's hardcoded green
    grid: true,
    gridColour: '#3cc88c',
    gridBrightness: 0.35,   // well down from full: the court reads better with the lattice faint
    sfx: true,
  }),
  // BLOCKANOID (operator, 2026-09-12: "Take blockout, and make rip off of Arkanoid using our
  // engine, and make it a new Diversion called 'Blockanoid'"). Blockout's shape plus the two
  // switches Arkanoid earns: whether capsules fall at all, and whether the minions turn up.
  blockanoid: Object.freeze({
    stars: true,
    galaxy: true,
    galaxyAt: 'center',
    neon: false,
    neonSource: 'brick',  // 'brick' (the brick's own colour) | 'colour'
    neonColour: '#3d8bff',
    neonBrightness: 1,
    capsules: true,       // the falling letters
    enemies: true,        // the minions drifting down the court
    grid: true,           // the grid under the court
    gridColour: '#332c63',   // deep indigo rather than the engine green
    gridBrightness: 1,
    sfx: true,
  }),
  // TETRUST (operator, 2026-09-12: "Have this entire panel filled black and rendering the spiral
  // galaxy for this display. Have the text floating over the spiral galaxy ... add toggles for
  // those settings in the game and have them persistent in settings"). The sky is the panel's own
  // canvas behind the well, so it costs the game nothing per key press.
  tetrust: Object.freeze({
    stars: true,          // the star field across the whole panel
    galaxy: true,         // the spiral galaxy in it
    galaxyAt: 'center',   // where its centre sits: behind the title
    // the landing marker's colour (operator: "I want to be able to set the ghost wireframe
    // color"). Its own setting, not the neon tubes': the wireframe is drawn instead of a block,
    // so the neon finish never touches it.
    ghostColour: '#2f2c44',
    ghostWidth: 0.5,      // multiplies the marker's line thickness (operator: "thinner lines")
    music: true,          // the tune
    sfx: true,            // the effects: move, rotate, drop, clear, game over
    neon: false,          // neon tubes on the pieces and the stack
    neonSource: 'piece',  // 'piece' (each piece's colour) | 'colour' (neonColour)
    neonColour: '#3d8bff',
    neonBrightness: 1,
    grid: true,           // the grid under the well
    gridColour: '#1844bf',   // blue rather than the engine green
    gridBrightness: 1.55,    // and above full, which the blue needs to read at all
  }),
});

const DETAIL = {
  // facetPx/crownPx are "draw this extra detail only when a stone is at least this many device
  // pixels across". Raising them is the cheap way to simplify: the same scene, fewer polygons.
  full: { facetPx: 9, crownPx: 18 },
  simple: { facetPx: 26, crownPx: Infinity },     // the divot IS the crown: never, at any size
  flat: { facetPx: Infinity, crownPx: Infinity },   // facets and crown only: the seam is the operator's call
};

const MOTION = {
  full: null,                                              // the shipped 20 s choreography
  quick: { rise: 900, travel: 3200, drop: 1800 },
  still: { rise: 0, travel: 1, drop: 0 },                  // lands immediately; no flight
};

// What the panel draws. Kept beside the values so a new setting cannot be added without a
// control, or a control without a value -- and, since normalise reads its bounds from here, so
// that a slider and the clamp behind it cannot disagree. They used to be written out twice.
export const PANEL = Object.freeze([
  Object.freeze({
    group: 'space',
    title: 'Block space',
    note: 'The 3D board on Overview, Block space, Mempool and Kiosk. Turn things off here if the board is heavy on this machine.',
    rows: Object.freeze([
      Object.freeze({ key: 'shadows', label: 'Shadows', kind: 'toggle', hint: 'Cubes casting shadows on the board and on each other' }),
      Object.freeze({ key: 'idleFx', label: 'Idle effects', kind: 'toggle', hint: 'Ripples, scans, light cycles and the lightning ball while the board rests' }),
      Object.freeze({ key: 'edges', label: 'Stone edges', kind: 'toggle', hint: 'The dark seam around each stone' }),
      Object.freeze({ key: 'grid', label: 'Neon grid', kind: 'toggle', hint: 'The glowing grid on the board' }),
      Object.freeze({ key: 'gridColour', label: 'Grid colour', kind: 'colour', hint: 'The grid’s colour: its lit core, and the halo and glow around it, all take it together' }),
      Object.freeze({ key: 'gridBrightness', label: 'Grid brightness', kind: 'range', min: 0, max: 2, step: 0.05, hint: 'How hard the grid burns; 1 is the shipped grid, 0 leaves the lines unlit' }),
      Object.freeze({ key: 'neon', label: 'Neon blocks', kind: 'toggle', hint: 'Every block a dim solid body under lit tubes on its edges. Works at any level of detail' }),
      Object.freeze({
        key: 'neonSource', label: 'Neon colour from', kind: 'choice', hint: 'The tubes in each block’s own feerate colour, or all in one colour',
        options: Object.freeze([['temperature', 'The block’s feerate colour'], ['colour', 'One colour']]),
      }),
      Object.freeze({ key: 'neonColour', label: 'Neon colour', kind: 'colour', hint: 'The one colour, when chosen above' }),
      Object.freeze({ key: 'neonBrightness', label: 'Neon brightness', kind: 'range', min: 0.2, max: 2, step: 0.1, hint: 'How hard the tubes glow; 1 is the shipped glow' }),
      Object.freeze({ key: 'sheen', label: 'Metallic sheen', kind: 'toggle', hint: 'A specular highlight along the lit edge of each block’s top face. Works on Simple cubes too' }),
      Object.freeze({ key: 'stars', label: 'Star field', kind: 'toggle', hint: 'Stars behind the board. They twinkle, so the board keeps repainting while they are on' }),
      Object.freeze({
        key: 'detail', label: 'Level of detail', kind: 'choice', hint: 'Simpler cubes draw fewer polygons at the same size',
        options: Object.freeze([['full', 'Full'], ['simple', 'Simple cubes'], ['flat', 'Flat tiles']]),
      }),
      Object.freeze({
        key: 'motion', label: 'Refresh animation', kind: 'choice', hint: 'How blocks travel when the board refreshes',
        options: Object.freeze([['full', 'Full flight'], ['quick', 'Quick'], ['still', 'None']]),
      }),
      Object.freeze({ key: 'dome', label: 'Board curve', kind: 'range', min: 0, max: 12, step: 1, hint: 'How far the board bows toward you; 0 is flat' }),
      Object.freeze({
        key: 'light', label: 'Light', kind: 'choice', hint: 'Where the lamp hangs. Straight above lights the whole board evenly; a corner shades the far slope of the curve and the sides turned away',
        options: Object.freeze([['overhead', 'Straight above'], ['upper-left', 'Upper left'], ['upper-right', 'Upper right'], ['front', 'From the viewer']]),
      }),
    ]),
  }),
  Object.freeze({
    group: 'sky',
    title: 'Sky',
    note: 'The star field itself, wherever it is drawn — behind the Block space board and behind the candles. Each board decides whether to show it; this decides what it looks like.',
    rows: Object.freeze([
      Object.freeze({ key: 'galaxy', label: 'Spiral galaxy', kind: 'toggle', hint: 'Lay the stars on slowly turning spiral arms instead of scattering them evenly. One turn takes about fifteen minutes' }),
      Object.freeze({
        key: 'galaxyAt', label: 'Galaxy centre', kind: 'choice',
        hint: 'Where its middle sits. A corner crowds the bright centre there and sweeps the arms across; behind the board shows the whole spiral',
        options: Object.freeze([['center', 'Behind the board'], ['top-left', 'Top left'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']]),
      }),
      Object.freeze({ key: 'nebulae', label: 'Nebulae', kind: 'toggle', hint: 'Clouds of gas along the spiral arms, in the colours of star-forming lanes' }),
      Object.freeze({ key: 'dust', label: 'Dust lanes', kind: 'toggle', hint: 'Dark ribbons along the inner edge of each arm, the way a real spiral carries them' }),
      Object.freeze({ key: 'clusters', label: 'Star clusters', kind: 'toggle', hint: 'Tight knots of stars out in the halo, turning with the galaxy' }),
      Object.freeze({ key: 'galaxies', label: 'Distant galaxies', kind: 'toggle', hint: 'Other galaxies, small and faint and far, behind everything else' }),
      Object.freeze({ key: 'colours', label: 'Star colours', kind: 'toggle', hint: 'Warm old stars in the middle, blue-white young ones in the arms. Off is one colour of starlight' }),
      Object.freeze({ key: 'glints', label: 'Star glints', kind: 'toggle', hint: 'The halo and cross glint on the brightest stars' }),
      Object.freeze({ key: 'density', label: 'Star density', kind: 'range', min: 0.2, max: 8, step: 0.1, hint: 'How many stars, against the shipped number. High values are a lot of drawing on a big panel' }),
      Object.freeze({ key: 'brightness', label: 'Star brightness', kind: 'range', min: 0.2, max: 1.5, step: 0.1, hint: 'How brightly they burn' }),
    ]),
  }),
  Object.freeze({
    group: 'markets',
    title: 'Markets & Price',
    note: 'The candle board on Markets and Kiosk.',
    rows: Object.freeze([
      Object.freeze({ key: 'stars', label: 'Star field', kind: 'toggle', hint: 'The twinkling sky behind the candles' }),
      Object.freeze({ key: 'effects', label: 'Board effects', kind: 'toggle', hint: 'Ripples, light cycles and the lightning ball while the board rests, and the flight when the candles refresh. Off draws the board and leaves it alone' }),
      Object.freeze({
        key: 'exchange', label: 'Exchange', kind: 'choice', hint: 'Whose candles the chart and the 3D board draw. The others stay as overlay lines',
        options: Object.freeze([['coinbase', 'Coinbase'], ['kraken', 'Kraken'], ['bitstamp', 'Bitstamp'], ['bitfinex', 'Bitfinex'], ['okx', 'OKX']]),
      }),
      Object.freeze({
        key: 'range', label: 'Range', kind: 'choice', hint: 'How many hours the chart covers when the page opens',
        options: Object.freeze([['24', '24 hours'], ['48', '48 hours'], ['168', '7 days']]),
      }),
      Object.freeze({
        key: 'overviewSummary', label: 'Price line on Overview', kind: 'toggle',
        hint: 'Median, spread, 24 h volume and how many books reported, at the top of Overview. '
          + 'Off by default: it needs the exchange feed, so turning it on means this monitor '
          + 'contacts five exchanges whenever Overview is open, not only on Markets and Kiosk.',
      }),
      Object.freeze({
        key: 'priceView', label: 'Price view', kind: 'choice', hint: 'Which one the Markets page draws. Only one at a time — they show the same hours, and two tall panels of it filled the screen',
        options: Object.freeze([['2d', 'Flat chart'], ['3d', '3D candle board']]),
      }),
    ]),
  }),
  Object.freeze({
    group: 'blockout',
    title: 'Blockout',
    note: 'The Breakout court. These switches are also on the game\u2019s own panel; the sky takes its density, brightness and layers from Sky above.',
    rows: Object.freeze([
      Object.freeze({ key: 'stars', label: 'Star field', kind: 'toggle', hint: 'The sky across the whole panel, behind the court' }),
      Object.freeze({ key: 'galaxy', label: 'Spiral galaxy', kind: 'toggle', hint: 'The galaxy in that sky, turning' }),
      Object.freeze({
        key: 'galaxyAt', label: 'Galaxy centre', kind: 'choice', hint: 'Where the galaxy\u2019s centre sits on the panel',
        options: Object.freeze([['center', 'Behind the court'], ['top-left', 'Top left'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']]),
      }),
      Object.freeze({ key: 'neon', label: 'Neon bricks', kind: 'toggle', hint: 'The wall, the bat and the ball as dim bodies under lit tubes' }),
      Object.freeze({
        key: 'neonSource', label: 'Neon colour from', kind: 'choice', hint: 'Each brick row\u2019s own colour, or all in one colour',
        options: Object.freeze([['brick', 'The brick\u2019s colour'], ['colour', 'One colour']]),
      }),
      Object.freeze({ key: 'neonColour', label: 'Neon colour', kind: 'colour', hint: 'The one colour, when chosen above' }),
      Object.freeze({ key: 'neonBrightness', label: 'Neon brightness', kind: 'range', min: 0.2, max: 2, step: 0.1, hint: 'How hard the tubes glow' }),
      Object.freeze({ key: 'grid', label: 'Grid', kind: 'toggle', hint: 'The grid under the court' }),
      Object.freeze({ key: 'gridColour', label: 'Grid colour', kind: 'colour', hint: 'The colour of the grid under the court' }),
      Object.freeze({ key: 'gridBrightness', label: 'Grid intensity', kind: 'range', min: 0, max: 2, step: 0.05, hint: 'How strongly the grid shows; 1 is the shipped weight, 0 hides it' }),
      Object.freeze({ key: 'sfx', label: 'Sound effects', kind: 'toggle', hint: 'The bat, the bricks, the walls and a lost ball' }),
    ]),
  }),
  Object.freeze({
    group: 'blockanoid',
    title: 'Blockanoid',
    note: 'The Arkanoid court: silver bricks that take more than one hit, gold that takes none, and capsules that fall out of what you break. These switches are also on the game’s own panel.',
    rows: Object.freeze([
      Object.freeze({ key: 'stars', label: 'Star field', kind: 'toggle', hint: 'The sky across the whole panel, behind the court' }),
      Object.freeze({ key: 'galaxy', label: 'Spiral galaxy', kind: 'toggle', hint: 'The galaxy in that sky, turning' }),
      Object.freeze({
        key: 'galaxyAt', label: 'Galaxy centre', kind: 'choice', hint: 'Where the galaxy’s centre sits on the panel',
        options: Object.freeze([['center', 'Behind the court'], ['top-left', 'Top left'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']]),
      }),
      Object.freeze({ key: 'neon', label: 'Neon bricks', kind: 'toggle', hint: 'The wall, Vaus and the ball as dim bodies under lit tubes' }),
      Object.freeze({
        key: 'neonSource', label: 'Neon colour from', kind: 'choice', hint: 'Each brick’s own colour, or all in one colour',
        options: Object.freeze([['brick', 'The brick’s colour'], ['colour', 'One colour']]),
      }),
      Object.freeze({ key: 'neonColour', label: 'Neon colour', kind: 'colour', hint: 'The one colour, when chosen above' }),
      Object.freeze({ key: 'neonBrightness', label: 'Neon brightness', kind: 'range', min: 0.2, max: 2, step: 0.1, hint: 'How hard the tubes glow' }),
      Object.freeze({ key: 'capsules', label: 'Capsules', kind: 'toggle', hint: 'The letters that fall out of broken bricks: laser, wide, catch, slow, three balls, a life, skip' }),
      Object.freeze({ key: 'enemies', label: 'Minions', kind: 'toggle', hint: 'The drifting shapes that spoil your aim, and pay when you hit one' }),
      Object.freeze({ key: 'grid', label: 'Grid', kind: 'toggle', hint: 'The grid under the court' }),
      Object.freeze({ key: 'gridColour', label: 'Grid colour', kind: 'colour', hint: 'The colour of the grid under the court' }),
      Object.freeze({ key: 'gridBrightness', label: 'Grid intensity', kind: 'range', min: 0, max: 2, step: 0.05, hint: 'How strongly the grid shows; 1 is the shipped weight, 0 hides it' }),
      Object.freeze({ key: 'sfx', label: 'Sound effects', kind: 'toggle', hint: 'Vaus, the bricks, the capsules, the laser and a lost ball' }),
    ]),
  }),
  Object.freeze({
    group: 'effects',
    title: 'Effects',
    note: 'What the board may play while it rests. One is chosen at random every seven to thirteen seconds, never the same one twice running \u2014 so the more you leave on, the less often you see any one of them. The price board only ever plays the two that follow the line.',
    rows: Object.freeze([
      Object.freeze({ key: 'ripple', label: 'Ripple', kind: 'toggle', hint: 'A ring spreading from a point on the board' }),
      Object.freeze({ key: 'outline', label: 'Outline sweep', kind: 'toggle', hint: 'A front that traces each block\u2019s edges as it passes' }),
      Object.freeze({ key: 'tide', label: 'Tide', kind: 'toggle', hint: 'A swell that lifts the blocks it passes under' }),
      Object.freeze({ key: 'cascade', label: 'Cascade', kind: 'toggle', hint: 'The blocks light in feerate order, richest first' }),
      Object.freeze({ key: 'twinkle', label: 'Twinkle', kind: 'toggle', hint: 'Scattered blocks flash white, each on its own beat' }),
      Object.freeze({ key: 'scan', label: 'Scan line', kind: 'toggle', hint: 'A tight line crossing the board, edge to edge' }),
      Object.freeze({ key: 'lightcycle', label: 'Light cycles', kind: 'toggle', hint: 'Two riders from opposite edges, leaving light walls, until one crashes' }),
      Object.freeze({ key: 'ball', label: 'Lightning ball', kind: 'toggle', hint: 'A plasma ball tracing the grid, throwing bolts and a dust trail' }),
      Object.freeze({ key: 'pulse', label: 'Energy pulse', kind: 'toggle', hint: 'The surge that runs the price line on Markets, blue behind the head' }),
      Object.freeze({ key: 'shockwave', label: 'Shockwave', kind: 'toggle', hint: 'A hard ring that throws the blocks it passes into the air' }),
      Object.freeze({ key: 'nova', label: 'Nova', kind: 'toggle', hint: 'An implosion to the middle, then a brighter blast back out' }),
      Object.freeze({ key: 'firework', label: 'Fireworks', kind: 'toggle', hint: 'Three bursts, each at its own moment and place' }),
      Object.freeze({ key: 'flare', label: 'Solar flare', kind: 'toggle', hint: 'One block goes supernova and lights its neighbourhood' }),
      Object.freeze({ key: 'wave', label: 'Wave', kind: 'toggle', hint: 'Several crests rolling across the board, the blocks riding them' }),
      Object.freeze({ key: 'quake', label: 'Quake', kind: 'toggle', hint: 'The board shakes, hardest at the start, and settles' }),
      Object.freeze({ key: 'rain', label: 'Code rain', kind: 'toggle', hint: 'A drop falls down every column with a white head and a green tail' }),
      Object.freeze({ key: 'sparkle', label: 'Sparkle', kind: 'toggle', hint: 'A constellation lighting a few blocks at a time, each its own colour' }),
      Object.freeze({ key: 'checker', label: 'Checkerboard', kind: 'toggle', hint: 'The board flips like a chessboard, dark squares against light' }),
      Object.freeze({ key: 'radar', label: 'Radar', kind: 'toggle', hint: 'A sweep hand turning once, the blocks behind it fading like phosphor' }),
      Object.freeze({ key: 'vortex', label: 'Vortex', kind: 'toggle', hint: 'Spiral arms turning, draining the board inward' }),
      Object.freeze({ key: 'laser', label: 'Laser', kind: 'toggle', hint: 'A white cutting beam with a thin red bloom, one pass' }),
      Object.freeze({ key: 'powerup', label: 'Power-up', kind: 'toggle', hint: 'The board charges from the floor up, gold, with a bright lip' }),
      Object.freeze({ key: 'combo', label: 'Combo chain', kind: 'toggle', hint: 'A chain reaction running the diagonal, each link popping in turn' }),
      Object.freeze({ key: 'aurora', label: 'Aurora', kind: 'toggle', hint: 'Slow curtains of colour drifting over the board' }),
      Object.freeze({ key: 'plasma', label: 'Plasma', kind: 'toggle', hint: 'The demoscene plasma: sines over the board, the colour cycling' }),
      Object.freeze({ key: 'glitch', label: 'Glitch', kind: 'toggle', hint: 'Data corruption: a handful of blocks tear, hard on and hard off' }),
    ]),
  }),
  Object.freeze({
    group: 'tetrust',
    title: 'Tetrust',
    note: 'The game. These switches are also on the game’s own panel; the sky takes the star field’s density, brightness and layers from Sky above.',
    rows: Object.freeze([
      Object.freeze({ key: 'stars', label: 'Star field', kind: 'toggle', hint: 'The sky across the whole panel, behind the well' }),
      Object.freeze({ key: 'galaxy', label: 'Spiral galaxy', kind: 'toggle', hint: 'The galaxy in that sky, turning' }),
      Object.freeze({
        key: 'galaxyAt', label: 'Galaxy centre', kind: 'choice', hint: 'Where the galaxy’s centre sits on the panel: behind the title, or a corner',
        options: Object.freeze([['center', 'Behind the title'], ['top-left', 'Top left'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']]),
      }),
      Object.freeze({ key: 'ghostColour', label: 'Landing marker', kind: 'colour', hint: 'The wireframe on the floor of the well showing where the falling piece will land. Its own colour: the neon finish below never touches it, because the marker is drawn instead of a block rather than over one' }),
      Object.freeze({ key: 'ghostWidth', label: 'Landing marker thickness', kind: 'range', min: 0.3, max: 2.5, step: 0.1, hint: 'How heavy the marker\u2019s lines are. 1 is the shipped weight; below it the outline thins out of the way of the stack behind it' }),
      Object.freeze({ key: 'music', label: 'Music', kind: 'toggle', hint: 'Korobeiniki, on oscillators' }),
      Object.freeze({ key: 'sfx', label: 'Sound effects', kind: 'toggle', hint: 'Move, rotate, drop, clear, game over' }),
      Object.freeze({ key: 'neon', label: 'Neon pieces', kind: 'toggle', hint: 'The pieces and the stack as dim bodies under lit tubes' }),
      Object.freeze({
        key: 'neonSource', label: 'Neon colour from', kind: 'choice', hint: 'Each piece’s own colour, or all in one colour',
        options: Object.freeze([['piece', 'The piece’s colour'], ['colour', 'One colour']]),
      }),
      Object.freeze({ key: 'neonColour', label: 'Neon colour', kind: 'colour', hint: 'The one colour, when chosen above' }),
      Object.freeze({ key: 'neonBrightness', label: 'Neon brightness', kind: 'range', min: 0.2, max: 2, step: 0.1, hint: 'How hard the tubes glow' }),
      Object.freeze({ key: 'grid', label: 'Grid', kind: 'toggle', hint: 'The grid under the well' }),
      Object.freeze({ key: 'gridColour', label: 'Grid colour', kind: 'colour', hint: 'The colour of the grid under the well' }),
      Object.freeze({ key: 'gridBrightness', label: 'Grid intensity', kind: 'range', min: 0, max: 2, step: 0.05, hint: 'How strongly the grid shows; 1 is the shipped weight, 0 hides it' }),
    ]),
  }),
]);

// "group.key" -> the row that defines it. The bounds live in exactly one place now.
const ROWS = new Map();
for (const g of PANEL) for (const r of g.rows) ROWS.set(`${g.group}.${r.key}`, r);

const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

/** Clamp a number to the bounds its own slider advertises. */
function clampRow(row, v, fallback) {
  return clamp(v, row?.min ?? -Infinity, row?.max ?? Infinity, fallback);
}
/** Accept a choice only if its own control offers it. */
const HEX = /^#[0-9a-f]{6}$/i;
function pickRow(row, v, fallback) {
  if (row?.kind === 'colour') return typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fallback;
  const allowed = (row?.options ?? []).map(([val]) => val);
  return allowed.includes(v) ? v : fallback;
}

// THE GRID'S COLOUR (operator, 2026-09-12: "we need to break out the green grid settings per game.
// We should also add a grid color picker, and a transparency slider. I don't want to see the grid
// in bitlaga for example, and I really want to turn down the intensity on blockanoid", and "Also
// add a color selector and brightness setting for the grid lighting for blockspace").
//
// A picker CANNOT simply overwrite one value. The board draws its grid as a family: an OPAQUE core
// with a translucent halo and glow around it and a brighter edge line over it, and that
// relationship is deliberate -- a see-through core reads dimmer wherever the floor beneath it is
// shadowed, and composite modes are off the table (details3d.js, "I want that neon light cutting
// through darkness entirely"). So one hex recolours the whole family while each layer keeps its
// RELATIVE alpha and lift toward white, and brightness multiplies those alphas together.
//
// [lift toward white, alpha at brightness 1, brighten first?] -- reverse-engineered from
// details3d.js's own tuned defaults, and MEASURED against them rather than guessed.
//
// The first cut lifted the base hue toward WHITE for the rings and got
// rgba(122,213,171) where the board draws rgba(40,255,140): the whole grid came out greyer. The
// palette does not lighten, it SATURATES -- every ring layer has its green channel pinned at 255 --
// so the ring colours brighten to full first, and only then lift toward white. Checked against the
// originals that puts gridEdgeColor at (123,255,194) against (120,255,190), and neonLine at
// (170,255,216) against (170,255,210). The core alone is the base hue untouched, which is exact.
const GRID_LAYERS = Object.freeze({
  neonCell: [0, 1, false],          // the opaque core: the chosen colour itself
  neonHalo: [0, 0.07, true],
  neonGlow: [0, 0.2, true],
  gridGlow: [0, 0.05, true],
  gridColor: [0, 0.16, true],
  gridEdgeColor: [0.3, 1, true],
  neonLine: [0.55, 1, true],
});
const rgbOf = (hex, fallback) => {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const liftRgb = ([r, g, b], t) => [r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t].map((v) => Math.round(v));
const rgbaOf = ([r, g, b], a) => `rgba(${r},${g},${b},${Math.round(Math.max(0, Math.min(1, a)) * 1000) / 1000})`;

/** The neon form of a colour: the same hue with its brightest channel pushed to full. */
const brighten = ([r, g, b]) => {
  const m = Math.max(r, g, b) || 1;
  return [r, g, b].map((v) => Math.min(255, Math.round((v * 255) / m)));
};

/** The block-space board's grid layers, from one colour and a brightness. */
export function gridColours(hex, brightness = 1) {
  const base = rgbOf(hex, [50, 190, 125]);
  const k = clamp(brightness, 0, 2, 1);
  const lit = brighten(base);
  const out = {};
  for (const [key, [lift, alpha, saturate]] of Object.entries(GRID_LAYERS)) {
    const c = saturate ? lit : base;
    out[key] = rgbaOf(lift ? liftRgb(c, lift) : c, alpha * k);
  }
  return out;
}

/**
 * A game court's grid. The courts deliberately suppress the halo and the glow -- a playfield wants
 * a quiet grid under the pieces, not a lit one -- so only the core is coloured and the two ring
 * layers stay off. `alpha` is the court's own weight: Tetrust draws its grid fainter (0.06) than
 * the brick games do (0.18), which is how they were hand-tuned before this was configurable.
 */
export function courtGridColours(hex, brightness = 1, alpha = 0.18) {
  const base = rgbOf(hex, [60, 200, 140]);
  const k = clamp(brightness, 0, 2, 1);
  // THE KEYS THE FLOOR ACTUALLY DRAWS WITH. This used to set neonCell, neonHalo and gridGlow only
  // -- and on a `space` board the visible grid is NOT neonCell. details3d strokes the floor twice:
  // `gridGlow` wide and faint, then `gridColor` thin and bright, with `gridEdgeColor` round the
  // board's rim. neonCell feeds boardGridLayers, a different layer. So the picker recoloured
  // something invisible while gridColor kept the engine's default green, and the slider scaled an
  // alpha nobody could see: measured, red-at-1 against blue-at-2 differed in neonCell and in
  // nothing else. That is the whole of "the slider does not update the games grid".
  //
  // The courts stay QUIET, which is the part worth keeping: the lit ring and the wide halo are the
  // board's treatment, not a playfield's. The line is the chosen colour, the glow under it is the
  // same colour at a fraction of the alpha, and the rim is a touch brighter so the court still has
  // an edge. Everything scales with `alpha` (the court's own weight) and `k` (the operator's).
  const lit = liftRgb(base, 0.35);
  // `neonLine` IS THE COURT'S GRID. boardGridLayers splits the lattice with
  // `(i % gridStep ? cell : line)`: cells take `neonCell`, every gridStep-th line takes `neonLine`.
  // The courts set gridStep: 1, so `i % 1` is always 0 -- EVERY line takes neonLine and neonCell is
  // never used on a court at all. Omitting neonLine left the whole lattice at the engine default
  // rgba(170,255,210,1), an opaque pale green, while the rim obediently changed colour: "grid color
  // only seems to affect the border, not the grid itself for the games. I can't change the entire
  // grid color from green."
  // It is stroked at a higher alpha than the cell lines because it is the ONLY line on these
  // boards -- at 0.18 the court would be a whisper -- and it is the colour that was picked, not a
  // lifted one, so what is chosen is what is seen.
  return {
    neonLine: rgbaOf(base, Math.min(1, alpha * 3.6 * k)),
    gridColor: rgbaOf(base, alpha * k),
    gridGlow: rgbaOf(base, alpha * 0.35 * k),
    gridEdgeColor: rgbaOf(lit, Math.min(1, alpha * 3.2 * k)),
    neonCell: rgbaOf(base, alpha * k),
    neonHalo: 'rgba(0,0,0,0)',
    neonGlow: 'rgba(0,0,0,0)',
  };
}

/**
 * v1 -> v2: the sky keys move out of `markets` into their own group. A v1 store keeps the values
 * the operator chose; it does not get them reset for having been written yesterday.
 * A store with no `version` at all is v1: that is every store written before this.
 */
const MIGRATIONS = {
  1: (raw) => {
    const mk = raw.markets && typeof raw.markets === 'object' ? raw.markets : {};
    const { starDensity, starBrightness, ...markets } = mk;
    const moved = {};
    if (starDensity !== undefined) moved.density = starDensity;
    if (starBrightness !== undefined) moved.brightness = starBrightness;
    // anything already under `sky` wins: it was written by a newer schema than the one being read
    return { ...raw, markets, sky: { ...moved, ...(raw.sky && typeof raw.sky === 'object' ? raw.sky : {}) } };
  },
  // v2 -> v3: `markets.glow` is dropped. The markets board never draws the grid glow now, so the
  // stored value has nothing left to mean. Written out rather than left to normalise (which would
  // drop the key anyway) so the chain says what changed and when.
  2: (raw) => {
    const mk = raw.markets && typeof raw.markets === 'object' ? raw.markets : {};
    const { glow, ...markets } = mk;
    return { ...raw, markets };
  },
};

function migrate(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  let v = Number.isFinite(raw.version) ? raw.version : 1;
  // Written by a build newer than this one: its shape is unknown, so the honest answer is the
  // defaults rather than a guess at what its keys meant.
  if (v > SCHEMA_VERSION) return null;
  let out = raw;
  while (v < SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) return null;
    out = step(out);
    v++;
  }
  return out;
}

/**
 * Merge anything (a parsed store, a patch) onto the defaults, clamping every value.
 * Driven by DEFAULTS and PANEL rather than written out key by key, so adding a setting is one
 * entry in each and a new key cannot arrive unclamped or unlisted.
 */
export function normalise(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const group of Object.keys(DEFAULTS)) {
    const given = s[group] && typeof s[group] === 'object' ? s[group] : {};
    const settled = {};
    for (const [key, def] of Object.entries(DEFAULTS[group])) {
      const row = ROWS.get(`${group}.${key}`);
      const v = given[key];
      if (typeof def === 'boolean') settled[key] = bool(v, def);
      else if (typeof def === 'number') settled[key] = clampRow(row, v, def);
      else settled[key] = pickRow(row, v, def);
    }
    out[group] = Object.freeze(settled);
  }
  return Object.freeze(out);
}

// Parsing localStorage on every board paint was a JSON.parse per frame (markets.js and mining.js
// both call loadSettings() as they draw). The parse is memoised on the raw string, so an
// unchanged store costs a getItem and a comparison.
let cache = { raw: null, value: null };

export function loadSettings(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(SETTINGS_KEY) ?? null;
    if (cache.value && cache.raw === raw) return cache.value;
    const value = normalise(migrate(raw ? JSON.parse(raw) : null));
    cache = { raw, value };
    return value;
  } catch {
    return normalise(null);          // unreadable or corrupt: the defaults, never a crash
  }
}

// Consumers that want to know the moment a value changes, rather than waiting for the next paint.
const listeners = new Set();
/** Subscribe to settled settings. Returns an unsubscribe. */
export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(s) {
  for (const fn of [...listeners]) {
    try { fn(s); } catch { /* a broken listener must not break the save */ }
  }
}

// THE SERVER HOLDS THESE NOW (operator, 2026-09-13: "This is a server app. Should store things on
// a server"). localStorage stays as a LOCAL CACHE of what the server has, for one reason:
// loadSettings() is called on every board paint and must answer synchronously -- fetching per paint
// is not on the table, and waiting on a fetch before the first render would stall the page. So the
// boot seeds this cache from GET /api/settings (app.js), every change writes through to
// POST /api/settings, and a browser that cannot reach the server still draws with the last values
// it saw instead of snapping back to the defaults.
let push = null;           // injected by app.js: (settled) => Promise, debounced below
let pushTimer = null;
/** app.js hands us the poster once it has a CSRF-capable api(). */
export function setSettingsPush(fn) { push = fn; }

/**
 * Seed the cache from the server, before the first paint.
 * Returns the settled settings so the caller can tell whether anything was stored.
 */
export function seedSettings(stored, storage = globalThis.localStorage) {
  const s = normalise(migrate(stored));
  try { storage?.setItem(SETTINGS_KEY, JSON.stringify({ version: SCHEMA_VERSION, ...s })); } catch { /* fine */ }
  cache = { raw: null, value: null };
  emit(s);
  return s;
}

// Coalesced: dragging a slider fires an input event per step, and each one must not be its own
// write to disk. The value is already applied locally and on screen; the file catches up.
function pushSoon(s) {
  if (!push) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    try { Promise.resolve(push(s)).catch(() => {}); } catch { /* offline: the local cache stands */ }
  }, 400);
}

export function saveSettings(next, storage = globalThis.localStorage) {
  const s = normalise(next);
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify({ version: SCHEMA_VERSION, ...s }));
  } catch { /* private mode, quota: keep it in memory */ }
  cache = { raw: null, value: null };
  emit(s);
  pushSoon(s);
  return s;
}

/**
 * Set one value by "group.key" and persist the result. Returns the whole settled object.
 *
 * An unknown path THROWS. It used to be ignored, which made a typo indistinguishable from a
 * saved setting -- the control would move and nothing would persist. Every path comes from PANEL
 * (app.js builds the markup from it, and a test asserts every row names a real setting), so this
 * is unreachable unless something is genuinely wrong, and then it should say so.
 */
export function setSetting(current, path, value, storage = globalThis.localStorage) {
  const [group, key] = String(path).split('.');
  const base = normalise(current);
  if (!base[group] || !(key in base[group])) {
    throw new TypeError(`unknown setting "${path}" (groups: ${Object.keys(DEFAULTS).join(', ')})`);
  }
  return saveSettings({ ...base, [group]: { ...base[group], [key]: value } }, storage);
}

export function resetSettings(storage = globalThis.localStorage) {
  try { storage?.removeItem(SETTINGS_KEY); } catch { /* nothing to remove */ }
  cache = { raw: null, value: null };
  const s = normalise(null);
  emit(s);
  // Reset is a change like any other: the server has to hear it, or the next browser to open the
  // page would be handed the settings this one just discarded.
  pushSoon(s);
  return s;
}

/** True when nothing has been changed from the shipped defaults. */
export function isDefault(s) {
  return JSON.stringify(normalise(s)) === JSON.stringify(normalise(null));
}

/**
 * The renderer options for a block-space board (mining.js: Overview, Block space, Mempool, Kiosk).
 * Merged OVER the caller's own options, so a mode's resolution and slab still win where they are
 * the point of the mode; these are the user's preferences about how it is drawn.
 */
export function spaceOptions(s) {
  const n = normalise(s);
  const sp = n.space;
  const d = DETAIL[sp.detail] ?? DETAIL.full;
  const out = {
    shadows: sp.shadows,
    idleFx: sp.idleFx,
    grid: sp.grid,
    neon: sp.neon,
    sheen: sp.sheen,
    // `space` is the board STYLE (no deck texture, a translucent floor); `stars` is the sky. They
    // travel together here, which is the block-space board's shipped behaviour, but they are two
    // options now so the markets board can keep its style while turning its sky off.
    space: sp.stars,
    stars: sp.stars,
    dome: sp.dome,
    facetPx: d.facetPx,
    crownPx: d.crownPx,
    // the same sky the markets board draws: this board had stars and no way to thin them
    starDensity: n.sky.density,
    starBrightness: n.sky.brightness,
    galaxy: n.sky.galaxy,
    galaxyAt: n.sky.galaxyAt,
    nebulae: n.sky.nebulae, galaxies: n.sky.galaxies, dust: n.sky.dust, clusters: n.sky.clusters,
    starColours: n.sky.colours, starGlints: n.sky.glints,
  };
  // the seam belongs to the Stone edges switch at every level of detail: a control that does
  // nothing in one mode is worse than no control (operator: "stone edges don't work in flat tile
  // display mode"). Detail decides facets and the crown; this decides the outline.
  out.edges = sp.edges;
  if (!sp.edges) out.seamAlpha = 0;
  const motion = MOTION[sp.motion];
  if (motion) out.transition = motion;
  out.light = sp.light;
  out.fxKinds = enabledEffects(n);
  out.neonSource = sp.neonSource; out.neonColour = sp.neonColour; out.neonBrightness = sp.neonBrightness;
  // THE GRID'S OWN COLOUR. Until now these were never set here at all, so the board fell through to
  // the hand-tuned greens in details3d.js and there was no way to change them. The shipped values
  // reproduce those greens, so this is a new control rather than a new look.
  Object.assign(out, gridColours(sp.gridColour, sp.gridBrightness));
  return out;
}

/**
 * The game's switches, with the sky's density, brightness and layers from the Sky group: the game
 * decides whether there is a sky and a galaxy and where the galaxy sits; what the sky is made of
 * is one preference for every board.
 */
export function enabledEffects(s) {
  const n = normalise(s);
  return Object.keys(n.effects).filter((k) => n.effects[k]);
}

/** Blockout's switches, with the sky's make-up from the Sky group (as tetrustOptions does). */
export function blockoutOptions(s) {
  const n = normalise(s);
  const sky = spaceOptions(s);
  return {
    stars: n.blockout.stars, galaxy: n.blockout.galaxy, galaxyAt: n.blockout.galaxyAt, sfx: n.blockout.sfx,
    neon: n.blockout.neon,
    // the engine calls the data-coloured source "temperature"; here that is the brick's own row
    neonSource: n.blockout.neonSource === 'colour' ? 'colour' : 'temperature',
    neonColour: n.blockout.neonColour, neonBrightness: n.blockout.neonBrightness,
    grid: n.blockout.grid, gridColour: n.blockout.gridColour, gridBrightness: n.blockout.gridBrightness,
    // composed here rather than in the screen, so the court needs no new import and the renderer
    // keys stay in one place. 0.18 is the weight this court was hand-tuned at.
    gridOpts: courtGridColours(n.blockout.gridColour, n.blockout.gridBrightness, 0.18),
    starDensity: sky.starDensity, starBrightness: sky.starBrightness,
    nebulae: sky.nebulae, galaxies: sky.galaxies, dust: sky.dust, clusters: sky.clusters,
    starColours: sky.starColours, starGlints: sky.starGlints,
  };
}

/** Blockanoid's switches. Blockout's shape, plus the two that are Arkanoid's own. */
export function blockanoidOptions(s) {
  const n = normalise(s);
  const sky = spaceOptions(s);
  return {
    stars: n.blockanoid.stars, galaxy: n.blockanoid.galaxy, galaxyAt: n.blockanoid.galaxyAt, sfx: n.blockanoid.sfx,
    capsules: n.blockanoid.capsules, enemies: n.blockanoid.enemies,
    neon: n.blockanoid.neon,
    neonSource: n.blockanoid.neonSource === 'colour' ? 'colour' : 'temperature',
    neonColour: n.blockanoid.neonColour, neonBrightness: n.blockanoid.neonBrightness,
    grid: n.blockanoid.grid, gridColour: n.blockanoid.gridColour, gridBrightness: n.blockanoid.gridBrightness,
    gridOpts: courtGridColours(n.blockanoid.gridColour, n.blockanoid.gridBrightness, 0.18),
    starDensity: sky.starDensity, starBrightness: sky.starBrightness,
    nebulae: sky.nebulae, galaxies: sky.galaxies, dust: sky.dust, clusters: sky.clusters,
    starColours: sky.starColours, starGlints: sky.starGlints,
  };
}

export function tetrustOptions(s) {
  const n = normalise(s);
  const sky = spaceOptions(s);
  return {
    stars: n.tetrust.stars, galaxy: n.tetrust.galaxy, galaxyAt: n.tetrust.galaxyAt, music: n.tetrust.music, sfx: n.tetrust.sfx,
    ghostColour: n.tetrust.ghostColour, ghostWidth: n.tetrust.ghostWidth,
    neon: n.tetrust.neon, neonSource: n.tetrust.neonSource === 'colour' ? 'colour' : 'temperature', neonColour: n.tetrust.neonColour, neonBrightness: n.tetrust.neonBrightness,
    grid: n.tetrust.grid, gridColour: n.tetrust.gridColour, gridBrightness: n.tetrust.gridBrightness,
    // 0.06, not 0.18: the well draws its grid fainter than the brick courts do, because the stack
    // sits on top of it. That difference was hardcoded in tetrust.js; it lives here now.
    gridOpts: courtGridColours(n.tetrust.gridColour, n.tetrust.gridBrightness, 0.06),
    starDensity: sky.starDensity, starBrightness: sky.starBrightness,
    nebulae: sky.nebulae, galaxies: sky.galaxies, dust: sky.dust, clusters: sky.clusters, starColours: sky.starColours, starGlints: sky.starGlints,
  };
}

/** The renderer options for the markets board (markets.js board3d). */
export function marketsOptions(s) {
  const n = normalise(s);
  const mk = n.markets;
  return {
    // ALWAYS a space board: `space` carries the deck texture, the floor and the floor line as well
    // as the sky, so driving it from the star switch restyled the whole board when the operator
    // only wanted the stars gone. The sky has its own option now.
    space: true,
    stars: mk.stars,
    starDensity: n.sky.density,
    starBrightness: n.sky.brightness,
    galaxy: n.sky.galaxy,
    galaxyAt: n.sky.galaxyAt,
    nebulae: n.sky.nebulae, galaxies: n.sky.galaxies, dust: n.sky.dust, clusters: n.sky.clusters,
    starColours: n.sky.colours, starGlints: n.sky.glints,
    // never, at any setting: the halo under the grid lines is not wanted on this board
    neonHalo: 'rgba(0,0,0,0)',
    gridGlow: 'rgba(0,0,0,0)',
    // One switch for everything that MOVES on this board (operator, 2026-09-12: "we need a toggle
    // for disable effects in the market and price"). The candle board inherited idleFx from the
    // renderer's defaults and ran the refresh flight, and neither had a control of its own: the
    // Block space switches next to them govern a different board entirely.
    ...(mk.effects ? {} : { idleFx: false, transition: MOTION.still }),
    // the per-effect switches govern this board too: the price line's own two (pulse, twinkle)
    // are in the same list as the grid's
    fxKinds: enabledEffects(n),
  };
}
