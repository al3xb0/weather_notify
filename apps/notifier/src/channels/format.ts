import { FiredCondition, Metric, Operator, TriggerFiredEvent } from '@app/contracts';

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

function testPrefix(event: TriggerFiredEvent): string {
  return event.test ? '[TEST] ' : '';
}

function describeCondition(c: FiredCondition): string {
  if (c.metric === 'SEVERE') {
    return `severe weather (WMO ${c.observedValue})`;
  }
  const metric = METRIC_LABEL[c.metric];
  const op = OPERATOR_LABEL[c.operator];
  return `${metric} ${c.observedValue} (${op} ${c.threshold})`;
}

export function alertTitle(event: TriggerFiredEvent): string {
  return `${testPrefix(event)}Weather alert: ${event.triggerName} (${event.city})`;
}

export function alertText(event: TriggerFiredEvent): string {
  const prefix = testPrefix(event);
  const joiner = event.conditionLogic === 'OR' ? ' or ' : ' and ';
  const parts = event.conditions.map(describeCondition).join(joiner);
  return `${prefix}In ${event.city}: ${parts}.`;
}

export function alertHtml(event: TriggerFiredEvent): string {
  return `<h2>${alertTitle(event)}</h2><p>${alertText(event)}</p>`;
}
