// ガイドツアー (デモ) の型定義。
// シナリオ = ステップの並び。各ステップは「キャプション + カーソル対象 + 実アクション」。
// 状態変更はアプリの実ハンドラ/store action を呼ぶ (API 駆動)。カーソルは演出。

export type DemoTarget =
    // CSS セレクタ (通常は data-demo="..." を指す安定キー)。
    | { kind: 'selector'; sel: string }
    // ビューポート絶対座標 (px)。
    | { kind: 'point'; x: number; y: number };

export type DemoGesture = 'click' | 'move' | 'wheel' | 'drag';

export interface DemoStep {
    id: string;
    /** 初心者向けナレーション (UI ポリシーに従い英語)。 */
    caption: string;
    /** カーソル移動先 / ハイライト対象。省略時はカーソル据え置き・ハイライト無し。 */
    target?: DemoTarget;
    /** 実状態変更 (実ハンドラ / store action)。省略時は「指すだけ」。 */
    action?: () => void | Promise<void>;
    /** カーソルの所作。既定は action があれば 'click'、無ければ 'move'。 */
    gesture?: DemoGesture;
    /** キャプションを読ませる間 (カーソル到着後・アクション前)。ms。 */
    preWaitMs?: number;
    /** アクション後の待ち。'idle' は __metavolTest.waitForIdle、数値は ms。 */
    settle?: number | 'idle';
}

export interface DemoScenario {
    id: string;
    title: string;
    steps: DemoStep[];
}
