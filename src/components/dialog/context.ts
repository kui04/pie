import { createContext, useContext } from "react";

export interface DialogFrameContextValue {
    mobile: boolean;
}

export const DialogFrameContext = createContext<DialogFrameContextValue | null>(null);

/** The host a footer key is drawn in. Throws outside a frame, where it has no host. */
export function useDialogFrame(): DialogFrameContextValue {
    const context = useContext(DialogFrameContext);
    if (context === null) throw new Error("useDialogFrame must be used within a DialogFrame.");
    return context;
}
