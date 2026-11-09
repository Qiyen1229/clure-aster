/**
 * 功能介紹（首次引導）的規則：固定 6 個、包含指定的幾招、依分數自動排名，
 * 而且「每次發佈都要檢查」——版本號改了、release.json 的 showcaseReviewed 沒跟著改，這裡就會失敗。
 */
import { describe, expect, it } from 'vitest';
import pkg from '../../package.json';
import rel from '@/release.json';
import { CANDIDATES, SHOWCASE, SHOWCASE_SIZE, compareVersion, pickShowcase, scoreOf, type ShowcaseFeature } from '@/features/onboarding/showcase';

const mk = (id: string, power: number, novelty: number, since = '1.0.0'): ShowcaseFeature => ({
  id, icon: 'ai', title: id, pitch: 'p', bullets: ['a', 'b', 'c'], howto: 'h', since, power, novelty,
});

describe('功能介紹：名單', () => {
  it('★ 剛好 6 個，id 不重複，必備的幾招都在（自動記帳、語音記帳、AI 上滑對話）', () => {
    expect(SHOWCASE).toHaveLength(SHOWCASE_SIZE);
    expect(new Set(CANDIDATES.map((c) => c.id)).size).toBe(CANDIDATES.length);
    const ids = SHOWCASE.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['auto-record', 'voice', 'ai-chat']));
  });
  it('候選資料合理：分數 1～5、版本格式正確且不晚於目前版本、文字不是空的', () => {
    for (const f of CANDIDATES) {
      expect(f.power >= 1 && f.power <= 5 && f.novelty >= 1 && f.novelty <= 5, f.id).toBe(true);
      expect(f.since).toMatch(/^\d+\.\d+\.\d+$/);
      expect(compareVersion(f.since, pkg.version), `${f.id} 的 since 不能晚於目前版本`).toBeLessThanOrEqual(0);
      expect(f.title && f.pitch && f.howto).toBeTruthy();
      expect(f.bullets.every((b) => b.trim().length > 0)).toBe(true);
    }
  });
  it('依分數排名：新功能分數夠高就自動擠掉第 6 名；不夠高進不來；同分較新的優先', () => {
    const base = Array.from({ length: 6 }, (_, i) => mk(`f${i}`, 4, 3)); // 都是 11 分
    const strong = mk('new-strong', 5, 5, '9.0.0'); // 15 分
    const weak = mk('new-weak', 2, 2, '9.0.0'); // 6 分
    expect(pickShowcase([...base, strong]).map((f) => f.id)).toContain('new-strong');
    expect(pickShowcase([...base, strong])).toHaveLength(6);
    expect(pickShowcase([...base, weak]).map((f) => f.id)).not.toContain('new-weak');
    const tie = mk('tie-newer', 4, 3, '9.0.0');
    expect(pickShowcase([...base, tie]).map((f) => f.id)).toContain('tie-newer'); // 同分：版本較新的先進
    expect(scoreOf(strong)).toBe(15);
  });
});

describe('功能介紹：每次發佈都要檢查', () => {
  it('★ release.json 的 showcaseReviewed 必須等於目前版本號（改版本時順便檢查新功能有沒有資格進功能介紹）', () => {
    expect(rel.showcaseReviewed, '版本號變了：請檢查這版的新功能是否該加進 showcase.ts 的 CANDIDATES，再把 release.json 的 showcaseReviewed 改成同一版').toBe(pkg.version);
  });
  it('featureRelease 不會比目前版本新', () => {
    expect(compareVersion(rel.featureRelease, pkg.version)).toBeLessThanOrEqual(0);
  });
});
