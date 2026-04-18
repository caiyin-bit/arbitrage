import { describe, it, expect } from "vitest";
import { toCsv } from "@/server/services/backtest/reporter/csv-writer";

describe("csv-writer", () => {
  it("quotes values containing commas", () => {
    const csv = toCsv(["a", "b"], [["x,y", "z"]]);
    expect(csv).toBe(`a,b\n"x,y",z\n`);
  });
  it("escapes quotes by doubling", () => {
    const csv = toCsv(["q"], [[`he said "hi"`]]);
    expect(csv).toBe(`q\n"he said ""hi"""\n`);
  });
  it("null/undefined → empty", () => {
    const csv = toCsv(["a", "b"], [[null, undefined]] as unknown as (string | number | null | undefined)[][]);
    expect(csv).toBe("a,b\n,\n");
  });
  it("Date → ISO", () => {
    const d = new Date("2025-01-01T00:00:00Z");
    const csv = toCsv(["d"], [[d]] as unknown as (string | number | Date)[][]);
    expect(csv).toBe(`d\n2025-01-01T00:00:00.000Z\n`);
  });
});
