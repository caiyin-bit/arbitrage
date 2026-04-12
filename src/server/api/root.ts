import { router } from "./trpc";
import { exchangeRouter } from "./routers/exchange";
import { opportunityRouter } from "./routers/opportunity";
import { positionRouter } from "./routers/position";
import { settingsRouter } from "./routers/settings";
import { dashboardRouter } from "./routers/dashboard";

export const appRouter = router({
  exchange: exchangeRouter,
  opportunity: opportunityRouter,
  position: positionRouter,
  settings: settingsRouter,
  dashboard: dashboardRouter,
});

export type AppRouter = typeof appRouter;
