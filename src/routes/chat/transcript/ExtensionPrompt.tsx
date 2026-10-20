/**
 * One dialog of an extension, as a person sees it: a choice, a confirmation, a
 * line of text, or a multi-line editor.
 *
 * The request is pi's own `RpcExtensionUIRequest`. A dismissal is an answer too:
 * closing the dialog sends `cancelled`, so an extension does not wait for a
 * question that nobody can see. The four methods share one shell and one answer
 * guard; only the body and the keys differ.
 */

import { useState } from "react";
import { ConfirmDialog, SelectDialog, TextDialog } from "@/components";
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
    isMobile?: boolean;
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
    if (request === null || !isDialog(request)) return null;
    switch (request.method) {
        case "select":
            return <Select key={request.id} request={request} onAnswer={onAnswer} isMobile={isMobile} />;
        case "confirm":
            return <Confirm key={request.id} request={request} onAnswer={onAnswer} isMobile={isMobile} />;
        case "input":
            return <Input key={request.id} request={request} onAnswer={onAnswer} isMobile={isMobile} />;
        case "editor":
            return <Editor key={request.id} request={request} onAnswer={onAnswer} isMobile={isMobile} />;
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

function Select({ request, onAnswer, isMobile }: PromptProps<SelectRequest>) {
    const { finish, cancel } = usePromptAnswer(onAnswer);
    return (
        <SelectDialog
            open
            onOpenChange={(next) => {
                if (!next) cancel();
            }}
            isMobile={isMobile}
            id="extension-select"
            title={request.title}
            options={request.options}
            onConfirm={(value) => finish({ type: "value", value })}
        />
    );
}

function Confirm({ request, onAnswer, isMobile }: PromptProps<ConfirmRequest>) {
    const { finish, cancel } = usePromptAnswer(onAnswer);
    return (
        <ConfirmDialog
            open
            onOpenChange={(next) => {
                if (!next) cancel();
            }}
            isMobile={isMobile}
            id="extension-prompt"
            title={request.title}
            description={request.message}
            confirmLabel="Confirm"
            onConfirm={() => finish({ type: "confirmed", confirmed: true })}
        />
    );
}

function Input({ request, onAnswer, isMobile }: PromptProps<InputRequest>) {
    const [value, setValue] = useState("");
    const { finish, cancel } = usePromptAnswer(onAnswer);
    return (
        <TextDialog
            open
            onOpenChange={(next) => {
                if (!next) cancel();
            }}
            isMobile={isMobile}
            id="extension-prompt"
            title={request.title}
            value={value}
            onValueChange={setValue}
            placeholder={request.placeholder}
            fieldId="extension-prompt-input"
            submitLabel="Send"
            onSubmit={() => finish({ type: "value", value })}
        />
    );
}

function Editor({ request, onAnswer, isMobile }: PromptProps<EditorRequest>) {
    const [value, setValue] = useState(request.prefill ?? "");
    const { finish, cancel } = usePromptAnswer(onAnswer);
    return (
        <TextDialog
            open
            onOpenChange={(next) => {
                if (!next) cancel();
            }}
            isMobile={isMobile}
            id="extension-prompt"
            title={request.title}
            value={value}
            onValueChange={setValue}
            fieldId="extension-prompt-editor"
            submitLabel="Save"
            onSubmit={() => finish({ type: "value", value })}
        />
    );
}
