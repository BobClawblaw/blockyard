// THE RADAR TILES, RAW (docs/PLAN-WEATHER-GLOBE.md). Every API route answers JSON; a PNG tile cannot, so this is
// served the way the DOS Diversions' game files are (http/games.js): a branch before the route table, behind the
// session when accounts are on, rate-limited per address or user. The proxy only serves a tile of a frame that
// /api/weather/radar has listed (collect/weather.js radarTile), at zoom 0-7, from its own cache or RainViewer's.
import { securityHeaders } from './static.js';
import { weatherOn } from './api.js';

export const TILE_PATH = /^\/weather\/tile\/([a-z0-9]{6,32})\/(\d{1,2})\/(\d{1,3})\/(\d{1,3})\.png$/;

export async function serveWeatherTile(req, res, urlPath, app, { tls = false, hstsMs = 0 } = {}) {
  const m = TILE_PATH.exec(urlPath);
  if (!m) return null;
  const headers = { ...securityHeaders({ tls, hstsMs }), 'Cache-Control': 'no-store' };
  const text = (status, body) => { res.writeHead(status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : body); return { status }; };
  if (!app.weather) return text(404, 'weather is off on this server');
  if (!(await weatherOn(app))) return text(403, 'the weather switch is off in Display settings');
  let buf;
  try { buf = await app.weather.radarTile(m[1], m[2], m[3], m[4]); } catch (e) { return text(502, `the radar tile could not be fetched: ${String(e?.message ?? e)}`); }
  if (!buf) return text(404, 'no such radar frame or tile');
  res.writeHead(200, { ...headers, 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=3600' });
  res.end(req.method === 'HEAD' ? undefined : buf);
  return { status: 200 };
}
