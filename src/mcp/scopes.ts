/**
 * A closed scope vocabulary for MCP tokens.
 *
 * Stored token rows can carry scopes that a later release retired, so every
 * read goes through parse(), which drops unknown values instead of trusting
 * the column.
 */
export interface ScopeSet<S extends string> {
  readonly all: readonly S[];
  is(value: string): value is S;
  /** Drops unknown values (stored rows may carry retired scopes), dedupes, keeps vocabulary order. */
  parse(values: readonly string[]): S[];
  has(granted: readonly S[], required: S): boolean;
  missing(granted: readonly S[], required: readonly S[]): S[];
}

export function defineScopes<const S extends string>(all: readonly S[]): ScopeSet<S> {
  if (!Array.isArray(all) || all.length === 0) {
    throw new TypeError('[app-core/mcp] defineScopes needs a non-empty scope list');
  }
  const vocabulary = new Set<string>();
  for (const scope of all) {
    if (typeof scope !== 'string' || !scope) {
      throw new TypeError('[app-core/mcp] every scope must be a non-empty string');
    }
    if (vocabulary.has(scope)) {
      throw new TypeError(`[app-core/mcp] duplicate scope "${scope}"`);
    }
    vocabulary.add(scope);
  }
  const frozen = Object.freeze([...all]) as readonly S[];

  const is = (value: string): value is S => typeof value === 'string' && vocabulary.has(value);

  return {
    all: frozen,
    is,
    parse(values) {
      if (!Array.isArray(values)) return [];
      const given = new Set<unknown>(values);
      return frozen.filter((scope) => given.has(scope));
    },
    has(granted, required) {
      return granted.includes(required);
    },
    missing(granted, required) {
      return required.filter((scope) => !granted.includes(scope));
    },
  };
}
