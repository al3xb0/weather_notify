import {
  FiredCondition,
  Metric,
  Operator,
  TriggerFiredEvent,
} from '@app/contracts';

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

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);
}

export function alertHtml(event: TriggerFiredEvent): string {
  // alertTitle/alertText carry user-controlled trigger name and city, so escape
  // them before embedding in the HTML email body to prevent markup injection.
  return `<h2>${escapeHtml(alertTitle(event))}</h2><p>${escapeHtml(alertText(event))}</p>`;
}
