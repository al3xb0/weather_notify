import { Metric, Operator } from '@prisma/client';
import {
  evaluateCondition,
  isSevereWeatherCode,
  WeatherSnapshot,
} from './condition';

const snapshot: WeatherSnapshot = {
  temperature: 31,
  apparentTemp: 34,
  humidity: 80,
  windSpeed: 12,
  precipitation: 2.5,
  weatherCode: 3,
};

describe('evaluateCondition', () => {
  it('matches GT when value exceeds threshold', () => {
    const r = evaluateCondition(snapshot, Metric.TEMPERATURE, Operator.GT, 30);
    expect(r).toEqual({ matched: true, observedValue: 31 });
  });

  it('does not match GT when value equals threshold', () => {
    expect(
      evaluateCondition(snapshot, Metric.TEMPERATURE, Operator.GT, 31).matched,
    ).toBe(false);
  });

  it('matches GTE at the boundary', () => {
    expect(
      evaluateCondition(snapshot, Metric.TEMPERATURE, Operator.GTE, 31).matched,
    ).toBe(true);
  });

  it('matches LT / LTE correctly', () => {
    expect(
      evaluateCondition(snapshot, Metric.WIND_SPEED, Operator.LT, 15).matched,
    ).toBe(true);
    expect(
      evaluateCondition(snapshot, Metric.WIND_SPEED, Operator.LTE, 12).matched,
    ).toBe(true);
  });

  it('matches EQ exactly', () => {
    expect(
      evaluateCondition(snapshot, Metric.HUMIDITY, Operator.EQ, 80).matched,
    ).toBe(true);
    expect(
      evaluateCondition(snapshot, Metric.HUMIDITY, Operator.EQ, 79).matched,
    ).toBe(false);
  });

  it('reads the right metric value', () => {
    expect(
      evaluateCondition(snapshot, Metric.APPARENT_TEMP, Operator.GT, 33)
        .observedValue,
    ).toBe(34);
    expect(
      evaluateCondition(snapshot, Metric.PRECIPITATION, Operator.GT, 1)
        .observedValue,
    ).toBe(2.5);
  });

  describe('SEVERE metric', () => {
    it('matches when weather code is severe, ignoring operator/threshold', () => {
      const stormy = { ...snapshot, weatherCode: 95 };
      const r = evaluateCondition(stormy, Metric.SEVERE, Operator.EQ, 0);
      expect(r).toEqual({ matched: true, observedValue: 95 });
    });

    it('does not match for a calm weather code', () => {
      expect(
        evaluateCondition(snapshot, Metric.SEVERE, Operator.EQ, 0).matched,
      ).toBe(false);
    });
  });
});

describe('isSevereWeatherCode', () => {
  it.each([65, 95, 99])('treats %i as severe', (code) => {
    expect(isSevereWeatherCode(code)).toBe(true);
  });

  it.each([0, 1, 3, 45, 80])('treats %i as not severe', (code) => {
    expect(isSevereWeatherCode(code)).toBe(false);
  });
});
