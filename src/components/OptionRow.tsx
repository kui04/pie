import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Check } from "lucide-react";
import { motion } from "motion/react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";

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
                row: "rounded-lg py-2 px-3 data-[state=checked]:bg-surface-container-highest",
                pill: [
                    "rounded-md py-2 px-3 data-[state=checked]:bg-surface-container-highest",
                    "data-[state=unchecked]:bg-surface-container-high",
                    "data-[state=unchecked]:text-muted-foreground",
                    "[&_[data-slot=radio-group-indicator]]:hidden",
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
                <motion.span
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ type: "tween", duration: 0.15 }}
                    className="flex"
                >
                    <Check className="size-4" />
                </motion.span>
            </RadioGroupPrimitive.Indicator>
        </RadioGroupPrimitive.Item>
    );
}

export { OptionRow };
