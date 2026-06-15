import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, Trash2, X } from 'lucide-react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

import { parsePlotLine, SerialPlotLineBuffer } from '@/lib/serialPlotParser';
import type { ResolvedTheme } from '@/lib/uiPreferences';
import type { SerialMonitorDataEvent } from '@/types/electron';

type SerialPlotterPopupProps = {
  open: boolean;
  onClose: () => void;
  sessionId: string | null;
  connected: boolean;
  port: string;
  baudRate: number;
  resolvedTheme: ResolvedTheme;
};

type PlotBuffers = {
  x: number[];
  ys: number[][];
  channelCount: number;
};

const MAX_POINTS = 1000;

const SERIES_COLORS_DARK = ['#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8', '#4db6ac', '#fff176', '#90a4ae'];
const SERIES_COLORS_LIGHT = ['#0277bd', '#2e7d32', '#ef6c00', '#c62828', '#6a1b9a', '#00695c', '#f9a825', '#546e7a'];

function createEmptyBuffers(channelCount = 1): PlotBuffers {
  return {
    x: [],
    ys: Array.from({ length: Math.max(1, channelCount) }, () => []),
    channelCount: Math.max(1, channelCount),
  };
}

function trimBuffers(buffers: PlotBuffers) {
  if (buffers.x.length <= MAX_POINTS) {
    return;
  }

  const overflow = buffers.x.length - MAX_POINTS;
  buffers.x = buffers.x.slice(overflow);
  buffers.ys = buffers.ys.map((series) => series.slice(overflow));
}

function appendSample(buffers: PlotBuffers, values: number[]) {
  const nextChannelCount = Math.max(buffers.channelCount, values.length, 1);

  if (nextChannelCount > buffers.channelCount) {
    for (let index = buffers.ys.length; index < nextChannelCount; index += 1) {
      const seed = buffers.ys[0]?.length ?? 0;
      buffers.ys.push(Array.from({ length: seed }, () => Number.NaN));
    }
    buffers.channelCount = nextChannelCount;
  }

  const sampleIndex = buffers.x.length > 0 ? (buffers.x[buffers.x.length - 1] ?? 0) + 1 : 0;
  buffers.x.push(sampleIndex);

  for (let index = 0; index < buffers.channelCount; index += 1) {
    const series = buffers.ys[index];
    if (!series) {
      continue;
    }
    series.push(index < values.length ? values[index] : Number.NaN);
  }

  trimBuffers(buffers);
}

function buffersToPlotData(buffers: PlotBuffers): uPlot.AlignedData {
  const aligned: uPlot.AlignedData = [buffers.x.length > 0 ? buffers.x : [0]];
  for (let index = 0; index < buffers.channelCount; index += 1) {
    const series = buffers.ys[index];
    aligned.push(series && series.length > 0 ? series : [Number.NaN]);
  }
  return aligned;
}

function plotTheme(resolvedTheme: ResolvedTheme) {
  const isDark = resolvedTheme === 'dark';
  return {
    colors: isDark ? SERIES_COLORS_DARK : SERIES_COLORS_LIGHT,
    axis: isDark ? '#858585' : '#6b6b6b',
    grid: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.08)',
    background: 'transparent',
  };
}

function buildPlotOptions(width: number, height: number, channelCount: number, resolvedTheme: ResolvedTheme): uPlot.Options {
  const theme = plotTheme(resolvedTheme);

  return {
    width,
    height,
    cursor: { show: true },
    legend: { show: false },
    scales: {
      x: { time: false },
      y: { auto: true },
    },
    axes: [
      {
        stroke: theme.axis,
        grid: { stroke: theme.grid },
        ticks: { stroke: theme.grid },
      },
      {
        stroke: theme.axis,
        grid: { stroke: theme.grid },
        ticks: { stroke: theme.grid },
      },
    ],
    series: [
      {},
      ...Array.from({ length: channelCount }, (_, index) => ({
        stroke: theme.colors[index % theme.colors.length],
        width: 2,
        spanGaps: true,
      })),
    ],
  };
}

