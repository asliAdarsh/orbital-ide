/**
 * The prompt each phase runs with when the user has not written their own.
 *
 * Single source of truth: the phase canvases prefill their textareas from here, and the
 * between-phase approval gate reuses them to re-run or advance a phase without the user
 * having to retype anything.
 */

import { DESIGN_DIR, PLAN_PATH, TEST_REPORT_PATH, type Phase } from "@/types/protocol";

export const PHASE_PROMPTS: Record<Phase, string> = {
  plan: `Research this project and write ${PLAN_PATH}.`,
  design:
    `Read ${PLAN_PATH}, then design one real HTML page per screen into ${DESIGN_DIR}/ that ` +
    "follows it — self-contained, so each mock can be previewed on its own.",
  build: "Implement the planned application using the workspace tools.",
  test: `Run the test suite, then write ${TEST_REPORT_PATH} with what you ran and what you found.`,
  sync: "Commit and push the verified workspace.",
};
