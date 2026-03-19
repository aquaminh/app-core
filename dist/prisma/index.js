/**
 * Create a singleton PrismaClient instance.
 *
 * In development, the client is stored on globalThis to survive HMR reloads.
 * The app must pass its own PrismaClient constructor since each app has its own
 * generated Prisma client with different models.
 *
 * @param PrismaClientClass - The PrismaClient class from '@prisma/client'
 * @param options - Optional Prisma client options (e.g., log levels)
 */
export function createPrismaClient(PrismaClientClass, options) {
    const globalForPrisma = globalThis;
    const client = globalForPrisma.__storeCorePrisma ??
        new PrismaClientClass(options?.log
            ? { log: options.log }
            : undefined);
    if (process.env.NODE_ENV !== 'production') {
        globalForPrisma.__storeCorePrisma = client;
    }
    return client;
}
//# sourceMappingURL=index.js.map