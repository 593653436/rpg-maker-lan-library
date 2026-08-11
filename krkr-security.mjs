const KRKR_PLAYER = /^\/player\.html$/;
const KRKR_RUNTIME = /^\/krkr-runtime\/([^/]+)(?:\/|$)/;
const KRKR_ARCHIVE = /^\/api\/krkr\/([^/]+)\/game\.zip$/;

function checkedHttpsOrigin(config) {
  if (!config?.enabled) return null;
  const host = String(config.publicHost || '').trim();
  const port = Number(config.port);
  if (!host || /[\s/:?#\\]/.test(host)) throw new Error('HTTPS publicHost 无效');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HTTPS port 无效');
  return `https://${host}:${port}`;
}

function checkedForwardedHttps({ forwardedProto, forwardedHost, trustForwardedHeaders }) {
  if (!trustForwardedHeaders) return { encrypted: false, origin: null };
  const proto = String(forwardedProto || '').split(',')[0].trim().toLowerCase();
  if (proto === 'https') return { encrypted: true, origin: null };
  if (proto !== 'http') return { encrypted: false, origin: null };
  const host = String(forwardedHost || '').split(',')[0].trim();
  if (!host || /[\s/@?#\\]/.test(host)) return { encrypted: false, origin: null };
  try {
    const parsed = new URL(`https://${host}`);
    if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return { encrypted: false, origin: null };
    return { encrypted: false, origin: parsed.origin };
  } catch {
    return { encrypted: false, origin: null };
  }
}

export function buildKrkrHttpsRedirect({ encrypted, forwardedProto, forwardedHost, trustForwardedHeaders = false, url, httpsConfig, isKrkrGame }) {
  const forwarded = checkedForwardedHttps({ forwardedProto, forwardedHost, trustForwardedHeaders });
  if (encrypted || forwarded.encrypted) return null;
  const origin = forwarded.origin || checkedHttpsOrigin(httpsConfig);
  if (!origin) return null;
  let gameId = null;
  if (KRKR_PLAYER.test(url.pathname)) gameId = url.searchParams.get('game');
  else gameId = KRKR_RUNTIME.exec(url.pathname)?.[1] || KRKR_ARCHIVE.exec(url.pathname)?.[1] || null;
  if (!gameId || !isKrkrGame(gameId)) return null;
  return origin + url.pathname + url.search;
}
