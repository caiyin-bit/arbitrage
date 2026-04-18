type Cell = string | number | boolean | Date | null | undefined;

export function toCsv(headers: string[], rows: Cell[][]): string {
  const lines = [headers.map(escape).join(",")];
  for (const row of rows) lines.push(row.map(serialize).join(","));
  return lines.join("\n") + "\n";
}

function serialize(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return escape(String(v));
}

function escape(v: string): string {
  if (v.includes(",") || v.includes('"') || v.includes("\n")) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
