// WebGPU device singleton + capability detect.
// すべての pipeline がこの 1 device を共有する。adapter / device の取得は async なので
// 初回呼出のみ重い (~50ms)。それ以降は cached。

let devicePromise: Promise<any> | null = null;
let cachedDevice: any | null = null;
let supportFlag: boolean | null = null;

export const isWebGpuAvailable = (): boolean => {
    if (supportFlag !== null) return supportFlag;
    supportFlag = typeof navigator !== 'undefined'
        && 'gpu' in navigator
        && !!(navigator as any).gpu;
    return supportFlag;
};

// device acquire。失敗したら null を返す（caller は CPU fallback へ）。
export const getGpuDevice = async (): Promise<any | null> => {
    if (cachedDevice) return cachedDevice;
    if (!isWebGpuAvailable()) return null;
    if (devicePromise) return devicePromise;
    devicePromise = (async () => {
        try {
            const adapter = await (navigator as any).gpu.requestAdapter({
                powerPreference: 'high-performance',
            });
            if (!adapter) return null;
            // 大型 volume (512²×N CT 等) の texture upload では writeTexture が
            // 「コピー全体」サイズの staging buffer を確保する。default の
            // maxBufferSize (256MB) では 512²×345 CT (~362MB) が入らず upload が
            // 失敗する。adapter がサポートするなら上限を引き上げておく
            // (volumeCache 側の slab 分割と併せて二重の防御)。
            const requiredLimits: Record<string, number> = {};
            const adapterMaxBuf = adapter.limits?.maxBufferSize;
            if (typeof adapterMaxBuf === 'number' && adapterMaxBuf > 0x10000000) {
                requiredLimits.maxBufferSize = adapterMaxBuf;
            }
            const device = await adapter.requestDevice(
                Object.keys(requiredLimits).length ? { requiredLimits } : undefined,
            );
            // device lost handler — 失われたら次回再取得できるように reset
            device.lost.then((info: any) => {
                console.warn('[gpu] device lost:', info?.reason, info?.message);
                cachedDevice = null;
                devicePromise = null;
            });
            cachedDevice = device;
            console.log('[gpu] device acquired:', adapter.info?.vendor ?? '(unknown vendor)');
            return device;
        } catch (err) {
            console.warn('[gpu] device acquisition failed:', err);
            devicePromise = null;
            return null;
        }
    })();
    return devicePromise;
};

// 同期版 getter — 既に取得済みのときだけ device を返す。Render hot path で
// await を避けたいときに使う。null なら caller は CPU fallback。
export const getGpuDeviceSync = (): any | null => cachedDevice;
