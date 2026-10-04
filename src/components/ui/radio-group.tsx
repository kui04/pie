import * as React from "react";
import { cn } from "cn";
import { Check } from "lucide-react";
import { motion } from "motion/react";
import { cva, type VariantProps } from "class-variance-authority";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { SWAP } from "@/lib/motion";

// Upstream draws a dot in a circle; an option here is a row or a pill, and the
// check is the indicator. `shadcn add radio-group --diff` re-merges the rest.
const radioGroupItemVariants = cva(
    "flex w-full items-center justify-between gap-2 border border-transparent text-start outline-none transition-colors duration-50 ease-in-out hover:bg-surface-container-highest focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
    {
        variants: {
            variant: {
                row: "rounded-lg py-2 px-3 data-[state=checked]:bg-surface-container-highest",
                pill: "rounded-md py-2 px-3 data-[state=checked]:bg-surface-container-highest data-[state=unchecked]:bg-surface-container-high data-[state=unchecked]:text-muted-foreground [&_[data-slot=radio-group-indicator]]:hidden",
            },
        },
        defaultVariants: {
            variant: "row",
        },
    },
);

function RadioGroup({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
    return (
        <RadioGroupPrimitive.Root data-slot="radio-group" className={cn("grid w-full gap-2", className)} {...props} />
    );
}

function RadioGroupItem({
    className,
    variant,
    children,
    ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item> & VariantProps<typeof radioGroupItemVariants>) {
    return (
        <RadioGroupPrimitive.Item
            data-slot="radio-group-item"
            className={cn(radioGroupItemVariants({ variant, className }))}
            {...props}
        >
            {children}
            <RadioGroupPrimitive.Indicator
                data-slot="radio-group-indicator"
                className="text-primary flex size-4 items-center justify-center"
            >
                {/* Radix mounts the indicator itself, so the arrival is
                    animated here rather than on the indicator: Motion treats a
                    freshly mounted element as an entrance, and the row's own
                    background is already carrying the rest of the change. */}
                <motion.span
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={SWAP}
                    className="flex"
                >
                    <Check className="size-4" />
                </motion.span>
            </RadioGroupPrimitive.Indicator>
        </RadioGroupPrimitive.Item>
    );
}

export { RadioGroup, RadioGroupItem, radioGroupItemVariants };
