/**
 * 旅遊模式專屬背景「島嶼假期」：固定裝飾層（太陽、雲、紙飛機、海浪）。
 * 純裝飾不攔截操作；日間為海空漸層，夜間自動切換黃昏夜航；減少動態時停止動畫。
 */

// 波形以 75 為週期（1200 寬共 16 週期），平移 50% 正好 8 週期，接縫無痕
const WAVE_PATH = (() => {
  let d = 'M0 12 Q18.75 2 37.5 12';
  for (let x = 75; x <= 1200; x += 37.5) d += ` T${x} 12`;
  return `${d} V24 H0 Z`;
})();

export function TravelScenery() {
  return (
    <div className="travel-scenery" aria-hidden="true">
      <div className="ts-sun" />
      <div className="ts-cloud c1" />
      <div className="ts-cloud c2" />
      <svg className="ts-plane" viewBox="0 0 24 24">
        <path d="M2 21l20-9L2 3v7l14 2-14 2v7z" />
      </svg>
      <svg className="ts-wave w2" viewBox="0 0 1200 24" preserveAspectRatio="none">
        <path d={WAVE_PATH} />
      </svg>
      <svg className="ts-wave w1" viewBox="0 0 1200 24" preserveAspectRatio="none">
        <path d={WAVE_PATH} />
      </svg>
      <div className="ts-sea" />
    </div>
  );
}
