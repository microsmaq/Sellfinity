import type { DayPoint } from "@/lib/orders/stats";
import { formatCents } from "@/lib/money";

const W = 960;
const H = 260;
const LEFT = 8;
const RIGHT = 8;
const TOP = 14;
const BOTTOM = 34;

/** Responsive revenue bars with a net-profit trend line. */
export function ProfitChart({ points }: { points: DayPoint[] }) {
  const plotHeight = H - TOP - BOTTOM;
  const plotWidth = W - LEFT - RIGHT;
  const maxRevenue = Math.max(...points.map((point) => point.revenueCents), 1);
  const minNet = Math.min(0, ...points.map((point) => point.netCents));
  const maxNet = Math.max(0, ...points.map((point) => point.netCents));
  const netRange = Math.max(maxNet - minNet, 1);
  const step = plotWidth / Math.max(points.length - 1, 1);
  const barWidth = Math.max(5, (plotWidth / Math.max(points.length, 1)) * 0.52);
  const yForNet = (value: number) => TOP + ((maxNet - value) / netRange) * plotHeight;
  const zeroY = yForNet(0);
  const linePoints = points
    .map((point, index) => `${LEFT + index * step},${yForNet(point.netCents)}`)
    .join(" ");
  const labelIndexes = new Set([0, 7, 14, 21, points.length - 1].filter((index) => index >= 0 && index < points.length));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full overflow-visible"
      role="img"
      aria-label="Revenue bars and daily net profit trend for the last 30 days"
    >
      <defs>
        <linearGradient id="profitLine" x1="0" x2="1">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="1" stopColor="#14b8a6" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((ratio) => (
        <line key={ratio} x1={LEFT} x2={W - RIGHT} y1={TOP + plotHeight * ratio} y2={TOP + plotHeight * ratio} stroke="#e2e8f0" strokeDasharray="4 7" />
      ))}
      <line x1={LEFT} x2={W - RIGHT} y1={zeroY} y2={zeroY} stroke="#94a3b8" strokeWidth="1.2" />
      {points.map((point, index) => {
        const x = LEFT + index * step;
        const revenueHeight = (point.revenueCents / maxRevenue) * plotHeight;
        return (
          <g key={point.date}>
            <title>{`${point.date}: ${formatCents(point.revenueCents)} revenue, ${formatCents(point.netCents)} net profit`}</title>
            <rect
              x={x - barWidth / 2}
              y={TOP + plotHeight - revenueHeight}
              width={barWidth}
              height={revenueHeight}
              rx={3}
              fill="#c7d2fe"
              opacity="0.6"
            />
            {labelIndexes.has(index) && (
              <text x={x} y={H - 8} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} fontSize="21" fill="#64748b">
                {new Date(`${point.date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
              </text>
            )}
          </g>
        );
      })}
      <polyline points={linePoints} fill="none" stroke="url(#profitLine)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((point, index) =>
        (index === points.length - 1 || index % 7 === 0) ? (
          <circle key={point.date} cx={LEFT + index * step} cy={yForNet(point.netCents)} r="5" fill="white" stroke={point.netCents >= 0 ? "#4f46e5" : "#ef4444"} strokeWidth="3" />
        ) : null,
      )}
    </svg>
  );
}
