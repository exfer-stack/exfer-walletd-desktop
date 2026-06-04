// Candlestick price chart (TradingView's open-source lightweight-charts).
// Pan/zoom by drag is enabled by default. Desktop is dark-only, so the palette
// is fixed to the dark theme. Self-contained — pass `candles` and an optional
// `onHover` to receive the bar under the crosshair (like a TradingView legend).

import { useEffect, useRef } from "react";
import { createChart, ColorType, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { Candle } from "../lib/market";

export function PriceChart({
  candles,
  height = 200,
  timeVisible = false,
  onHover,
}: {
  candles: Candle[];
  height?: number;
  timeVisible?: boolean;
  /** Fires with the candle under the crosshair (null when the cursor leaves the
   *  plot) so the parent can show that bar's OHLC, like a TradingView legend. */
  onHover?: (c: Candle | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  // Keep the latest callback in a ref so the chart isn't recreated when the
  // parent passes a fresh closure each render.
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;

  // (Re)create the chart on sizing changes.
  useEffect(() => {
    if (!ref.current) return;
    // Fixed dark palette (desktop is dark-only).
    const grid = "rgba(255,255,255,0.05)";
    const border = "rgba(255,255,255,0.09)";
    const text = "#8b929c";
    const up = "#34d399";
    const down = "#f87171";

    const chart = createChart(ref.current, {
      width: ref.current.clientWidth,
      height,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: text, fontFamily: "inherit", fontSize: 11 },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      // Tighter margins give the price axis more room → more labeled levels.
      rightPriceScale: {
        borderColor: border,
        scaleMargins: { top: 0.08, bottom: 0.08 },
        ticksVisible: true,
        entireTextOnly: true,
      },
      timeScale: {
        borderColor: border,
        timeVisible,
        secondsVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        ticksVisible: true,
        minBarSpacing: 4,
      },
      // Magnet crosshair snaps to candles so the exact price/time reads cleanly.
      crosshair: { mode: 1 },
      handleScroll: true,
      handleScale: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false,
      priceFormat: { type: "price", precision: 6, minMove: 0.000001 },
      // Show the last-price line + label so the current level is always marked.
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineColor: border,
      priceLineWidth: 1,
    });
    chartRef.current = chart;
    seriesRef.current = series;

    // Report the hovered bar's OHLC to the parent (null when off the plot).
    chart.subscribeCrosshairMove((param) => {
      const cb = onHoverRef.current;
      if (!cb) return;
      const bar = (param.time && param.point ? param.seriesData.get(series) : undefined) as
        | { open?: number; high?: number; low?: number; close?: number }
        | undefined;
      if (bar && typeof bar.open === "number" && typeof bar.high === "number" && typeof bar.low === "number" && typeof bar.close === "number") {
        cb({ time: Number(param.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close });
      } else {
        cb(null);
      }
    });

    const ro = new ResizeObserver(() => {
      if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
    });
    ro.observe(ref.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [height, timeVisible]);

  // Push data whenever it changes.
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return;
    seriesRef.current.setData(
      candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  return <div ref={ref} style={{ width: "100%", height }} />;
}
