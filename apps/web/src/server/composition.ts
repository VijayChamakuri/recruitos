import {
  createDefaultRuntimeComposition,
  createStubComposition,
  type RecruitosComposition
} from "@recruitos/cli";
import type { RuntimeComposition } from "@recruitos/runtime/composition";

let activeComposition: RecruitosComposition | null = null;
let activeRuntime: RuntimeComposition | null = null;

/**
 * Server-only composition boundary.
 * Prevents client-side components from attempting to import runtime or native modules.
 */
export function getServerComposition(): RecruitosComposition {
  if (!activeComposition) {
    const result = createDefaultRuntimeComposition();
    activeComposition = result.ok ? result.value : createStubComposition();
  }
  return activeComposition ?? createStubComposition();
}

export function setServerComposition(composition: RecruitosComposition): void {
  activeComposition = composition;
}

export function getServerRuntime(): RuntimeComposition | null {
  return activeRuntime;
}

export function setServerRuntime(runtime: RuntimeComposition): void {
  activeRuntime = runtime;
}
