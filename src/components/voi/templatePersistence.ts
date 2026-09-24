import * as THREE from '@/lib/threeMath';
import type { Volume } from '../Volume';
import type { VoiTemplate, VoiTemplateCheck } from './voiTemplate';

// VOI テンプレートの IndexedDB 永続化 (ペルソナ ATLAS)。
//
// 症例を回すたびにテンプレートを選び直すのが最大の摩擦だったため、
// 読み込んだテンプレートを丸ごと (ラベル volume ~2M voxel Float32 ≒ 8.5MB を含めて)
// ブラウザに憶えておき、次回起動時に自動復元する。
//
// - **配布ではない**: 保存先はユーザ自身のブラウザの IndexedDB のみ。
//   Neuromorphometrics の CC BY-NC (アプリ同梱配布の禁止) には抵触しない。
// - THREE.Vector3 は structured clone で prototype が落ちるので、
//   保存時に数値配列へ分解し、復元時に new THREE.Vector3 で組み直す。
// - 自動保存 (useAutoSave) とは別 DB。あちらは症例セッション、こちらは
//   症例をまたぐ道具 (テンプレート) なのでライフサイクルが違う。

const DB_NAME = 'metavol-voi-template';
const STORE = 'template';
const KEY = 'current';

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
});

interface StoredVolume {
    nx: number; ny: number; nz: number;
    pos: [number, number, number];
    vx: [number, number, number];
    vy: [number, number, number];
    vz: [number, number, number];
    voxel: Float32Array;
}
interface StoredTemplate {
    savedAt: number;
    sourceName: string;
    labels: VoiTemplate['labels'];
    header: VoiTemplate['header'];
    check: VoiTemplateCheck;
    volume: StoredVolume;
}

const v3 = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];

export const saveVoiTemplate = async (t: VoiTemplate, check: VoiTemplateCheck): Promise<void> => {
    const rec: StoredTemplate = {
        savedAt: Date.now(),
        sourceName: t.sourceName,
        // labels / header は plain object なのでそのまま。reactive proxy を剥がすため JSON 経由
        labels: JSON.parse(JSON.stringify(t.labels)),
        header: JSON.parse(JSON.stringify(t.header)),
        check: JSON.parse(JSON.stringify(check)),
        volume: {
            nx: t.volume.nx, ny: t.volume.ny, nz: t.volume.nz,
            pos: v3(t.volume.imagePosition),
            vx: v3(t.volume.vectorX), vy: v3(t.volume.vectorY), vz: v3(t.volume.vectorZ),
            voxel: t.volume.voxel as Float32Array,
        },
    };
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(rec, KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    db.close();
};

export const loadVoiTemplate = async (): Promise<{ template: VoiTemplate; check: VoiTemplateCheck } | null> => {
    try {
        const db = await openDb();
        const rec = await new Promise<StoredTemplate | undefined>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const rq = tx.objectStore(STORE).get(KEY);
            rq.onsuccess = () => resolve(rq.result as StoredTemplate | undefined);
            rq.onerror = () => reject(rq.error);
        });
        db.close();
        if (!rec || !rec.volume || !rec.labels?.length) return null;
        const vol: Volume = {
            nx: rec.volume.nx, ny: rec.volume.ny, nz: rec.volume.nz,
            imagePosition: new THREE.Vector3(...rec.volume.pos),
            vectorX: new THREE.Vector3(...rec.volume.vx),
            vectorY: new THREE.Vector3(...rec.volume.vy),
            vectorZ: new THREE.Vector3(...rec.volume.vz),
            voxel: rec.volume.voxel,
        } as Volume;
        return {
            template: { volume: vol, labels: rec.labels, header: rec.header, sourceName: rec.sourceName },
            check: rec.check,
        };
    } catch (e) {
        console.warn('[voi-template] restore failed', e);
        return null;
    }
};

export const clearVoiTemplate = async (): Promise<void> => {
    try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        db.close();
    } catch { /* 消せなくても実害なし */ }
};
