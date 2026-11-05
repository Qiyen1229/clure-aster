/**
 * 「通知與提醒」的兩個分頁：系統與推播（這台裝置怎麼提醒你）｜外部通道（Discord、Telegram、LINE、Webhook）。
 * 設定頁只留一個入口；沒有登入帳號（沒有伺服器）時沒有外部通道，就不顯示切換。
 */
import { useNavigate } from 'react-router-dom';
import { AUTH_ENABLED } from '@/stores/auth';
import { Segmented } from '@/ui/controls';

export function NotifTabs({ current }: { current: 'system' | 'channels' }) {
  const navigate = useNavigate();
  if (!AUTH_ENABLED) return null;
  return (
    <div style={{ margin: '0 0 12px' }}>
      <Segmented value={current} ariaLabel="通知分頁" onChange={(v) => navigate(v === 'channels' ? '/settings/channels' : '/settings/notifications', { replace: true })}
        options={[{ value: 'system', label: '系統與推播' }, { value: 'channels', label: '外部通道' }]} />
    </div>
  );
}
