/**
 * A line or a block of text in the app's dialog. Both are one field: the same
 * textarea, the same keys, and the same Composer words, so an input and an
 * editor do not grow two shells or two ways to submit. The field opens at one
 * row with the caret at the end of its text, and grows to five rows.
 */

import { useEffect, useId, useRef, type FocusEvent, type KeyboardEvent, type ReactNode, type SubmitEvent } from "react";
import { cn } from "cn";
import { Label, Textarea } from "@/components/ui";
import { DialogFrame, type DialogFrameProps } from "./DialogFrame";
import { DialogAction } from "./DialogAction";

export interface TextDialogProps extends Omit<DialogFrameProps, "children" | "actions"> {
    label?: ReactNode;
    value: string;
    onValueChange: (value: string) => void;
    placeholder?: string;

    submitLabel: string;
    submitDisabled?: boolean;
    onSubmit: () => void;

    fieldId?: string;
    autoComplete?: string;
    textareaClassName?: string;
}

export function TextDialog({
    label,
    value,
    onValueChange,
    placeholder,
    submitLabel,
    submitDisabled = false,
    onSubmit,
    fieldId,
    autoComplete,
    textareaClassName,
    id,
    open,
    ...frame
}: TextDialogProps) {
    const generated = useId();
    const baseId = id ?? generated;
    const formId = `${baseId}-form`;
    const field = fieldId ?? `${baseId}-field`;
    const placed = useRef(false);

    useEffect(() => {
        if (!open) placed.current = false;
    }, [open]);

    const onFocus = (event: FocusEvent<HTMLTextAreaElement>) => {
        if (placed.current) return;
        placed.current = true;
        const end = event.currentTarget.value.length;
        event.currentTarget.setSelectionRange(end, end);
    };

    const submit = (event: SubmitEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!submitDisabled) onSubmit();
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        if (!submitDisabled) onSubmit();
    };

    return (
        <DialogFrame
            {...frame}
            open={open}
            id={baseId}
            actions={
                <>
                    <DialogAction variant="outline" onClick={() => frame.onOpenChange(false)}>
                        Cancel
                    </DialogAction>
                    <DialogAction type="submit" form={formId} disabled={submitDisabled}>
                        {submitLabel}
                    </DialogAction>
                </>
            }
        >
            <form id={formId} className="flex flex-col gap-3" onSubmit={submit}>
                {label !== undefined && <Label htmlFor={field}>{label}</Label>}
                <Textarea
                    id={field}
                    rows={1}
                    value={value}
                    placeholder={placeholder}
                    autoComplete={autoComplete}
                    enterKeyHint="send"
                    onFocus={onFocus}
                    onChange={(event) => onValueChange(event.target.value)}
                    onKeyDown={onKeyDown}
                    className={cn(
                        `
                            block field-sizing-content max-h-32.5 min-h-8.5 resize-none overflow-y-auto rounded-lg
                            border border-input bg-transparent px-3 py-1 text-(length:--text-body-lg) leading-6
                            focus-visible:ring-0
                            md:text-(length:--text-body-lg) md:leading-6
                            dark:bg-transparent
                        `,
                        textareaClassName,
                    )}
                />
            </form>
        </DialogFrame>
    );
}
