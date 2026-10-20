/**
 * One dialog of an extension, as a person sees it: a choice, a confirmation, a
 * line of text, or a multi-line editor.
 *
 * The request is pi's own `RpcExtensionUIRequest`. A dismissal is an answer too:
 * closing the dialog sends `cancelled`, so an extension does not wait for a
 * question that nobody can see. The four methods share one shell and one answer
 * guard; only the body and the keys differ.
 */

import {
    useEffect,
    useRef,
    useState,
    type ComponentProps,
    type KeyboardEvent,
    type ReactNode,
    type RefObject,
    type SubmitEvent,
} from "react";
import { Check } from "lucide-react";
import { cn } from "cn";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    Drawer,
    DrawerContent,
    DrawerDescription,
    DrawerFooter,
    DrawerTitle,
    Input as InputField,
    Textarea as EditorField,
} from "@/components/ui";
import { Icon, ScrollPane } from "@/components";
import { useIsMobile, useKeyboardInset } from "@/hooks";
import type { ExtensionAnswer } from "@/lib/bridge";
import type { ExtensionUIRequest } from "@/lib/rpc-protocol";

type DialogRequest = Extract<ExtensionUIRequest, { method: "select" | "confirm" | "input" | "editor" }>;
type SelectRequest = Extract<DialogRequest, { method: "select" }>;
type ConfirmRequest = Extract<DialogRequest, { method: "confirm" }>;
type InputRequest = Extract<DialogRequest, { method: "input" }>;
type EditorRequest = Extract<DialogRequest, { method: "editor" }>;

interface PromptProps<T extends DialogRequest> {
    request: T;
    onAnswer: (answer: ExtensionAnswer) => void;
    mobile: boolean;
}

export interface ExtensionPromptProps {
    /** The request at the head of the queue, or null while none waits. */
    request: ExtensionUIRequest | null;
    onAnswer: (answer: ExtensionAnswer) => void;
    /** Pins the layout, for a story or a test. */
    isMobile?: boolean;
}

function isDialog(request: ExtensionUIRequest): request is DialogRequest {
    return (
        request.method === "select" ||
        request.method === "confirm" ||
        request.method === "input" ||
        request.method === "editor"
    );
}

export function ExtensionPrompt({ request, onAnswer, isMobile }: ExtensionPromptProps) {
    const mobileIs = useIsMobile();
    const mobile = isMobile ?? mobileIs;
    if (request === null || !isDialog(request)) return null;
    switch (request.method) {
        case "select":
            return <Select key={request.id} request={request} onAnswer={onAnswer} mobile={mobile} />;
        case "confirm":
            return <Confirm key={request.id} request={request} onAnswer={onAnswer} mobile={mobile} />;
        case "input":
            return <Input key={request.id} request={request} onAnswer={onAnswer} mobile={mobile} />;
        case "editor":
            return <Editor key={request.id} request={request} onAnswer={onAnswer} mobile={mobile} />;
    }
}

function usePromptAnswer(onAnswer: (answer: ExtensionAnswer) => void) {
    const [answered, setAnswered] = useState(false);
    const finish = (answer: ExtensionAnswer) => {
        if (answered) return;
        setAnswered(true);
        onAnswer(answer);
    };
    return { finish, cancel: () => finish({ type: "cancelled" }) };
}

