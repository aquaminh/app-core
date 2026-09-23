"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.paginate = paginate;
function paginate(items, total, offset) {
    const hasMore = total > offset + items.length;
    return {
        total,
        count: items.length,
        offset,
        items,
        has_more: hasMore,
        ...(hasMore ? { next_offset: offset + items.length } : {}),
    };
}
