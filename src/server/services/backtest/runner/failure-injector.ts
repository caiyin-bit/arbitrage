import seedrandom from "seedrandom";

export interface FailureInjector {
  shouldFail(op: "open" | "close"): boolean;
  random: () => number;
}

export function createFailureInjector(seed: string, failureRate: number): FailureInjector {
  const prng = seedrandom(seed);
  return {
    shouldFail: () => prng() < failureRate,
    random: () => prng(),
  };
}
