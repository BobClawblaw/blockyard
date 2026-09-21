# PLAN: The Sun — a sixth BlockYard sky

Operator, 2026-09-21: *"I want you to research all the visual effects that go into rendering our
Sun, with its various flares, and movements, rotating very slowly. All the information you need
is here at this NASA link"* (https://svs.gsfc.nasa.gov/gallery/sdosolar-events/) — *"a new 3D
background for blockyard that is an animated simulation of our sun. Do whatever research you
need, and document everything for this project scope. It's going to be a rather serious
simulation requiring lots of work."*

This document is the scope. Everything measured is cited to its source so the next person can
re-derive it rather than guess. Research done 2026-09-21 against the NASA SVS SDO gallery and
the solar-physics literature it points into (SDO/AIA instrument papers, IOPscience/A&A event
studies, sunpy's differential-rotation docs, Stanford's HCS pages).

---

## 1. The reference material and what it actually shows

The SDO gallery is real observational footage from the Solar Dynamics Observatory, not
artist renders. Its shots are full-disk 4096x4096 frames in extreme ultraviolet at a 12 s
cadence (SVS 14126). Each shot is ONE AIA wavelength; the colour is a false-colour mapping. The
channels and what each shows (SDO / thesuntoday.org wavelength guide, svs.gsfc.nasa.gov/3980
and /4117):

| AIA channel | false colour | plasma temp | what it shows |
|---|---|---|---|
| 171 Å | gold | ~1 MK | quiet corona and upper transition region; coronal loops — plasma arcs tracing magnetic field lines. THE default "look" of the sun in most media |
| 193 Å | bronze | ~1.2 MK + flare plasma | hotter corona, active regions, CMEs bright; coronal holes DARK (open field lines, source of the fast wind) |
| 211 Å | green | ~2 MK | magnetically active regions, flares, CMEs |
| 304 Å | red | ~50 kK (He II) | the chromosphere: filaments on the disk, prominences at the limb, spicules, coronal rain |
| 131 Å | teal | >10 MK | the hottest flare plasma; the reconnection site itself |
| 94 Å | green | >6 MK | same class: flares only |
| 1600/1700 Å | yellow | 5–10 kK | upper photosphere + transition region; sunspot structure |
| HMI 6173 Å | white/orange | photosphere | visible light: granulation, sunspots, the "real colour" disk |

Key structural fact from SVS 4117 (Slices of SDO): the same feature changes shape and brightness
across channels — limb prominences bright in 304 are dark in most others; sunspots dark in
visible light are "festooned with glowing ribbons" in UV; small flares invisible in optical are
bright UV ribbons. **A serious simulation therefore wants a two-layer disk (photosphere below,
chromosphere/corona above) with each layer carrying its own phenomena, not one painted surface.**

## 2. Phenomena catalogue, with the numbers

Everything the sky must eventually show, each with its measured parameters. This is the research
deliverable; the phases in §4 map onto it.

### 2.1 Rotation — differential, very slow

- The sun is not solid: equator rotates in **25 days**, poles in **~35 days** (NASA SOHO
  classroom lesson; sunpy docs, Beck 1999). The Carrington frame rate is 25.38 days sidereal
  (Mahajan et al. 2022, Table 2 note); features complete a "Carrington rotation" every
  27.2753 days as seen from Earth.
- The standard surface fit: omega(lat) = A + B·sin²(lat) + C·sin⁴(lat). We only need the
  visible band: use omega = A + B·sin²(lat), A ≈ 14.713 °/day (sidereal), B ≈ −2.396 °/day.
- Consequence for the render: every surface feature (granule pattern, spot, filament) must be
  advected by ITS OWN latitude's rate, or sunspots visibly slide relative to the granulation and
  the simulation reads as fake. This is a shader-domain advection, not a rotation of one mesh:
  sample the noise field at longitude offset by omega(lat)·t. Slow spin is a `sunSpin` slider
  (integrated clock — the formgl lesson: never `now × speed`).
- The rotation axis is tilted 7.25° to the ecliptic — visible as the equator running at a slight
  angle. Worth having.

### 2.2 Granulation — the boiling surface

