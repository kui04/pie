import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Check } from "lucide-react";
import { motion } from "motion/react";
import { useMotion } from "@/hooks/useMotion";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";

const optionRowVariants = cva(
    [
        "flex w-full items-center justify-between gap-2",
        "border border-transparent text-start outline-none",
        "transition-colors duration-50 ease-in-out hover:bg-surface-container-highest",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0",
    ],
    {
        variants: {
            variant: {
                row: "rounded-lg px-3 py-2 data-checked:bg-surface-container-highest",
                pill: [
                    "rounded-md px-3 py-2 data-checked:bg-surface-container-highest",
                    "data-unchecked:bg-surface-container-high",
                    "data-unchecked:text-muted-foreground",
                    "**:data-[slot=radio-group-indicator]:hidden",
                ],
            },
        },
        defaultVariants: {
            variant: "row",
        },
    },
);

function OptionRow({
    className,
    variant,
    children,
    ...props
}: RadioPrimitive.Root.Props & VariantProps<typeof optionRowVariants>) {
    const { swap } = useMotion();

    return (
        // A real button, not the primitive's span: the card locks the form
        // with a disabled fieldset, which only reaches a form control. A span
        // would stay focused and clickable behind the lock.
        <RadioPrimitive.Root
            data-slot="radio-group-item"
            className={cn(optionRowVariants({ variant, className }))}
            render={<button type="button" />}
            nativeButton
            {...props}
        >
            {children}
            <RadioPrimitive.Indicator
                data-slot="radio-group-indicator"
                className="flex size-4 items-center justify-center text-primary-text"
            >
                <motion.span className="flex" {...swap}>
                    <Check className="size-4" />
                </motion.span>
            </RadioPrimitive.Indicator>
        </RadioPrimitive.Root>
    );
}

export { OptionRow };
