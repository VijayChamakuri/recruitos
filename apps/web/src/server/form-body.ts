const FORBIDDEN_FACT_KEYS = new Set([
  "assignedlevel",
  "evidencetext",
  "extractedfacts",
  "facts",
  "quotedtext",
  "quotes",
  "spans"
]);

export const HUMAN_OPERATOR_ACTOR_ID = "human:operator";
export const SYSTEM_ACTOR_ID = "system:runtime";
export const FIXTURE_CORRECTION_SOURCE_KEY = "demo/route-4-reviewable-failure";

export const CORRECTION_DISABLED_MESSAGE =
  "Correction mutations are disabled. Start with make demo-web-correction.";

export function forbiddenFactField(body: URLSearchParams): string | undefined {
  for (const key of body.keys()) {
    if (FORBIDDEN_FACT_KEYS.has(key.toLowerCase())) {
      return key;
    }
  }
  return undefined;
}

export function postedActorId(body: URLSearchParams): string | undefined {
  const actorId = body.get("actorId") ?? body.get("actor");
  if (actorId === null || actorId.length === 0) {
    return undefined;
  }
  return actorId;
}

export function rejectPostedActor(body: URLSearchParams): string | undefined {
  const actorId = postedActorId(body);
  if (actorId === undefined) {
    return undefined;
  }
  if (actorId === SYSTEM_ACTOR_ID) {
    return "The browser cannot select the system actor.";
  }
  if (actorId !== HUMAN_OPERATOR_ACTOR_ID) {
    return "The browser cannot select an actor. Re-extraction is recorded as human:operator.";
  }
  return undefined;
}

export function requiredText(body: URLSearchParams, name: string): string | undefined {
  const value = body.get(name);
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function requiredInteger(body: URLSearchParams, name: string): number | undefined {
  const raw = body.get(name);
  if (raw === null || raw.length === 0) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || String(value) !== raw.trim()) {
    return undefined;
  }
  return value;
}
