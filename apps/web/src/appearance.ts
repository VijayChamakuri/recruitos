export const DEFAULT_THEME = "light";
export const DEFAULT_DENSITY = "default";

export type Theme = "light" | "dark";
export type Density = "compact" | "default" | "comfortable";

export type Appearance = Readonly<{
  theme: Theme;
  density: Density;
}>;

export const DEFAULT_APPEARANCE: Appearance = Object.freeze({
  theme: DEFAULT_THEME,
  density: DEFAULT_DENSITY
});

export function parseAppearance(searchParams: URLSearchParams): Appearance {
  const themeRaw = searchParams.get("theme");
  const densityRaw = searchParams.get("density");
  const theme: Theme = themeRaw === "dark" || themeRaw === "light" ? themeRaw : DEFAULT_THEME;
  const density: Density =
    densityRaw === "compact" || densityRaw === "default" || densityRaw === "comfortable"
      ? densityRaw
      : DEFAULT_DENSITY;
  return { theme, density };
}

export function appearanceQuery(appearance: Appearance): string {
  return `theme=${appearance.theme}&density=${appearance.density}`;
}

export function hrefWithAppearance(
  pathname: string,
  appearance: Appearance,
  preserved?: URLSearchParams
): string {
  const params = new URLSearchParams();
  if (preserved !== undefined) {
    for (const [key, value] of preserved.entries()) {
      if (key === "theme" || key === "density") {
        continue;
      }
      params.append(key, value);
    }
  }
  params.set("theme", appearance.theme);
  params.set("density", appearance.density);
  return `${pathname}?${params.toString()}`;
}

export function packetHref(
  candidateId: string,
  appearance: Appearance,
  resultId?: string
): string {
  const encodedId = encodeURIComponent(candidateId);
  const preserved = new URLSearchParams();
  if (resultId !== undefined) {
    preserved.set("result", resultId);
  }
  return hrefWithAppearance(`/packet/${encodedId}`, appearance, preserved);
}
