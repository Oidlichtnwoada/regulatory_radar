import { defineConfig } from 'prisma/config';

/** Prisma CLI configuration: schema, migrations and the connection string from DATABASE_URL. */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? 'postgresql://radar:radar@localhost:5432/radar' },
});
