/**
 * A question with two answers, in the app's dialog or sheet. The caller owns the
 * work behind the answer; this only draws the keys and reports the choice.
 */

import type { ReactNode } from "react";
import { DialogFrame, type DialogFrameProps } from "./DialogFrame";
import { DialogAction } from "./DialogAction";

export interface ConfirmDialogProps extends Omit<DialogFrameProps, "title" | "children" | "actions"> {
    title: ReactNode;
    description?: ReactNode;

    confirmLabel: string;
    confirmVariant?: "default" | "destructive";
    confirmDisabled?: boolean;
    confirmId?: string;

    cancelLabel?: string;
    cancelId?: string;

    onConfirm: () => void;
}

export function ConfirmDialog({
    title,
    description,
    confirmLabel,
    confirmVariant = "default",
    confirmDisabled = false,
    confirmId,
    cancelLabel = "Cancel",
    cancelId,
    onConfirm,
    ...frame
}: ConfirmDialogProps) {
    return (
        <DialogFrame
            {...frame}
            title={title}
            description={description}
            actions={
                <>
                    <DialogAction id={cancelId} variant="outline" onClick={() => frame.onOpenChange(false)}>
                        {cancelLabel}
                    </DialogAction>
                    <DialogAction
                        id={confirmId}
                        variant={confirmVariant}
                        disabled={confirmDisabled}
                        onClick={onConfirm}
                    >
                        {confirmLabel}
                    </DialogAction>
                </>
            }
        />
    );
}
