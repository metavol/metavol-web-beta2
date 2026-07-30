// Plugins
import Components from 'unplugin-vue-components/vite'
import Vue from '@vitejs/plugin-vue'
import Vuetify, { transformAssetUrls } from 'vite-plugin-vuetify'
import ViteFonts from 'unplugin-fonts/vite'

// Utilities
import { defineConfig, type Plugin } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import * as fs from 'node:fs'
import * as path from 'node:path'

// 開発時に sample-data/ 配下の DICOM (or NIfTI) を HTTP で提供する dev middleware。
// クライアント側は ?dev=case001 で起動時に自動 fetch + loadFiles できる。
//   GET /api/cases                  → ["case001", "case002", ...]
//   GET /api/cases/:caseId/files    → ["foo.dcm", "bar.dcm", ...] (再帰、相対パス)
//   GET /samples/:caseId/<relPath>  → 当該ファイル本体 (octet-stream)
// sample-data/ は .gitignore 推奨 (各 dev のローカル症例)。
const devSampleDataPlugin = (): Plugin => ({
  name: 'metavol-dev-sample-data',
  configureServer(server) {
    const root = path.resolve(__dirname, 'sample-data');

    const listCases = (): string[] => {
      try {
        return fs.readdirSync(root, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name)
          .sort();
      } catch { return []; }
    };

    const walk = (dir: string, base: string): string[] => {
      const out: string[] = [];
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...walk(full, rel));
        else if (e.isFile()) out.push(rel);
      }
      return out;
    };

    server.middlewares.use('/api/cases', (req, res, next) => {
      try {
        // /api/cases/:caseId/files の判定
        const url = req.url ?? '';
        const m = url.match(/^\/([^\/]+)\/files\/?$/);
        if (m) {
          const caseId = decodeURIComponent(m[1]);
          const dir = path.join(root, caseId);
          const files = walk(dir, '');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
          return;
        }
        if (url === '/' || url === '') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(listCases()));
          return;
        }
        next();
      } catch (err) {
        res.statusCode = 500;
        res.end(String(err));
      }
    });

    server.middlewares.use('/samples', (req, res, next) => {
      try {
        const url = decodeURIComponent((req.url ?? '').split('?')[0]);
        // path traversal 防止
        if (url.includes('..')) { res.statusCode = 400; res.end('bad path'); return; }
        const filePath = path.join(root, url);
        // root 配下に収まることを確認
        const rel = path.relative(root, filePath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          res.statusCode = 400; res.end('out of root'); return;
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          res.statusCode = 404; res.end('not found'); return;
        }
        // **stream + pipe をやめて readFile にする。**
        // 2000 ファイル超の症例を並列 fetch すると、createReadStream が fd 枯渇等で
        // エラー終了し、**200 のまま空ボディ**を返すことがあった (実測: 大量の
        // 「otherfile: 0 bytes」でシリーズが 16→6 に欠落)。読み切ってから送り、
        // 失敗は 500 で明示してクライアントにリトライさせる。
        fs.readFile(filePath, (err, data) => {
          if (err) { res.statusCode = 500; res.end(String(err)); return; }
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Content-Length', String(data.length));
          res.end(data);
        });
      } catch (err) {
        res.statusCode = 500;
        res.end(String(err));
        next();
      }
    });
  },
});

// 開発専用: canvas を PNG/JPEG で受け取り .screenshots/ に保存する。
//   POST /api/screenshot?name=foo   body = data URL 文字列
//
// **なぜ必要か**: Browser ペインが非表示のとき webview は hidden 扱いになり、
// requestAnimationFrame が 1 度も発火しない (実測: hidden 状態で 1.5 秒間 0 回)。
// 合成フレームが生成されないため、通常のスクリーンショット API は新フレームを待って
// タイムアウトする。canvas.toDataURL() は合成に依存しないので、ここへ POST すれば
// ペインの表示状態に関係なく描画結果を画像として確認できる。
// dev middleware なので本番ビルドには含まれない。
const devScreenshotPlugin = (): Plugin => ({
  name: 'metavol-dev-screenshot',
  configureServer(server) {
    const outDir = path.resolve(__dirname, '.screenshots');
    server.middlewares.use('/api/screenshot', (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const name = (new URL(req.url ?? '', 'http://x').searchParams.get('name') || 'shot')
            .replace(/[^a-zA-Z0-9_-]/g, '_');
          const m = body.match(/^data:image\/(png|jpeg);base64,(.*)$/s);
          if (!m) { res.statusCode = 400; res.end('expected data URL'); return; }
          fs.mkdirSync(outDir, { recursive: true });
          const file = path.join(outDir, `${name}.${m[1] === 'jpeg' ? 'jpg' : 'png'}`);
          fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, file }));
        } catch (err) {
          res.statusCode = 500; res.end(String(err));
        }
      });
    });
  },
});

// https://vitejs.dev/config/
export default defineConfig({
  base: '/metavol-web-beta2/',
  plugins: [
    Vue({
      template: { transformAssetUrls },
    }),
    // https://github.com/vuetifyjs/vuetify-loader/tree/master/packages/vite-plugin#readme
    Vuetify(),
    Components(),
    ViteFonts({
      google: {
        families: [
          { name: 'Roboto', styles: 'wght@100;300;400;500;700;900' },
          { name: 'Inter', styles: 'wght@400;500;600;700' },
          { name: 'JetBrains Mono', styles: 'wght@400;500' },
        ],
      },
    }),
    devSampleDataPlugin(),
    devScreenshotPlugin(),
  ],
  define: { 'process.env': {} },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    extensions: [
      '.js',
      '.json',
      '.jsx',
      '.mjs',
      '.ts',
      '.tsx',
      '.vue',
    ],
  },
  server: {
    port: 3000,
  },
  build: {
    rollupOptions: {
      output: {
        // Manual chunk: 重い依存を main bundle から分離 → 初回ロード短縮 + 並列 fetch。
        // - vue / vuetify は core (毎回必要) なのでデフォルトのまま (vendor)
        // - dicom-parser / nifti-reader-js / dcmjs-codecs は file ロード時のみ必要
        // - three は VR/MIP 等 volume 描画時のみ
        // - jpeg-lossless-decoder-js は JPEG Lossless DICOM のみ
        // - fflate / pako は gzip 解凍 (現在は native DecompressionStream 優先のため fallback のみ)
        manualChunks: {
          'vendor-vue': ['vue', 'pinia'],
          'vendor-vuetify': ['vuetify'],
          'vendor-three': ['three'],
          'vendor-dicom-parser': ['dicom-parser'],
          'vendor-jpeg-lossless': ['jpeg-lossless-decoder-js'],
          'vendor-dcmjs-codecs': ['dcmjs-codecs'],   // ~800KB、JPEG Lossless WASM
          'vendor-nifti': ['nifti-reader-js', 'fflate'],
        },
      },
    },
    chunkSizeWarningLimit: 900,    // dcmjs-codecs chunk が ~800KB
  },
})
