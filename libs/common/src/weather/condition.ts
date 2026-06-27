import { Metric, Operator } from '@prisma/client';

export interface WeatherSnapshot {
  temperature: number;
  apparentTemp: number;
  humidity: number;
  windSpeed: number;
  precipitation: number;
  weatherCode: number;
}

export interface ConditionResult {
  matched: boolean;
  observedValue: number;
}

/**
 * WMO weather codes considered "severe": heavy rain/snow, violent showers and
 * thunderstorms. Used by the SEVERE metric which ignores operator/threshold.
 */
export const SEVERE_WEATHER_CODES = new Set([65, 67, 75, 82, 86, 95, 96, 99]);

export function isSevereWeatherCode(code: number): boolean {
  return SEVERE_WEATHER_CODES.has(code);
}

// Metrics are floats, so exact equality almost never holds. Treat EQ as
// "within half a unit" of the threshold.
const EQ_TOLERANCE = 0.5;

function metricValue(snapshot: WeatherSnapshot, metric: Metric): number {
  switch (metric) {
    case Metric.TEMPERATURE:
      return snapshot.temperature;
    case Metric.APPARENT_TEMP:
      return snapshot.apparentTemp;
    case Metric.WIND_SPEED:
      return snapshot.windSpeed;
    case Metric.PRECIPITATION:
      return snapshot.precipitation;
    case Metric.HUMIDITY:
      return snapshot.humidity;
    case Metric.SEVERE:
      return snapshot.weatherCode;
  }
}

function compare(
  value: number,
  operator: Operator,
  threshold: number,
): boolean {
  switch (operator) {
    case Operator.GT:
      return value > threshold;
    case Operator.GTE:
      return value >= threshold;
    case Operator.LT:
      return value < threshold;
    case Operator.LTE:
      return value <= threshold;
    case Operator.EQ:
      return Math.abs(value - threshold) <= EQ_TOLERANCE;
  }
}

/** Pure evaluation of a trigger condition against a weather snapshot. */
export function evaluateCondition(
  snapshot: WeatherSnapshot,
  metric: Metric,
  operator: Operator,
  threshold: number,
): ConditionResult {
  if (metric === Metric.SEVERE) {
    return {
      matched: isSevereWeatherCode(snapshot.weatherCode),
      observedValue: snapshot.weatherCode,
    };
  }
  const observedValue = metricValue(snapshot, metric);
  return {
    matched: compare(observedValue, operator, threshold),
    observedValue,
  };
}
