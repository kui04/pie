import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Check } from "lucide-react";
import { motion } from "motion/react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { SWAP } from "@/lib/motion";

/**
 * One option a person picks with the arrow keys, drawn as a row of this app's
 * own rather than as the registry's dot in a circle.
 *
 * The registry's `ui/radio-group.tsx` keeps its own indicator and its own
 * children: an option handed to its item is replaced by the dot (verified - the
 * item renders its indicator as JSX, which wins over the `children` a caller
 * spreads in), so there is no way to put a name, an icon and a line of
 * description beside it. This row is the same Radix item, with the check as the
 * indicator and the content as children, and it belongs inside the registry's
 * `RadioGroup` root, which still owns the value and the keyboard.
 *
 * `row` is the default: a full-width choice with a name and a description.
 * `pill` is the compact form for a group of short choices, where the selection
 * shows as the background alone and the check is hidden.
 */
const optionRowVariants = cva(
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

function OptionRow({
    className,
    variant,
    children,
    ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item> & VariantProps<typeof optionRowVariants>) {
    return (
        <RadioGroupPrimitive.Item
            data-slot="radio-group-item"
            className={cn(optionRowVariants({ variant, className }))}
            {...props}
        >
            {children}
            <RadioGroupPrimitive.Indicator
                data-slot="radio-group-indicator"
                className="text-primary-text flex size-4 items-center justify-center"
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

export { OptionRow };
