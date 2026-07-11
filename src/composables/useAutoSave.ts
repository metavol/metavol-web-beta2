// Pinia segmentation store の状態を IndexedDB に自動保存する composable。
// maskVersion / sphere / labels の変化を watch、debounce してから書き出す。
// 保存先 key は PT seriesUID。PT が無い / seriesUID が無いシリーズでは何もしない。

import { onUnmounted, watch } from 'vue';
import { useSegmentationStore } from '../stores/segmentation';
import { saveSession, cleanupOldSessions } from '../stores/persistence';

const DEBOUNCE_MS = 2000;

export const useAutoSave = () => {
    const store = useSegmentationStore();

    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSerializedUid: string | null = null;

    const flush = async () => {
        const payload = store.serializeForPersistence();
        if (!payload) return;
        try {
            await saveSession(payload);
            store.markAutoSaved(payload.savedAt);
            lastSerializedUid = payload.seriesUID;
        } catch (err) {
            console.warn('[auto-save] saveSession failed', err);
        }
    };

    const scheduleSave = () => {
        if (timer != null) clearTimeout(timer);
        timer = setTimeout(flush, DEBOUNCE_MS);
    };

    // 初回起動時に古いセッションを 30 日以上前のもの掃除 (バックグラウンド、エラー無視)
    cleanupOldSessions(30).catch(() => {});

    // maskVersion の変化を監視。Apply / polygon / paste 等あらゆるマスク変更で増える。
    const stopMask = watch(() => store.maskVersion, () => scheduleSave());

    // labels / threshold / sphere の変化も保存対象 (mask 変化と独立に発生する)
    const stopLabels    = watch(() => JSON.stringify(store.labels), () => scheduleSave());
    const stopThreshold = watch(() => store.threshold + ':' + store.thresholdUnit, () => scheduleSave());
    const stopSphere    = watch(() => store.sphere?.radiusMm ?? null, () => scheduleSave());

    onUnmounted(() => {
        if (timer != null) clearTimeout(timer);
        stopMask(); stopLabels(); stopThreshold(); stopSphere();
    });

    return {
        flush,           // 即座に保存 (Test 等で利用)
        getLastUid: () => lastSerializedUid,
    };
};
