import { z } from 'zod';

// External payload — validated at runtime so a null/missing field surfaces as a
// fetch error instead of silently becoming NaN downstream.
export const openMeteoCurrentSchema = z.object({
  temperature_2m: z.number(),
  apparent_temperature: z.number(),
  relative_humidity_2m: z.number(),
  wind_speed_10m: z.number(),
  precipitation: z.number(),
  weather_code: z.number(),
});

export const openMeteoResponseSchema = z.object({
  current: openMeteoCurrentSchema,
});

export type OpenMeteoResponse = z.infer<typeof openMeteoResponseSchema>;
