// IndexedDB-backed persistence for in-progress segmentation sessions.
// Browser を閉じても作業状態が消えないよう、PT seriesUID をキーに最新マスクと
// メタデータを定期保存する。
//
// API:
//   await openDb()                              -> IDBDatabase
//   await saveSession(seriesUID, payload)        -> void
//   await loadSession(seriesUID)                 -> SessionPayload | null
//   await listSessions()                         -> SessionMeta[]
//   await deleteSession(seriesUID)               -> void
//   await cleanupOldSessions(maxAgeDays = 30)    -> number (deleted count)
//
// SessionPayload は serializeForPersistence() の戻り値そのまま (segStore 側)。

const DB_NAME = 'metavol';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';

export interface SessionMeta {
    seriesUID: string;
    seriesDescription?: string;
    savedAt: number;       // epoch ms
    nx: number; ny: number; nz: number;
    nLabels: number;
    sizeBytes: number;     // 概算
}

export interface SessionPayload {
    seriesUID: string;
    seriesDescription?: string;
    savedAt: number;       // epoch ms
    // mask blobs (Uint16Array buffers stored as ArrayBuffer)
    thresholdMask?: ArrayBuffer;
    manualEdits?: ArrayBuffer;
    finalMask?: ArrayBuffer;
    // dims / voxel size (re-validate on restore)
    dims: [number, number, number];
    voxelSizeMm?: [number, number, number];
    // settings
    threshold: number;
    thresholdUnit: 'SUV' | 'CNTS';
    labels: Array<{ id: number; name: string; color: [number, number, number] }>;
    currentLabelId: number;
    // ROI state (optional)
    sphere?: { centerWorld: [number, number, number]; radiusMm: number } | null;
    // 注意: undoStack は意図的に保存しない (容量肥大化を避けるため)
}

let _dbPromise: Promise<IDBDatabase> | null = null;

export const openDb = (): Promise<IDBDatabase> => {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'seriesUID' });
                store.createIndex('savedAt', 'savedAt', { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    });
    return _dbPromise;
};

const tx = async (mode: IDBTransactionMode): Promise<IDBObjectStore> => {
    const db = await openDb();
    return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
};

export const saveSession = async (payload: SessionPayload): Promise<void> => {
    const store = await tx('readwrite');
    return new Promise<void>((resolve, reject) => {
        const req = store.put(payload);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error ?? new Error('saveSession failed'));
    });
};

export const loadSession = async (seriesUID: string): Promise<SessionPayload | null> => {
    if (!seriesUID) return null;
    const store = await tx('readonly');
    return new Promise<SessionPayload | null>((resolve, reject) => {
        const req = store.get(seriesUID);
        req.onsuccess = () => resolve((req.result as SessionPayload | undefined) ?? null);
        req.onerror = () => reject(req.error ?? new Error('loadSession failed'));
    });
};

export const listSessions = async (): Promise<SessionMeta[]> => {
    const store = await tx('readonly');
    return new Promise<SessionMeta[]>((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => {
            const all = (req.result as SessionPayload[]) ?? [];
            resolve(all.map(p => ({
                seriesUID: p.seriesUID,
                seriesDescription: p.seriesDescription,
                savedAt: p.savedAt,
                nx: p.dims[0], ny: p.dims[1], nz: p.dims[2],
                nLabels: p.labels?.length ?? 0,
                sizeBytes: (p.thresholdMask?.byteLength ?? 0)
                         + (p.manualEdits?.byteLength ?? 0)
                         + (p.finalMask?.byteLength ?? 0),
            })));
        };
        req.onerror = () => reject(req.error ?? new Error('listSessions failed'));
    });
};

export const deleteSession = async (seriesUID: string): Promise<void> => {
    const store = await tx('readwrite');
    return new Promise<void>((resolve, reject) => {
        const req = store.delete(seriesUID);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error ?? new Error('deleteSession failed'));
    });
};

export const cleanupOldSessions = async (maxAgeDays = 30): Promise<number> => {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const store = await tx('readwrite');
    return new Promise<number>((resolve, reject) => {
        const idx = store.index('savedAt');
        const range = IDBKeyRange.upperBound(cutoff);
        const req = idx.openCursor(range);
        let count = 0;
        req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
                cursor.delete();
                count++;
                cursor.continue();
            } else {
                resolve(count);
            }
        };
        req.onerror = () => reject(req.error ?? new Error('cleanupOldSessions failed'));
    });
};