- Granules are convection cells ~1 Mm across (1,000 km), lifetime 8–15 min: bright centres
  where hot plasma rises, dark narrow boundaries where cool plasma descends. Supergranules:
  ~25–30 Mm across, lifetime ~1.5 days (Rieutord & Rincon 2010 review; Roudier et al. 2013 CST
  tracking of 4,759 cells over 7 days; A&A 2014: lifetime τ = 1.5 days, diameter peaked at
  25 Mm).
- Procedural recipe (Pavel Zosim's physically-based UE5 sun, no textures, is the closest
  published technique — pavelzosim.com "Procedural Sun in UE5"): granulation = **inverted
  Voronoi F1 with domain warping** (k ∈ [2,4] shapes cell interiors: wide flat bright tops,
  sharp dark boundaries), warped by curl noise so cells deform and push each other instead of
  blinking. Fine layer capped at 3 octaves — high-frequency noise needs no depth (Godot shader
  note).
- BlockYard constraint carried over from NOVA_GLSL (worklog 2026-09-21): **band-limited fbm** —
  fade an octave out under 3–9 px per cell via fwidth, or the Markets panel (~100 px of sun)
  draws sub-pixel scribbles. No ridged noise.
- Colour: the photosphere is a 5778 K blackbody — perceptually near-white with a warm cast.
  Limb darkening: I(θ)/I(0) ≈ 1 − 0.6·(1 − cos θ); measured centre-to-limb ratio ~0.65–0.69
  at 0.9 D (Janss-korea SDO/HMI study 2017). The rim of the disk is dimmer and redder. This is
  the single biggest "that's a ball, not the sun" tell and costs one multiply.

### 2.3 Sunspots and the magnetic cycle

- Sunspots are where concentrated magnetic flux suppresses convection: umbra ~3,800 K against
  5,800 K photosphere (Zosim) — dark because they radiate less, not painted dark.
- Structure: dark umbra, filamented grey penumbra. Sizes range to twice Earth across (NASA).
- Placement physics worth honouring (Hale's polarity law: leading/trailing spot polarity
  alternates hemispheres and flips each cycle; Joy's law: groups tilt toward the equator;
  butterfly diagram: spots migrate equator-ward through an 11-year cycle). A serious
  simulation can run a slow phase parameter (cycle 0..1) that moves the spot latitudes and
  scales the activity — this is the "serious simulation" hook.
- Spots are anchored: they rotate WITH the surface at their latitude and drift slowly. They
  must be seeded features (deterministic from the sky's seed — engine rule: no Math.random at
  draw time; sameBoard/retained-frame logic in details3d requires every input to be a function
  of seed + clock).

### 2.4 Active regions, coronal loops

- Active regions = strong-field clusters: bright plage in UV channels over the spot pair, with
  **coronal loops** — semi-circular arcs of plasma following field lines between opposite
  polarities, brightest at their footpoints (171 Å is THE loop channel; thesuntoday.org).
- Loop scale: large AR loop systems ≥0.5 solar radius (Veronig et al. 2018, X8.2 CME paper).
  Loops are thin bundles with visible fine structure, brighter where denser.
- Render approach: footpoint pairs straddling the spot, arcs as ribbons/tubes between them with
  a brightness gradient (bright at feet, dimmer at apex). This is geometry over the shader disk,
  not a texture — same class of thing as the Formation's satellite knots.

### 2.5 Coronal holes and the solar wind

