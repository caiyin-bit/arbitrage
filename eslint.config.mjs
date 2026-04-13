import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // Plan 3 lint-debt carve-out: existing code uses `any` extensively in
    // exchange adapters / ccxt glue (~50 occurrences) and two setState-in-
    // effect patterns that are legitimate SSR idioms (next-themes mount
    // probe, settings-form server→form sync). Demoted to warnings so CI
    // gates real regressions without blocking on pre-existing debt. A
    // follow-up cleanup plan should tighten these back to errors.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
