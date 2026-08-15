// **render が止まっていないか**を検出する回帰テスト。
//
// CLAUDE.md 2.8 のバグ種別が対象。template から呼ばれる判定関数が throw すると
// Vue の render 関数が毎回失敗し、**以後 DOM が一切更新されなくなる**。
// Vue はこれを error ではなく **warn** で出すので、console.error を見ているだけでは気付かない。
// 症状は「レイアウトを変えても画面が変わらない」「右サイドバーが出ない」など別物に化ける。
//
// ここでは:
//   1. `app.config.warnHandler` / `errorHandler` を **ページ読み込み前**に仕込む
//      (読み込み後だと最初の render を取り逃す)
//   2. 実データを読み、レイアウト・タイル数・描画方式を一通り切り替える
//   3. 各操作の後で「DOM の canvas 枚数が imageBoxInfos と一致するか」を確認する
//      = render が実際に走っている証拠。version を上げただけで DOM が追随しなければ停止している
//   4. 拾った warn / error を全部出す
//
// 使い方: node scripts/render-health.mjs [--case Hirata20260728]
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const CASE = opt('case', 'Hirata20260728');
const URL = `http://localhost:${parseInt(opt('port', '3000'), 10)}${opt('base', '/metavol-web-beta2')}/?dev=${CASE}`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', m => { if (m.type() === 'error') console.error('[browser-console]', m.text()); });
  page.on('pageerror', e => console.error('[pageerror]', e.message));

  // **Vue が生成される前**に warn/error を捕まえる仕掛けを入れる。
  // createApp が返すオブジェクトの config に後から差し込むのでは最初の render を逃すため、
  // console.warn 自体を包んで Vue の warn 文字列を拾う。
  await page.addInitScript(() => {
    window.__vueWarns = [];
    const ow = console.warn.bind(console);
    console.warn = (...a) => {
      const s = a.map(x => (x && x.stack) ? x.stack : String(x)).join(' ');
      if (/\[Vue warn\]|render function|Unhandled error/i.test(s)) window.__vueWarns.push(s.slice(0, 400));
      ow(...a);
    };
    const oe = console.error.bind(console);
    console.error = (...a) => {
      const s = a.map(x => (x && x.stack) ? x.stack : String(x)).join(' ');
      if (/render|Unhandled/i.test(s)) window.__vueWarns.push('[error] ' + s.slice(0, 400));
      oe(...a);
    };
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`[render-health] loading ${CASE}…`);
  await page.waitForFunction(
    () => (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 1,
    null, { timeout: 900000 });
  let prev = -1, stable = 0;
  while (stable < 6) {
    const n = await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n === prev) stable++; else { stable = 0; prev = n; process.stdout.write(`\r  series=${n}   `); }
    await page.waitForTimeout(5000);
  }
  console.log(`\n[render-health] ${prev} series`);

  // errorHandler は読み込み後でも「以後の render 失敗」を捕まえられるので追加で仕込む
  await page.evaluate(() => {
    const app = document.querySelector('#app').__vue_app__;
    app.config.errorHandler = (e, _i, info) => window.__vueWarns.push(`[errorHandler] ${info}: ${e?.message}`);
  });

  // canvas 枚数が期待値に追随するかを見る = render が生きている証拠
  const checkDom = async (label, expectFn) => {
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => {
      const app = document.querySelector('#app').__vue_app__;
      const ss = app._instance.setupState;
      const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
      return {
        tileN: d.tileN?.value ?? d.tileN,
        infos: d.imageBoxInfos?.length ?? 0,
        canvases: [...document.querySelectorAll('canvas')].filter(c => c.width > 32).length,
        drawerVisible: !!document.querySelector('.mv-seg-panel, .v-navigation-drawer'),
      };
    });
    const ok = expectFn ? expectFn(r) : r.canvases > 0;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(30)} tileN=${r.tileN} infos=${r.infos} canvas=${r.canvases}`);
    return { ok, ...r };
  };

  // **レイアウトを呼ぶ前に volume を作っておくこと。**
  // setupTriplanarFused / setupPtOnly4up などは volume が無いと **早期 return** する。
  // 用意せずに呼ぶと「例外も出ないが何も起きない」ので、テストが素通りする
  // (実測: tileN が 16 のまま変わらないのに PASS と表示していた)。
  console.log('\n  PET/CT の volume を構築中…');
  await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const ss = app._instance.setupState;
    const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
    const sum = ss.seriesSummariesView;
    let pt = -1, ct = -1;
    sum.forEach((x, i) => { const m = (x.modality || '').toUpperCase();
      if ((m === 'PT' || m === 'PET') && pt < 0) pt = i;
      if (m === 'CT' && ct < 0) ct = i; });
    if (pt >= 0) d.ensureVolume_(pt);
    if (ct >= 0) d.ensureVolume_(ct);
  });
  await page.waitForTimeout(12000);

  const results = [];
  console.log('\n  操作ごとの DOM 追随');
  console.log('  ' + '-'.repeat(70));
  results.push(await checkDom('初期表示'));

  // App.vue の runLayout が呼ぶ 4 つ。**期待 tileN を明記して素通りを防ぐ**
  // (petCtMipRight は 5 box を 3x2 に置くので tileN=3)。
  const layouts = [
    { name: 'TriplanarFused', tileN: 3 },
    { name: 'PtOnly4up',      tileN: 4 },
    { name: 'Compare2up',     tileN: 2 },
    { name: 'PetCtMipRight',  tileN: null },   // 実装が tileN を直接持たないので枚数だけ見る
  ];
  for (const L of layouts) {
    const called = await page.evaluate((name) => {
      const app = document.querySelector('#app').__vue_app__;
      const ss = app._instance.setupState;
      const dv = ss.dicomViewRef.value ?? ss.dicomViewRef;
      const fn = 'setup' + name;
      const f = dv[fn] ?? dv.$.exposed?.[fn] ?? dv.$.setupState[fn];
      if (typeof f !== 'function') return false;
      try { f(); return true; } catch (e) { window.__vueWarns.push(`[throw] ${fn}: ${e?.message}`); return true; }
    }, L.name);
    if (!called) { console.log(`  FAIL  setup${L.name} が見つからない`); results.push({ ok: false }); continue; }
    results.push(await checkDom(`layout ${L.name}`,
      r => r.canvases > 0 && r.canvases <= r.infos && (L.tileN == null || r.tileN === L.tileN)));
  }

  // タイル数の変更 (穴あき imageBoxInfos が作られないかの確認も兼ねる)
  // setupState 上の tileN は **既に unwrap 済みの数値**。`.value` を触ると TypeError になる。
  for (const n of [1, 4, 9, 16, 4]) {
    await page.evaluate((tn) => {
      const app = document.querySelector('#app').__vue_app__;
      const d = (app._instance.setupState.dicomViewRef.value ?? app._instance.setupState.dicomViewRef).$.setupState;
      d.tileN = tn;
    }, n);
    results.push(await checkDom(`tileN=${n}`, r => r.tileN === n && r.canvases > 0));
  }

  // ===== box を増減する経路 =====
  // **2.8 の真因はここだった。** `imageBoxInfos.value.push(newInfo)` で box を足すと
  // newBoxId > length のとき間の index が undefined のまま tileN だけ伸び、
  // template から呼ばれる判定関数が undefined に対して throw して render が永久停止する。
  // 複製 / 閉じる / 最大化 / 融合 / 融合解除 を順に叩いて、毎回 DOM が追随することを見る。
  const callDv = async (name, ...a) => await page.evaluate(({ n, args }) => {
    const app = document.querySelector('#app').__vue_app__;
    const ss = app._instance.setupState;
    const dv = ss.dicomViewRef.value ?? ss.dicomViewRef;
    const f = dv[n] ?? dv.$.exposed?.[n] ?? dv.$.setupState[n];
    if (typeof f !== 'function') return 'missing';
    try { f(...args); return 'ok'; } catch (e) { window.__vueWarns.push(`[throw] ${n}: ${e?.message}`); return 'throw'; }
  }, { n: name, args: a });

  const boxOps = [
    ['onTitlebarDuplicate', [0], '複製'],
    ['onTitlebarDuplicate', [0], '複製 x2'],
    ['onTitlebarMaximize',  [1], '最大化'],
    ['onTitlebarMaximize',  [1], '最大化 解除'],
    ['onTitlebarClose',     [1], '閉じる'],
    ['onTitlebarClose',     [0], '閉じる x2'],
  ];
  for (const [fn, a, label] of boxOps) {
    const r = await callDv(fn, ...a);
    if (r === 'missing') { console.log(`  SKIP  ${label} (${fn} が expose されていない)`); continue; }
    results.push(await checkDom(`${label}`, x => x.canvases === x.tileN && x.tileN >= 0));
  }

  // 融合 / 融合解除。CT box に PET を重ねて外す。
  const fuseOk = await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const ss = app._instance.setupState;
    const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
    const sum = ss.seriesSummariesView;
    let pt = -1, ct = -1;
    sum.forEach((x, i) => { const m = (x.modality || '').toUpperCase();
      if ((m === 'PT' || m === 'PET') && pt < 0) pt = i;
      if (m === 'CT' && ct < 0) ct = i; });
    if (pt < 0 || ct < 0) return 'no-pair';
    if (d.tileN < 1) d.tileN = 1;
    try {
      d.promoteBoxToVolume(0, ct);
      await new Promise(r => setTimeout(r, 1200));
      d.fuseSeriesIntoBox(pt, 0);
      return 'ok';
    } catch (e) { window.__vueWarns.push(`[throw] fuse: ${e?.message}`); return 'throw'; }
  });
  if (fuseOk === 'ok') {
    results.push(await checkDom('融合', x => x.canvases === x.tileN));
    await page.evaluate(() => {
      const app = document.querySelector('#app').__vue_app__;
      const d = (app._instance.setupState.dicomViewRef.value ?? app._instance.setupState.dicomViewRef).$.setupState;
      try { d.unfuseBox(0); } catch (e) { window.__vueWarns.push(`[throw] unfuse: ${e?.message}`); }
    });
    results.push(await checkDom('融合解除', x => x.canvases === x.tileN));
  } else {
    console.log(`  SKIP  融合 (${fuseOk})`);
  }

  // imageBoxInfos に **穴 (undefined)** が無いこと。2.8 の真因はこれだった。
  const holes = await page.evaluate(() => {
    const app = document.querySelector('#app').__vue_app__;
    const d = (app._instance.setupState.dicomViewRef.value ?? app._instance.setupState.dicomViewRef).$.setupState;
    const arr = d.imageBoxInfos ?? [];
    const bad = [];
    for (let i = 0; i < arr.length; i++) if (arr[i] == null) bad.push(i);
    return { len: arr.length, bad };
  });
  const holesOk = holes.bad.length === 0;
  console.log(`  ${holesOk ? 'PASS' : 'FAIL'}  imageBoxInfos に穴が無い        len=${holes.len} 穴=${JSON.stringify(holes.bad)}`);

  const warns = await page.evaluate(() => window.__vueWarns ?? []);
  console.log(`\n  Vue warn / render error: ${warns.length} 件`);
  for (const w of warns.slice(0, 15)) console.log('    - ' + w.replace(/\s+/g, ' ').slice(0, 200));

  const allOk = results.every(r => r.ok) && holesOk && warns.length === 0;
  console.log(`\n  総合: ${allOk ? 'PASS' : 'FAIL'}`);
  if (!allOk) process.exitCode = 1;
} catch (e) { console.error('failed:', e?.stack ?? e); process.exitCode = 1; }
finally { await browser.close(); }
