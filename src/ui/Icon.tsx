/**
 * 內建線條圖示（24×24，stroke 1.8，currentColor）。避免引入整包圖示庫以縮小首屏體積。
 */
import { useId } from 'react';

const P: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  wallet: 'M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3M21 12h-5a2 2 0 0 0 0 4h5v-4zM3 7h16a2 2 0 0 1 2 2v3',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7zM8 13h8',
  chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  chevronR: 'M9 6l6 6-6 6',
  chevronL: 'M15 6l-6 6 6 6',
  chevronD: 'M6 9l6 6 6-6',
  close: 'M18 6L6 18M6 6l12 12',
  trash: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6',
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z',
  copy: 'M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  backspace: 'M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM18 9l-6 6M12 9l6 6',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
  keyboard: 'M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  camera: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  tag: 'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01',
  check: 'M20 6L9 17l-5-5',
  swap: 'M7 16V4M7 4L3 8M7 4l4 4M17 8v12M17 20l4-4M17 20l-4-4',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24M1 1l22 22',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  note: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5',
  template: 'M12 2l3 6.5 7 .9-5.1 4.8 1.3 7L12 17.8 5.8 21.2l1.3-7L2 9.4l7-.9z',
  repeat: 'M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3',
  filter: 'M22 3H2l8 9.46V19l4 2v-8.54L22 3z',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M19 12l-7 7-7-7',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 0 20M12 2a15.3 15.3 0 0 0 0 20',
  ai: '',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  target: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  card: 'M2 5h20v14H2zM2 10h20',
  pie: 'M21.21 15.89A10 10 0 1 1 8 2.83M22 12A10 10 0 0 0 12 2v10z',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  trend: 'M23 6l-9.5 9.5-5-5L1 18M17 6h6v6',
};

export type IconName = keyof typeof P;

/**
 * Aster 自創的 AI 圖示：一顆彩虹光澤的多面寶石（珍珠白、薰衣草紫、天空藍的切面）。
 * 是彩色圖示、不吃 currentColor，要放在深色底上（首頁小圓球是深色圓底）。
 */
const GEM_PTS: Record<string, [number, number]> = {
  top: [12, 3.6], ur: [18.4, 7.2], r: [20, 12], lr: [18.5, 16.7], bot: [12, 20.5], ll: [5.6, 16.8], l: [4, 12], ul: [5.4, 7.4],
  p1: [10.4, 7.3], p2: [14.4, 7.6], p3: [9, 12.7], p4: [15.8, 11.2], p5: [13.4, 15.8], p6: [8.6, 15.9],
};
const GEM_FACETS: [string[], 'warm' | 'lav' | 'cool' | 'white' | 'rose'][] = [
  [['top', 'p1', 'p2'], 'white'],
  [['ul', 'top', 'p1'], 'warm'],
  [['top', 'ur', 'p2'], 'rose'],
  [['ul', 'p1', 'p3', 'l'], 'warm'],
  [['p1', 'p2', 'p4', 'p3'], 'lav'],
  [['p2', 'ur', 'r', 'p4'], 'rose'],
  [['l', 'p3', 'p6', 'll'], 'warm'],
  [['p3', 'p4', 'p5', 'p6'], 'lav'],
  [['p4', 'r', 'lr', 'p5'], 'cool'],
  [['ll', 'p6', 'bot'], 'white'],
  [['p6', 'p5', 'bot'], 'lav'],
  [['p5', 'lr', 'bot'], 'cool'],
];
const GEM_FILL: Record<string, [string, string]> = {
  white: ['#ffffff', '#e9e5ff'], warm: ['#fff6e3', '#e4d9f7'], rose: ['#f6d4ea', '#cdbcf3'], lav: ['#cfc4f6', '#9fb0ee'], cool: ['#c4f0f4', '#9fc3f0'],
};

