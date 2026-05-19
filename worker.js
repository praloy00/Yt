/**
 * VortexDL — Cloudflare Worker v3.1
 * Fixed Cobalt API call format
 */

const COBALT = 'https://api.cobalt.tools';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('facebook.com') || u.includes('fb.watch')) return 'facebook';
  if (u.includes('tiktok.com')) return 'tiktok';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('twitter.com') || u.includes('x.com')) return 'twitter';
  return 'unknown';
}

async function cobaltFetch(url, videoQuality = '1080', audioFormat = 'mp3') {
  const res = await fetch(`${COBALT}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      url,
      videoQuality,
      audioFormat,
      filenameStyle: 'pretty',
      downloadMode: 'auto',
      youtubeVideoCodec: 'h264',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cobalt ${res.status}: ${text}`);
  }
  return res.json();
}

async function getMeta(url) {
  try {
    const r = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);
    const d = await r.json();
    return { title: d.title || 'Video', author: d.author_name || '', thumbnail: d.thumbnail_url || '' };
  } catch {
    return { title: 'Video', author: '', thumbnail: '' };
  }
}

async function handleFetch(req) {
  let body;
  try { body = await req.json(); } catch { return json({ success: false, error: 'Invalid JSON' }, 400); }

  const url = (body.url || '').trim();
  if (!url) return json({ success: false, error: 'URL required' }, 400);

  const platform = detectPlatform(url);
  if (platform === 'unknown') return json({ success: false, error: 'Unsupported platform.' }, 400);

  const qualities = ['1080', '720', '480', '360'];
  let formats = [];
  let lastErr = '';

  for (const q of qualities) {
    try {
      const cobaltRes = await cobaltFetch(url, q);

      if (['stream', 'redirect', 'tunnel'].includes(cobaltRes.status)) {
        formats.push({ label: `${q}p`, url: cobaltRes.url, ext: 'mp4', filesize: null, type: 'video' });
        try {
          const aRes = await cobaltFetch(url, q, 'mp3');
          if (aRes.url) formats.push({ label: 'MP3 Audio', url: aRes.url, ext: 'mp3', filesize: null, type: 'audio' });
        } catch (_) {}
        break;

      } else if (cobaltRes.status === 'picker') {
        for (const item of cobaltRes.picker || []) {
          formats.push({ label: item.quality ? `${item.quality}p` : 'Video', url: item.url, ext: 'mp4', filesize: null, type: 'video' });
        }
        break;

      } else if (cobaltRes.status === 'error') {
        lastErr = cobaltRes.error?.code || cobaltRes.error || 'Cobalt error';
      }
    } catch (e) { lastErr = e.message; }
  }

  if (!formats.length) return json({ success: false, error: lastErr || 'Could not extract video.' }, 500);

  const meta = await getMeta(url);
  return json({ success: true, platform, ...meta, duration: null, formats, stats: {} });
}

async function handleBatch(req) {
  let body;
  try { body = await req.json(); } catch { return json({ success: false, error: 'Invalid JSON' }, 400); }
  const urls = (body.urls || []).slice(0, 10);
  if (!urls.length) return json({ success: false, error: 'No URLs' }, 400);

  const results = await Promise.allSettled(
    urls.map(url => handleFetch(new Request('https://x', {
      method: 'POST', body: JSON.stringify({ url }),
      headers: { 'Content-Type': 'application/json' },
    })).then(r => r.json()))
  );
  return json({ success: true, results: results.map((r, i) => r.status === 'fulfilled' ? r.value : { success: false, url: urls[i], error: r.reason?.message || 'Failed' }) });
}

async function handleProxy(req) {
  const u = new URL(req.url);
  const b64 = u.searchParams.get('url');
  const filename = u.searchParams.get('filename') || 'video.mp4';
  if (!b64) return new Response('Missing url', { status: 400, headers: CORS });
  let realUrl;
  try { realUrl = atob(b64); } catch { return new Response('Bad encoding', { status: 400, headers: CORS }); }

  const rangeHeader = req.headers.get('Range') || '';
  const upstream = await fetch(realUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.youtube.com/',
      ...(rangeHeader ? { Range: rangeHeader } : {}),
    },
  });

  const headers = {
    ...CORS,
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  const contentLength = upstream.headers.get('Content-Length');
  const contentRange = upstream.headers.get('Content-Range');
  if (contentLength) headers['Content-Length'] = contentLength;
  if (contentRange) headers['Content-Range'] = contentRange;

  return new Response(upstream.body, { status: upstream.status, headers });
}

async function handleProbe(req) {
  const u = new URL(req.url);
  const b64 = u.searchParams.get('url');
  if (!b64) return json({ size: null });
  let realUrl;
  try { realUrl = atob(b64); } catch { return json({ size: null }); }
  try {
    const r = await fetch(realUrl, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } });
    const size = r.headers.get('Content-Length');
    return json({ size: size ? parseInt(size) : null });
  } catch { return json({ size: null }); }
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (path === '/health') return json({ ok: true, version: '3.1' });
    if (path === '/api/fetch' && method === 'POST') return handleFetch(req);
    if (path === '/api/batch' && method === 'POST') return handleBatch(req);
    if (path === '/api/proxy') return handleProxy(req);
    if (path === '/api/probe') return handleProbe(req);

    return json({ error: 'Not found' }, 404);
  },
};
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'VortexDL/3.0',
    },
    body: JSON.stringify({
      url,
      videoQuality,
      audioFormat,
      filenameStyle: 'pretty',
      downloadMode: 'auto',
      youtubeVideoCodec: 'h264',
      alwaysProxy: false,
      disableMetadata: false,
    }),
  });
  if (!res.ok) throw new Error(`Cobalt ${res.status}`);
  return res.json();
}

