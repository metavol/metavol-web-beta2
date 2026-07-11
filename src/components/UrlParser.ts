export const getWH = () => {
const params = new URLSearchParams(window.location.search);
const w_str = params.get("w");
let w = Math.floor(Number(w_str));
const h_str = params.get("h");
let h = Math.floor(Number(h_str));

if (w<100 || w>1000){
    w = 500;
}
if (h<100 || h>1000){
    h = 500;
}

return [w,h];
}

export const getTileN = () => {
    const params = new URLSearchParams(window.location.search);
    const n_str = params.get("n");
    let n = Math.floor(Number(n_str));

    // ?n=N が無い / 範囲外なら 0 = 起動時 box ゼロ (画像エリアは empty state を表示)。
    // ファイル読み込みやレイアウト操作で必要数まで自動拡張される。
    if (n_str == null || isNaN(n) || n < 0 || n > 20){
        n = 0;
    }
    return n;
    }

    