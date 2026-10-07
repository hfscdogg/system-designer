import { applyAssumptions } from "./assumptions.ts";
import type { ScopeExtraction } from "./scope.ts";

/**
 * Material blocking questions (PRD §7.5, §9.1). An explicit unknown/TBD is an
 * answer; only values that were never supplied block. Order is priority order.
 */
export interface Blocker {
  field: string;
  question: string;
}

export const MAX_QUESTIONS_PER_TURN = 3;

/** Systems whose design depends on whether existing smoke/CO detectors stay. */
export const LIFE_SAFETY_SYSTEMS = ["fire_detection", "co_detection"];

export function needsDetectorAnswer(s: Pick<ScopeExtraction, "functional_systems">): boolean {
  return s.functional_systems.some((x) => LIFE_SAFETY_SYSTEMS.includes(x));
}

/**
 * Only what cannot be inferred blocks (see assumptions.ts): what to price,
 * who it is for, which margin floor applies when that isn't obvious, and the
 * smoke/CO decision that changes the design.
 */
export function computeBlockers(raw: ScopeExtraction): Blocker[] {
  const s = applyAssumptions(raw).scope;
  const b: Blocker[] = [];
  if (s.functional_systems.length === 0) {
    b.push({ field: "functional_systems", question: "Which systems should the budget cover?" });
  }
  if (!s.client) b.push({ field: "client", question: "Who is the client (person or company)?" });
  if (s.market === "not_provided") b.push({ field: "market", question: "Is this a residential or a commercial project?" });
  if (needsDetectorAnswer(s) && s.existing_detectors === "not_provided") {
    b.push({
      field: "existing_detectors",
      question: "Are there existing hard-wired smoke/CO detectors? Keep and monitor them, replace them with new wireless detectors, or there are none?",
    });
  }
  return b;
}

export function questionsForTurn(blockers: Blocker[]): Blocker[] {
  return blockers.slice(0, MAX_QUESTIONS_PER_TURN);
}
