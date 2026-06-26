import { Metric, Operator, TriggerFiredEvent } from '@app/contracts';

const METRIC_LABEL: Record<Metric, string> = {
  TEMPERATURE: 'Temperature',
  APPARENT_TEMP: 'Feels like',
  WIND_SPEED: 'Wind speed',
  PRECIPITATION: 'Precipitation',
  HUMIDITY: 'Humidity',
  SEVERE: 'Severe weather',
};

const OPERATOR_LABEL: Record<Operator, string> = {
  GT: '>',
  GTE: '≥',
  LT: '<',
  LTE: '≤',
  EQ: '=',
};

export function alertTitle(event: TriggerFiredEvent): string {
  return `Weather alert: ${event.triggerName} (${event.city})`;
}

export function alertText(event: TriggerFiredEvent): string {
  if (event.metric === 'SEVERE') {
    return `Severe weather detected in ${event.city} (WMO code ${event.observedValue}).`;
  }
  const metric = METRIC_LABEL[event.metric];
  const op = OPERATOR_LABEL[event.operator];
  return `${metric} in ${event.city} is ${event.observedValue} (condition: ${metric} ${op} ${event.threshold}).`;
}

export function alertHtml(event: TriggerFiredEvent): string {
  return `<h2>${alertTitle(event)}</h2><p>${alertText(event)}</p>`;
}
