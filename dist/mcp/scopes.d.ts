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
export declare function defineScopes<const S extends string>(all: readonly S[]): ScopeSet<S>;
//# sourceMappingURL=scopes.d.ts.map