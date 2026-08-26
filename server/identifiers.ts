/**
 * PostgreSQL's uuid type accepts the full 8-4-4-4-12 hexadecimal shape.
 *
 * Some imported Fluid records use deterministic UUIDs whose version/variant
 * bits do not match RFC-generated UUIDs, so validation must check the database
 * representation rather than restricting the UUID version or variant bits.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
