import { WeatherSnapshot } from '@app/domain';

/** DI token for the upstream weather port — see `OpenMeteoWeatherProvider`. */
export const WEATHER_PROVIDER = Symbol('WEATHER_PROVIDER');

/**
 * Current conditions for a location. The watcher only ever needs a snapshot,
 * so caching, retries and the shape of the upstream API stay behind this.
 */
export interface WeatherProvider {
  getSnapshot(latitude: number, longitude: number): Promise<WeatherSnapshot>;
}