export function SerialPlotterPopup({
  open,
  onClose,
  sessionId,
  connected,
  port,
  baudRate,
  resolvedTheme,
}: SerialPlotterPopupProps) {
  const chartHostRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const buffersRef = useRef<PlotBuffers>(createEmptyBuffers());
  const lineBufferRef = useRef(new SerialPlotLineBuffer());
  const pausedRef = useRef(false);
  const openRef = useRef(open);
  const sessionIdRef = useRef(sessionId);
  const resolvedThemeRef = useRef(resolvedTheme);
  const pendingFrameRef = useRef<number | null>(null);
  const pendingLatestValuesRef = useRef<number[] | null>(null);
  const plotChannelCountRef = useRef(1);
  const plotThemeRef = useRef(resolvedTheme);

  const [paused, setPaused] = useState(false);
  const [latestValues, setLatestValues] = useState<number[]>([]);
  const [channelCount, setChannelCount] = useState(1);

  const cancelPendingPlotUpdate = useCallback(() => {
    if (pendingFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingFrameRef.current);
      pendingFrameRef.current = null;
    }
  }, []);

  const destroyPlot = useCallback(() => {
    cancelPendingPlotUpdate();
    if (plotRef.current) {
      plotRef.current.destroy();
      plotRef.current = null;
    }

    const host = chartHostRef.current;
    while (host?.firstChild) {
      host.removeChild(host.firstChild);
    }
  }, [cancelPendingPlotUpdate]);

  const syncPlotData = useCallback(() => {
    const plot = plotRef.current;
    if (!plot) {
      return;
    }

    plot.setData(buffersToPlotData(buffersRef.current));
  }, []);

  const readChartSize = useCallback(() => {
    const host = chartHostRef.current;
    if (!host) {
      return null;
    }

    return {
      width: Math.max(320, Math.floor(host.clientWidth)),
      height: Math.max(240, Math.floor(host.clientHeight)),
    };
  }, []);

  const ensurePlot = useCallback((forceRecreate = false) => {
    const host = chartHostRef.current;
    const size = readChartSize();
    if (!host || !size || !openRef.current) {
      return;
    }

    const nextChannelCount = buffersRef.current.channelCount;
    const nextTheme = resolvedThemeRef.current;
    const needsRecreate =
      forceRecreate ||
      !plotRef.current ||
      plotChannelCountRef.current !== nextChannelCount ||
      plotThemeRef.current !== nextTheme;

    if (needsRecreate) {
      destroyPlot();
      while (host.firstChild) {
        host.removeChild(host.firstChild);
      }

      plotRef.current = new uPlot(
        buildPlotOptions(size.width, size.height, nextChannelCount, nextTheme),
        buffersToPlotData(buffersRef.current),
        host,
      );
      plotChannelCountRef.current = nextChannelCount;
      plotThemeRef.current = nextTheme;
      return;
    }

    const plot = plotRef.current;
    if (!plot) {
      return;
    }

    if (plot.width !== size.width || plot.height !== size.height) {
      plot.setSize(size);
    }
  }, [destroyPlot, readChartSize]);

  const schedulePlotUpdate = useCallback(() => {
    if (pendingFrameRef.current !== null) {
      return;
    }

    pendingFrameRef.current = window.requestAnimationFrame(() => {
      pendingFrameRef.current = null;
      if (!openRef.current) {
        return;
      }

      const nextChannelCount = buffersRef.current.channelCount;
      setChannelCount((current) => (current === nextChannelCount ? current : nextChannelCount));
      if (pendingLatestValuesRef.current) {
        const nextLatestValues = pendingLatestValuesRef.current;
        pendingLatestValuesRef.current = null;
        setLatestValues(nextLatestValues);
      }

      ensurePlot(plotChannelCountRef.current !== nextChannelCount);
      syncPlotData();
    });
  }, [ensurePlot, syncPlotData]);

  const handleIncomingData = useCallback((event: SerialMonitorDataEvent) => {
    if (!sessionIdRef.current || event.sessionId !== sessionIdRef.current || pausedRef.current) {
      return;
    }

    const lines = lineBufferRef.current.append(event.data);
    let updated = false;

    for (const line of lines) {
      const values = parsePlotLine(line);
      if (!values || values.length === 0) {
        continue;
      }

      appendSample(buffersRef.current, values);
      pendingLatestValuesRef.current = values;
      updated = true;
    }

    if (updated) {
      schedulePlotUpdate();
    }
  }, [schedulePlotUpdate]);

  const resetPlotData = useCallback(() => {
    buffersRef.current = createEmptyBuffers();
    lineBufferRef.current.clear();
    pendingLatestValuesRef.current = null;
    setChannelCount(1);
    setLatestValues([]);
  }, []);

  const clearPlot = useCallback(() => {
    resetPlotData();
    ensurePlot(true);
    schedulePlotUpdate();
  }, [ensurePlot, resetPlotData, schedulePlotUpdate]);

  const togglePaused = useCallback(() => {
    setPaused((current) => {
      const next = !current;
      pausedRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    resolvedThemeRef.current = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
    resetPlotData();
    if (open) {
      ensurePlot(true);
      schedulePlotUpdate();
    }
  }, [ensurePlot, open, resetPlotData, schedulePlotUpdate, sessionId]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const offData = window.tantalum.serialMonitor.onData((event) => {
      handleIncomingData(event);
    });

    return () => {
      offData();
    };
  }, [handleIncomingData, open]);

  useEffect(() => {
    if (!open) {
      destroyPlot();
      return;
    }

    ensurePlot();

    const host = chartHostRef.current;
    if (!host) {
      return;
    }

    const observer = new ResizeObserver(() => {
      ensurePlot();
      schedulePlotUpdate();
    });

    observer.observe(host);

    return () => {
      observer.disconnect();
      destroyPlot();
    };
  }, [destroyPlot, ensurePlot, open, resolvedTheme, schedulePlotUpdate]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  const theme = plotTheme(resolvedTheme);
  const statusText = connected && port ? `${port} @ ${baudRate}` : 'Not connected';

  return (
    <div className="serial-plotter-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="serial-plotter-dialog" role="dialog" aria-modal="true" aria-label="Serial Plotter">
        <div className="serial-plotter-head">
          <div className="serial-plotter-head-top">
            <strong className="serial-plotter-title">Serial Plotter</strong>
            <div className="serial-plotter-head-actions">
              <span className={`serial-plotter-status ${connected ? 'status-pill status-online' : 'status-pill'}`}>{statusText}</span>
              <button className={`ghost-button compact ${paused ? 'active' : ''}`} type="button" onClick={togglePaused} title={paused ? 'Resume plotting' : 'Pause plotting'}>
                {paused ? <Play size={14} /> : <Pause size={14} />}
                {paused ? 'Resume' : 'Pause'}
              </button>
              <button className="icon-button" type="button" onClick={clearPlot} title="Clear plot">
                <Trash2 size={16} />
              </button>
              <button className="icon-button" type="button" onClick={onClose} aria-label="Close Serial Plotter">
                <X size={16} />
              </button>
            </div>
          </div>
        </div>

        {!connected ? (
          <div className="inline-banner inline-banner-warning serial-plotter-notice">
            <span>Connect in Serial Monitor to start plotting.</span>
          </div>
        ) : null}

        <div className="serial-plotter-chart">
          <div className="serial-plotter-chart-host" ref={chartHostRef} />
        </div>

        <div className="serial-plotter-legend">
          {Array.from({ length: channelCount }, (_, index) => {
            const value = latestValues[index];
            const label = Number.isFinite(value) ? value.toString() : '—';
            return (
              <div key={index} className="serial-plotter-legend-item">
                <span className="serial-plotter-legend-swatch" style={{ backgroundColor: theme.colors[index % theme.colors.length] }} />
                <span className="serial-plotter-legend-label">Channel {index + 1}</span>
                <span className="serial-plotter-legend-value">{label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
