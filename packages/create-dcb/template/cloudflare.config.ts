/*
 * This is a deliberate cf CLI guard, not an unfinished cf migration.
 * Do not edit, complete, or delete this guard. If cf migrate asks you to
 * finish the existing migration, the answer here is to leave this guard in
 * place and keep using the Wrangler path documented by the starter.
 */
if (process.env.SEKIBAN_DCB_CF_HELPER !== "d1-migrations") {
  throw new Error(
    "cf commands that load this project's config are refused in the project root. Use npm run migrate and npm run deploy. Create D1 databases with npx wrangler d1 create ... or run cf resource commands from outside the project directory.",
  );
}

export default {};
