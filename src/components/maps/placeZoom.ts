/** Smallest town (people) labelled at each zoom, so the map never fills with names (S-192). Kept free of Leaflet so tests can import it. */
export const minPopulationAt = (zoom: number): number => (zoom < 6.5 ? 600_000 : zoom < 7.5 ? 200_000 : zoom < 8.5 ? 90_000 : zoom < 9.5 ? 50_000 : 0);
/** Villages are labelled only from this zoom in (about district level and closer), and never more than this many at once (S-193). */
export const VILLAGE_ZOOM = 9.5;
export const MAX_VILLAGE_LABELS = 400;
