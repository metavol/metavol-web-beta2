<script setup lang="ts">
// 左サイドバー = **シリーズ一覧だけ**。
//
// 以前はこの下に Slice / Window preset / Advanced を積んでいたが、
// 全シリーズを表示するようにした結果、16 series で一覧だけが 1748px になり (ペインは 700px)、
// 下のセクションが実質到達不能になった。使用頻度で振り分けて外に出してある:
//   - Window preset  → app-bar の WindowPresetMenu (最頻用。選択 box の modality で出し分け)
//   - Slice の 4 ボタン → 廃止 (画像右端の縦スライダ / ホイール / カーソルキーで代替済み)
//   - Advanced       → ハンバーガー → AdvancedToolsDialog
import SeriesList from './SeriesList.vue';

defineProps<{
  seriesSummaries?: Array<{
    index: number;
    description: string;
    modality: string;
    matrixSize: string;
    voxelSize: string;
    fileCount: number;
    hasVolume: boolean;
    thumbnail: string | null;
    seriesUID: string;
    transferSyntaxName: string;
    transferSyntaxSupported: boolean;
    transferSyntaxReason?: string;
    acquisitionTime?: string;
    studyDate?: string;
    studyUID?: string;
    attenuationCorrected?: boolean;
    isPrimary: boolean;
    isRgb: boolean;
    sourceType: 'DICOM' | 'NIFTI';
  }>;
}>();

// **SeriesList のイベントはここで 1 つずつ中継する必要がある。**
// Sidebar は SeriesList を包んでいるだけだが、コンポーネントのイベントは
// 親から孫へ自動では伝わらない。DicomView 側で `<sidebar @xxx=...>` と書いても、
// ここに列挙して転送しなければ **無言で捨てられる** (エラーも出ない)。
// 実際 exportNifti を足したとき、ここへの追加を忘れてメニューが無反応になった。
// **SeriesList に emit を足したら必ずここも足すこと。**
const emit = defineEmits([
  "setModality",
  "setActiveForSeg",
  "inspectRaw",
  "viewHeader",
  "exportNifti",
]);
</script>

<template>
  <div class="mv-sidebar">
    <!-- ヘッダ ("SERIES 16") は置かない。ペインの中身がシリーズ一覧しか無いので
         見出しは情報を足しておらず、縦を食うだけ (ユーザ指定)。 -->
    <div class="mv-sidebar-body">
      <SeriesList
        :series="seriesSummaries ?? []"
        @setModality="(p: { index: number; modality: 'PT' | 'CT' | 'MR' }) => emit('setModality', p)"
        @setActiveForSeg="(p: { index: number; modality: 'PT' | 'CT' }) => emit('setActiveForSeg', p)"
        @inspectRaw="(p: { index: number }) => emit('inspectRaw', p)"
        @viewHeader="(p: { index: number }) => emit('viewHeader', p)"
        @exportNifti="(p: { index: number; gzip: boolean }) => emit('exportNifti', p)"
      />
    </div>
  </div>
</template>

<style scoped>
.mv-sidebar {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding-top: 4px;
  min-height: 0;
}
.mv-sidebar-body {
  flex: 1 1 auto;
  min-height: 0;      /* これが無いと flex 子が縮まずスクロールしない */
  overflow-y: auto;
  padding: 8px 12px;
}
</style>