async function getMeta(url) {
  try {
    const r = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);
    const d = await r.json();
    return { title: d.title || 'Video', author: d.author_name || '', thumbnail: d.thumbnail_url || '' };
  } catch {
    return { title: 'Video', author: '', thumbnail: '' };
  }
}

async function handleFetch(req) {
  let body;
  try { body = await req.json() } catch { return json({ success: false, error: 'Invalid JSON' }, 400) }

  const url = (body.url || '').trim();
  if (!url) return json({ success: false, error: 'URL required' }, 400);

  const platform = detectPlatform(url);
  if (platform === 'unknown') return json({ success: false, error: 'Unsupported platform' }, 400);

  const qualities = ['1080', '720', '480', '360'];
  let formats = [];
  let lastErr = '';

  for (const q of qualities) {
    try {
      const cobaltRes = await cobaltFetch(url, q);
      if (cobaltRes.status === 'stream' || cobaltRes.status === 'redirect') {
        formats.push({ label: `${q}p`, url: cobaltRes.url, ext: 'mp4', filesize: null, type: 'video', direct: true });
        // also get audio
        try {
          const aRes = await cobaltFetch(url, q, 'mp3');
          if (aRes.url) formats.push({ label: 'MP3 Audio', url: aRes.url, ext: 'mp3', filesize: null, type: 'audio', direct: true });
        } catch (_) {}
        break;
      } else if (cobaltRes.status === 'picker') {
        for (const item of cobaltRes.picker || []) {
          formats.push({ label: item.quality ? `${item.quality}p` : 'Video', url: item.url, ext: 'mp4', filesize: null, type: 'video', direct: true });
        }
        break;
      } else if (cobaltRes.status === 'error') {
        lastErr = cobaltRes.error?.code || 'Cobalt error';
      }
    } catch (e) { lastErr = e.message }
  }

  if (!formats.length) return json({ success: false, error: lastErr || 'Could not extract video' }, 500);

  const meta = await getMeta(url);
  return json({ success: true, platform, ...meta, duration: null, formats, stats: {} });
}

async function handleBatch(req) {
  let body;
  try { body = await req.json() } catch { return json({ success: false, error: 'Invalid JSON' }, 400) }
  const urls = (body.urls || []).slice(0, 10);
  if (!urls.length) return json({ success: false, error: 'No URLs' }, 400);

  const results = await Promise.allSettled(
    urls.map(url => handleFetch(new Request('https://x', { method: 'POST', body: JSON.stringify({ url }), headers: { 'Content-Type': 'application/json' } })).then(r => r.json()))
  );
  return json({ success: true, results: results.map((r, i) => r.status === 'fulfilled' ? r.value : { success: false, url: urls[i], error: r.reason?.message || 'Failed' }) });
}

// ── Chunked proxy download for large files ──────────────────────
// Frontend sends Range header → worker proxies that range from CDN
// This allows the frontend to download 200MB chunks sequentially
async function handleProxy(req) {
  const u = new URL(req.url);
  const b64 = u.searchParams.get('url');
  const filename = u.searchParams.get('filename') || 'video.mp4';

  if (!b64) return new Response('Missing url', { status: 400, headers: CORS });

  let realUrl;
  try { realUrl = atob(b64) } catch { return new Response('Bad encoding', { status: 400, headers: CORS }) }

  // Forward the Range header from client if present
  const rangeHeader = req.headers.get('Range') || '';

  const upstream = await fetch(realUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.youtube.com/',
      ...(rangeHeader ? { Range: rangeHeader } : {}),
    },
  });

  const status = upstream.status; // 200 or 206
  const contentLength = upstream.headers.get('Content-Length');
  const contentRange = upstream.headers.get('Content-Range');
  const contentType = upstream.headers.get('Content-Type') || 'application/octet-stream';

  const headers = {
    ...CORS,
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  };
  if (contentLength) headers['Content-Length'] = contentLength;
  if (contentRange) headers['Content-Range'] = contentRange;

  return new Response(upstream.body, { status, headers });
}

// ── File size probe (HEAD request) ──────────────────────────────
async function handleProbe(req) {
  const u = new URL(req.url);
  const b64 = u.searchParams.get('url');
  if (!b64) return json({ size: null });
  let realUrl;
  try { realUrl = atob(b64) } catch { return json({ size: null }) }

  try {
    const r = await fetch(realUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const size = r.headers.get('Content-Length');
    return json({ size: size ? parseInt(size) : null });
  } catch {
    return json({ size: null });
  }
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (path === '/health') return json({ ok: true, version: '3.0' });
    if (path === '/api/fetch' && method === 'POST') return handleFetch(req);
    if (path === '/api/batch' && method === 'POST') return handleBatch(req);
    if (path === '/api/proxy') return handleProxy(req);
    if (path === '/api/probe') return handleProbe(req);

    return json({ error: 'Not found' }, 404);
  },
};


