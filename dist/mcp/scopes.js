export function defineScopes(all) {
    if (!Array.isArray(all) || all.length === 0) {
        throw new TypeError('[app-core/mcp] defineScopes needs a non-empty scope list');
    }
    const vocabulary = new Set();
    for (const scope of all) {
        if (typeof scope !== 'string' || !scope) {
            throw new TypeError('[app-core/mcp] every scope must be a non-empty string');
        }
        if (vocabulary.has(scope)) {
            throw new TypeError(`[app-core/mcp] duplicate scope "${scope}"`);
        }
        vocabulary.add(scope);
    }
    const frozen = Object.freeze([...all]);
    const is = (value) => typeof value === 'string' && vocabulary.has(value);
    return {
        all: frozen,
        is,
        parse(values) {
            if (!Array.isArray(values))
                return [];
            const given = new Set(values);
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
//# sourceMappingURL=scopes.js.map