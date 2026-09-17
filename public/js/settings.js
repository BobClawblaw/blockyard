// SETTINGS THE VIEWER KEEPS (operator, 2026-09-12: "We need to add a configuration panel, allow
// persistent settings for our app ... tweaking the visual effects of the Block space. eg: remove
// shadows, simple cubes, lower level of detail etc... anything to make it run faster ... settings
// that affect the star field").
//
// Every switch here maps to an option the renderer already honours, or to one added for it
// (`shadows`, `starDensity`, `starBrightness`). Nothing in this file draws: it holds the values,
// clamps them, persists them on the server, and hands the renderers their options. A setting that
// did not change what is drawn would be a lie told in a checkbox.
//
// Stored on the server in config/blockyard.json (GET/POST /api/settings), so a phone and a desktop
// pointed at the same monitor agree; the browser keeps a copy under `blockyard.settings` so a board
// still draws when the server cannot be reached. (They were per browser until 2026-09-13.)
//
// THE STORE IS VERSIONED (operator, 2026-09-12: "Scope an improved durable settings menu", and
// the choice to build the foundation first). Regrouping a key used to be unaffordable: normalise
// dropped what it did not recognise and setSetting ignored what it could not place, so any move
// silently discarded the operator's stored choice. A version and a migration chain make a move
// survivable, and `sky` below is the first one to take it.

export const SETTINGS_KEY = 'blockyard.settings';
export const SCHEMA_VERSION = 6;

