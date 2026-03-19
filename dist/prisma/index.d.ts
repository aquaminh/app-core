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
export declare function createPrismaClient<T>(PrismaClientClass: new (options?: any) => T, options?: Record<string, unknown>): T;
//# sourceMappingURL=index.d.ts.map