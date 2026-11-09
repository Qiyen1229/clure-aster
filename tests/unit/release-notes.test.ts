/**
 * 更新後的新功能說明視窗：範圍是「使用者上次看過的版本 → 目前版本」之間所有版本的功能；
 * 而且每次發佈都要在 releaseNotes.ts 新增這一版（測試把關）。
 */
import { describe, expect, it } from 'vitest';
import pkg from '../../package.json';
import { RELEASE_NOTES, cmpVersion, featuresBetween, type ReleaseNote } from '@/features/whatsnew/releaseNotes';
import { LEGACY_BASELINE, planWhatsNew } from '@/features/whatsnew/WhatsNew';
import { isNewAttention } from '@/features/home/AttentionCard';

const N: ReleaseNote[] = [
  { version: '1.0.1', date: '2026-01-01', features: [{ title: 'A', intro: 'a', howto: 'a' }] },
  { version: '1.0.2', date: '2026-01-02', features: [] },
  { version: '1.1.0', date: '2026-01-03', features: [{ title: 'B', intro: 'b', howto: 'b' }, { title: 'C', intro: 'c', howto: 'c' }] },
  { version: '1.2.0', date: '2026-01-04', features: [{ title: 'D', intro: 'd', howto: 'd' }] },
];

describe('更新說明資料', () => {
  it('★ 目前版本一定要有一筆（每次發佈都要新增；沒有新功能就寫 features: []）', () => {
    expect(RELEASE_NOTES.some((n) => n.version === pkg.version), `releaseNotes.ts 還沒有 v${pkg.version} 這一版`).toBe(true);
  });
  it('版本不重複、由新到舊、不晚於目前版本；每個功能都有標題、介紹與用法', () => {
    const vs = RELEASE_NOTES.map((n) => n.version);
    expect(new Set(vs).size).toBe(vs.length);
    expect([...vs].sort((a, b) => cmpVersion(b, a))).toEqual(vs);
    expect(cmpVersion(vs[0], pkg.version)).toBeLessThanOrEqual(0);
    for (const n of RELEASE_NOTES) for (const f of n.features) expect(f.title.trim() && f.intro.trim() && f.howto.trim(), `${n.version} ${f.title}`).toBeTruthy();
  });
});

describe('featuresBetween：從舊版到新版中途所有功能', () => {
  it('★ 不是只有最新一版：舊版 1.0.0 → 1.2.0 會拿到中間每一版，新的在前', () => {
    const r = featuresBetween('1.0.0', '1.2.0', N);
    expect(r.map((x) => `${x.version} ${x.title}`)).toEqual(['1.2.0 D', '1.1.0 B', '1.1.0 C', '1.0.1 A']);
  });
  it('不含「上次看過的那一版」本身，含目前版本；超過目前版本的不算', () => {
    expect(featuresBetween('1.0.1', '1.1.0', N).map((x) => x.title)).toEqual(['B', 'C']);
    expect(featuresBetween('1.0.0', '1.1.0', N).map((x) => x.version)).not.toContain('1.2.0');
    expect(featuresBetween('1.2.0', '1.2.0', N)).toEqual([]);
  });
  it('每一項帶著它是哪一版、哪天更新的', () => {
    const [d] = featuresBetween('1.1.0', '1.2.0', N);
    expect(d).toMatchObject({ version: '1.2.0', date: '2026-01-04', title: 'D' });
  });
  it('版本號用數字比較（1.10.0 比 1.9.0 新）', () => {
    expect(cmpVersion('1.10.0', '1.9.0')).toBeGreaterThan(0);
  });
});

describe('planWhatsNew：什麼時候跳視窗', () => {
  const store = () => { const m = new Map<string, string>(); return { m, read: () => m.get('k') ?? null, write: (v: string) => { m.set('k', v); } }; };
  it('★ 全新安裝（沒做完首次引導）不跳，直接記下版本', () => {
    const s = store();
    expect(planWhatsNew({ current: pkg.version, onboarded: false, read: s.read, write: s.write })).toBeNull();
    expect(s.m.get('k')).toBe(pkg.version);
  });
  it('★ 已在用的使用者、有舊版紀錄 → 列出舊版到現在的所有功能；還沒按「知道了」前不改紀錄', () => {
    const s = store(); s.m.set('k', '4.1.8');
    const p = planWhatsNew({ current: pkg.version, onboarded: true, read: s.read, write: s.write })!;
    expect(p.seen).toBe('4.1.8');
    const versions = new Set(p.items.map((i) => i.version));
    expect(versions.has('4.1.9') && versions.has('4.1.12') && versions.has('4.1.14') && versions.has('4.1.15') && versions.has('4.1.16')).toBe(true);
    expect(versions.has('4.1.8')).toBe(false);
    expect(s.m.get('k')).toBe('4.1.8');
  });
  it('沒有任何紀錄的既有使用者，視為從機制上線前的最後一版更新上來', () => {
    const s = store();
    const p = planWhatsNew({ current: pkg.version, onboarded: true, read: s.read, write: s.write })!;
    expect(p.seen).toBe(LEGACY_BASELINE);
    expect(p.items.every((i) => cmpVersion(i.version, LEGACY_BASELINE) > 0)).toBe(true);
  });
  it('已經是最新、或這段更新只有小修正（沒有新功能）→ 不跳；小修正會靜默記下版本', () => {
    const a = store(); a.m.set('k', pkg.version);
    expect(planWhatsNew({ current: pkg.version, onboarded: true, read: a.read, write: a.write })).toBeNull();
    const b = store(); b.m.set('k', '4.1.13'); // 4.1.13 沒有新功能，但到 4.1.14 有；改用「已在 4.1.14、目前也 4.1.14」之外的情境：目前版本為 4.1.13
    expect(planWhatsNew({ current: '4.1.13', onboarded: true, read: b.read, write: b.write })).toBeNull();
    const c = store(); c.m.set('k', '4.1.12');
    expect(planWhatsNew({ current: '4.1.13', onboarded: true, read: c.read, write: c.write })).toBeNull();
    expect(c.m.get('k')).toBe('4.1.13');
  });
});

describe('需要你看一下：隱藏後只有「新的」才會再出現', () => {
  it('量變大才算新的：收件匣 3 筆隱藏後，仍是 3 筆或變少不出現，變 4 筆才出現；沒隱藏過的項目都算新的', () => {
    const hidden = { inbox: 3, anomaly: 2 };
    expect(isNewAttention(hidden, 'inbox', 3)).toBe(false);
    expect(isNewAttention(hidden, 'inbox', 2)).toBe(false);
    expect(isNewAttention(hidden, 'inbox', 4)).toBe(true);
    expect(isNewAttention(hidden, 'anomaly', 3)).toBe(true);
    expect(isNewAttention(hidden, 'budget:x', 1)).toBe(true);
    expect(isNewAttention({ 'budget:x': 1 }, 'budget:x', 1)).toBe(false);
  });
});