function Select({ request, onAnswer, mobile }: PromptProps<SelectRequest>) {
    const { finish, cancel } = usePromptAnswer(onAnswer);
    const [cursor, setCursor] = useState(0);
    const list = useRef<HTMLDivElement>(null);
    const lit = request.options.length === 0 ? -1 : Math.min(cursor, request.options.length - 1);

    useEffect(() => {
        const row = document.getElementById(`extension-select-row-${lit}`);
        row?.scrollIntoView({ block: "nearest" });
    }, [lit]);

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (request.options.length === 0) return;
            event.preventDefault();
            setCursor((current) => {
                const at =
                    (current + (event.key === "ArrowDown" ? 1 : -1) + request.options.length) % request.options.length;
                return at;
            });
            return;
        }
        if (event.key === "Enter" && lit >= 0) {
            event.preventDefault();
            finish({ type: "value", value: request.options[lit] });
        }
    };

    const confirm = () => {
        if (lit >= 0) finish({ type: "value", value: request.options[lit] });
    };

    return (
        <PromptFrame
            title={request.title}
            mobile={mobile}
            onCancel={cancel}
            initialFocus={list}
            actions={
                <>
                    <PromptButton mobile={mobile} variant="outline" onClick={cancel}>
                        Cancel
                    </PromptButton>
                    <PromptButton mobile={mobile} disabled={lit < 0} onClick={confirm}>
                        Confirm
                    </PromptButton>
                </>
            }
        >
            <ScrollPane
                id="extension-select-scroll"
                className="min-h-0"
                viewportClassName={mobile ? "max-h-96" : "max-h-64"}
                bars="vertical"
            >
                {request.options.length === 0 ? (
                    <p className="px-2 py-1 text-body-md text-muted-foreground">No options.</p>
                ) : (
                    <div
                        ref={list}
                        role="listbox"
                        id="extension-select-options"
                        aria-label={request.title}
                        tabIndex={0}
                        autoFocus
                        onKeyDown={onKeyDown}
                        className="flex flex-col gap-1 outline-none"
                    >
                        {request.options.map((option, index) => (
                            <button
                                key={`${option}-${index}`}
                                type="button"
                                id={`extension-select-row-${index}`}
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
        </PromptFrame>
    );
}

function Confirm({ request, onAnswer, mobile }: PromptProps<ConfirmRequest>) {
    const { finish, cancel } = usePromptAnswer(onAnswer);
    return (
        <PromptFrame
            title={request.title}
            description={request.message}
            mobile={mobile}
            onCancel={cancel}
            actions={
                <>
                    <PromptButton mobile={mobile} variant="outline" onClick={cancel}>
                        Cancel
                    </PromptButton>
                    <PromptButton mobile={mobile} onClick={() => finish({ type: "confirmed", confirmed: true })}>
                        Confirm
                    </PromptButton>
                </>
            }
        />
    );
}

function Input({ request, onAnswer, mobile }: PromptProps<InputRequest>) {
    const [value, setValue] = useState("");
    const { finish, cancel } = usePromptAnswer(onAnswer);
    const submit = (event: SubmitEvent<HTMLFormElement>) => {
        event.preventDefault();
        finish({ type: "value", value });
    };
    return (
        <PromptFrame
            title={request.title}
            mobile={mobile}
            onCancel={cancel}
            actions={
                <>
                    <PromptButton mobile={mobile} type="button" variant="outline" onClick={cancel}>
                        Cancel
                    </PromptButton>
                    <PromptButton mobile={mobile} type="submit" form="extension-prompt-form">
                        Send
                    </PromptButton>
                </>
            }
        >
            <form id="extension-prompt-form" className="flex flex-col gap-3" onSubmit={submit}>
                <InputField
                    id="extension-prompt-input"
                    autoFocus
                    value={value}
                    placeholder={request.placeholder}
                    onChange={(event) => setValue(event.target.value)}
                    className="focus-visible:ring-0"
                />
            </form>
        </PromptFrame>
    );
}

function Editor({ request, onAnswer, mobile }: PromptProps<EditorRequest>) {
    const [value, setValue] = useState(request.prefill ?? "");
    const { finish, cancel } = usePromptAnswer(onAnswer);
    const submit = (event: SubmitEvent<HTMLFormElement>) => {
        event.preventDefault();
        finish({ type: "value", value });
    };
    return (
        <PromptFrame
            title={request.title}
            mobile={mobile}
            onCancel={cancel}
            actions={
                <>
                    <PromptButton mobile={mobile} type="button" variant="outline" onClick={cancel}>
                        Cancel
                    </PromptButton>
                    <PromptButton mobile={mobile} type="submit" form="extension-prompt-form">
                        Save
                    </PromptButton>
                </>
            }
        >
            <form id="extension-prompt-form" className="flex flex-col gap-3" onSubmit={submit}>
                <EditorField
                    id="extension-prompt-editor"
                    autoFocus
                    rows={8}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    className="min-h-40 resize-y focus-visible:ring-0"
                />
            </form>
        </PromptFrame>
    );
}

function PromptButton({ mobile, className, children, ...props }: ComponentProps<typeof Button> & { mobile: boolean }) {
    return (
        <Button className={cn(mobile ? "h-10 flex-1" : "rounded-lg px-4 py-3", className)} {...props}>
            <span className="text-label-lg font-medium">{children}</span>
        </Button>
    );
}

function PromptFrame({
    title,
    description,
    mobile,
    onCancel,
    children,
    actions,
    initialFocus,
}: {
    title: string;
    description?: string;
    mobile: boolean;
    onCancel: () => void;
    children?: ReactNode;
    actions: ReactNode;
    initialFocus?: RefObject<HTMLElement | null>;
}) {
    const keyboardInset = useKeyboardInset();
    if (mobile) {
        return (
            <Drawer
                open
                onOpenChange={(open) => (!open ? onCancel() : undefined)}
                swipeDirection="down"
                showSwipeHandle
            >
                <DrawerContent
                    initialFocus={initialFocus}
                    className="gap-4 border-border px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] outline-none"
                    aria-describedby={description !== undefined ? "extension-prompt-sheet-message" : undefined}
                    style={
                        keyboardInset > 0
                            ? { paddingBottom: `calc(1.5rem + env(safe-area-inset-bottom) + ${keyboardInset}px)` }
                            : undefined
                    }
                >
                    <DrawerTitle>{title}</DrawerTitle>
                    {description !== undefined && (
                        <DrawerDescription id="extension-prompt-sheet-message" className="mt-4 text-muted-foreground">
                            {description}
                        </DrawerDescription>
                    )}
                    {children}
                    <DrawerFooter className="mt-8 flex flex-row gap-4 p-0">{actions}</DrawerFooter>
                </DrawerContent>
            </Drawer>
        );
    }

    return (
        <Dialog open onOpenChange={(open) => (!open ? onCancel() : undefined)}>
            <DialogContent
                showCloseButton={false}
                initialFocus={initialFocus}
                className="rounded-xl border border-border bg-card p-6 text-foreground"
                aria-describedby={description !== undefined ? "extension-prompt-dialog-message" : undefined}
            >
                <DialogTitle className="text-body-md font-normal">{title}</DialogTitle>
                {description !== undefined && (
                    <DialogDescription
                        id="extension-prompt-dialog-message"
                        className="text-body-md text-muted-foreground"
                    >
                        {description}
                    </DialogDescription>
                )}
                {children}
                <DialogFooter className="mt-0 flex flex-row justify-end gap-4 border-0 bg-transparent">
                    {actions}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
