# The weather globe

Operator, 2026-10-13, after the weather ribbon landed: "For webgl and software mode, is there any way
we can have a zoomable view of the area centered around the users location, and show weather radar
animations from forecast data, and allow zooming in and out and rotating to see global weather?" --
"heck see if we can do it for simple mode too" -- then "yes to all three, build it - update weather
every 30 minutes for API quota stuff. Configurable starting at 10 minute refreshes, and then retrigger
time ... Default should be 10 minute refresh for 6 per hours max".

## What it is

A map on the Weather tab that OPENS LOCAL (operator, after the first cut opened on the globe: "it needs to
zoom in at least to the surrounding zip codes. Not up so high. It's a local weather station to start"):
the place at tile zoom 11, about 75 km across a wide panel, distance rings round it and a scale bar in
place of a street map (this monitor contacts no map-tile server). Zoom out and it is the region, then
the globe, which turns under the pointer; `local` / `region` / `world` buttons jump between them. Two animated layers over the coastlines:

| layer | what | from | frames |
|---|---|---|---|
| **Radar** | observed precipitation, the last two hours, plus a short nowcast | RainViewer's public composite (`api.rainviewer.com` for the frame list, `tilecache.rainviewer.com` for 256-px tiles) | 13 at 10-minute steps (+ up to 3 nowcast) |
| **Forecast** | precipitation, temperature, wind and cloud for the next 48 hours, round the place | Open-Meteo, an 11 x 11 grid of points in ONE request (probed 2026-10-13: four points in 9.6 KB, 0.59 s); **local** 0.1 degrees apart (~110 km across, the default) or **regional** 0.5 (~550 km) | 48, hourly |

Radar is global where radar stations are; oceans and much of the global south are blank BY NATURE, and
the map says "no radar coverage" rather than painting them. The forecast grid covers about 5 degrees
round the place -- a global forecast field is outside Open-Meteo's free tier.

## Quota, and the refresh setting

Open-Meteo's free tier is 10,000 calls a day, 600 a minute, each point of a multi-point request counting
as a call. RainViewer's tiles are free with no stated cap; the proxy caches them so a pan never fans out.

`weather.refresh` (Display settings, minutes): how often a shown forecast -- the ribbon's, the grid's --
is re-asked. **10 minutes is the floor and the default** (6 an hour at most, enforced on the server per
place whatever a browser asks), 15, 20, 30 and 60 the other choices. The server obeys the SHARED file's
value, as it does for the weather switch itself. Cost at the default with one place: the ribbon's
forecast 144 calls a day, the grid 121 x 144 = 17,424 -- OVER the quota, so the grid refreshes at most
every 30 minutes regardless (`GRID_MIN_MS`), 121 x 48 = 5,808, and at `refresh` when that is slower.
Radar frames are re-listed every 5 minutes while the map is open (RainViewer publishes every 10).

## How it is drawn

Everything on the globe is RASTER REPROJECTION of one equirectangular picture (`weathermap.js`, pure):
the land polygons are rasterised into it once, a radar frame's mercator tiles are resampled into it row
by row, and a forecast hour is interpolated into it from the grid. The globe is then the orthographic
inverse of each panel pixel into that picture. One code path, no horizon clipping of polygons.

- **Software**: the inverse per pixel into an ImageData (a 600 x 600 globe is ~5 ms).
- **WebGL**: the same picture as a texture on its own GL canvas, the sphere ray-cast in a fragment shader
  (the Formation's and the Sun's seam: a field under the board), falling back to Software.
- **Simple**: the flat map alone, the latest frame, no loop: the 2-hour loop plays only while the play
  button is held down or the slider is dragged. A looping animation is exactly the repaint the Simple
  renderer exists to avoid.

Past the zoom where the sphere is three panels wide the view flattens into mercator, where the tiles
are drawn as they are up to zoom 7 and the zoom-7 tile scaled up past it (RainViewer's tiles stop at 7:
beyond, a "Zoom Level Not Supported" picture with a 200; ~1 km a pixel is about the radar's own grain)
and the 1:50m land, lakes and borders as vectors up to zoom 10, with the place names from 1:10m.

## Milestones

1. Geography shipped (`public/geo/land-50m.json`, `lines-50m.json`, `places-10m.json`; `scripts/geo-build.mjs`):
   land, lakes, country borders, state lines and ~7,300 place names; the globe turning and zooming on all three renderers.
2. Radar: the RainViewer proxy (`/api/weather/radar`, `/weather/tile/...`), frames cached, the loop.
3. Forecast grid: `/api/weather/grid`, the 48-hour loop, a layer switch.
4. The refresh setting with its floor and cap; docs (SECURITY.md's outbound table, README).
