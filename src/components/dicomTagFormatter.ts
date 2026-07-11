// DICOM データセットを metavol26 (pydicom) と同じ可読フォーマットでテキスト化する。
// 例:
//   (0008,0008) Image Type                          CS: ['DERIVED', 'PRIMARY']
//   (0008,0016) SOP Class UID                       UI: 1.2.840.10008.5.1.4.1.1.128
//
// metavol26 との互換性:
//   - filter は AND/OR 構文 ("space" = AND、"|" = OR)
//   - "Single line" モードは改行 → タブ置換 (1 タグ 1 行)
//
// 入力: dicom-parser の DataSet
// 出力: 1 行 1 タグの文字列

import type { DataSet, Element } from 'dicom-parser';
// dcmjs の dictionary を tag→name 変換用に流用 (バンドル ~50 KB gzip)。
import tagDictRaw from './dicomTagDict.json';

interface TagDictEntry {
    name: string;
    vr: string;
}

const tagDict = tagDictRaw as Record<string, TagDictEntry>;

// "(GGGG,EEEE)" 形式に変換
const formatTagId = (key: string): string => {
    // dicom-parser の key は 'xggggeeee' (lowercase, no comma)
    if (key.length !== 9 || key[0] !== 'x') return key;
    return `(${key.slice(1, 5).toUpperCase()},${key.slice(5).toUpperCase()})`;
};

// "PatientName" → "Patient Name" (スペース挿入で人間可読に)
const humanizeName = (name: string): string => {
    return name
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
};

// VR 別の値整形。dicom-parser は raw bytes / string accessor を提供するので、
// VR に応じて適切な API を呼ぶ。
const formatValue = (
    ds: DataSet,
    key: string,
    vr: string,
    el: Element,
): string => {
    if (el.length === 0) return '(empty)';
    if (el.length > 1024) return `<binary, ${el.length} bytes>`;

    try {
        switch (vr) {
            case 'AE': case 'AS': case 'CS': case 'DS': case 'IS':
            case 'LO': case 'LT': case 'PN': case 'SH': case 'ST':
            case 'TM': case 'DA': case 'DT': case 'UI': case 'UR':
            case 'UC': case 'UT': {
                const raw = ds.string(key);
                if (raw == null) return '';
                // CS, DS, IS は \ で複数値を区切る
                if ((vr === 'CS' || vr === 'DS' || vr === 'IS') && raw.includes('\\')) {
                    const parts = raw.split('\\').map(s => `'${s.trim()}'`);
                    return '[' + parts.join(', ') + ']';
                }
                return raw.trim();
            }
            case 'US': case 'SS': {
                const v = ds.uint16(key);
                return v != null ? String(v) : '';
            }
            case 'UL': case 'SL': {
                const v = ds.int32(key);
                return v != null ? String(v) : '';
            }
            case 'FL': case 'OF': {
                const v = ds.float(key);
                return v != null ? String(v) : '';
            }
            case 'FD': case 'OD': {
                const v = ds.double(key);
                return v != null ? String(v) : '';
            }
            case 'AT': {
                // attribute tag (group, element)
                const g = ds.uint16(key, 0);
                const e = ds.uint16(key, 1);
                if (g != null && e != null) {
                    return `(${g.toString(16).padStart(4, '0').toUpperCase()},${e.toString(16).padStart(4, '0').toUpperCase()})`;
                }
                return '';
            }
            case 'OB': case 'OW': case 'UN':
                return `<binary, ${el.length} bytes>`;
            case 'SQ':
                return ''; // 中身は recursive に追加される
            default: {
                // 不明 VR は文字列で試す
                const raw = ds.string(key);
                if (raw != null) return raw.trim();
                return `<unknown VR ${vr}, ${el.length} bytes>`;
            }
        }
    } catch {
        return `<error reading>`;
    }
};

// 1 つの DataSet を再帰的に行リストに展開する (Sequence は indent あり)
const formatDataSet = (
    ds: DataSet,
    indent: number,
    out: string[],
): void => {
    const elements = ds.elements;
    // tag を昇順ソート (dicom-parser は順序保持しないことがある)
    const keys = Object.keys(elements).sort();
    for (const key of keys) {
        const el = elements[key];
        const tagId = formatTagId(key);
        const dictEntry = tagDict[key];
        const name = dictEntry ? humanizeName(dictEntry.name) : 'Unknown';
        const vr = (el.vr ?? dictEntry?.vr ?? '??') as string;
        const indentStr = '  '.repeat(indent);
        const valueStr = formatValue(ds, key, vr, el);

        // 名前カラムは 40 文字目までにパディング
        const nameField = name.length < 40 ? name.padEnd(40, ' ') : name + ' ';

        if (vr === 'SQ' && el.items && el.items.length > 0) {
            // sequence header
            out.push(`${indentStr}${tagId} ${nameField} ${vr}: <${el.items.length} item(s)>`);
            for (let idx = 0; idx < el.items.length; idx++) {
                const item = el.items[idx];
                if (!item.dataSet) continue;
                out.push(`${indentStr}  --- Item #${idx + 1} ---`);
                formatDataSet(item.dataSet, indent + 1, out);
            }
        } else {
            out.push(`${indentStr}${tagId} ${nameField} ${vr}: ${valueStr}`);
        }
    }
};

export const formatDicomTags = (ds: DataSet | null | undefined): string => {
    if (!ds) return '(no DICOM dataset)';
    const out: string[] = [];
    formatDataSet(ds, 0, out);
    return out.join('\n');
};

// metavol26 互換のフィルタ: "space" = AND、"|" = OR、case-insensitive。
// 空キーワードは all。
export const filterTagText = (text: string, keyword: string): string => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return text;
    const orGroups = kw.split('|').map(g => g.trim()).filter(g => g);
    if (orGroups.length === 0) return text;

    const matchLine = (line: string): boolean => {
        const lower = line.toLowerCase();
        for (const group of orGroups) {
            const terms = group.split(/\s+/).filter(t => t);
            if (terms.length === 0) continue;
            if (terms.every(t => lower.includes(t))) return true;
        }
        return false;
    };

    // sequence ヘッダ行 + その下の Item 範囲は header がマッチしたら全体を保持する。
    // ただし複雑になるので metavol26 と同様の単純な行 grep を採用。
    const lines = text.split('\n');
    return lines.filter(matchLine).join('\n');
};

// Single line モード: 改行をタブに置換 (1 タグ = 1 行で grep しやすく)
export const toSingleLine = (text: string): string => {
    return text.replace(/\t/g, ' ').replace(/\r\n/g, '\n').replace(/\n/g, '\t');
};

// dcmjs.es.js 内の vite 警告を黙らせるため `assert: { type: 'json' }` ではなく default import.
