import { router } from "./trpc";
import { authRouter } from "./routers/auth";
import { backtestRouter } from "./routers/backtest";
import { exchangeRouter } from "./routers/exchange";
import { opportunityRouter } from "./routers/opportunity";
import { positionRouter } from "./routers/position";
import { settingsRouter } from "./routers/settings";
import { dashboardRouter } from "./routers/dashboard";

export const appRouter = router({
  auth: authRouter,
  backtest: backtestRouter,
  exchange: exchangeRouter,
  opportunity: opportunityRouter,
  position: positionRouter,
  settings: settingsRouter,
  dashboard: dashboardRouter,
});

export type AppRouter = typeof appRouter;
