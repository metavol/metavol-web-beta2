// three.js の数学クラスだけを再エクスポートする薄いモジュール。
// このアプリは three の Vector/Matrix/Euler/Quaternion しか使わない
// (レンダラ・Scene・Mesh・Loader は src/components/webgpu の手書きパスで代替済み)。
// 各所を `import * as THREE from '@/lib/threeMath'` にすることで Rollup が three を
// この 5 クラスへツリーシェイクでき、vendor-three バンドルが縮む。
//
// 注意: `THREE.Xxx` で新しい three のシンボルを使うときは、必ずここに追記すること。
//       欠けると namespace import 経由で実行時 undefined になる。
export { Vector2, Vector3, Matrix4, Euler, Quaternion } from 'three';
