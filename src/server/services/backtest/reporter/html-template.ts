import type { Aggregated } from "./aggregate";
import type { BacktestConfig, EquityCurvePoint } from "@/server/services/backtest/types";

export function renderHtml(config: BacktestConfig, agg: Aggregated, equityCurve: EquityCurvePoint[]): string {
  const o = agg.overall;
  const cards = [
    card("ROI", `${(o.roi * 100).toFixed(2)}%`, o.roi >= 0 ? "pos" : "neg"),
    card("净收益", `$${o.netPnl.toFixed(0)}`, o.netPnl >= 0 ? "pos" : "neg"),
    card("交易数", String(o.totalTrades)),
    card("胜率", `${(o.winRate * 100).toFixed(1)}%`),
    card("最大回撤", `$${o.maxDrawdown.toFixed(0)}`, "neg"),
  ].join("");

  const json = JSON.stringify({ equityCurve, agg }).replace(/</g, "\\u003c");

  return `<!doctype html><html><head>
<meta charset="utf-8" />
<title>Backtest Report</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>
<style>
  body{font:14px -apple-system,Segoe UI,Roboto,sans-serif;margin:24px;color:#111;}
  h1{margin-top:0;}
  .cards{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0;}
  .card{flex:1;min-width:160px;padding:16px;border:1px solid #ddd;border-radius:8px;background:#fafafa;}
  .card .label{font-size:12px;color:#666;text-transform:uppercase;}
  .card .value{font-size:24px;font-weight:600;margin-top:4px;}
  .pos{color:#0a0;} .neg{color:#a00;}
  .chart{height:360px;margin:24px 0;}
  pre{background:#f5f5f5;padding:12px;border-radius:4px;overflow-x:auto;}
</style>
</head><body>
<h1>Backtest Report</h1>
<p>${config.from.toISOString().slice(0, 10)} → ${config.to.toISOString().slice(0, 10)}</p>
<div class="cards">${cards}</div>
<pre id="params">${escapeHtml(JSON.stringify(config, null, 2))}</pre>
<div id="equity" class="chart"></div>
<div id="histogram" class="chart"></div>
<div id="bypair" class="chart"></div>
<div id="bysymbol" class="chart"></div>
<div id="fee" class="chart"></div>
<div id="hold" class="chart"></div>
<div id="heatmap" class="chart"></div>
<script>
const data = ${json};
(function(){
  const e = echarts.init(document.getElementById('equity'));
  e.setOption({
    title:{text:'账户净值曲线'},
    xAxis:{type:'time'}, yAxis:{type:'value'},
    series:[{type:'line', smooth:true, data: data.equityCurve.map(p => [p.date, p.equity])}],
  });
  const h = echarts.init(document.getElementById('histogram'));
  h.setOption({
    title:{text:'每日/每笔 收益分布'},
    xAxis:{type:'category', data: data.agg.dailyPnlHistogram.map(x=>x.bin.toFixed(2))},
    yAxis:{type:'value'},
    series:[{type:'bar', data: data.agg.dailyPnlHistogram.map(x=>x.count)}],
  });
  const bp = echarts.init(document.getElementById('bypair'));
  bp.setOption({
    title:{text:'按交易所对 P&L'},
    xAxis:{type:'value'},
    yAxis:{type:'category', data: data.agg.byExchangePair.map(g=>g.key)},
    series:[{type:'bar', data: data.agg.byExchangePair.map(g=>g.netPnl)}],
  });
  const bs = echarts.init(document.getElementById('bysymbol'));
  bs.setOption({
    title:{text:'按币种 P&L'},
    xAxis:{type:'category', data: data.agg.bySymbol.map(g=>g.key)},
    yAxis:{type:'value'},
    series:[{type:'bar', data: data.agg.bySymbol.map(g=>g.netPnl)}],
  });
  const fe = echarts.init(document.getElementById('fee'));
  fe.setOption({
    title:{text:'手续费 vs 净收益'},
    series:[{type:'pie',
      data:[
        { name:'总手续费', value: Math.max(0,data.agg.feeBreakdown.totalFees) },
        { name:'净收益', value: Math.max(0,data.agg.feeBreakdown.netPnl) },
      ],
    }],
  });
  const hd = echarts.init(document.getElementById('hold'));
  hd.setOption({
    title:{text:'持仓时长分布'},
    xAxis:{type:'category', data: data.agg.holdDurationBuckets.map(b=>b.bucket)},
    yAxis:{type:'value'},
    series:[{type:'bar', data: data.agg.holdDurationBuckets.map(b=>b.count)}],
  });
  const hm = echarts.init(document.getElementById('heatmap'));
  const heat = [];
  for (const g of data.agg.byDayOfWeek) {
    for (const h of data.agg.byHourOfDay) {
      heat.push([Number(h.key), Number(g.key), g.count * h.count]);
    }
  }
  hm.setOption({
    title:{text:'机会热力图（星期 × 小时）'},
    xAxis:{type:'category', data: ['0','1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','20','21','22','23']},
    yAxis:{type:'category', data: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']},
    visualMap:{min:0, max:10, orient:'horizontal'},
    series:[{type:'heatmap', data: heat}],
  });
})();
</script>
</body></html>`;
}

function card(label: string, value: string, tone?: "pos" | "neg"): string {
  const cls = tone ? ` ${tone}` : "";
  return `<div class="card"><div class="label">${label}</div><div class="value${cls}">${value}</div></div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
