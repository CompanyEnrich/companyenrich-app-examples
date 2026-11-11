'use client';

import { useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import type { PeerPoint } from '@/lib/benchmark';
import type { LinearScale } from '@/lib/scale';
import { percentileRank } from '@/lib/stats';

export interface DotPlotRow {
  key: string;
  label: string;
  subject: number | null;
  /** Why the subject has no value here, for the tooltip and table. */
  subjectNote?: string;
  median: number | null;
  peers: PeerPoint[];
  /** Draw a hairline above this row to set it apart. */
  divider?: boolean;
}

interface Props {
  title: string;
  description: ReactNode;
  subjectName: string;
  rows: DotPlotRow[];
  scale: LinearScale;
  format: (value: number) => string;
  /** Draw the zero line stronger than the grid (for growth). */
  zeroLine?: boolean;
}

const GRID = 'grid grid-cols-[5.5rem_minmax(0,1fr)_3.25rem] items-center gap-x-3 sm:grid-cols-[8.5rem_minmax(0,1fr)_4rem]';

/**
 * One row per category: the subject as a blue dot, the peer median as a dark
 * tick, and every peer as a faint gray dot. Hovering or focusing a row shows
 * all of its values; "Show table" gives the same numbers without hovering.
 */
export function DotPlot({ title, description, subjectName, rows, scale, format, zeroLine }: Props) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const peerCount = Math.max(0, ...rows.map((row) => row.peers.length));
  const anyClamped = rows.some((row) =>
    [row.subject, row.median, ...row.peers.map((peer) => peer.value)].some(
      (value) => value !== null && scale.isClamped(value),
    ),
  );

  return (
    <figure className="rounded-xl border border-line bg-surface p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <figcaption className="font-semibold">{title}</figcaption>
          <p className="mt-1 text-sm text-ink-2">{description}</p>
        </div>
        <button
          type="button"
          onClick={() => setView(view === 'chart' ? 'table' : 'chart')}
          className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-sm text-ink-2 hover:text-ink"
        >
          {view === 'chart' ? 'Show table' : 'Show chart'}
        </button>
      </div>

      <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-2">
        <li className="flex items-center gap-2">
          <span aria-hidden className="size-3 rounded-full bg-accent" />
          {subjectName}
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden className="h-4 w-[3px] rounded-sm bg-ink-2" />
          Peer median
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden className="size-2 rounded-full bg-muted/70" />
          Each peer ({peerCount})
        </li>
        {anyClamped && (
          <li className="flex items-center gap-2">
            <span aria-hidden className="size-2.5 bg-muted [clip-path:polygon(0_0,100%_50%,0_100%)]" />
            Past the axis edge
          </li>
        )}
      </ul>

      {view === 'chart' ? (
        <Plot rows={rows} scale={scale} format={format} zeroLine={zeroLine} subjectName={subjectName} />
      ) : (
        <PlotTable rows={rows} format={format} subjectName={subjectName} />
      )}
    </figure>
  );
}

interface Hover {
  key: string;
  x: number;
  y: number;
}

function Plot({ rows, scale, format, zeroLine, subjectName }: Omit<Props, 'title' | 'description'>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  function track(row: DotPlotRow, event: PointerEvent<HTMLDivElement>) {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;
    const target = event.currentTarget;
    setHover({ key: row.key, x: event.clientX - box.left, y: target.offsetTop + target.offsetHeight });
  }

  function focusRow(row: DotPlotRow, target: HTMLDivElement) {
    const anchor = row.subject ?? row.median ?? scale.min;
    const x = target.offsetLeft + (scale.position(anchor) / 100) * target.offsetWidth;
    setHover({ key: row.key, x, y: target.offsetTop + target.offsetHeight });
  }

  const hovered = rows.find((row) => row.key === hover?.key);

  return (
    <div ref={containerRef} className="relative mt-3" onPointerLeave={() => setHover(null)}>
      {rows.map((row) => (
        <div key={row.key} className={`${GRID} ${row.divider ? 'mt-2 border-t border-line pt-2' : ''}`}>
          <div className="truncate text-sm text-ink-2" title={row.label}>
            {row.label}
          </div>
          <div
            role="img"
            tabIndex={0}
            aria-label={describeRow(row, subjectName, format)}
            onPointerMove={(event) => track(row, event)}
            onPointerDown={(event) => track(row, event)}
            onFocus={(event) => focusRow(row, event.currentTarget)}
            onBlur={() => setHover(null)}
            className={`relative h-9 rounded outline-none focus-visible:ring-2 focus-visible:ring-accent ${hover?.key === row.key ? 'bg-accent-wash' : ''}`}
          >
            {scale.ticks.map((tick) => (
              <span
                key={tick}
                aria-hidden
                className={`absolute inset-y-0 w-px ${zeroLine && tick === 0 ? 'bg-axis' : 'bg-grid'}`}
                style={{ left: `${scale.position(tick)}%` }}
              />
            ))}
            <Marks row={row} scale={scale} />
          </div>
          <div className="text-right text-sm font-medium tabular-nums">
            {row.subject === null ? <span className="font-normal text-muted">n/a</span> : format(row.subject)}
          </div>
        </div>
      ))}

      <div className={`${GRID} mt-1`} aria-hidden>
        <div />
        <div className="relative h-5">
          {scale.ticks.map((tick) => (
            <span
              key={tick}
              className="absolute -translate-x-1/2 text-xs text-muted tabular-nums"
              style={{ left: `${scale.position(tick)}%` }}
            >
              {format(tick)}
            </span>
          ))}
        </div>
        <div />
      </div>

      {hover && hovered && (
        <Tooltip row={hovered} hover={hover} format={format} subjectName={subjectName} width={containerRef.current?.offsetWidth ?? 320} />
      )}
    </div>
  );
}

