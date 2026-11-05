/** 對話裡的「稅務規劃」檢視卡：直接嵌入稅務頁最上面那幾張卡（除息前預警、海外所得控管），全部本機規則運算 */
import { useNavigate } from 'react-router-dom';
import { TaxPlanCards } from '@/features/reports/TaxPlanCards';

export function TaxView() {
  const navigate = useNavigate();
  return (
    <div className="view-card view-tax">
      <TaxPlanCards />
      <button className="attn-link" onClick={() => navigate('/reports/tax')}>完整投資稅務彙總 →</button>
    </div>
  );
}
