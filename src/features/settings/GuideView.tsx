/** 外部通知的設定教學：可摺疊，依序列出步驟、要貼的欄位、常見問題與官方連結。 */
import type { ChannelKind } from '@/services/outgoing';
import { KIND_INFO } from '@/services/outgoing';
import { GUIDES } from './channelGuides';

export function GuideBody({ kind }: { kind: ChannelKind }) {
  const g = GUIDES[kind];
  return (
    <div className="guide-body">
      <p className="guide-blurb">{g.blurb}</p>
      <ul className="guide-facts">{g.facts.map((f, i) => <li key={i}>{f}</li>)}</ul>
      <div className="guide-h">步驟</div>
      <ol className="guide-steps">
        {g.steps.map((s, i) => (
          <li key={i}>
            <span>{s.text}</span>
            {s.note && <span className="guide-note">💡 {s.note}</span>}
          </li>
        ))}
      </ol>
      <div className="guide-h">要貼進 Aster 的欄位</div>
      <ul className="guide-facts">{g.paste.map((p, i) => <li key={i}>{p}</li>)}</ul>
      <div className="guide-h">常見問題</div>
      {g.troubleshoot.map((t, i) => (
        <details key={i} className="guide-q">
          <summary>{t.q}</summary>
          <p>{t.a}</p>
        </details>
      ))}
      <div className="guide-h">官方文件</div>
      <ul className="guide-links">
        {g.links.map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noopener noreferrer">{l.label} ↗</a></li>)}
      </ul>
    </div>
  );
}

/** 一個可摺疊的教學（標題＋展開後的內容） */
export function Guide({ kind, open }: { kind: ChannelKind; open?: boolean }) {
  return (
    <details className="guide" open={open}>
      <summary><span aria-hidden="true">{KIND_INFO[kind].icon}</span> {GUIDES[kind].title}</summary>
      <GuideBody kind={kind} />
    </details>
  );
}
