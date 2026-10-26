const assets = import.meta.glob<string>("../assets/landing/showcase/*.webp", { eager: true, query: "?url", import: "default" });

export function landingAsset(name: string): string {
  return assets[`../assets/landing/showcase/${name}`];
}
