import { readFile } from 'node:fs/promises';
import { extname, normalize, resolve } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export function safeResolve(base, requestPath) {
  const root = resolve(base);
  const target = normalize(resolve(root, `.${requestPath}`));
  return target === root || target.startsWith(`${root}\\`) || target.startsWith(`${root}/`)
    ? target
    : null;
}

export async function serveFile(res, absPath, extraHeaders = {}) {
  try {
    const data = await readFile(absPath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(absPath).toLowerCase()] || 'application/octet-stream',
      ...extraHeaders,
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('404');
  }
}
