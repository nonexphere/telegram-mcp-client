import { PrismaClient } from '@prisma/client';

let prismaInstance: PrismaClient | null = null;

export async function initDb(): Promise<PrismaClient> {
  if (prismaInstance) {
    return prismaInstance;
  }
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

export async function getDb(): Promise<PrismaClient> {
  if (!prismaInstance) {
    return await initDb();
  }
  return prismaInstance;
}

export async function closeDb(): Promise<void> {
  if (prismaInstance) {
    await prismaInstance.$disconnect();
    prismaInstance = null;
    console.log('Prisma Client disconnected.');
  }
}
