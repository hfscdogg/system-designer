import type { ClarificationPatch } from "./scope.ts";

/**
 * Tap-to-answer choices for blocking questions. A choice becomes a bounded
 * clarification patch in code, so answering by button needs no model. Fields
 * without choices (client, address, outcomes) are answered by typing.
 */
export interface AnswerChoice {
  value: string;
  label: string;
  /** The usual answer; shown first and marked "(Recommended)". */
  recommended?: true;
}

export interface QuestionChoices {
  /** Several options may be picked, then confirmed with one button. */
  multi: boolean;
  options: AnswerChoice[];
}

const choice = (value: string, label = value[0]!.toUpperCase() + value.slice(1)): AnswerChoice => ({ value, label });
const recommended = (c: AnswerChoice): AnswerChoice => ({ ...c, recommended: true });

/** Values are phrases the normalizer maps to canonical terms, so a tap and a typed answer agree. */
export const ANSWER_CHOICES: Record<string, QuestionChoices> = {
  // Most Livewire work is residential.
  market: { multi: false, options: [recommended(choice("residential")), choice("commercial")] },
  project_type: { multi: false, options: [recommended(choice("upgrade", "Upgrade / retrofit")), choice("new construction"), choice("renovation")] },
  existing_equipment: { multi: false, options: [choice("none", "None"), choice("unknown", "Unknown")] },
  existing_detectors: {
    multi: false,
    // Replacing prices the fuller scope, so a budget does not come in low.
    options: [recommended(choice("replace", "Replace with wireless")), choice("keep_and_monitor", "Keep and monitor them"), choice("none", "None")],
  },
  room_types: {
    multi: true,
    options: ["whole house", "entry", "living room", "kitchen", "primary bedroom", "office", "basement", "garage", "exterior"].map((v) => choice(v)),
  },
  functional_systems: {
    multi: true,
    options: [
      choice("security", "Security / alarm"),
      choice("monitoring", "Alarm monitoring"),
      choice("smoke detectors", "Smoke detection"),
      choice("carbon monoxide detectors", "CO detection"),
      choice("cameras", "Cameras"),
      choice("video doorbell", "Video doorbell"),
      choice("thermostats", "Thermostats"),
      choice("networking", "Networking / Wi-Fi"),
      choice("whole-home audio", "Whole-home audio (Sonos)"),
      choice("audio video", "TV / home theater"),
      choice("lighting control", "Lighting control"),
      choice("shades", "Shades"),
      choice("door locks", "Door locks"),
    ],
  },
  service_categories: {
    multi: true,
    options: ["design", "prewire", "installation", "programming", "testing", "commissioning", "training", "removal", "monitoring activation", "project management"].map((v) =>
      choice(v),
    ),
  },
  budget: { multi: false, options: [choice("unknown", "Unknown")] },
  target_installation_date: { multi: false, options: [choice("unknown", "Unknown")] },
};

export const NO_CHANGE_PATCH: ClarificationPatch = {
  client: null,
  property: null,
  project_type: null,
  market: null,
  room_types: null,
  functional_systems: null,
  requested_changes: null,
  requested_quantities: null,
  requested_discount: null,
  existing_equipment: null,
  existing_detectors: null,
  excluded_scope: null,
  service_categories: null,
  size: null,
  size_is_unknown: false,
  budget: null,
  target_installation_date: null,
  proposal: null,
  unmapped: false,
};

/** Labels for the picked values, or null when any value is not an offered choice. */
export function answerLabels(field: string, values: string[]): string[] | null {
  const choices = ANSWER_CHOICES[field];
  if (!choices || values.length === 0 || (!choices.multi && values.length !== 1)) return null;
  const labels = values.map((v) => choices.options.find((o) => o.value === v)?.label);
  return labels.every((l): l is string => l !== undefined) ? labels : null;
}

/** The patch a tapped answer stands for, or null when the answer is not one of the offered choices. */
export function answerPatch(field: string, values: string[]): ClarificationPatch | null {
  if (!answerLabels(field, values)) return null;
  const picked = [...new Set(values)];
  const v = picked[0]!;
  const patch = { ...NO_CHANGE_PATCH };
  switch (field) {
    case "market":
      patch.market = v as ClarificationPatch["market"];
      break;
    case "project_type":
      patch.project_type = v;
      break;
    case "existing_equipment":
      patch.existing_equipment = { status: v as "none" | "unknown", retained: [], removed_or_replaced: [] };
      break;
    case "existing_detectors":
      patch.existing_detectors = v as ClarificationPatch["existing_detectors"];
      break;
    case "room_types":
      patch.room_types = picked;
      break;
    case "functional_systems":
      patch.functional_systems = picked;
      break;
    case "service_categories":
      patch.service_categories = picked;
      break;
    case "budget":
      patch.budget = { status: "unknown", amount_usd: null };
      break;
    case "target_installation_date":
      patch.target_installation_date = "unknown";
      break;
    default:
      return null;
  }
  return patch;
}