/** Position style for a mark centered at `value`; a value past the axis sits at the edge as an arrow. */
function at(scale: LinearScale, value: number): { style: CSSProperties; clampedClass: string } {
  const clamped = scale.isClamped(value);
  const pointsRight = value > scale.max;
  return {
    style: { left: `${scale.position(value)}%` },
    clampedClass: clamped
      ? pointsRight
        ? '[clip-path:polygon(0_0,100%_50%,0_100%)] rounded-none'
        : '[clip-path:polygon(100%_0,0_50%,100%_100%)] rounded-none'
      : '',
  };
}

function Marks({ row, scale }: { row: DotPlotRow; scale: LinearScale }) {
  const { subject, median } = row;
  return (
    <>
      {subject !== null && median !== null && (
        <span
          aria-hidden
          className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-accent/40"
          style={{
            left: `${Math.min(scale.position(subject), scale.position(median))}%`,
            width: `${Math.abs(scale.position(subject) - scale.position(median))}%`,
          }}
        />
      )}
      {row.peers.map((peer) => {
        const mark = at(scale, peer.value);
        return (
          <span
            key={peer.domain}
            aria-hidden
            className={`absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted/70 ring-2 ring-surface ${mark.clampedClass}`}
            style={mark.style}
          />
        );
      })}
      {median !== null && (
        <span
          aria-hidden
          className="absolute top-1/2 h-[18px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-sm bg-ink-2"
          style={at(scale, median).style}
        />
      )}
      {subject !== null && (
        <span
          aria-hidden
          className={`absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-surface ${at(scale, subject).clampedClass}`}
          style={at(scale, subject).style}
        />
      )}
    </>
  );
}

function describeRow(row: DotPlotRow, subjectName: string, format: (value: number) => string): string {
  const parts = [`${row.label}: ${subjectName} ${row.subject === null ? 'n/a' : format(row.subject)}`];
  if (row.median !== null) parts.push(`peer median ${format(row.median)}`);
  if (row.peers.length > 0) {
    const values = row.peers.map((peer) => peer.value);
    parts.push(`peers from ${format(Math.min(...values))} to ${format(Math.max(...values))}`);
  }
  return parts.join(', ');
}

function Tooltip({
  row,
  hover,
  format,
  subjectName,
  width,
}: {
  row: DotPlotRow;
  hover: Hover;
  format: (value: number) => string;
  subjectName: string;
  width: number;
}) {
  const TOOLTIP_WIDTH = 240;
  const left = Math.max(0, Math.min(width - TOOLTIP_WIDTH, hover.x - TOOLTIP_WIDTH / 2));
  const peers = [...row.peers].sort((a, b) => b.value - a.value);

  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 rounded-lg border border-line bg-surface p-3 text-sm shadow-lg"
      style={{ left, top: hover.y + 4, width: TOOLTIP_WIDTH }}
    >
      <p className="mb-2 text-xs font-medium text-ink-2">{row.label}</p>
      <ul className="space-y-1">
        <TooltipRow keyClass="bg-accent" value={row.subject === null ? 'n/a' : format(row.subject)} name={subjectName} />
        {row.subject === null && row.subjectNote && <li className="pl-5 text-xs text-muted">{row.subjectNote}</li>}
        {row.median !== null && <TooltipRow keyClass="bg-ink-2" value={format(row.median)} name="Peer median" />}
        {peers.map((peer) => (
          <TooltipRow key={peer.domain} keyClass="bg-muted/70" value={format(peer.value)} name={peer.name} faint />
        ))}
      </ul>
    </div>
  );
}

function TooltipRow({ keyClass, value, name, faint }: { keyClass: string; value: string; name: string; faint?: boolean }) {
  return (
    <li className="flex items-center gap-2">
      <span aria-hidden className={`h-0.5 w-3 shrink-0 rounded ${keyClass}`} />
      <strong className={`tabular-nums ${faint ? 'font-medium' : 'font-semibold'}`}>{value}</strong>
      <span className="truncate text-ink-2">{name}</span>
    </li>
  );
}

/** The chart's table twin: every value, readable without hovering. */
function PlotTable({ rows, format, subjectName }: { rows: DotPlotRow[]; format: (value: number) => string; subjectName: string }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[32rem] text-sm">
        <thead className="text-left text-ink-2">
          <tr className="border-b border-line">
            <th className="py-2 pr-3 font-medium" />
            <th className="py-2 pr-3 text-right font-medium">{subjectName}</th>
            <th className="py-2 pr-3 text-right font-medium">Peer median</th>
            <th className="py-2 pr-3 text-right font-medium">Peer range</th>
            <th className="py-2 text-right font-medium">Rank among peers</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((row) => {
            const values = row.peers.map((peer) => peer.value);
            const rank = row.subject === null ? null : percentileRank(row.subject, values);
            return (
              <tr key={row.key} className="border-b border-line last:border-0">
                <th scope="row" className="py-2 pr-3 text-left font-normal text-ink-2">
                  {row.label}
                </th>
                <td className="py-2 pr-3 text-right font-medium">
                  {row.subject === null ? <span className="font-normal text-muted">{row.subjectNote ?? 'n/a'}</span> : format(row.subject)}
                </td>
                <td className="py-2 pr-3 text-right">{row.median === null ? '–' : format(row.median)}</td>
                <td className="py-2 pr-3 text-right">
                  {values.length === 0 ? '–' : `${format(Math.min(...values))} to ${format(Math.max(...values))}`}
                </td>
                <td className="py-2 text-right">{rank ? `above ${rank.below} of ${rank.total}` : '–'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