function AiGem({ size, className }: { size: number; className?: string }) {
  const uid = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <defs>
        {Object.entries(GEM_FILL).map(([k, [c1, c2]]) => (
          <linearGradient key={k} id={`g-${uid}-${k}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={c1} /><stop offset="1" stopColor={c2} />
          </linearGradient>
        ))}
      </defs>
      {GEM_FACETS.map(([ids, fill], i) => (
        <polygon key={i} points={ids.map((id) => GEM_PTS[id].join(',')).join(' ')} fill={`url(#g-${uid}-${fill})`}
          stroke="#ffffff" strokeOpacity="0.75" strokeWidth="0.3" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

/** 文字行內用的小 AI 圖示（取代 ✨），大小跟著字 */
export function AiMark({ className }: { className?: string }) {
  return <AiGem size={16} className={`ai-mark${className ? ` ${className}` : ''}`} />;
}

export function Icon({ name, size = 22, stroke = 1.8, className }: { name: IconName; size?: number; stroke?: number; className?: string }) {
  if (name === 'ai') return <AiGem size={size} className={className} />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d={P[name]} />
    </svg>
  );
}

/** App 3D 星軌草寫 A 品牌 Logo（與 App 圖標同源） */
/** ★ 應用程式內 Logo（底部中央按鈕、載入畫面等）的位置微調：x 正數往右、y 正數往下（1024 畫布上的像素） */
const LOGO_OFFSET = { x: 0, y: 0 };

export function Logo({ className = 'logo' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 1024 1024" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="lg-script" x1="0.15" y1="0.9" x2="0.8" y2="0.1">
          <stop offset="0%" stopColor="#2563EB" />
          <stop offset="50%" stopColor="#38BDF8" />
          <stop offset="100%" stopColor="#A855F7" />
        </linearGradient>
        <linearGradient id="lg-ring-front" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#60A5FA" />
          <stop offset="50%" stopColor="#818CF8" />
          <stop offset="100%" stopColor="#C084FC" />
        </linearGradient>
        <linearGradient id="lg-ring-back" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#1E3A8A" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#4C1D95" stopOpacity="0.7" />
        </linearGradient>
      </defs>

      <g transform={`translate(${LOGO_OFFSET.x} ${LOGO_OFFSET.y})`}>
      {/* 身後星軌 */}
      <g transform="rotate(-26 512 512)">
        <path d="M 96,512 A 420 140 0 0 1 928,512" stroke="url(#lg-ring-back)" strokeWidth="28" strokeLinecap="round" />
        <path d="M 96,512 A 420 140 0 0 1 928,512" stroke="#60A5FA" strokeWidth="6" strokeOpacity="0.6" />
      </g>

      {/* 花體大寫 A 主幹 */}
      <path
        d="M 120,630 C 120,730 200,770 270,720 C 340,670 380,570 300,500 C 230,440 200,520 280,610 C 330,665 420,530 680,110"
        stroke="url(#lg-script)"
        strokeWidth="68"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M 680,110 C 650,220 540,560 480,750 C 470,780 440,780 435,740"
        stroke="url(#lg-script)"
        strokeWidth="62"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M 270,595 C 380,580 470,570 590,560 C 660,550 730,525 780,475"
        stroke="url(#lg-script)"
        strokeWidth="42"
        strokeLinecap="round"
      />

      {/* 高光流線 */}
      <path
        d="M 120,630 C 120,730 200,770 270,720 C 340,670 380,570 300,500 C 230,440 200,520 280,610 C 330,665 420,530 680,110"
        stroke="#FFFFFF"
        strokeWidth="16"
        strokeLinecap="round"
        opacity="0.9"
      />
      <path
        d="M 680,110 C 650,220 540,560 480,750 C 470,780 440,780 435,740"
        stroke="#FFFFFF"
        strokeWidth="14"
        strokeLinecap="round"
        opacity="0.9"
      />

      {/* 身前星軌 */}
      <g transform="rotate(-26 512 512)">
        <path d="M 96,512 A 420 140 0 0 0 928,512" stroke="url(#lg-ring-front)" strokeWidth="22" strokeLinecap="round" />
        <path d="M 96,512 A 420 140 0 0 0 928,512" stroke="#FFFFFF" strokeWidth="4" strokeLinecap="round" opacity="0.9" />
        <circle cx="760" cy="625" r="9" fill="#FFFFFF" />
        <circle cx="260" cy="590" r="7" fill="#C084FC" />
      </g>

      <circle cx="680" cy="110" r="12" fill="#FFFFFF" />
      </g>
    </svg>
  );
}