- Coronal holes: dark, low-density patches where field lines open into space — the source of
  FAST wind ~700–800 km/s; commonest at the poles, can appear anywhere (SVS 14892 "Solar Wind
  Animations"). In 193/211 they read as large soft dark regions, slowly evolving (days).
- The Heliospheric Current Sheet: field polarity flips at a surface drawn outward by the wind —
  the "ballerina skirt", resembling a baseball seam during the rising phase, source ~2.5 solar
  radii (Stanford WSO HCS page). Equatorial streamer belt = slow wind 300–500 km/s (SVS 14892).
  In EUV this is mostly *implied* (streamer stalks at the limb), but a faint far radial haze at
  the limb sells it without dominating the board.

### 2.6 Prominences and filaments — the crown jewel

- Same object two names: a **filament** seen against the disk (dark in most channels), a
  **prominence** seen at the limb (bright red in 304 Å). Cool (~8–50 kK) dense plasma suspended
  in the hot corona by magnetic field, in the dips of a twisted **flux rope**.
- Measured geometry (3D stereoscopic SDO+STEREO study, arXiv 2103.07111): leg lengths
  15,000–63,000 km, apex heights 21,000–60,000 km, whole-prominence lengths up to
  ~736,000 km (more than a solar radius), leg inclinations 19–86° from vertical.
  **All 14 footpoints in that study sat at supergranular boundaries** — a free realism win if
  footpoints are placed on the same cell boundaries the granulation shader uses.
- Structure: helically twisted threads. Observed twist 2–3 turns (6π) before eruption
  (A&A 2012 loop-like EP; IOPscience aa9020: 2.96 turns); twist ≥ 2π (one full wind) is the
  kink-instability threshold (Hood & Priest; Török & Kliem 2005).
- Eruption kinematics (multi-event): **slow rise ~10 km/s for an hour or more** (sometimes with
  large-amplitude longitudinal oscillations, period ~2 h, damped after 2–3 cycles), then kink
  writhe (twist converts to writhe; helicity conserved — same sign), then **fast rise
  100–230 km/s with acceleration 46–430 m/s²**, reaching torus instability where the overlying
  field decays fast enough (decay index n > 1.5, measured at 85–118 Mm in one event — IOP
  ab92a0). Some eruptions FAIL: deceleration 391 m/s² > solar gravity, plasma falls back along
  the legs (abb01d, failed eruption). A simulation should include failed eruptions — they are
  common and visually distinctive (material raining down the legs).
- Rendering: a prominence is an arc/tube structure between two footpoints with helical thread
  detail, standing off the limb. Slow wiggle, drain, and fall-back are the motions; Zosim's
  paired-particle arcs (sine-envelope lift along interpolated surface normals) is the technique
  reference.

### 2.7 Flares

- Cause: magnetic reconnection — field lines "short-circuit", snap into new positions, release
  magnetic energy (SVS 11199 "X Marks the Spot"). The reconnection happens ABOVE the loop
  arcade: an X-shape forms, splits, half the material falls to form the arcade, half escapes.
- Observational sequence (SVS 11199, 131 Å): loops pull together → cusp flattens → X forms →
  splits → **flare bursts from the arcade of post-flare loops** and reconnection propagates
  down the arcade. On disk: two bright **flare ribbons** in the chromosphere (1600/304 Å),
  separating as the flare proceeds; post-flare loops connect the ribbons and brighten
  successively higher (arXiv 2510.16647: free energy drops ~30% into post-flare loops).
- Timescale: impulsive phase minutes; the whole flare + arcade re-filling is tens of minutes
  to hours. GOES classification C/M/X (log scale) gives an activity vocabulary a settings
  slider can drive (mysimulator.uk maps an activity slider to NOAA classes).
- Rendering: an active region suddenly brightens (131-style hot white-cyan flash in the cusp),
  two ribbons light at the loop feet and separate, then the loop arcade lights up rung by rung
  with hot loops cooling through the ramp.

### 2.8 Coronal mass ejections

- Three-part structure (Illing & Hundhausen 1986; arXiv 2410.20603): **bright leading front
  (compressed pile-up shell) → dark cavity → bright core** (the erupting flux rope /
  prominence). Only ~⅓ of CMEs show it in coronagraphs but nearly all wide ones show it below
  3 solar radii (Song et al. 2023 via K-Cor) — good, because we render the low corona.
- Kinematics: three phases (Zhang et al. 2001/2004) — gradual slow rise, fast acceleration
  (coupled to the flare's impulsive phase), constant-velocity propagation. Speeds
  **100–3,500 km/s**; energy up to 10³² erg; the Aug 31 2012 SDO icon erupted at >900 mi/s
  (~1,450 km/s) (SVS 14126).
- Coronal dimming: EUV brightness drops where the CME evacuated material (Hudson 1996;
  Thompson 1998) — the eruption site goes dark for a while. Cheap to render (a decaying
  brightness mask) and a strong authenticity cue.
- ~54% of prominence eruptions are associated with a CME (1,225-event cycle-24 study,
  pith.science 2505.24202); failed eruptions are the rest of the story. So: sometimes a
  prominence eruption just falls back; sometimes it launches the three-part structure off-disk.
- Render: expanding shell geometry above the source region, cavity as absence, core as the
  existing prominence material carried outward; the whole thing fades over a long envelope
  (operator standard: distant things fade in/out over long spans, never pop).

### 2.9 Coronal rain

- Cool dense blobs formed by thermal instability in hot loops, falling along the loop arcs to
  the surface; blobs appear in 171 first and in 304 more than an hour later (rapid cooling —
  A&A 2015 / arXiv 1504.03471). Typical speeds tens to ~100+ km/s along curved paths; the
  multi-stranded study (ISSI 2015) stresses the rain is thin fine strands, not blobs alone.
- Render: particles constrained to loop paths with gravity along the arc; a slow-brightening
  warm speck trail. This is the one genuinely particle-heavy layer; on WebGL it maps to
  `ctx.particles` (transform feedback, like the pulsar), on software to the batched
  brightness-bucket strokes (the pulsar's approach: ~a dozen strokes for thousands of dots).

### 2.10 What we deliberately do NOT simulate

- MHD numerics. This is a *visual* simulation: every phenomenon is a seeded procedural model
  whose parameters come from the measurements above, not a solver. The node's own ethos
  (AGENTS.md rule 3) applies in spirit: absent physics is not faked — the models we run are
  honest parametrisations, and the plan doc says so.
- Spectroscopy, polarization, irradiance, helioseismology outputs.
- Small-scale spicule forests (15–30 Mm needles, ~100 km/s, Hinode Ca II data — they matter at
  the limb but are sub-pixel at panel scale; a faint limb-fuzz in the chromosphere shell is the
  right approximation).

## 3. Architecture on the BlockYard engine

Standing constraints (AGENTS.md, skills, memory):

- Two render paths, kept separate: Software (2D canvas, `public/js/`) and WebGL (gl2d.js seam).
  No mixing; user-selected app-wide.
- Software rules: no clip, no globalAlpha, no composite modes, no shadowBlur, no gradients.
  Soft edges = grain (speck clouds; density does the work) or stacked translucent fills.
  NO stacked translucent circles as a substitute for gas, no motion streaks, no '+' glints.
- WebGL: `ctx.shade`/`ctx.bake` fragment-shader layers exist (NOVA_GLSL, GAS_GLSL precedents).
  Additive blending IS allowed on GL. `precision highp int` required wherever a 32-bit hash
  lives. A shader that fails to compile must fall back SILENTLY but LOUDLY LOGGED
  (console + `window.__blockyardGlErrors`), and a declined layer paints a background rather
  than leaving the board bare (FORM_DEAD precedent).
- The Formation (formgl.js + galform.js) is the template for this project: pure maths module
  (no DOM at module level — the server loads it), a shader layer that declines on software GL,
  a 9,000-speck fallback sharing ONE ramp definition with the shader, settings pinned equal to
  module constants, picker/palettes as uniform data, clocks integrated in layer state.
- Anything with state lives on `st.fx`/layer state, never rebuilt from Math.random per frame.
- Wrap/loop envelopes: every periodic thing fades at both ends (env = min(phase, 1−phase)·k).
  Perpetual evolution, no visible loop seam.
- Desaturated-slate gas rule (memory) is the DEFAULT; as with the Formation, the operator's
  eye overrides for this sky — but ship the first cut restrained (the sun behind a chart must
  not overpower it; the operator's Formation lesson, 2026-09-21: "it was originally too bright
  and was threatening to overpower the chart").

### Layer stack (far → near), radius in solar radii

1. **Star field** (reuse the engine's starField; the sun's own sky keeps it sparse — the sun is
   in the zodiacal foreground).
2. **Corona volume** ×1.5–3.0 R (Zosim's nesting): the HCS/streamer haze at the limb, faint
   radial structure, CME shells live here. Mostly GL fragment work; software = baked limb haze
   bitmap + geometry shells.
3. **Chromosphere shell** ×1.005–1.015 R: limb darkening reads here, spicule fuzz, flare
   ribbons paint onto the disk through this layer, prominences root at its edge.
4. **Photosphere** ×1.0 R: the shader disk. Granulation (Voronoi-F1 + curl warp + band-limited
   fbm, differential-rotation advection), sunspots (seeded, Hale/Joy placement), active-region
   plage, coronal-hole darkening, flare brightness. All as shader terms keyed to the same seed;
   software = a baked offscreen bitmap regenerated on a slow cadence (the Living-sky dome
   caching pattern: per N degrees/half-degree of change, not per frame).
5. **Geometry above the disk**: loops, prominences, CME parts, rain particles.

Event machinery: an activity scheduler drives occurrence of {microflare, flare, filament
eruption (succeeds/fails), CME, rain episode} with a no-repeat-style cadence, seeded, in the
sky's own time base. Rates scale with the cycle phase parameter (§2.3).

### Settings group `sun` (Sky tab)

`sunSpin` (0..8, default 1 — one rotation per ~4 min wall clock at 1 is already slow on screen;
tune by eye), `sunActivity` (cycle phase 0..1: spot latitudes, event rate), `sunBrightness`
(1 = as made; scales colour, per the Formation's slider), `sunEvents` (on/off switch for the
event machinery). All wired through `skyFor()` — a control not in skyFor is dead (memory).
DEFAULTS.sky and sunsky module constants pinned equal, like FORM_*.

### Naming and seams

New module `public/js/sunsky.js` (pure maths + ramp/geometry constants) + `sungl.js` (the GL
layer) if needed — or one file following formgl's split. Sky choice value: `'sun'` in
SKIES/SKY_CHOICES/SKY_LABELS (order: appended after Galaxy, before Earth? — decide at
implementation, pin tests). details3d dispatch + optSig; six board sky-row hints; viewer-canvas
rules file list; test/settings.test.js pins.

## 4. Phased plan

Each milestone ends verified: headless chromium screenshots (scratch page + http.server on a
port picked with `ss -ltn`), numeric checks (PIL/numpy on the PNGs) and the full suite green;
`doc-counts --fix` LAST. GL verification via in-page readPixels with preserveDrawingBuffer:true
(rAF does not tick under --virtual-time-budget).

- **M1 — the disk.** Shader photosphere: granulation, limb darkening, differential-rotation
  advection, 7.25° tilt, sunSpin. Software: baked bitmap path. Success = a still that a
  stranger reads as "the sun": correct centre-to-limb falloff (numeric: radial profile matches
  1 − 0.6(1−cosθ) within tolerance), granule size in range vs disk radius, visibly rotating
  with equator leading poles.
- **M2 — atmosphere.** Chromosphere shell, limb fuzz, corona haze/streamer stalks, coronal
  holes. Success = limb reads as a glowing atmosphere with visible dark holes; nothing at the
  limb pops on wrap.
- **M3 — magnetism.** Sunspot groups (umbra/penumbra, Hale polarity, Joy tilt, cycle-phase
  latitudes), active-region plage, coronal loops between footpoints with footpoint-brightened
  shading. Success = loops arch between the same polarities the spots imply; spot latitudes
  migrate with the cycle slider.
- **M4 — prominences.** Quiescent prominences at supergranular-boundary footpoints, helical
  threads, slow evolution and drain; filaments on-disk as dark threads. Success = a still shows
  limb prominences whose size is in the measured range (heights 0.03–0.09 R), threads visible
  at 2560-wide panel, no streaks.
- **M5 — eruptions.** The event scheduler: slow rise → kink writhe → fast rise; failed
  eruptions (material falls back along legs); flare sequence (cusp flash, separating ribbons,
  post-flare arcade lighting rung by rung); coronal dimming after each event. Success =
  kinematics in the measured bands (slow ~10 km/s phase, fast 100–230 km/s, acceleration
  tens–hundreds m/s² scaled to the visual), every wrap faded.
- **M6 — CMEs.** Three-part structure leaving the disk, shell front + cavity + core, 3-phase
  kinematics, long fade envelope off-frame. Success = a capture sequence shows front/cavity/
  core distinguishable and the site dimmed behind it.
- **M7 — rain and polish.** Coronal rain particles on loop paths (ctx.particles on GL, bucket
  strokes on software); Kiosk-panel checks (every effect verified at Kiosk size — standing
  rule from the supernova white-out); gl-compare scene added (`sun-rest`, `sun-flare`,
  `sun-cme`); operator look pass on both renderers at 2560x1300.

Estimate: M1–M3 are the foundation and the most shader-heavy; M4–M6 are geometry + state
machines; M7 is polish. This is deliberately scoped as the largest sky project yet — the
Formation took two full days and this has more independent phenomena.

## 5. Open questions — ANSWERED (operator, 2026-09-21)

1. **Channel look.** **171 Å gold with red prominences** (the classic SDO look). The ramp
   everywhere derives from one SUN_RAMP; red prominence/304 tones sit outside it as a second,
   narrow ramp.
2. **Brightness.** **Ship dimmer: sunBrightness default 0.6** so the chart always wins
   (the Formation's lesson, applied from the start this time).
3. **Event frequency.** **Dense: near-constant activity, maximum drama** — the event scheduler
   runs hot at default (flares and small eruptions near-continuous, staggered so the board is
   rarely idle), CMEs regular rather than rare. A `sunActivity` slider still lets it calm down.
4. **Earth for scale.** **No.**

## 6. Sources

- NASA SVS, "SDO: Solar Events" gallery (the operator's link) — event footage index.
- NASA SVS 14126 (SDO Video Toolkit: 12 s cadence, 4096² full disk, Aug 2012 CME at 900 mi/s),
  4117 (Slices of SDO — channel-by-channel feature behaviour), 3980 (Active Sun 171 Å),
  11199 (X Marks the Spot — reconnection sequence), 14892 (solar wind origins), 4259
  (April 2012 flare frames), 4128.
- SDO/AIA wavelength guide — thesuntoday.org/sun/wavelengths (temps, ions per channel).
- sdo.gsfc.nasa.gov "The Sun Now" (live channels).
- Differential rotation: NASA SOHO classroom lesson (25 d equator / 35 d poles); sunpy
  differential-rotation docs (Beck 1999); Mahajan et al. 2022 (Carrington 25.38 d sidereal,
  coefficients).
- Supergranulation: Rieutord & Rincon 2010 (Living Reviews); Roudier et al. 2013; A&A 2014
  aa23577-14 (τ = 1.5 d, 25 Mm).
- Limb darkening: JASS 34, 99 (2017) — SDO/HMI u ≈ 0.65.
- Prominence geometry: arXiv 2103.07111 (stereoscopic heights/lengths; footpoints at
  supergranular boundaries).
- Eruption physics: IOPscience aa9020 (kink, 2.96 turns, slow 10 km/s → 28.9 m/s²); abb01d
  (failed eruption, 391 m/s² deceleration, cusp structures); A&A 2012 aa18588-11 (6π twist →
  writhe, 46–430 m/s², 166 km/s); IOP ab92a0 (torus instability, decay index 1.5 at 85–118 Mm);
  IOP 778/2/142 (SR→FR, kink, current-sheet brightening, splitting); 2D/3D torus-unstable
  prominence.
- CMEs: arXiv 2410.20603 (three-part, dimming); arXiv 1810.09320 (Veronig et al. 2018, X8.2:
  hot rim/cavity/shell, ≥0.5 Rs loop systems); ar5iv 1407.2271 (three kinematic phases,
  100–3000 km/s); pith.science 2505.24202 (54% association, core–prominence identity);
  DONKI CME morphology vocabulary.
- Coronal rain: A&A 577, A136 2015 (thermal instability, 171→304 lag > 1 h); ISSI multi-
  thermal multi-stranded study.
- Technique references (procedural rendering): pavelzosim.com Procedural Sun in UE5 (layered
  spheres ×1.0/×1.005–1.015/×1.5–3.0, inverted-Voronoi-F1 granulation, Hale polarity, paired-
  particle prominences); mysimulator.uk solar-flare page (fbm + domain warp, parabolic loop
  arcs, NOAA activity mapping); Godotshaders 2D sun (3-octave fine cap, sphere-trick); dev.to
  particle-sun (Unity, mass particle surface).
