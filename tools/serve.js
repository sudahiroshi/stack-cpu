#!/usr/bin/env node
// 依存なしの簡易HTTPサーバ。ESモジュールをブラウザで読むために使う。
// 使い方: node tools/serve.js [port]   → http://localhost:8000/ui/
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const port = Number(process.argv[2] || 8000);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.asm': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream', '.png': 'image/png',
};

const redirect = (res, location) => { res.writeHead(302, { Location: location }); res.end(); };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const path = normalize(decodeURIComponent(url.pathname));
    if (path === '/') return redirect(res, '/ui/');
    let file = join(root, path);
    if (!file.startsWith(root)) throw new Error('forbidden');
    if ((await stat(file)).isDirectory()) {
      // 最後に / がないと、ページの中の相対パス（main.js など）が1つ上のフォルダーを指してしまうので、/ を付けて転送する
      if (!url.pathname.endsWith('/')) return redirect(res, `${url.pathname}/${url.search}`);
      file = join(file, 'index.html');
    }
    const body = await readFile(file);
    // 開発用なので、古いファイルがブラウザに残らないようにキャッシュさせない
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(port, () => console.log(`http://localhost:${port}/ui/`));
