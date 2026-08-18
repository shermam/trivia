import {
  FirestoreValue,
  decodeFields,
  decodeValue,
  encodeFields,
  encodeValue,
} from './firestore-value';

/**
 * `FIRESTORE_SDK_VS_REST.md` §7 calls the typed wire format the main
 * correctness risk of moving off the SDK, so this suite is a table rather than
 * a handful of examples: every type the app can write, every type the Cloud
 * Functions backend can write back, and the encodings that are easy to get
 * subtly wrong (integers as strings, an empty array with no `values` key, the
 * difference between an integer and a double).
 */

describe('encodeValue', () => {
  const cases: { name: string; input: unknown; expected: FirestoreValue }[] = [
    { name: 'a string', input: 'hello', expected: { stringValue: 'hello' } },
    { name: 'an empty string', input: '', expected: { stringValue: '' } },
    { name: 'true', input: true, expected: { booleanValue: true } },
    { name: 'false', input: false, expected: { booleanValue: false } },
    { name: 'null', input: null, expected: { nullValue: null } },
    // The one that matters most: an integer is a *string* on the wire, and
    // sending it as a JSON number makes Firestore read it as a double, which
    // `data.createdAt is int` in firestore.rules then rejects.
    { name: 'a small integer', input: 7, expected: { integerValue: '7' } },
    { name: 'zero', input: 0, expected: { integerValue: '0' } },
    { name: 'a negative integer', input: -3, expected: { integerValue: '-3' } },
    {
      name: 'an epoch-millisecond timestamp',
      input: 1_755_000_000_000,
      expected: { integerValue: '1755000000000' },
    },
    { name: 'a fractional number', input: 66.5, expected: { doubleValue: 66.5 } },
    {
      name: 'a string array',
      input: ['a', 'b'],
      expected: { arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] } },
    },
    { name: 'an empty array', input: [], expected: { arrayValue: { values: [] } } },
    {
      name: 'a nested map',
      input: { message: 'boom' },
      expected: { mapValue: { fields: { message: { stringValue: 'boom' } } } },
    },
    {
      name: 'a Date',
      input: new Date('2026-08-18T10:00:00.000Z'),
      expected: { timestampValue: '2026-08-18T10:00:00.000Z' },
    },
  ];

  for (const { name, input, expected } of cases) {
    it(`encodes ${name}`, () => {
      expect(encodeValue(input)).toEqual(expected);
    });
  }

  it('distinguishes an integer from a whole-numbered double', () => {
    // 5 and 5.0 are the same JavaScript number, so the encoder has no way to
    // tell them apart and always sends `integerValue`. Pinned because the
    // alternative — guessing at doubleValue — would break every rules check
    // that says `is int`.
    expect(encodeValue(5.0)).toEqual({ integerValue: '5' });
  });
});

describe('encodeValue rejections', () => {
  it('rejects undefined inside a document body, naming the key', () => {
    // NewQuestionReportDoc.detail is the live case: it must be omitted when
    // empty, never set to undefined.
    expect(() => encodeFields({ detail: undefined })).toThrow(/detail/);
  });

  it('rejects NaN rather than silently writing null', () => {
    expect(() => encodeValue(Number.NaN)).toThrow(/non-finite/);
  });

  it('rejects Infinity', () => {
    expect(() => encodeValue(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });

  it('rejects an integer too large to survive the string round trip', () => {
    expect(() => encodeValue(1e21)).toThrow(/outside the range/);
  });

  it('rejects a function', () => {
    expect(() => encodeValue(() => undefined)).toThrow(/Cannot encode a value of type function/);
  });
});

describe('decodeValue', () => {
  const cases: { name: string; input: FirestoreValue; expected: unknown }[] = [
    { name: 'a string', input: { stringValue: 'hello' }, expected: 'hello' },
    // Arrives as a string and must come back as a number, or every arithmetic
    // comparison downstream is a string comparison instead.
    { name: 'an integer', input: { integerValue: '7' }, expected: 7 },
    {
      name: 'a large epoch timestamp',
      input: { integerValue: '1755000000000' },
      expected: 1_755_000_000_000,
    },
    { name: 'a double', input: { doubleValue: 66.5 }, expected: 66.5 },
    { name: 'true', input: { booleanValue: true }, expected: true },
    { name: 'null', input: { nullValue: null }, expected: null },
    {
      name: 'an array',
      input: { arrayValue: { values: [{ stringValue: 'a' }, { integerValue: '2' }] } },
      expected: ['a', 2],
    },
    // Firestore omits `values` entirely for an empty array — which is what
    // `products.images` is for a Stripe product with no images.
    { name: 'an array with no values key', input: { arrayValue: {} }, expected: [] },
    {
      name: 'a map',
      input: { mapValue: { fields: { message: { stringValue: 'boom' } } } },
      expected: { message: 'boom' },
    },
    { name: 'a map with no fields key', input: { mapValue: {} }, expected: {} },
    {
      name: 'a reference',
      input: { referenceValue: 'projects/p/databases/(default)/documents/c/d' },
      expected: 'projects/p/databases/(default)/documents/c/d',
    },
    { name: 'bytes', input: { bytesValue: 'aGk=' }, expected: 'aGk=' },
    {
      name: 'a geo point',
      input: { geoPointValue: { latitude: 1.5, longitude: -2.5 } },
      expected: { latitude: 1.5, longitude: -2.5 },
    },
    // Firestore omits a zero coordinate rather than sending 0.
    {
      name: 'a geo point at the origin',
      input: { geoPointValue: {} },
      expected: { latitude: 0, longitude: 0 },
    },
  ];

  for (const { name, input, expected } of cases) {
    it(`decodes ${name}`, () => {
      expect(decodeValue(input)).toEqual(expected);
    });
  }

  it('decodes a timestamp to a Date', () => {
    // `expiresAt` on a checkout session document is written by the Admin SDK
    // as a real Timestamp, so this type is on a path the client reads.
    expect(decodeValue({ timestampValue: '2026-08-18T10:00:00.000Z' })).toEqual(
      new Date('2026-08-18T10:00:00.000Z'),
    );
  });

  it('throws on a value matching none of the eleven types', () => {
    expect(() => decodeValue({ somethingElse: 1 } as unknown as FirestoreValue)).toThrow(
      /Unrecognised Firestore value/,
    );
  });
});

describe('round trips', () => {
  it('round-trips a leaderboard entry', () => {
    const entry = {
      uid: 'user-1',
      name: 'Ada',
      score: 8,
      totalQuestions: 10,
      percentage: 80,
      createdAt: 1_755_000_000_000,
      timeLimit: '15',
    };
    expect(decodeFields(encodeFields(entry))).toEqual(entry);
  });

  it('round-trips a custom question, string array and all', () => {
    const question = {
      category: 'Science',
      type: 'multiple',
      difficulty: 'easy',
      question: 'Q?',
      correct_answer: 'A',
      incorrect_answers: ['B', 'C', 'D'],
      createdBy: 'user-1',
      createdAt: 1_755_000_000_000,
    };
    expect(decodeFields(encodeFields(question))).toEqual(question);
  });

  it('round-trips a subscription mirror carrying a null role', () => {
    // The H6 shape: an active subscription whose price has no `firebaseRole`
    // metadata mirrors with `role: null`, and null must survive as null rather
    // than becoming undefined — the client's Pro check compares against 'pro'.
    const mirror = {
      status: 'active',
      role: null,
      price: 'price_1',
      product: 'prod_1',
      cancel_at_period_end: false,
      eventCreated: 1_755_000_000,
    };
    expect(decodeFields(encodeFields(mirror))).toEqual(mirror);
  });
});
