import { integer, sqliteTable } from "drizzle-orm/sqlite-core";

export const runtimeMigrationSmoke = sqliteTable("runtime_migration_smoke", {
  singleton: integer("singleton").primaryKey(),
  applied: integer("applied").notNull().default(1)
});
