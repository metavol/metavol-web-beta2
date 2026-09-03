// sample-data 内のファイル名を**ハードコードしない**ための解決ヘルパ。
// spm-normalized/ に置く nii はユーザが症例ごとに差し替えるため
// (w00r.nii → wFDG.nii のように)、名前で固定するとスクリプトが一斉に落ちる。
import fs from 'node:fs';
import path from 'node:path';

/** ディレクトリ内で拡張子が合う最初のファイルを返す。無ければ throw。 */
export const pickOne = (dir, re, what) => {
  const abs = path.resolve(dir);
  const hits = fs.existsSync(abs) ? fs.readdirSync(abs).filter(f => re.test(f)).sort() : [];
  if (hits.length === 0) throw new Error(`${what} が見つかりません: ${abs} (${re})`);
  return path.join(abs, hits[0]);
};

/** SPM 正規化済み画像 (spm-normalized/ の *.nii / *.nii.gz) */
export const normalizedNii = () =>
  pickOne('sample-data/spm-normalized', /\.nii(\.gz)?$/i, 'SPM 正規化済み NIfTI');

/** VOI テンプレート (アトラス nii + ラベル xml) */
export const atlasFiles = () => ({
  nii: pickOne('sample-data/spm-atlas', /\.nii(\.gz)?$/i, 'アトラス NIfTI'),
  xml: pickOne('sample-data/spm-atlas', /\.xml$/i, 'ラベル XML'),
});

/** 同上を sample-data/ からの相対パス (posix 区切り) で返す。fetch URL 組み立て用。 */
export const normalizedNiiRel = () =>
  'spm-normalized/' + path.basename(normalizedNii());
