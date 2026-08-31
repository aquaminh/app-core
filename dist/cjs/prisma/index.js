"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPrismaClient = createPrismaClient;
/**
 * Create a singleton PrismaClient instance.
 *
 * In development, the client is stored on globalThis to survive HMR reloads.
 * The app must pass its own PrismaClient constructor since each app has its own
 * generated Prisma client with different models.
 *
 * @param PrismaClientClass - The PrismaClient class from '@prisma/client'
 * @param options - Constructor options passed directly to PrismaClient
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createPrismaClient(PrismaClientClass, options) {
    const globalForPrisma = globalThis;
    const client = globalForPrisma.__appCorePrisma ??
        new PrismaClientClass(options);
    if (process.env.NODE_ENV !== 'production') {
        globalForPrisma.__appCorePrisma = client;
    }
    return client;
}
