/** 操作助手的「執行預覽」內容（影響摘要＋逐步說明）：AI 助理頁的卡片與首頁對話框的泡泡共用 */
import { summarizePlan, type ResolvedStep } from '@/domain/agent/plan';
import { formatMoney } from '@/domain/money';
import { useSettings } from '@/stores/settings';

export function PlanPreview({ steps }: { steps: ResolvedStep[] }) {
  const base = useSettings((s) => s.baseCurrency);
  const diff = summarizePlan(steps);
  return (
    <>
      <div className="agent-diff">
        {diff.affectedTx > 0 && <span className="pill">影響 {diff.affectedTx} 筆帳目</span>}
        {diff.budgetChanges > 0 && <span className="pill">預算 {diff.budgetChanges} 項</span>}
        {diff.rulesCreated > 0 && <span className="pill">新增週期 {diff.rulesCreated} 條</span>}
        {diff.autoRulesCreated > 0 && <span className="pill">自動分類規則 {diff.autoRulesCreated} 條</span>}
        {diff.goalsCreated > 0 && <span className="pill">存錢目標 {diff.goalsCreated} 個</span>}
        {diff.txCreated > 0 && <span className="pill">新增 {diff.txCreated} 筆帳目</span>}
        {diff.accountsTouched > 0 && <span className="pill">動到 {diff.accountsTouched} 個帳戶餘額</span>}
        {diff.debtsSettled > 0 && <span className="pill">結清 {diff.debtsSettled} 筆欠款</span>}
        {diff.accountsTouched === 0 && <span className="pill">帳戶餘額不變</span>}
      </div>
      {steps.map((s, i) => (
        <div key={i} className={`agent-step${s.preview.blocked ? ' blocked' : ''}`}>
          <div className="agent-step-title">
            <span className="agent-n">{i + 1}</span>{s.preview.blocked ? `${s.preview.title}（不會執行）` : s.preview.title}
            {s.preview.readonly && !s.preview.blocked && <span className="agent-tag">僅試算</span>}
          </div>
          {s.preview.blocked ? <p className="row-sub" style={{ color: 'var(--danger)', whiteSpace: 'normal' }}>{s.preview.blocked}</p> : (
            <>
              <ul className="agent-lines">{s.preview.lines.map((l, j) => <li key={j}>{l}</li>)}</ul>
              {s.preview.samples && (
                <details className="agent-samples">
                  <summary>抽樣看 {s.preview.samples.length} 筆（核對有沒有誤傷）</summary>
                  {s.preview.samples.map((x, j) => (
                    <div key={j} className="agent-sample"><span>{x.date.slice(5)}　{x.note}</span><span className="num">{formatMoney(x.amountMinor, base, { decimals: 0 })}　<i>{x.from}</i></span></div>
                  ))}
                </details>
              )}
              {s.preview.warnings.map((w, j) => <p key={j} className="row-sub" style={{ color: 'var(--warning)', whiteSpace: 'normal' }}>⚠️ {w}</p>)}
            </>
          )}
        </div>
      ))}
    </>
  );
}
