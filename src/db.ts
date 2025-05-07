import { PrismaClient } from '@prisma/client';

let prismaInstance: PrismaClient | null = null;

/**
 * Initializes the Prisma Client instance if it hasn't been already.
 * Ensures a connection to the database can be established.
 * Exits the process if initialization fails.
 * @returns A promise resolving to the initialized PrismaClient instance.
 */
export async function initDb(): Promise<PrismaClient> {
  // Return existing instance if already initialized.
  if (prismaInstance) {
    return prismaInstance;
  }

  // Attempt to create and connect the Prisma Client.
  try {
    // Prisma Client automatically handles connection pooling.
    // The schema and database creation are handled by `prisma migrate dev`.
    // This function ensures the PrismaClient instance is created and connected.
    prismaInstance = new PrismaClient();
    await prismaInstance.$connect(); // Explicitly connect to check DB reachability
    console.log('Prisma Client connected to database successfully.');
    return prismaInstance;
  } catch (error) {
    console.error('Failed to initialize Prisma Client:', error);
    process.exit(1);
  }
}

/**
 * Retrieves the singleton Prisma Client instance.
 * Initializes it first if necessary.
 * @returns A promise resolving to the PrismaClient instance.
 */
export async function getDb(): Promise<PrismaClient> {
  if (!prismaInstance) {
    return await initDb();
  }
  return prismaInstance;
}

/**
 * Closes the Prisma Client database connection if it's currently open.
 */

export async function closeDb(): Promise<void> {
  if (prismaInstance) {
    await prismaInstance.$disconnect();
    prismaInstance = null;
    console.log('Prisma Client disconnected.');
  }
}
