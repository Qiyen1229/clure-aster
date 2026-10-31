import { describe, expect, it } from 'vitest';
import { drawSchedule, invoiceDigits, matchInvoice, parsePrizeRss, periodLabel, periodOf, periodRange, type PrizeDraw } from '@/domain/invoice-prize';

const draw: PrizeDraw = { period: '2026-07', label: '', special: '89996565', grand: '91098182', firsts: ['54348835', '44991397', '06595111'], extraSixth: [] };

describe('統一發票對獎', () => {
  it('期別：單雙月合併，標籤用民國年', () => {
    expect(periodOf('2026-07-15')).toBe('2026-07');
    expect(periodOf('2026-08-31')).toBe('2026-07');
    expect(periodOf('2026-01-01')).toBe('2026-01');
    expect(periodOf('2026-12-31')).toBe('2026-11');
    expect(periodLabel('2026-07')).toBe('115 年 07～08 月');
    expect(periodRange('2026-07')).toEqual({ start: '2026-07-01', end: '2026-08-31' });
    expect(periodRange('2028-01')).toEqual({ start: '2028-01-01', end: '2028-02-29' });
  });
  it('開獎日與領獎期間', () => {
    expect(drawSchedule('2026-07')).toEqual({ drawDate: '2026-09-25', claimFrom: '2026-10-06', claimTo: '2027-01-05' });
    expect(drawSchedule('2026-11')).toEqual({ drawDate: '2027-01-25', claimFrom: '2027-02-06', claimTo: '2027-05-05' });
  });
  it('號碼取末 8 碼數字，接受橫線', () => {
    expect(invoiceDigits('AB12345678')).toBe('12345678');
    expect(invoiceDigits('AB-12345678')).toBe('12345678');
    expect(invoiceDigits('1234567')).toBe('');
  });
  it('特別獎、特獎、頭獎：8 碼全中', () => {
    expect(matchInvoice('AB89996565', draw)?.level).toBe('special');
    expect(matchInvoice('CD91098182', draw)?.level).toBe('grand');
    const h = matchInvoice('EF44991397', draw);
    expect(h?.level).toBe('first');
    expect(h?.amount).toBe(200_000);
  });
  it('二獎～六獎：與頭獎號碼末 7～3 碼相同', () => {
    expect(matchInvoice('XX14348835', draw)?.level).toBe('second'); // 與 54348835 末 7 碼相同
    expect(matchInvoice('XX12348835', draw)?.level).toBe('third'); // 末 6 碼
    expect(matchInvoice('XX00048835', draw)?.level).toBe('fourth'); // 末 5 碼
    expect(matchInvoice('XX11118835', draw)?.level).toBe('fifth'); // 末 4 碼
    expect(matchInvoice('XX11111835', draw)?.level).toBe('sixth'); // 末 3 碼
    expect(matchInvoice('XX11111834', draw)).toBeNull();
    expect(matchInvoice('XX11111835', draw)?.amount).toBe(200);
  });
  it('多組頭獎號碼時取最高獎', () => {
    const d: PrizeDraw = { ...draw, firsts: ['11111111', '22222222'] };
    expect(matchInvoice('AA99911111', d)?.level).toBe('fourth'); // 末 5 碼 11111 與第一組相同
    expect(matchInvoice('AA99922222', d)?.amount).toBe(4000);
  });
  it('增開六獎：末 3 碼，金額 200', () => {
    expect(matchInvoice('ZZ00000123', draw)).toBeNull();
    const h = matchInvoice('ZZ00000123', draw, ['123']);
    expect(h?.level).toBe('extraSixth');
    expect(h?.amount).toBe(200);
  });
  it('解析財政部 RSS', () => {
    const xml = `<rss><channel><item><title><![CDATA[115年 07~08月]]></title><description><![CDATA[<p>特別獎：89996565</p><p>特獎：91098182</p><p>頭獎：54348835、44991397、06595111</p>]]></description></item>
<item><title><![CDATA[115年 05~06月]]></title><description><![CDATA[<p>特別獎：38548029</p><p>特獎：10138845</p><p>頭獎：24121106、28589937、83663333</p><p>增開六獎：123、456</p>]]></description></item></channel></rss>`;
    const r = parsePrizeRss(xml);
    expect(r.map((x) => x.period)).toEqual(['2026-07', '2026-05']);
    expect(r[0]).toMatchObject({ special: '89996565', grand: '91098182', firsts: ['54348835', '44991397', '06595111'], extraSixth: [] });
    expect(r[1].extraSixth).toEqual(['123', '456']);
    expect(parsePrizeRss('<rss></rss>')).toEqual([]);
  });
});
