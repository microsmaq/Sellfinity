import type { DayPoint } from "@/lib/orders/stats";
import { formatCents } from "@/lib/money";

const W = 960;
const H = 200;
const PAD = 4;

/** Daily net-profit bar chart (SVG, server-rendered). */
export function ProfitChart({ points }: { points: DayPoint[] }) {
  const max = Math.max(...points.map((p) => Math.abs(p.netCents)), 1);
  const barW = (W - PAD * 2) / points.length;
  const zeroY = H / 2;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      role="img"
      aria-label="Daily net profit for the last 30 days"
    >
      <line x1={PAD} x2={W - PAD} y1={zeroY} y2={zeroY} stroke="#e2e8f0" />
      {points.map((p, i) => {
        const h = (Math.abs(p.netCents) / max) * (H / 2 - PAD);
        const x = PAD + i * barW;
        const positive = p.netCents >= 0;
        return (
          <g key={p.date}>
            <title>{`${p.date}: ${formatCents(p.netCents)} net (${formatCents(p.revenueCents)} revenue)`}</title>
            <rect
              x={x + barW * 0.15}
              width={barW * 0.7}
              y={positive ? zeroY - h : zeroY}
              height={Math.max(h, p.netCents === 0 ? 0 : 2)}
              rx={2}
              fill={positive ? "#10b981" : "#ef4444"}
              opacity={0.85}
            />
          </g>
        );
      })}
    </svg>
  );
}
