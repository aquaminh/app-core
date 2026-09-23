/**
 * Read the bearer credential out of an Authorization header.
 *
 * Same regex as zeebrar's original `extractBearer` so behaviour is identical:
 * the scheme is case-insensitive, surrounding whitespace is ignored, and any
 * other scheme (Basic, Token, ...) yields null.
 */
export declare function extractBearer(authorization: string | null | undefined): string | null;
//# sourceMappingURL=bearer.d.ts.map