import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Dashboard as DashboardData } from "../../application/dashboard";
import { formatCents } from "../engine";
import { Card } from "./ui";

const COFRE = "#0E7C66";
const ENTRADA = "#1E9E6A";
const SAIDA = "#C0392B";
const INK_SOFT = "#5A6B75";
const LINE = "#D8E0E6";

const axis = { stroke: INK_SOFT, fontSize: 12, fontFamily: "Public Sans" };

export function Dashboard({ data }: { data: DashboardData }) {
  const rows = data.months.map((m) => ({
    mes: m.label.slice(0, 3),
    Entradas: m.entradaCents / 100,
    Saídas: m.saidaCents / 100,
    Saldo: m.cumulativeCents / 100,
  }));

  const tip = (v: number) => formatCents(Math.round(v * 100));

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card className="p-4">
        <h3 className="mb-3 font-display text-xs font-semibold uppercase tracking-wide text-ink-soft">
          Entradas × Saídas por competência
        </h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke={LINE} vertical={false} />
            <XAxis dataKey="mes" tick={axis} tickLine={false} axisLine={{ stroke: LINE }} />
            <YAxis tick={axis} tickLine={false} axisLine={false} width={40} />
            <Tooltip formatter={tip} contentStyle={{ fontFamily: "IBM Plex Mono", fontSize: 12 }} />
            <Legend wrapperStyle={{ fontFamily: "Public Sans", fontSize: 12 }} />
            <Bar dataKey="Entradas" fill={ENTRADA} radius={[3, 3, 0, 0]} />
            <Bar dataKey="Saídas" fill={SAIDA} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <Card className="p-4">
        <h3 className="mb-3 font-display text-xs font-semibold uppercase tracking-wide text-ink-soft">
          Saldo acumulado
        </h3>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke={LINE} vertical={false} />
            <XAxis dataKey="mes" tick={axis} tickLine={false} axisLine={{ stroke: LINE }} />
            <YAxis tick={axis} tickLine={false} axisLine={false} width={40} />
            <Tooltip formatter={tip} contentStyle={{ fontFamily: "IBM Plex Mono", fontSize: 12 }} />
            <Line type="monotone" dataKey="Saldo" stroke={COFRE} strokeWidth={2.5} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </Card>
    </div>
  );
}
