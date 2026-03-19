interface PrismaClientLike {
    $connect(): Promise<void>;
    $disconnect(): Promise<void>;
}
interface CreatePrismaClientOptions {
    log?: string[];
}
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
export declare function createPrismaClient<T extends PrismaClientLike>(PrismaClientClass: new (options?: {
    log?: string[];
}) => T, options?: CreatePrismaClientOptions): T;
export {};
//# sourceMappingURL=index.d.ts.map