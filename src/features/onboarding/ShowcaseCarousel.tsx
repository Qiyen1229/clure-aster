/**
 * 功能介紹輪播：左右滑動（scroll-snap），底下的點可以點。首次引導用。
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/ui/Icon';
import { SHOWCASE } from './showcase';

export function ShowcaseCarousel() {
  const ref = useRef<HTMLDivElement>(null);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => setIdx(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const go = (i: number) => ref.current?.scrollTo({ left: i * (ref.current?.clientWidth ?? 0), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });

  return (
    <div className="showcase">
      <div className="showcase-track" ref={ref} role="list" aria-label="功能介紹">
        {SHOWCASE.map((f, i) => (
          <article key={f.id} className="showcase-card" role="listitem" aria-label={`${i + 1} / ${SHOWCASE.length}：${f.title}`}>
            <div className="showcase-icon"><Icon name={f.icon} size={30} /></div>
            <h2>{f.title}</h2>
            <p className="showcase-pitch">{f.pitch}</p>
            <ul>{f.bullets.map((b) => <li key={b}>{b}</li>)}</ul>
            <p className="showcase-how">{f.howto}</p>
          </article>
        ))}
      </div>
      <div className="showcase-dots" role="tablist" aria-label="切換功能">
        {SHOWCASE.map((f, i) => (
          <button key={f.id} role="tab" aria-selected={i === idx} aria-label={f.title} className={i === idx ? 'on' : ''} onClick={() => go(i)} />
        ))}
      </div>
    </div>
  );
}
