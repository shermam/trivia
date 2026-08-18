/**
 * The Firestore REST wire format for field values, and the encoder/decoder
 * between it and ordinary JavaScript.
 *
 * The client SDK hides this entirely; REST does not. Every value crosses the
 * wire tagged with its type — `{"stringValue": "x"}`, `{"integerValue": "7"}`,
 * `{"arrayValue": {"values": [...]}}` — and **integers arrive as strings**.
 * `FIRESTORE_SDK_VS_REST.md` §7 names this the main correctness risk of the
 * migration, and it is right to: a silent `"7"` where `7` was meant reaches
 * `firestore.rules`, fails `data.createdAt is int`, and comes back as a
 * `permission-denied` that names no cause. So this file is deliberately
 * complete and deliberately loud — see the two `throw`s below.
 */

/** One field value as Firestore's REST API represents it. All eleven types. */
export type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number | string }
  | { timestampValue: string }
  | { stringValue: string }
  | { bytesValue: string }
  | { referenceValue: string }
  | { geoPointValue: { latitude?: number; longitude?: number } }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

/** A document body as sent and received: field name → tagged value. */
export type FirestoreFields = Record<string, FirestoreValue>;

/**
 * Encodes one JavaScript value.
 *
 * Two things are rejected rather than coerced, both because the alternative is
 * a write that succeeds and stores the wrong thing:
 *
 * - **`undefined`**, which the client SDK also rejects. `NewQuestionReportDoc.detail`
 *   is the live case — it must be *omitted* when empty, not set to `undefined`.
 * - **Non-finite and unsafe-integer numbers**, which cannot survive the round
 *   trip. `JSON.stringify(NaN)` is `null`, and `String(1e21)` is `"1e+21"`,
 *   which is not a valid int64. Every number this app writes — epoch
 *   milliseconds, scores, percentages — is far inside the safe range, so a
 *   value out of it is a bug, and failing at the call site beats storing
 *   `null` under a key that was supposed to hold a count.
 */
export function encodeValue(value: unknown): FirestoreValue {
  if (value === null) {
    return { nullValue: null };
  }
  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } };
  }
  switch (typeof value) {
    case 'string':
      return { stringValue: value };
    case 'boolean':
      return { booleanValue: value };
    case 'number':
      return encodeNumber(value);
    case 'object':
      return { mapValue: { fields: encodeFields(value as Record<string, unknown>) } };
    default:
      throw new TypeError(
        `Cannot encode a value of type ${typeof value} for Firestore (got ${String(value)})`,
      );
  }
}

function encodeNumber(value: number): FirestoreValue {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Cannot encode the non-finite number ${String(value)} for Firestore`);
  }
  if (Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `Cannot encode the integer ${String(value)} for Firestore: outside the range that ` +
          'survives the string round trip of integerValue',
      );
    }
    // A string, not a number. Firestore's int64 does not fit in a JSON number,
    // so the wire format spells every integer out.
    return { integerValue: String(value) };
  }
  return { doubleValue: value };
}

/** Encodes a whole document body. */
export function encodeFields(data: Record<string, unknown>): FirestoreFields {
  const fields: FirestoreFields = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) {
      throw new TypeError(
        `Cannot encode "${key}": Firestore has no undefined. Omit the key instead.`,
      );
    }
    fields[key] = encodeValue(value);
  }
  return fields;
}

/**
 * Decodes one wire value.
 *
 * Every type Firestore can return is handled, so there is no "unknown type"
 * path to fall through — which is why the `throw` at the end can afford to be
 * a hard error rather than a shrug. A value shaped like none of the eleven is
 * a malformed response, and reading `undefined` out of it would put the wrong
 * data in front of a player instead of saying so.
 *
 * `integerValue` is parsed with `Number`, which is exact up to 2^53. Firestore
 * stores int64. Nothing this app reads comes close — the largest is an epoch
 * timestamp in milliseconds, about 1.8e12 — but a counter that one day exceeds
 * it would lose precision here silently, so it is worth knowing.
 */
export function decodeValue(value: FirestoreValue): unknown {
  if ('stringValue' in value) {
    return value.stringValue;
  }
  if ('integerValue' in value) {
    return Number(value.integerValue);
  }
  if ('booleanValue' in value) {
    return value.booleanValue;
  }
  if ('nullValue' in value) {
    return null;
  }
  if ('doubleValue' in value) {
    // Arrives as a number normally, but as the strings "NaN"/"Infinity"/
    // "-Infinity" for the values JSON cannot spell.
    return Number(value.doubleValue);
  }
  if ('timestampValue' in value) {
    return new Date(value.timestampValue);
  }
  if ('arrayValue' in value) {
    // `values` is absent, not empty, for an empty array — which is exactly
    // what `products.images` is whenever a Stripe product has no images.
    return (value.arrayValue.values ?? []).map(decodeValue);
  }
  if ('mapValue' in value) {
    return decodeFields(value.mapValue.fields ?? {});
  }
  if ('referenceValue' in value) {
    return value.referenceValue;
  }
  if ('bytesValue' in value) {
    // Left as the base64 the wire carries; nothing in this app stores bytes.
    return value.bytesValue;
  }
  if ('geoPointValue' in value) {
    return {
      latitude: value.geoPointValue.latitude ?? 0,
      longitude: value.geoPointValue.longitude ?? 0,
    };
  }
  throw new TypeError(`Unrecognised Firestore value: ${JSON.stringify(value)}`);
}

/** Decodes a whole document body. */
export function decodeFields(fields: FirestoreFields): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    data[key] = decodeValue(value);
  }
  return data;
}
