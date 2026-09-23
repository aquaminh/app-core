"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.paginate = exports.ConfirmUnavailableError = exports.hashArgs = exports.canonicalJson = exports.createConfirmGate = exports.McpTokenInputError = exports.createMcpTokens = exports.defineScopes = exports.extractBearer = void 0;
/**
 * Shared building blocks for app MCP servers: bearer parsing, scope
 * vocabularies, hashed agent tokens, the two-phase confirmation gate and the
 * list envelope.
 *
 * Tier-1: node:crypto only. No MCP SDK, no Zod, no next/*, no @prisma/client,
 * no @upstash/* import - Prisma and Redis are injected by the app, and tool
 * handlers, schemas and rate-limit policy stay app-local.
 */
var bearer_js_1 = require("./bearer.js");
Object.defineProperty(exports, "extractBearer", { enumerable: true, get: function () { return bearer_js_1.extractBearer; } });
var scopes_js_1 = require("./scopes.js");
Object.defineProperty(exports, "defineScopes", { enumerable: true, get: function () { return scopes_js_1.defineScopes; } });
var tokens_js_1 = require("./tokens.js");
Object.defineProperty(exports, "createMcpTokens", { enumerable: true, get: function () { return tokens_js_1.createMcpTokens; } });
Object.defineProperty(exports, "McpTokenInputError", { enumerable: true, get: function () { return tokens_js_1.McpTokenInputError; } });
var confirm_js_1 = require("./confirm.js");
Object.defineProperty(exports, "createConfirmGate", { enumerable: true, get: function () { return confirm_js_1.createConfirmGate; } });
Object.defineProperty(exports, "canonicalJson", { enumerable: true, get: function () { return confirm_js_1.canonicalJson; } });
Object.defineProperty(exports, "hashArgs", { enumerable: true, get: function () { return confirm_js_1.hashArgs; } });
Object.defineProperty(exports, "ConfirmUnavailableError", { enumerable: true, get: function () { return confirm_js_1.ConfirmUnavailableError; } });
var paginate_js_1 = require("./paginate.js");
Object.defineProperty(exports, "paginate", { enumerable: true, get: function () { return paginate_js_1.paginate; } });