export const DEFAULTS = Object.freeze({
  // APPEARANCE (operator, 2026-09-16: "add an appearance section in preferences to change the colors
  // of our layout. Our current scheme should be the default appearance ... as well as options for
  // configure custom schemes by allowing users to pick colors and save to settings so it sticks").
  // The faces themselves live in theme.js; this holds the choice and the nine custom colours, whose
  // defaults are the shipped dark look so that Custom starts where the page starts.
  appearance: Object.freeze({
    mode: 'dark',             // 'light' | 'dark' | 'system' -- which face of the theme
    theme: 'blockyard',       // a preset in theme.js PRESETS, or 'custom'
    customBg: '#0b0d10',      // the page
    customPanel: '#12151a',   // cards, the header, the settings sheet
    customText: '#dfe5ee',
    customMuted: '#96a0b0',
    customAccent: '#f7931a',
    customLine: '#262c36',
    customOk: '#2ecc8f',
    customWarn: '#f0b429',
    customBad: '#ef5a5a',
  }),
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
    // WHICH METAL (operator, 2026-09-14: "give it a chrome or faux reflective effect ... really improve
    // the metallic look"). 'chrome' mirrors a horizon in every face that slides as cubes move;
    // 'satin' is the edge highlight the sheen always was. Chrome is the default because it is the
    // answer to that ask; satin stays for anyone who preferred the quieter finish.
    sheenStyle: 'chrome', // 'chrome' | 'satin'
    // ON (operator, 2026-09-13: "the current settings I have saved out should be the shipping
    // defaults"). It was opt-in because a twinkling field means the board never stops repainting.
    // That cost is now paid deliberately rather than avoided: it is the look that was chosen.
    sky: 'galaxy',        // 'galaxy' | 'earth' | 'none' -- which sky this board draws (docs/PLAN-SKIES.md)
    dome: 5,              // how far the board bows toward the viewer, 0 = flat
    // HEIGHT THAT FORESHORTENS (operator, 2026-09-13: "I'm not seeing the bottom or the front face
    // changing at all during movement ... fix camera stuff"). The oblique camera is parallel: height
    // moves a cube up the screen and nothing scales, so a face is the same size at z=0 and z=80 --
    // measured at 11.0px either way. This scales a point about the vanishing point by 1 + gz*rise,
    // so a cube's top is larger than its base and a flying cube grows as it comes toward you.
    //
    // Off by default: a size that changes with height is exactly what the oblique camera was chosen
    // to avoid ("nothing ever changes size -- so there is no growth to police and nothing to
    // flicker"), and this area has already regressed the paint order three times. It ships as a
    // control to be looked at and compared, not as a new default.
    // RANGE: 0.01, then 0.08 (operator, 2026-09-14: "allow us a much greater range on the slider to
    // adjust Depth"), then CAPPED AT 0.03 the same day ("Lock depth at 0.03. too many issues higher than
    // that"). Measured on the paint order across a refresh, pops rise with depth -- 6 at 0.01, 24 at
    // 0.03, 44 at 0.08 -- and past 0.03 a rising cube swells over its neighbours enough to be seen.
    // A stored value above the cap is clamped to it on load; the default stays 0.
    // ...AND THEN 0.001 (operator, 2026-09-14: "The board depth slider should be a limit between 0 and
    // 0.001. It starts looking bad any higher than 0.001"), in steps of 0.0001 so the range still has
    // ten stops. A stored value above it clamps on load.
    perspective: 0,       // 0 = the parallel camera; 0.001 the most allowed
    light: 'overhead',    // where the lamp is (operator, 2026-09-12: "directly above the board centered")
    lightHeight: 'middle', // and how high it hangs when it is not overhead: 'low' | 'middle' | 'high'
    detail: 'simple',     // 'full' | 'simple' | 'flat' -- facet and crown thresholds below; simple by default
    motion: 'full',       // 'full' | 'quick' | 'still' -- the refresh choreography
    // HOW CUBES LEAVE AND ARRIVE (operator, 2026-09-13: "all the left and right side blocks are
    // arcing towards/away from the sides instead of just traveling straight up ... make it a toggle
    // for Linear vs Arcing", then "give me 3 choices to see and toggle between", then, having seen
    // all three on the live board: "Get rid of straight up. Make Along the board's curve the
    // default.")
    //
    // Measured before any of it: the shipped path is already nearly straight (the drawn slope dx/dy
    // moves only 0.7335 -> 0.7481 over a whole climb at the left edge). What reads as arcing is
    // that the straight line is STEEP -- three pixels sideways for every four up at the rim,
    // against -0.017 over the middle. A `vertical` mode that removed the fan entirely was built and
    // shown alongside these two, and cut after the comparison: the fan is the domed board being
    // honest about itself.
    //
    // A stored 'vertical' from that round is not a valid value any more, and normalise resolves an
    // unknown choice to this default, so those boards land on 'normal' rather than on nothing.
    departures: 'normal',  // 'normal' | 'arcing'
  }),
  // TWO SKIES, GALAXY AND EARTH (docs/PLAN-SKIES.md; operator, 2026-09-16: "The skybox settings are
  // not clear in the preferences, for which sky settings apply to which panel"). This group is what
  // each sky is MADE of. WHICH sky a board draws is that board's own `sky` key -- 'galaxy', 'earth'
  // or 'none' -- and the Sky tab opens with a table of every board's choice. There is no global
  // switch any more: the one that was here picked Space or Living for every board at once, beside
  // six scattered "Star field" toggles, and nobody could tell which board drew what.
  sky: Object.freeze({
    // THE EARTH SKY (operator: "something realistic with blue skies, clouds, the sun, change of
    // day, night with the moon coming out"; livingsky.js)
    clock: 'real',        // 'real' (this machine's time) | 'cycle' (a day every 24 minutes) | 'fixed' (the hour below)
    hour: 17.5,           // the hour to admire when the clock is fixed
    weather: 'scattered', // 'clear' | 'scattered' | 'overcast' | 'storm'
    cover: -1,            // cloud cover 0..1; -1 leaves it to the weather
    lat: -100,            // latitude for real sunrise and season; -100 means "not set": a six-to-six day
    rays: true,           // crepuscular rays when the sun is low
    rainbow: true,        // a rainbow opposite a low sun in scattered weather
    shooting: true,       // shooting stars at night
    moon: 'night',        // 'night' (up every night, highest at midnight) | 'real' (its real track and phase)
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
    // THE SWITCH (operator, 2026-09-15: "an app wide 'Enable Market Polling' checkbox"): off out
    // of the box, so a fresh monitor makes no outbound connection but to the node. The server
    // reads it from the shared settings file on every market request (http/api.js).
    polling: false,
    sky: 'galaxy',        // 'galaxy' | 'earth' | 'none'
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
    // ON by default (operator, 2026-09-13: "In Display and Settings, enable 'Price Line on
    // Overview' checked as default"). It shipped OFF, and the reason it was off still stands and
    // is worth stating plainly rather than deleting: those four figures come from the full
    // exchange feed, which is otherwise parked unless someone is on Markets or Kiosk -- and
    // Overview is the page the app OPENS on. So with this on, EVERY deployment contacts five
    // exchanges the moment anyone looks at it, not only when they go looking for a price.
    //
    // That is the operator's call to make, and it is made. What must not happen is the code
    // quietly disagreeing with the promise: docs/SECURITY.md's outbound table and the README row
    // both now say Overview reaches out by default, and the switch is still here for anyone who
    // wants the old behaviour.
    overviewSummary: true,
  }),
  // EVERY EFFECT ITS OWN SWITCH (operator, 2026-09-12: "at least 25 total different effects, all
  // toggleable"), AND EACH BOARD ITS OWN LIST (operator, 2026-09-14: "I want the markets tab to have
  // a separate effects list ... the Block Space effects specific to that panel, and settings specific
  // to market panel"). This group is the block board's: its keys are exactly details3d's SPACE_FX --
  // every effect but the two drawn on a price line -- and a test asserts the lists match, so an
  // effect cannot ship without a switch or a switch outlive its effect. All on: they were asked
  // for, and the board picks among whatever is left on (scheduleFx). Turn them all off and the
  // board simply rests, which `idleFx` also does in one click.
  effects: Object.freeze({
    ripple: true, outline: true, tide: true, cascade: true, twinkle: true, scan: true, xray: true,
    lightcycle: true, ball: true,
    // FIREWORKS ARE KEPT FOR OCCASIONS (operator, 2026-09-15: "make it disabled by default. I want
    // to re-use that one for special occasions in the future, and don't want it in the rotation
    // unless user selects it"): off on both boards until someone ticks it
    shockwave: true, nova: true, firework: false, flare: true, wave: true, quake: true,
    rain: true, sparkle: true, checker: true, radar: true, vortex: true, powerup: true, combo: true, aurora: true, plasma: true,
    // the agents: something happening on the board, rather than a pattern over it
    centipede: true, tractor: true, missile: true, boulderdash: true, stormball: true,
    // NO REPEATS (operator, 2026-09-14: "add a config field that defaults to 12. Make sure to pick a
    // random effect to play, but never pick one that has been played in the last 12 sequences"). A
    // number, not a switch: enabledEffects reads only the switches.
    noRepeat: 12,
    // THE CADENCE (operator, 2026-09-14: "add sliders to each the market and block space effects
    // panels so we can tune the randomized timing of the events being triggered ... maximum
    // configurability on how often they see effects trigger for each panel, based on the current
    // defaults ... delay effects being triggered even longer than they are now"). The scheduler
    // waits a random span between pauseMin and pauseMax seconds after one effect before the next
    // (details3d idleEvery, 5-9 s since 2026-09-11), and firstAfter seconds, give or take a third,
    // for the first after the board lands (idleFirst, 0.8-1.6 s). Up to ten minutes between.
    pauseMin: 5,
    pauseMax: 9,
    firstAfter: 1.2,
  }),
  // THE PRICE BOARD'S OWN LIST: details3d's MARKET_FX -- the twelve that translate to a candle
  // chart (operator, 2026-09-14: "the selection I have made for the market effects is what we
  // should ship with ... Many of the effects don't translate over to the market chart"). Its own
  // no-repeat window too. All on, twelve.
  marketEffects: Object.freeze({
    ripple: true, outline: true, tide: true, cascade: true, twinkle: true, scan: true, xray: true,
    pulse: true,          // the surge that runs the price line
    bulge: true,          // a sphere rolls through the pipe and it swells round it
    breathe: true,        // the line breathes between the wire and the pulse's heat
    saber: true,          // the line ignites as a light saber
    blackhole: true,      // the chart collapses into a black hole
    firework: false,      // kept for occasions, off until ticked (see the block board's list)
    flare: true, wave: true, stormball: true,
    noRepeat: 12,
    // no firstAfter here: the candle board does not land (operator, 2026-09-14: "there is no
    // 'landing' for the markets display"); after a refresh its first effect keeps the cadence below
    pauseMin: 5,
    pauseMax: 9,
  }),
  // BLOCKOUT (operator, 2026-09-12: "take the classic Atari Breakout game, and make a clone of it,
  // in another tab, using our engine"). The same shape as the Tetrust group: the game says whether
  // there is a sky and a galaxy; what the sky is MADE of comes from the Sky group.
  blockout: Object.freeze({
    sky: 'galaxy',        // 'galaxy' | 'earth' | 'none'
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
    sky: 'galaxy',        // 'galaxy' | 'earth' | 'none'
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
    sky: 'galaxy',        // 'galaxy' | 'earth' | 'none' -- the panel's own canvas behind the well
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
  // SCORCHED YARD (operator, 2026-09-16; docs/PLAN-SCORCHED-YARD.md): the sky and the sound as the
  // other games have them, and the rules the original exposed in its own menus
  scorched: Object.freeze({
    sky: 'earth',         // an artillery duel wants a day and a horizon (docs/PLAN-SKIES.md §3)
    sfx: true,
    music: true,          // the march
    talk: true,           // what the tanks say, over the field
    roundSky: true,       // under the Living sky, each round draws its own hour
    fast: false,          // shells fly at three times the pace
    cheat: false,         // cheat mode: the firing solution drawn live, wind and gravity and all
    aimGuide: 'short',    // 'off' | 'short' (the first fifth of the flight) | 'full': the ranging arc while you aim
    helper: true,         // mark a target, see how your last shot missed it, and C corrects the power
    confirmLast: true,    // the last of a one-of-a-kind weapon asks once before it goes
    demo: false,          // attract mode: every seat is a computer player, and it plays on by itself
    grid: false,          // the quiet grid under the field, off: the land is the picture
    gridColour: '#2a5a8f',
    gridBrightness: 1,
    opponents: 2,         // computer players against the one human; up to seven, for the original's eight seats
    opponentKind: 'mix',  // 'mix' (Shooter, Tosser, Chooser, Spoiler, Cyborg and Poolshark, shuffled each game) or one of the manual's eight
    rounds: 5,
    walls: 'none',        // the manual's default: 'none' | 'concrete' | 'padded' | 'rubber' | 'spring' | 'wrap'
    wind: 'round',        // 'round' (one wind a round, the shipped mode) | 'turn' | 'shot' | 'none'
    gravity: 1,           // 1 = Earth
    land: 'hills',        // 'hills' | 'mountains' | 'valley' | 'flat'
    cash: 10000,          // to start, dollars
    interest: 5,          // per cent, on what is left between rounds
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
// THE EFFECT ROWS, one table for both boards' groups: the label and the hint of each effect are
// written once, and each group below lists the keys it offers.
const FX_ROW = Object.freeze({
  ripple: Object.freeze({ label: 'Ripple', hint: 'A ring spreading from a point on the board' }),
  outline: Object.freeze({ label: 'Outline sweep', hint: 'A front that traces each block\u2019s edges as it passes' }),
  tide: Object.freeze({ label: 'Tide', hint: 'A swell that lifts the blocks it passes under' }),
  cascade: Object.freeze({ label: 'Cascade', hint: 'The blocks light in feerate order, richest first' }),
  twinkle: Object.freeze({ label: 'Twinkle', hint: 'Scattered blocks flash white, each on its own beat' }),
  scan: Object.freeze({ label: 'Scan line', hint: 'A curtain of light standing on the board, floor to top, sweeping across: a white core, soft cyan faces, raster rippling down it, a bar it hangs from, a glowing foot with a phosphor tail, motes in the beam' }),
  xray: Object.freeze({ label: 'X-ray', hint: 'A front sweeps the board and everything behind it goes x-ray -- bodies to glass, edges and a raster lit -- then develops back to solid' }),
  lightcycle: Object.freeze({ label: 'Light cycles', hint: 'Two riders from opposite edges, leaving light walls, until one crashes' }),
  ball: Object.freeze({ label: 'Lightning ball', hint: 'A plasma ball tracing the grid, throwing bolts and a dust trail' }),
  pulse: Object.freeze({ label: 'Energy pulse', hint: 'The surge that runs the price line on Markets, blue behind the head' }),
  bulge: Object.freeze({ label: 'Pipe bulge', hint: 'On Markets: a glowing sphere rolls through the price line left to right, and the pipe swells around it as it passes' }),
  breathe: Object.freeze({ label: 'Breathe', hint: 'The price line breathes: three slow swells from the plain wire to the pulse\u2019s white heat and back' }),
  saber: Object.freeze({ label: 'Light saber', hint: 'The price line ignites from its left end as a light saber -- blue, green, red or purple -- hums, spits sparks, and retracts' }),
  blackhole: Object.freeze({ label: 'Black hole', hint: 'A point of darkness opens on the price line and grows, then drifts slowly across the chart from one side to the other: the line bends round it, the candles nearest are swallowed into orbit, and an accretion disk of the chart\u2019s own colours spirals in round the shadow -- brighter on the side coming toward you, its far side arched over the top -- until it lets everything go' }),
  shockwave: Object.freeze({ label: 'Shockwave', hint: 'A hard ring that throws the blocks it passes into the air' }),
  nova: Object.freeze({ label: 'Nova', hint: 'An implosion to the middle, then a brighter blast back out' }),
  firework: Object.freeze({ label: 'Fireworks', hint: 'A display of up to ten shells, each at its own moment and place, with its smoke. Off by default -- kept for special occasions; tick it to put it in the rotation' }),
  flare: Object.freeze({ label: 'Supernova', hint: 'One block goes supernova: a star swells and blows out in a white-out, a debris cloud of gas expands and cools white to blue to violet, a shockwave throws what it crosses, and a pulsar is left beating at the centre' }),
  wave: Object.freeze({ label: 'Wave', hint: 'Several crests rolling across the board, the blocks riding them' }),
  quake: Object.freeze({ label: 'Quake', hint: 'The board shakes, hardest at the start, and settles' }),
  rain: Object.freeze({ label: 'Code rain', hint: 'A drop falls down every column with a white head and a green tail' }),
  sparkle: Object.freeze({ label: 'Sparkle', hint: 'A constellation lighting a few blocks at a time, each its own colour' }),
  checker: Object.freeze({ label: 'Checkerboard', hint: 'The board flips like a chessboard, dark squares against light' }),
  radar: Object.freeze({ label: 'Radar', hint: 'A sweep hand turning once, the blocks behind it fading like phosphor' }),
  vortex: Object.freeze({ label: 'Vortex', hint: 'Spiral arms turning, draining the board inward' }),
  powerup: Object.freeze({ label: 'Power-up', hint: 'The board charges from the floor up, gold, with a bright lip' }),
  combo: Object.freeze({ label: 'Combo chain', hint: 'A chain reaction running the diagonal, each link popping in turn' }),
  aurora: Object.freeze({ label: 'Aurora', hint: 'Slow curtains of colour drifting over the board' }),
  plasma: Object.freeze({ label: 'Plasma', hint: 'The demoscene plasma: sines over the board, the colour cycling' }),
  centipede: Object.freeze({ label: 'Centipede', hint: 'A column weaving down the board that splits in two partway, each half carrying on' }),
  tractor: Object.freeze({ label: 'Tractor beam', hint: 'A saucer draws the tallest transaction up in a beam, and puts it back' }),
  missile: Object.freeze({ label: 'Interception', hint: 'Arcs rain toward the board while interceptors rise to meet them, each catch a ring of light' }),
  boulderdash: Object.freeze({ label: 'Collapse', hint: 'The board gives way from a point and the blocks fall in, cascading outward' }),
  stormball: Object.freeze({ label: 'Ball lightning', hint: 'An electric blue sphere in a nebula drifts across the view, crackling, throwing arcs that electrify the blocks they strike; a struck block often throws a green arc on to another, and that one sometimes on to a third' }),
});
// where an effect reads differently on the price board, the price board's hint
const MARKET_HINT = Object.freeze({
  blackhole: 'A point of darkness opens on the price line and grows, then drifts slowly along the hours from one side to the other: the line bends round it, the candles nearest are swallowed into orbit, and an accretion disk of the chart\u2019s own colours spirals in round the shadow -- brighter on the side coming toward you, its far side arched over the top -- until it lets everything go',
  twinkle: 'Scattered candles flash white, each on its own beat',
  pulse: 'The surge that runs the price line: the tube swells round the head and goes white-hot behind it',
  bulge: 'A glowing sphere rolls through the price line left to right, and the pipe swells around it as it passes',
  stormball: 'An electric blue sphere in a nebula flies through the chart, striking candles and charging the price line where it passes; a struck candle often throws a green arc on to another, and that one sometimes on to a third',
  cascade: 'The candles light in order, tallest first',
  flare: 'One candle goes supernova: it swells white-hot, blows out in a flash and a lens flare, a shockwave rings out across the chart, plasma is flung on every side, and a ring nebula expands and cools for the rest of the run',
});
// THE WINDOW'S TOP IS THE LIST'S LENGTH (operator, 2026-09-14: "for the markets page, all we have
// is 12 effects, so max the slider out at max effects"): a window wider than the list is the same
// as one the list's length (chooseIdleFx clamps it), so the slider stops where the meaning does.
const noRepeatRow = (max) => Object.freeze({ key: 'noRepeat', label: 'No repeats within', kind: 'range', min: 0, max, step: 1, hint: `An effect is never played again until this many other effects have played since (at ${max}, every effect on the list plays before any comes round again). Where fewer effects are switched on, the one that has waited longest plays next` });
// THE CADENCE SLIDERS, on both tabs: how long the board rests between effects, as a random span
// between a floor and a ceiling, and how soon the first one comes after the board lands. Ten
// minutes is the top: an operator who wants a still board has the switches and all off.
// `top`: the sliders' ceiling in seconds -- ten minutes on the block board, five on the candle board
// (operator, 2026-09-14: "600 seconds is too long for the market effects time sliders. Have the
// range on the bars be between 1 and 300 seconds")
const cadenceRows = (top) => Object.freeze([
  Object.freeze({ key: 'pauseMin', label: 'Between effects, at least', kind: 'range', min: 1, max: top, step: 1, hint: 'Seconds the board rests after one effect before the next may start. The wait is a random span between this and the ceiling below; if this is set above the ceiling, the two swap' }),
  Object.freeze({ key: 'pauseMax', label: 'Between effects, at most', kind: 'range', min: 1, max: top, step: 1, hint: 'The ceiling on that wait, in seconds. Set both high for an effect only now and then; set both low for a busy board' }),
]);
// only the block board lands (the flight when the pool changes); the candle board has no landing
// to time from, so it gets the two sliders and its first effect after a refresh keeps the cadence
const LANDING_ROW = Object.freeze({ key: 'firstAfter', label: 'First effect after landing', kind: 'range', min: 0, max: 120, step: 0.1, hint: 'Seconds after the blocks land before the first effect, give or take a third. The board re-lays on every refresh, so this is also how soon one follows each refresh' });
const fxRows = (keys, hintFor = {}, { landing = true, top = 600 } = {}) => Object.freeze([noRepeatRow(keys.length), ...cadenceRows(top), ...(landing ? [LANDING_ROW] : []), ...keys.map((key) => Object.freeze({ key, label: FX_ROW[key].label, kind: 'toggle', hint: hintFor[key] ?? FX_ROW[key].hint }))]);

/** The scheduler's timers from a group's sliders, in ms: [floor, ceiling] between effects, and the first after landing (the same span where the board has no landing). */
export function fxCadence(g) {
  const lo = Math.min(g.pauseMin, g.pauseMax), hi = Math.max(g.pauseMin, g.pauseMax);
  const idleEvery = [lo * 1000, hi * 1000];
  const idleFirst = Number.isFinite(g.firstAfter) ? [Math.round(g.firstAfter * 1000 * (2 / 3)), Math.round(g.firstAfter * 1000 * (4 / 3))] : idleEvery;
  return { idleEvery, idleFirst };
}

// THE TABS, IN ORDER AND IN ROWS (operator, 2026-09-16: "we really need to group these better.
// Diversions go at the very end"). The groups are written below in the order they were added; the
// sheet shows them in this order, each row of the strip labelled: the boards, their effects, the
// games last.
export const TAB_ROWS = Object.freeze([
  Object.freeze({ label: 'Boards', groups: Object.freeze(['appearance', 'space', 'sky', 'markets']) }),
  Object.freeze({ label: 'Effects', groups: Object.freeze(['effects', 'marketEffects']) }),
  Object.freeze({ label: 'Diversions', groups: Object.freeze(['tetrust', 'blockout', 'blockanoid', 'scorched']) }),
]);
/** The three answers to "which sky": the Galaxy, the Earth, or none. */
export const SKIES = Object.freeze(['galaxy', 'earth', 'none']);
export const SKY_CHOICES = Object.freeze([['galaxy', 'Galaxy'], ['earth', 'Earth'], ['none', 'None']]);
export const SKY_LABELS = Object.freeze({ galaxy: 'Galaxy', earth: 'Earth', none: 'no sky' });
/** Every board that has a sky behind it, in the order the Sky tab's table lists them. */
export const SKY_BOARDS = Object.freeze([
  Object.freeze({ group: 'space', label: 'Block space', note: 'also the Kiosk\u2019s left panel' }),
  Object.freeze({ group: 'markets', label: 'Markets & Price', note: 'also the Kiosk\u2019s right panel' }),
  Object.freeze({ group: 'tetrust', label: 'Tetrust', note: '' }),
  Object.freeze({ group: 'blockout', label: 'Blockout', note: '' }),
  Object.freeze({ group: 'blockanoid', label: 'Blockanoid', note: '' }),
  Object.freeze({ group: 'scorched', label: 'Scorched Yard', note: '' }),
]);
/** The next sky round the ring, for the games' one-button switch. */
export function nextSky(v) { return SKIES[(SKIES.indexOf(v) + 1) % SKIES.length]; }

const PANEL_GROUPS = Object.freeze([
  Object.freeze({
    group: 'appearance',
    title: 'Appearance',
    note: 'The colours of the layout: the page, its cards, text, lines, accent and charts. The 3D boards are space whatever is chosen here, and the Explorer\u2019s block and transaction pages keep their own dark cards.',
    rows: Object.freeze([
      Object.freeze({
        key: 'mode', label: 'Theme mode', kind: 'segment', hint: 'Light or dark, or whichever the operating system asks for (System follows it as it changes)',
        options: Object.freeze([['light', 'Light'], ['dark', 'Dark'], ['system', 'System']]),
      }),
      Object.freeze({
        key: 'theme', label: 'Theme', kind: 'cards', hint: 'Each has a light and a dark face; the mode above picks which. Custom is the nine colours below',
        options: Object.freeze([['blockyard', 'BlockYard'], ['mono', 'Mono'], ['nous', 'Nous'], ['github', 'GitHub'], ['catppuccin', 'Catppuccin'], ['custom', 'Custom']]),
      }),
      Object.freeze({ key: 'customBg', label: 'Page', kind: 'colour', hint: 'The colour behind everything. Whether Custom is a light or a dark theme follows from this one: the derived shades go the other way', custom: true }),
      Object.freeze({ key: 'customPanel', label: 'Panels', kind: 'colour', hint: 'Cards, the header, tables and the settings sheet. Raised panels and hovers are this nudged toward the text colour', custom: true }),
      Object.freeze({ key: 'customText', label: 'Text', kind: 'colour', hint: 'Body text and figures', custom: true }),
      Object.freeze({ key: 'customMuted', label: 'Muted text', kind: 'colour', hint: 'Labels, hints and notes. The fainter text is this halfway to the page colour', custom: true }),
      Object.freeze({ key: 'customAccent', label: 'Accent', kind: 'colour', hint: 'Titles, the active tab, links, buttons and the primary lines of charts', custom: true }),
      Object.freeze({ key: 'customLine', label: 'Lines', kind: 'colour', hint: 'Card borders and table rules. The softer rules are this halfway to the page colour', custom: true }),
      Object.freeze({ key: 'customOk', label: 'Good', kind: 'colour', hint: 'Synced, fresh, a block on time', custom: true }),
      Object.freeze({ key: 'customWarn', label: 'Warning', kind: 'colour', hint: 'Late, stale, a caveat', custom: true }),
      Object.freeze({ key: 'customBad', label: 'Bad', kind: 'colour', hint: 'Overdue, failed, offline', custom: true }),
    ]),
  }),
  Object.freeze({
    group: 'space',
    title: 'Block space',
    note: 'The 3D board on Overview, Block space, Mempool and Kiosk. Turn things off here if the board is heavy on this machine.',
    rows: Object.freeze([
      Object.freeze({ key: 'shadows', label: 'Shadows', kind: 'toggle', hint: 'Cubes casting shadows on the board and on each other' }),
      Object.freeze({ key: 'idleFx', label: 'Idle effects', kind: 'toggle', hint: 'The effects while the board rests: which of them is the Space effects tab' }),
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
      Object.freeze({
        key: 'sheenStyle', label: 'Metallic finish', kind: 'choice', hint: 'Chrome mirrors a horizon in every face that slides as the blocks move; satin is a softer highlight along the lit edge. Needs Metallic sheen on',
        options: Object.freeze([['chrome', 'Chrome'], ['satin', 'Satin']]),
      }),
      Object.freeze({ key: 'sky', label: 'Sky', kind: 'choice', hint: 'Which sky stands behind the board: the Galaxy, the Earth, or none. What each sky is made of is the Sky tab\u2019s; this is only the choice. The Kiosk\u2019s left panel is this board', options: SKY_CHOICES }),
      Object.freeze({
        key: 'detail', label: 'Level of detail', kind: 'choice', hint: 'Simpler cubes draw fewer polygons at the same size',
        options: Object.freeze([['full', 'Full'], ['simple', 'Simple cubes'], ['flat', 'Flat tiles']]),
      }),
      Object.freeze({
        key: 'motion', label: 'Refresh animation', kind: 'choice', hint: 'How blocks travel when the board refreshes',
        options: Object.freeze([['full', 'Full flight'], ['quick', 'Quick'], ['still', 'None']]),
      }),
      Object.freeze({
        key: 'departures', label: 'Departures and arrivals', kind: 'choice',
        hint: 'The path a block takes as it leaves or arrives. Both follow the board’s curve outward from the middle; along the curve is a straight line, arcing bends as the block climbs',
        options: Object.freeze([['normal', 'Along the board’s curve'], ['arcing', 'Arcing (original)']]),
      }),
      Object.freeze({ key: 'dome', label: 'Board curve', kind: 'range', min: 0, max: 12, step: 1, hint: 'How far the board bows toward you; 0 is flat' }),
      Object.freeze({ key: 'perspective', label: 'Depth', kind: 'range', min: 0, max: 0.001, step: 0.0001, hint: 'How much height foreshortens. 0 is the flat parallel camera the board shipped with: a cube is the same size however high it flies. Raise it and a cube’s top grows a little wider than its base and a flying block swells slightly as it rises' }),
      Object.freeze({
        key: 'light', label: 'Light', kind: 'choice', hint: 'Where the lamp hangs. Straight above lights the whole board evenly; a corner shades the far slope of the curve and the sides turned away',
        options: Object.freeze([['overhead', 'Straight above'], ['top-left', 'Top left'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right'], ['front', 'From the viewer']]),
      }),
      Object.freeze({
        key: 'lightHeight', label: 'Light height', kind: 'choice', hint: 'How high the lamp hangs over that place: low rakes the sides and shades the far slope hard, high is nearly overhead',
        options: Object.freeze([['low', 'Low'], ['middle', 'Middle'], ['high', 'High']]),
      }),
    ]),
  }),
  Object.freeze({
    group: 'sky',
    title: 'Sky',
    note: 'Two skies, and which board draws which. The table is the whole map: every board that has a sky behind it, and the sky it is drawing \u2014 change one here or in the board\u2019s own tab, it is the same setting. Below it, what each sky is made of.',
    rows: Object.freeze([
      Object.freeze({ key: 'map', label: 'Which sky, where', kind: 'skymap', hint: 'Every board with a sky, and the one it draws' }),
      Object.freeze({ key: 'galaxyHead', label: 'The Galaxy', kind: 'heading', hint: 'The star field: stars on slowly turning spiral arms, with the layers of a real galaxy. BlockYard\u2019s own sky' }),
      Object.freeze({ key: 'galaxy', label: 'Spiral arms', kind: 'toggle', hint: 'Lay the stars on slowly turning spiral arms instead of scattering them evenly. One turn takes about fifteen minutes' }),
      Object.freeze({
        key: 'galaxyAt', label: 'Arms centre', kind: 'choice',
        hint: 'Where the middle of the spiral sits. A corner crowds the bright centre there and sweeps the arms across; behind the board shows the whole spiral',
        options: Object.freeze([['center', 'Behind the board'], ['top-left', 'Top left'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']]),
      }),
      Object.freeze({ key: 'density', label: 'Star density', kind: 'range', min: 0.2, max: 8, step: 0.1, hint: 'How many stars, against the shipped number. High values are a lot of drawing on a big panel' }),
      Object.freeze({ key: 'brightness', label: 'Star brightness', kind: 'range', min: 0.2, max: 1.5, step: 0.1, hint: 'How brightly they burn' }),
      Object.freeze({ key: 'colours', label: 'Star colours', kind: 'toggle', hint: 'Warm old stars in the middle, blue-white young ones in the arms. Off is one colour of starlight' }),
      Object.freeze({ key: 'glints', label: 'Star glints', kind: 'toggle', hint: 'The halo and cross glint on the brightest stars' }),
      Object.freeze({ key: 'nebulae', label: 'Nebulae', kind: 'toggle', hint: 'Clouds of gas along the spiral arms, in the colours of star-forming lanes' }),
      Object.freeze({ key: 'dust', label: 'Dust lanes', kind: 'toggle', hint: 'Dark ribbons along the inner edge of each arm, the way a real spiral carries them' }),
      Object.freeze({ key: 'clusters', label: 'Star clusters', kind: 'toggle', hint: 'Tight knots of stars out in the halo, turning with the arms' }),
      Object.freeze({ key: 'galaxies', label: 'Distant galaxies', kind: 'toggle', hint: 'Other galaxies, small and faint and far, behind everything else' }),
      Object.freeze({ key: 'earthHead', label: 'The Earth', kind: 'heading', hint: 'A real day from this machine\u2019s clock: the sun, clouds, dusk, the moon at its phase, and the stars at night' }),
      Object.freeze({
        key: 'clock', label: 'Clock', kind: 'choice', hint: 'What time the Earth sky shows',
        options: Object.freeze([['real', 'Real time'], ['cycle', 'A day every 24 minutes'], ['fixed', 'A fixed hour']]),
      }),
      Object.freeze({ key: 'hour', label: 'Fixed hour', kind: 'range', min: 0, max: 24, step: 0.25, hint: 'The hour the Earth sky holds when the clock is fixed; 17.5 is late afternoon' }),
      Object.freeze({
        key: 'weather', label: 'Weather', kind: 'choice', hint: 'How much cloud, and whether it rains',
        options: Object.freeze([['clear', 'Clear'], ['scattered', 'Scattered cloud'], ['overcast', 'Overcast'], ['storm', 'Storm: rain and lightning']]),
      }),
      Object.freeze({ key: 'cover', label: 'Cloud cover', kind: 'range', min: -1, max: 1, step: 0.05, hint: 'Overrides the weather\u2019s cloud amount, 0 to 1; -1 leaves it to the weather' }),
      Object.freeze({ key: 'lat', label: 'Latitude', kind: 'range', min: -100, max: 90, step: 1, hint: 'Your latitude, for real sunrise and sunset and the season; -100 leaves a six-to-six day' }),
      Object.freeze({ key: 'rays', label: 'Sun rays', kind: 'toggle', hint: 'Crepuscular rays when the sun is low' }),
      Object.freeze({ key: 'rainbow', label: 'Rainbow', kind: 'toggle', hint: 'A rainbow opposite a low sun in scattered weather' }),
      Object.freeze({ key: 'shooting', label: 'Shooting stars', kind: 'toggle', hint: 'Now and then, at night' }),
      Object.freeze({
        key: 'moon', label: 'Moon', kind: 'choice', hint: 'Up every night, highest at midnight, never thinner than a fat crescent \u2014 or on its real track at its real phase, which some nights means no moon at all',
        options: Object.freeze([['night', 'Up every night'], ['real', 'Its real track and phase']]),
      }),
    ]),
  }),
  Object.freeze({
    group: 'markets',
    title: 'Markets & Price',
    note: 'The exchange feed, and the candle board on Markets and Kiosk.',
    rows: Object.freeze([
      Object.freeze({
        key: 'polling', label: 'Enable market polling', kind: 'toggle',
        hint: 'Let the server ask five exchanges (Coinbase, Kraken, Bitstamp, Bitfinex, OKX) for prices, candles and order books. '
          + 'Off out of the box: this is the only thing the monitor ever says to anyone but your node, and until it is on, '
          + 'Markets and Kiosk say so and the explorer shows no dollar figures. On, the server asks only while someone is looking, '
          + 'and stops ten minutes after the last look. Shared by every screen of this monitor',
      }),
      // right under the polling switch it depends on (operator, 2026-09-15: "Move price line on Overview
      // underneath Enable Market Polling")
      Object.freeze({
        key: 'overviewSummary', label: 'Price line on Overview', kind: 'toggle',
        hint: 'Median, spread, 24 h volume and how many books reported, at the top of Overview. '
          + 'It needs market polling (above); with that on, leaving this on means this monitor contacts '
          + 'five exchanges whenever Overview is open, not only on Markets and Kiosk. '
          + 'Switch it off and the landing page talks to nothing but your node.',
      }),
      Object.freeze({ key: 'sky', label: 'Sky', kind: 'choice', hint: 'Which sky stands behind the candles: the Galaxy, the Earth, or none. The Kiosk\u2019s right panel is this board', options: SKY_CHOICES }),
      Object.freeze({ key: 'effects', label: 'Board effects', kind: 'toggle', hint: 'The idle effects while the board rests (which of them is the Market effects tab) and the flight when the candles refresh. Off draws the board and leaves it alone' }),
      Object.freeze({
        key: 'exchange', label: 'Exchange', kind: 'choice', hint: 'Whose candles the chart and the 3D board draw. The others stay as overlay lines',
        options: Object.freeze([['coinbase', 'Coinbase'], ['kraken', 'Kraken'], ['bitstamp', 'Bitstamp'], ['bitfinex', 'Bitfinex'], ['okx', 'OKX']]),
      }),
      Object.freeze({
        key: 'range', label: 'Range', kind: 'choice', hint: 'How many hours the chart covers when the page opens',
        options: Object.freeze([['24', '24 hours'], ['48', '48 hours'], ['168', '7 days']]),
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
      Object.freeze({ key: 'sky', label: 'Sky', kind: 'choice', hint: 'Which sky stands behind the court: the Galaxy, the Earth, or none. Also a button on the game\u2019s panel', options: SKY_CHOICES }),
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
      Object.freeze({ key: 'sky', label: 'Sky', kind: 'choice', hint: 'Which sky stands behind the court: the Galaxy, the Earth, or none. Also a button on the game\u2019s panel', options: SKY_CHOICES }),
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
  // TWO EFFECTS TABS, one per board (operator, 2026-09-14: "I want the markets tab to have a
  // separate effects list"). The rows come from FX_ROW above; the key lists are the boards' own and
  // test/effects.test.js holds them to details3d's SPACE_FX and MARKET_FX.
  Object.freeze({
    group: 'effects',
    title: 'Space effects',
    note: 'What the Block space board may play while it rests. One is chosen at random every seven to thirteen seconds, never one played within the no-repeat window \u2014 so the more you leave on, the less often you see any one of them. The Markets board has a list of its own, on the next tab.',
    bulk: true,
    rows: fxRows([
      'ripple', 'outline', 'tide', 'cascade', 'twinkle', 'scan', 'xray', 'lightcycle', 'ball', 'shockwave', 'nova',
      'firework', 'flare', 'wave', 'quake', 'rain', 'sparkle', 'checker', 'radar', 'vortex', 'powerup',
      'combo', 'aurora', 'plasma', 'centipede', 'tractor', 'missile', 'boulderdash', 'stormball',
    ]),
  }),
  Object.freeze({
    group: 'marketEffects',
    title: 'Market effects',
    note: 'What the candle board on Markets and Kiosk may play while it rests, chosen the same way as on Block space but from the sixteen that translate to a chart: fronts along the hours, bursts from the candle row, the candles lit where they stand, and the price line\u2019s own pulse, bulge and ball lightning. The Board effects switch on the Markets & Price tab is the master.',
    bulk: true,
    rows: fxRows([
      'ripple', 'outline', 'tide', 'cascade', 'twinkle', 'scan', 'xray', 'pulse', 'bulge', 'breathe', 'saber', 'blackhole', 'firework', 'flare', 'wave', 'stormball',
    ], MARKET_HINT, { landing: false, top: 300 }),
  }),
  Object.freeze({
    group: 'tetrust',
    title: 'Tetrust',
    note: 'The game. These switches are also on the game’s own panel; the sky takes the star field’s density, brightness and layers from Sky above.',
    rows: Object.freeze([
      Object.freeze({ key: 'sky', label: 'Sky', kind: 'choice', hint: 'Which sky stands behind the well: the Galaxy, the Earth, or none. Also a button on the game\u2019s panel', options: SKY_CHOICES }),
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
  Object.freeze({
    group: 'scorched',
    title: 'Scorched Yard',
    note: 'The artillery game. The switches are also on the game\u2019s own panel; the rules below take effect at the next new game.',
    rows: Object.freeze([
      Object.freeze({ key: 'sky', label: 'Sky', kind: 'choice', hint: 'Which sky stands behind the field: the Galaxy, the Earth, or none. Earth is the shipped choice here: an artillery duel wants a day and a horizon, and each round draws its own hour of it. Also a button on the game\u2019s panel', options: SKY_CHOICES }),
      Object.freeze({ key: 'sfx', label: 'Sound effects', kind: 'toggle', hint: 'The shot, the blast, a hit, a fall, a death' }),
      Object.freeze({ key: 'music', label: 'Music', kind: 'toggle', hint: 'A march in D minor, on oscillators' }),
      Object.freeze({ key: 'talk', label: 'Talk', kind: 'toggle', hint: 'What the tanks say when they fire, are hit, or die' }),
      Object.freeze({ key: 'roundSky', label: 'A sky per round', kind: 'toggle', hint: 'Under the Living sky, each round draws its own hour: dawn, noon, dusk, night' }),
      Object.freeze({ key: 'fast', label: 'Fast shells', kind: 'toggle', hint: 'Shells fly at three times the pace, for the impatient' }),
      Object.freeze({
        key: 'aimGuide', label: 'Aim guide', kind: 'choice', hint: 'A ghost of the shell\u2019s path while you aim, under this round\u2019s wind and gravity. Short shows the first fifth of the flight: enough to read the lean of the shot without giving the landing away. Off is the original',
        options: Object.freeze([['short', 'Short'], ['full', 'The whole flight'], ['off', 'Off']]),
      }),
      Object.freeze({ key: 'helper', label: 'Correction helper', kind: 'toggle', hint: 'Click an enemy tank to mark it: the panel then says how far your last shot fell short of it or went over, and C corrects your power from that miss. Nothing is solved for you \u2014 the wind and the hills are still yours to read' }),
      Object.freeze({ key: 'confirmLast', label: 'Confirm the last of a weapon', kind: 'toggle', hint: 'The last Nuke, the last Death\u2019s Head \u2014 any weapon sold one at a time \u2014 asks once before it goes: press fire again to send it' }),
      Object.freeze({ key: 'cheat', label: 'Cheat mode', kind: 'toggle', hint: 'Draw the firing solution while you aim: the shell\u2019s own path under this round\u2019s wind and the game\u2019s gravity, clipped where it meets the dirt, with a ring where it lands. It moves as you move' }),
      Object.freeze({ key: 'demo', label: 'Attract mode', kind: 'toggle', hint: 'Every seat is a computer player and the war runs on by itself, for a wall display' }),
      Object.freeze({ key: 'grid', label: 'Grid', kind: 'toggle', hint: 'A quiet grid under the field' }),
      Object.freeze({ key: 'gridColour', label: 'Grid colour', kind: 'colour', hint: 'The colour of that grid' }),
      Object.freeze({ key: 'gridBrightness', label: 'Grid intensity', kind: 'range', min: 0, max: 2, step: 0.05, hint: 'How strongly the grid shows; 0 hides it' }),
      Object.freeze({ key: 'opponents', label: 'Computer players', kind: 'range', min: 1, max: 7, step: 1, hint: 'How many tanks the computer fields against you. Two is the shipped game; seven fills the original\u2019s eight seats' }),
      Object.freeze({
        key: 'opponentKind', label: 'Their kind', kind: 'choice', hint: 'The manual\u2019s personalities: a mix dealt in a new order every game, or every seat the one you name. Moron fires at random; Shooter takes straight shots; Poolshark banks off rubber walls; Tosser lobs and corrects; Chooser picks its method; Spoiler nearly never misses; Cyborg is a Spoiler with a grudge; Unknown is one of them, drawn each round',
        options: Object.freeze([['mix', 'A mix'], ['moron', 'Morons'], ['shooter', 'Shooters'], ['poolshark', 'Poolsharks'], ['tosser', 'Tossers'], ['chooser', 'Choosers'], ['spoiler', 'Spoilers'], ['cyborg', 'Cyborgs'], ['unknown', 'Unknowns']]),
      }),
      Object.freeze({ key: 'rounds', label: 'Rounds', kind: 'range', min: 1, max: 10, step: 1, hint: 'A game is this many rounds; the highest score at the end wins' }),
      Object.freeze({
        key: 'walls', label: 'Walls', kind: 'choice', hint: 'What a shell does at the edge of the field',
        options: Object.freeze([['none', 'None: it is lost (the original\u2019s default)'], ['concrete', 'Concrete: it explodes there'], ['padded', 'Padded: it stops and drops'], ['rubber', 'Rubber: it bounces'], ['spring', 'Spring: it bounces back harder'], ['wrap', 'Wraparound: it comes in the other side']]),
      }),
      Object.freeze({
        key: 'wind', label: 'Wind', kind: 'choice', hint: 'Whether the wind blows, and how often it changes. Once a round holds its direction and strength for the whole round, so the air blows one way while you read it; every turn is the original\u2019s, and it can turn right around between two shots',
        options: Object.freeze([['round', 'Once a round'], ['turn', 'Changes every turn'], ['shot', 'Changes every shot'], ['none', 'No wind']]),
      }),
      Object.freeze({ key: 'gravity', label: 'Gravity', kind: 'range', min: 0.4, max: 2, step: 0.1, hint: 'How hard shells fall; 1 is Earth' }),
      Object.freeze({
        key: 'land', label: 'Landscape', kind: 'choice', hint: 'The shape of the land each round is drawn from',
        options: Object.freeze([['hills', 'Rolling hills'], ['mountains', 'Mountains'], ['valley', 'A valley'], ['flat', 'Flat']]),
      }),
      Object.freeze({ key: 'cash', label: 'Starting cash', kind: 'range', min: 0, max: 100000, step: 5000, hint: 'What every tank has to spend at the first shop; damage and kills earn more' }),
      Object.freeze({ key: 'interest', label: 'Interest', kind: 'range', min: 0, max: 25, step: 1, hint: 'Per cent paid on unspent cash between rounds' }),
    ]),
  }),
]);
/** The groups in the sheet's order: row by row of TAB_ROWS, then anything a row forgot (a test says nothing is). */
export const PANEL = Object.freeze([
  ...TAB_ROWS.flatMap((row) => row.groups.map((id) => PANEL_GROUPS.find((g) => g.group === id)).filter(Boolean)),
  ...PANEL_GROUPS.filter((g) => !TAB_ROWS.some((row) => row.groups.includes(g.group))),
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
  // v3 -> v4: the price board gets its own effects group. Until now one list governed both boards,
  // so the store's list is the operator's choice for both: it is copied to `marketEffects` (normalise
  // drops the keys the price board does not offer). A store that already has the group keeps it.
  3: (raw) => {
    if (raw.marketEffects && typeof raw.marketEffects === 'object') return raw;
    const fx = raw.effects && typeof raw.effects === 'object' ? raw.effects : {};
    return { ...raw, marketEffects: { ...fx } };
  },
  // v4 -> v5: the lamp's placements were renamed as six places at three heights (2026-09-16):
  // upper-left is top-left, upper-right top-right; front stays; the height is new (middle)
  4: (raw) => {
    const sp = raw.space && typeof raw.space === 'object' ? raw.space : {};
    const map = { 'upper-left': 'top-left', 'upper-right': 'top-right' };
    return { ...raw, space: { ...sp, light: map[sp.light] ?? sp.light } };
  },

  // v5 -> v6: ONE SKY PER BOARD (docs/PLAN-SKIES.md). One global `sky.type` (space | living) plus a
  // `stars` toggle on each of six boards becomes a `sky` choice on each board (galaxy | earth |
  // none), and the games' private `galaxy` / `galaxyAt` are dropped in favour of the Sky tab's.
  // The mapping keeps every installation drawing exactly what it drew.
  //
  // IDEMPOTENT ON PURPOSE: settings stored on the server carry no schema version, so this runs on
  // every boot. It acts only on a board that still has the old key and lacks the new one, and a
  // store already in the new shape passes through untouched.
  5: (raw) => {
    const type = raw.sky && typeof raw.sky === 'object' ? raw.sky.type : undefined;
    const out = { ...raw };
    if (out.sky && typeof out.sky === 'object' && 'type' in out.sky) { const { type: _t, ...rest } = out.sky; out.sky = rest; }
    for (const board of ['space', 'markets', 'tetrust', 'blockout', 'blockanoid', 'scorched']) {
      const g = raw[board];
      if (!g || typeof g !== 'object') continue;
      const { stars, galaxy: _g, galaxyAt: _a, ...rest } = g;
      if (g.sky === undefined && stars !== undefined) rest.sky = stars === false ? 'none' : type === 'living' ? 'earth' : 'galaxy';
      out[board] = rest;
    }
    return out;
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
/** The living sky's settings as board options, for every board that draws a sky. */
/** Which sky a board draws, from its own key: 'galaxy' | 'earth' | 'none'. */
export function skyOf(n, board) {
  const v = n[board]?.sky;
  return SKIES.includes(v) ? v : 'galaxy';
}

/**
 * THE DEEP SKY belongs to the Galaxy: spiral arms, nebulae, dust lanes, halo clusters and distant
 * galaxies are wrong over a real day and a real night (operator, 2026-09-16: "It's counter
 * intuitive in the preferences to display a spiral galaxy for a night/day scene"). Gated by the
 * board's choice, so a board back on the Galaxy gets them all exactly as saved.
 */
export function deepSky(n, sky = 'galaxy') {
  const off = sky !== 'galaxy';
  return {
    galaxy: n.sky.galaxy && !off,
    galaxyAt: n.sky.galaxyAt,
    nebulae: n.sky.nebulae && !off,
    galaxies: n.sky.galaxies && !off,
    dust: n.sky.dust && !off,
    clusters: n.sky.clusters && !off,
  };
}

/** The Earth sky's settings as renderer options. */
export function skyExtras(n) {
  const sky = n.sky;
  return {
    skyClock: sky.clock, skyHour: sky.hour, skyWeather: sky.weather,
    skyCover: sky.cover < 0 ? undefined : sky.cover, skyLat: sky.lat <= -95 ? undefined : sky.lat,
    skyRays: sky.rays, skyRainbow: sky.rainbow, skyShooting: sky.shooting, skyMoon: sky.moon,
  };
}

/**
 * ONE ANSWER PER BOARD (docs/PLAN-SKIES.md): everything the renderer needs to draw the sky this
 * board chose. `sky` is the choice, `stars` whether any sky is drawn at all, `skyType` which one
 * ('galaxy' or 'earth'); then the Earth's settings and the Galaxy's, the deep layers gated off
 * under the Earth. Every board's option builder spreads this and nothing else about the sky.
 */
export function skyFor(n, board) {
  const sky = skyOf(n, board);
  return {
    sky,
    stars: sky !== 'none',
    skyType: sky === 'earth' ? 'earth' : 'galaxy',
    ...skyExtras(n),
    starDensity: n.sky.density,
    starBrightness: n.sky.brightness,
    starColours: n.sky.colours, starGlints: n.sky.glints,
    ...deepSky(n, sky),
  };
}

export function spaceOptions(s) {
  const n = normalise(s);
  const sp = n.space;
  const d = DETAIL[sp.detail] ?? DETAIL.full;
  const out = {
    shadows: sp.shadows,
    // THE SPACE EFFECTS GO OFF UNDER THE LIVING SKY (operator, 2026-09-16: "We have to toggle all
    // the Space effects off when Living Sky is selected"): supernovae and black holes over a blue
    // afternoon are wrong. Gated here, not by flipping the switches, so space gets them back as saved.
    idleFx: sp.idleFx && skyOf(n, 'space') !== 'earth',
    grid: sp.grid,
    neon: sp.neon,
    sheen: sp.sheen,
    sheenStyle: sp.sheenStyle,
    // `space` is the board STYLE (no deck texture, a translucent floor); `stars` is the sky. They
    // travel together here, which is the block-space board's shipped behaviour, but they are two
    // options now so the markets board can keep its style while turning its sky off.
    space: skyOf(n, 'space') !== 'none',
    dome: sp.dome,
    facetPx: d.facetPx,
    crownPx: d.crownPx,
    // the sky this board chose, and what it is made of (skyFor): the Kiosk's left panel is this board
    ...skyFor(n, 'space'),
  };
  // the seam belongs to the Stone edges switch at every level of detail: a control that does
  // nothing in one mode is worse than no control (operator: "stone edges don't work in flat tile
  // display mode"). Detail decides facets and the crown; this decides the outline.
  out.edges = sp.edges;
  if (!sp.edges) out.seamAlpha = 0;
  const motion = MOTION[sp.motion];
  if (motion) out.transition = motion;
  out.departures = sp.departures;
  out.light = sp.light;
  out.lightHeight = sp.lightHeight;
  // merged into the camera by details3d (it owns the oblique constants); 0 leaves it exactly as it
  // has always been, so the switch costs nothing until someone moves it
  out.obliqueRise = sp.perspective;
  out.fxKinds = skyOf(n, 'space') === 'earth' ? [] : enabledEffects(n);
  out.fxNoRepeat = n.effects.noRepeat;
  Object.assign(out, fxCadence(n.effects));
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
// A slider's value as the panel prints it: to its step's decimals, always (operator, 2026-09-14: "these
// sliders jump around when changing values. Many of our bars do this"). The panel row is a grid whose
// control column sizes to fit, and the value was printed with String(): `1`, `0.9`, `0.35`, `0.0005`
// -- a different width almost every notch, so the column resized and the slider moved under the
// pointer. Fixed decimals make every value of a row the same width, and the CSS box (.cfgrow .val,
// 6.5ch) holds the widest any row can print, which test/settings.test.js checks for every slider.
export function formatRangeValue(step, v) {
  const s = String(step);
  const decimals = s.includes('e-') ? Number(s.split('e-')[1]) : (s.split('.')[1] ?? '').length;
  return Number(v).toFixed(decimals);
}

export function enabledEffects(s, group = 'effects') {
  const n = normalise(s);
  return Object.keys(n[group]).filter((k) => n[group][k] === true);
}

/** Blockout's switches, with the sky's make-up from the Sky group (as tetrustOptions does). */
export function blockoutOptions(s) {
  const n = normalise(s);
  return {
    sky: skyFor(n, 'blockout'), sfx: n.blockout.sfx,
    neon: n.blockout.neon,
    // the engine calls the data-coloured source "temperature"; here that is the brick's own row
    neonSource: n.blockout.neonSource === 'colour' ? 'colour' : 'temperature',
    neonColour: n.blockout.neonColour, neonBrightness: n.blockout.neonBrightness,
    grid: n.blockout.grid, gridColour: n.blockout.gridColour, gridBrightness: n.blockout.gridBrightness,
    // composed here rather than in the screen, so the court needs no new import and the renderer
    // keys stay in one place. 0.18 is the weight this court was hand-tuned at.
    gridOpts: courtGridColours(n.blockout.gridColour, n.blockout.gridBrightness, 0.18),
  };
}

/** Blockanoid's switches. Blockout's shape, plus the two that are Arkanoid's own. */

export function blockanoidOptions(s) {
  const n = normalise(s);
  return {
    sky: skyFor(n, 'blockanoid'), sfx: n.blockanoid.sfx,
    capsules: n.blockanoid.capsules, enemies: n.blockanoid.enemies,
    neon: n.blockanoid.neon,
    neonSource: n.blockanoid.neonSource === 'colour' ? 'colour' : 'temperature',
    neonColour: n.blockanoid.neonColour, neonBrightness: n.blockanoid.neonBrightness,
    grid: n.blockanoid.grid, gridColour: n.blockanoid.gridColour, gridBrightness: n.blockanoid.gridBrightness,
    gridOpts: courtGridColours(n.blockanoid.gridColour, n.blockanoid.gridBrightness, 0.18),
  };
}

export function tetrustOptions(s) {
  const n = normalise(s);
  return {
    sky: skyFor(n, 'tetrust'), music: n.tetrust.music, sfx: n.tetrust.sfx,
    ghostColour: n.tetrust.ghostColour, ghostWidth: n.tetrust.ghostWidth,
    neon: n.tetrust.neon, neonSource: n.tetrust.neonSource === 'colour' ? 'colour' : 'temperature', neonColour: n.tetrust.neonColour, neonBrightness: n.tetrust.neonBrightness,
    grid: n.tetrust.grid, gridColour: n.tetrust.gridColour, gridBrightness: n.tetrust.gridBrightness,
    // 0.06, not 0.18: the well draws its grid fainter than the brick courts do, because the stack
    // sits on top of it. That difference was hardcoded in tetrust.js; it lives here now.
    gridOpts: courtGridColours(n.tetrust.gridColour, n.tetrust.gridBrightness, 0.06),
  };
}

/** Scorched Yard's switches and rules, with the sky's make-up from the Sky group. */
export function scorchedOptions(s) {
  const n = normalise(s);
  const sc = n.scorched;
  return {
    sky: skyFor(n, 'scorched'), sfx: sc.sfx, music: sc.music, talk: sc.talk, roundSky: sc.roundSky, fast: sc.fast, cheat: sc.cheat, aimGuide: sc.aimGuide, helper: sc.helper, confirmLast: sc.confirmLast, demo: sc.demo,
    grid: sc.grid, gridColour: sc.gridColour, gridBrightness: sc.gridBrightness,
    gridOpts: courtGridColours(sc.gridColour, sc.gridBrightness, 0.08),
    opponents: sc.opponents, opponentKind: sc.opponentKind, rounds: sc.rounds, walls: sc.walls, wind: sc.wind, gravity: sc.gravity, land: sc.land, cash: sc.cash, interest: sc.interest,
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
    // the sky this board chose (skyFor): the Kiosk's right panel is this board
    ...skyFor(n, 'markets'),
    // never, at any setting: the halo under the grid lines is not wanted on this board
    neonHalo: 'rgba(0,0,0,0)',
    gridGlow: 'rgba(0,0,0,0)',
    // One switch for everything that MOVES on this board (operator, 2026-09-12: "we need a toggle
    // for disable effects in the market and price"). The candle board inherited idleFx from the
    // renderer's defaults and ran the refresh flight, and neither had a control of its own: the
    // Block space switches next to them govern a different board entirely.
    ...(mk.effects ? {} : { idleFx: false, transition: MOTION.still }),
    // ITS OWN SWITCHES (operator, 2026-09-14: "settings specific to market panel"): the Market
    // effects group, not the block board's
    // the market effects go off under the Earth the way the Space effects do: a supernova over a
    // blue afternoon is wrong on this board too
    fxKinds: skyOf(n, 'markets') === 'earth' ? [] : enabledEffects(n, 'marketEffects'),
    fxNoRepeat: n.marketEffects.noRepeat,
    ...fxCadence(n.marketEffects),
  };
}
