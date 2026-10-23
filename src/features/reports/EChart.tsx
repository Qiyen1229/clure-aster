/**
 * ECharts 封裝：按需引入（tree-shaking）、跟隨深淺色與主題色、自動 resize、點擊事件、
 * 進場動畫（尊重 prefers-reduced-motion）。此檔只在報表相關頁面被動態載入，不影響首屏。
 */
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';
import { useSettings } from '@/stores/settings';
import { chartTheme } from './chart-theme';
export { chartTheme };

echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, CanvasRenderer]);

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function EChart({ option, height = 240, onClick, ariaLabel }: {
  option: EChartsCoreOption; height?: number; onClick?: (p: { name: string; dataIndex: number; seriesIndex: number; data: any }) => void; ariaLabel: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const theme = useSettings((s) => `${s.theme}-${s.accent}-${s.upColor}`);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;

  useEffect(() => {
    if (!el.current) return;
    const c = echarts.init(el.current, undefined, { renderer: 'canvas' });
    chart.current = c;
    c.on('click', (p: any) => clickRef.current?.(p));
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el.current);
    return () => { ro.disconnect(); c.dispose(); chart.current = null; };
  }, []);

  useEffect(() => {
    const t = chartTheme();
    chart.current?.setOption({
      animation: !reduced(),
      animationDuration: 700,
      animationEasing: 'cubicOut',
      textStyle: { fontFamily: t.font, color: t.text2 },
      tooltip: { backgroundColor: t.surface, borderColor: t.sep, textStyle: { color: t.text }, confine: true },
      ...option,
    }, true);
  }, [option, theme]);

  return <div ref={el} style={{ width: '100%', height }} role="img" aria-label={ariaLabel} />;
}

export default EChart;
