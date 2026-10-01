/**
 * The class-merge helper shadcn components import as `@/lib/utils`.
 *
 * The implementation is the `cn` package (the shadcn registry's own
 * clsx + tailwind-merge replacement); this file exists so the `utils` alias in
 * `components.json` resolves to the same helper the registry's package imports
 * use, instead of a second, parallel implementation.
 */
export { cn } from "cn";
