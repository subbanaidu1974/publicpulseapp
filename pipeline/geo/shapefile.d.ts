declare module "shapefile" {
  export function open(shp: string, dbf?: string, options?: Record<string, unknown>): Promise<{
    read(): Promise<{ done: boolean; value: { type: "Feature"; properties: Record<string, unknown>; geometry: any } }>;
  }>;
}
