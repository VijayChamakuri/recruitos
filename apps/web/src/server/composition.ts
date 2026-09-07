import { createStubComposition, type RecruitosComposition } from "@recruitos/cli";

let activeComposition: RecruitosComposition | null = null;

/**
 * Server-only composition boundary.
 * Prevents client-side components from attempting to import runtime or native modules.
 */
export function getServerComposition(): RecruitosComposition {
  if (!activeComposition) {
    activeComposition = createStubComposition();
  }
  return activeComposition;
}

export function setServerComposition(composition: RecruitosComposition): void {
  activeComposition = composition;
}
