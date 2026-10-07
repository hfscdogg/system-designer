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

export function computeBlockers(s: ScopeExtraction): Blocker[] {
  const b: Blocker[] = [];
  if (!s.client) b.push({ field: "client", question: "Who is the client (person or company)?" });
  const missingAddress = (["line1", "city", "region"] as const).filter((k) => !s.property[k]);
  if (missingAddress.length) {
    b.push({
      field: "property",
      question: `What is the project address? Missing: ${missingAddress
        .map((k) => ({ line1: "street", city: "city", region: "state" })[k])
        .join(", ")}.`,
    });
  }
  if (s.room_types.length === 0) b.push({ field: "room_types", question: "Which rooms or areas are in scope?" });
  if (s.requested_changes.length === 0) {
    b.push({ field: "requested_changes", question: "What outcomes does the client want from this project?" });
  }
  if (s.functional_systems.length === 0) {
    b.push({ field: "functional_systems", question: "Which systems are involved (for example security, AV, networking)?" });
  }
  if (!s.project_type) b.push({ field: "project_type", question: "What kind of project is this (new build, renovation, upgrade)?" });
  if (s.market === "not_provided") b.push({ field: "market", question: "Is this a residential or a commercial project?" });
  if (s.existing_equipment.status === "not_provided") {
    b.push({
      field: "existing_equipment",
      question: "What happens to existing equipment: keep, replace, remove, or none? \"Unknown\" is fine.",
    });
  }
  if (needsDetectorAnswer(s) && s.existing_detectors === "not_provided") {
    b.push({
      field: "existing_detectors",
      question: "Are there existing hard-wired smoke/CO detectors? Keep and monitor them, replace them with new wireless detectors, or there are none?",
    });
  }
  if (s.service_categories.length === 0) {
    b.push({ field: "service_categories", question: "Which services are we providing (installation, programming, testing, commissioning…)?" });
  }
  if (s.budget.status === "not_provided") {
    b.push({ field: "budget", question: "Is there a budget expectation? \"Unknown\" is fine." });
  }
  if (s.target_installation_date === null) {
    b.push({ field: "target_installation_date", question: "Target install date or timeline? \"Unknown\" is fine." });
  }
  return b;
}

export function questionsForTurn(blockers: Blocker[]): Blocker[] {
  return blockers.slice(0, MAX_QUESTIONS_PER_TURN);
}
