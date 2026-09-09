let correctionFixtureMode = false;

export function setCorrectionFixtureMode(enabled: boolean): void {
  correctionFixtureMode = enabled;
}

export function isCorrectionFixtureMode(): boolean {
  return correctionFixtureMode;
}
