/**
 * 操作助手的「執行預覽」內容（影響摘要＋逐步說明）。
 * 單步勾選：傳入 off（被略過的步驟序號）與 onToggle，每個能執行的步驟標題旁就有「☑ 執行／☐ 略過」；
 * 影響摘要用 summarySteps（略過之後重新預覽的結果）計算，略過的步驟顯示成灰色、不計入。
 */
import { summarizePlan, type ResolvedStep } from '@/domain/agent/plan';
import { formatMoney } from '@/domain/money';
import { useSettings } from '@/stores/settings';

export function PlanPreview({ steps, summarySteps, off, onToggle }: { steps: ResolvedStep[]; summarySteps?: ResolvedStep[]; off?: Set<number>; onToggle?: (i: number) => void }) {
  const base = useSettings((s) => s.baseCurrency);
  const diff = summarizePlan(summarySteps ?? steps);
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
        {diff.debtsCreated > 0 && <span className="pill">新增 {diff.debtsCreated} 筆應收／應付</span>}
        {diff.accountsTouched === 0 && <span className="pill">帳戶餘額不變</span>}
      </div>
      {steps.map((s, i) => {
        const skipped = !!off?.has(i);
        // 被擋下的步驟本來就不會執行，不給勾選；略過的步驟可以再勾回來
        const canToggle = !!onToggle && (skipped || !s.preview.blocked);
        return (
          <div key={i} className={`agent-step${s.preview.blocked ? ' blocked' : ''}${skipped ? ' skipped' : ''}`}>
            <div className="agent-step-title">
              <span className="agent-n">{i + 1}</span>
              <span style={{ flex: 1, minWidth: 0 }}>{s.preview.blocked && !skipped ? `${s.preview.title}（不會執行）` : s.preview.title}</span>
              {s.preview.readonly && !s.preview.blocked && !skipped && <span className="agent-tag">僅試算</span>}
              {canToggle && (
                <button type="button" className={`agent-toggle${skipped ? '' : ' on'}`} aria-pressed={!skipped} aria-label={`${skipped ? '改為執行' : '略過'}第 ${i + 1} 步`} onClick={() => onToggle!(i)}>
                  {skipped ? '☐ 略過' : '☑ 執行'}
                </button>
              )}
            </div>
            {skipped ? <p className="row-sub" style={{ whiteSpace: 'normal' }}>這一步先不執行（後面的步驟已依此重新試算）</p>
              : s.preview.blocked ? <p className="row-sub" style={{ color: 'var(--danger)', whiteSpace: 'normal' }}>{s.preview.blocked}</p> : (
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
        );
      })}
    </>
  );
}
