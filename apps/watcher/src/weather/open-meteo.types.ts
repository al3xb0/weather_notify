export interface OpenMeteoCurrent {
  temperature_2m: number;
  apparent_temperature: number;
  relative_humidity_2m: number;
  wind_speed_10m: number;
  precipitation: number;
  weather_code: number;
}

export interface OpenMeteoResponse {
  current: OpenMeteoCurrent;
}
