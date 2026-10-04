import { createHash } from 'node:crypto';
import { ApiError } from './errors.js';

export const MAX_BATCH_SIZE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const FIELDS = new Set(['eventId', 'sessionId', 'occurredAt', 'name', 'screen', 'platform', 'appVersion', 'properties']);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(field, message) {
  throw new ApiError(400, 'invalid_event', message, field);
}

export function validateBatch(body, now = Date.now()) {
  if (!plainObject(body) || body.schemaVersion !== 1 || Object.keys(body).some(k => !['schemaVersion', 'events'].includes(k))) {
    invalid('schemaVersion', 'Ожидается пакет schemaVersion: 1 и массив events.');
  }
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > MAX_BATCH_SIZE) invalid('events', `Пакет должен содержать от 1 до ${MAX_BATCH_SIZE} событий.`);
  const ids = new Map();
  return body.events.map((source, index) => {
    const field = key => `events[${index}].${key}`;
    if (!plainObject(source) || Object.keys(source).some(k => !FIELDS.has(k))) invalid(`events[${index}]`, 'Неизвестные поля события.');
    for (const key of ['eventId', 'sessionId']) {
      if (typeof source[key] !== 'string' || !UUID.test(source[key])) invalid(field(key), 'Требуется UUID.');
    }
    if (typeof source.name !== 'string' || !NAME.test(source.name)) invalid(field('name'), 'Имя события: латинские буквы, цифры и подчёркивания, до 64 символов.');
    if (source.screen !== undefined && source.screen !== null && (typeof source.screen !== 'string' || !NAME.test(source.screen))) invalid(field('screen'), 'Некорректное имя экрана.');
    if (!['android', 'ios', 'web'].includes(source.platform)) invalid(field('platform'), 'Допустимы android, ios, web.');
    if (typeof source.appVersion !== 'string' || source.appVersion.length < 1 || source.appVersion.length > 32) invalid(field('appVersion'), 'Версия приложения: от 1 до 32 символов.');
    if (typeof source.occurredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(source.occurredAt)) invalid(field('occurredAt'), 'Время должно быть в UTC, например 2026-10-04T10:20:30.000Z.');
    const date = new Date(source.occurredAt);
    if (!Number.isFinite(date.getTime()) || date.toISOString().replace('.000Z', 'Z') !== source.occurredAt.replace('.000Z', 'Z')) invalid(field('occurredAt'), 'Некорректная календарная дата.');
    if (date.getTime() > now + 5 * 60_000 || date.getTime() < now - 365 * 86_400_000) invalid(field('occurredAt'), 'Проверьте часы устройства: дата старше года или более чем на 5 минут в будущем.');
    const properties = source.properties ?? {};
    if (!plainObject(properties) || Object.keys(properties).length > 16) invalid(field('properties'), 'Ожидается объект, не более 16 свойств.');
    const normalizedProperties = {};
    for (const key of Object.keys(properties).sort()) {
      const value = properties[key];
      if (!NAME.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid(field('properties'), 'Некорректное имя свойства.');
      if (!(value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 256))) invalid(field(`properties.${key}`), 'Свойство: строка до 256 символов, число, boolean или null.');
      normalizedProperties[key] = value;
    }
    if (Buffer.byteLength(JSON.stringify(normalizedProperties)) > 4096) invalid(field('properties'), 'Свойства превышают 4 КиБ.');
    const event = {
      eventId: source.eventId.toLowerCase(), sessionId: source.sessionId.toLowerCase(),
      occurredAt: date.toISOString(), name: source.name, screen: source.screen ?? null,
      platform: source.platform, appVersion: source.appVersion, properties: normalizedProperties,
    };
    const payloadHash = createHash('sha256').update(JSON.stringify(event)).digest('hex');
    if (ids.has(event.eventId) && ids.get(event.eventId) !== payloadHash) throw new ApiError(409, 'event_id_conflict', 'Один eventId использован для разных событий.', field('eventId'));
    ids.set(event.eventId, payloadHash);
    return { ...event, payloadHash };
  });
}
