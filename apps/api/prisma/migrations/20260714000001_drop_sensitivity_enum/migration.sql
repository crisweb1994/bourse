-- Drop unused Sensitivity enum.
-- No model field references this type; it was defined but never used.
-- The same-named Sensitivity in packages/analysis/src/contracts/source-document.ts
-- is an independent zod schema and is unaffected.
DROP TYPE IF EXISTS "Sensitivity";
