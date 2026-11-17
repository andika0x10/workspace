import "vitest";
declare module "vitest" {
  export interface ProvidedContext {
    schema: string;
    permanentDeleteMigration: string;
  }
}
