import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/meta-db/schema.ts',
  out: './drizzle',
  casing: 'snake_case',
});
