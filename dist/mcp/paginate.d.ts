/**
 * The list envelope every MCP list tool returns, so agents page the same way
 * across apps: `has_more` plus `next_offset` (present only when there is a
 * next page). Mirrors zeebrar's `page()` helper.
 */
export interface Page<T> {
    total: number;
    count: number;
    offset: number;
    items: T[];
    has_more: boolean;
    next_offset?: number;
}
export declare function paginate<T>(items: T[], total: number, offset: number): Page<T>;
//# sourceMappingURL=paginate.d.ts.map