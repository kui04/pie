/**
 * One value from a list, in the app's dialog. A row is selected by a press or
 * an arrow key; the Confirm key is the only thing that answers, so a pointer
 * that passes over the list changes nothing.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import { cn } from "cn";
import { useIsMobile } from "@/hooks";
import { Icon } from "../Icon";
import { ScrollPane } from "../ScrollPane";
import { DialogFrame, type DialogFrameProps } from "./DialogFrame";
import { DialogAction } from "./DialogAction";

export interface SelectDialogProps extends Omit<DialogFrameProps, "children" | "actions"> {
    options: readonly string[];
    confirmLabel?: string;
    cancelLabel?: string;
    emptyLabel?: string;
    initialIndex?: number;
    onConfirm: (value: string) => void;
}

export function SelectDialog({
    title,
    options,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    emptyLabel = "No options.",
    initialIndex = 0,
    onConfirm,
    isMobile,
    id,
    ...frame
}: SelectDialogProps) {
    const mobileIs = useIsMobile();
    const mobile = isMobile ?? mobileIs;
    const generated = useId();
    const baseId = id ?? generated;
    const list = useRef<HTMLDivElement>(null);
    const [cursor, setCursor] = useState(() =>
        options.length === 0 ? -1 : Math.min(Math.max(initialIndex, 0), options.length - 1),
    );
    const lit = options.length === 0 ? -1 : Math.min(cursor, options.length - 1);

    useEffect(() => {
        if (lit < 0) return;
        document.getElementById(`${baseId}-row-${lit}`)?.scrollIntoView({ block: "nearest" });
    }, [baseId, lit]);

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (options.length === 0) return;
            event.preventDefault();
            setCursor((current) => {
                const at = (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
                return at;
            });
            return;
        }
        if (event.key === "Enter" && lit >= 0) {
            event.preventDefault();
            onConfirm(options[lit]);
        }
    };

    const confirm = () => {
        if (lit >= 0) onConfirm(options[lit]);
    };

    return (
        <DialogFrame
            {...frame}
            id={baseId}
            isMobile={mobile}
            title={title}
            initialFocus={list}
            actions={
                <>
                    <DialogAction variant="outline" onClick={() => frame.onOpenChange(false)}>
                        {cancelLabel}
                    </DialogAction>
                    <DialogAction disabled={lit < 0} onClick={confirm}>
                        {confirmLabel}
                    </DialogAction>
                </>
            }
        >
            <ScrollPane
                id={`${baseId}-scroll`}
                className="min-h-0"
                viewportClassName={mobile ? "max-h-96" : "max-h-64"}
                bars="vertical"
            >
                {options.length === 0 ? (
                    <p className="px-2 py-1 text-body-md text-muted-foreground">{emptyLabel}</p>
                ) : (
                    <div
                        ref={list}
                        role="listbox"
                        id={`${baseId}-options`}
                        aria-label={typeof title === "string" ? title : "Options"}
                        tabIndex={0}
                        autoFocus
                        onKeyDown={onKeyDown}
                        className="flex flex-col gap-1 outline-none"
                    >
                        {options.map((option, index) => (
                            <button
                                key={`${option}-${index}`}
                                type="button"
                                id={`${baseId}-row-${index}`}
                                role="option"
                                aria-selected={index === lit}
                                data-lit={index === lit}
                                tabIndex={-1}
                                onClick={() => setCursor(index)}
                                className={cn(
                                    "flex w-full items-center rounded-md px-2 text-left text-body-md outline-none",
                                    "data-[lit=true]:bg-accent/50",
                                    mobile ? "min-h-12" : "min-h-9",
                                )}
                            >
                                <span className="min-w-0 flex-1 truncate">{option}</span>
                                {index === lit && (
                                    <Icon className="shrink-0 text-primary-text">
                                        <Check aria-hidden />
                                    </Icon>
                                )}
                            </button>
                        ))}
                    </div>
                )}
            </ScrollPane>
        </DialogFrame>
    );
}
