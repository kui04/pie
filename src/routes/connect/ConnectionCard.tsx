import { cn } from "cn";
import { AnimatePresence, motion } from "motion/react";
import { useMotion } from "@/hooks";
import { Check, HardDrive, FolderOpen, Loader2, Plug, Server } from "lucide-react";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { Button, Card, Input, Label, RadioGroup, Textarea } from "@/components/ui";
import { Icon, ScrollPane, TruncatedText } from "@/components";

export type Transport = "local" | "ssh";
export type AuthMethod = "password" | "key";

export interface ConnectionForm {
    transport: Transport;
    auth: AuthMethod;
    /** `user@host`, `user@host:port`, or a bracketed IPv6 literal. */
    address: string;
    password: string;
    /** The private key itself, pasted in or brought back by the picker. */
    privateKeyMaterial: string;
    /** Only for a key that is encrypted; pie never stores it. */
    passphrase: string;
}

export interface ConnectionCardProps {
    form: ConnectionForm;
    /** A dial is in flight, so the form is locked and the key shows a busy look. */
    connecting: boolean;
    /** Nothing to connect to yet, which is the only reason Connect stays off. */
    canConnect: boolean;
    /** What the card still waits for, or `null` when it waits for nothing. */
    missing: string | null;
    onChange: (patch: Partial<ConnectionForm>) => void;
    onConnect: () => void;
    /** Opens the picker and drops whatever it brought back into the form. */
    onPickKey: () => void;
}

function RadioChoice({
    className,
    children,
    showCheck = true,
    ...props
}: RadioPrimitive.Root.Props & { showCheck?: boolean }) {
    const { swap } = useMotion();

    return (
        // A real button, not the primitive's span: the card locks the form
        // with a disabled fieldset, which only reaches a form control. A span
        // would stay focused and clickable behind the lock.
        <RadioPrimitive.Root
            data-slot="radio-group-item"
            className={cn(
                "flex w-full items-center gap-2 border border-transparent px-3 py-2 text-start outline-none",
                "transition-colors hover:bg-accent/50 focus-visible:border-primary disabled:opacity-50",
                className,
            )}
            render={<button type="button" />}
            nativeButton
            {...props}
        >
            {children}
            {showCheck && (
                <RadioPrimitive.Indicator
                    data-slot="radio-group-indicator"
                    className="flex size-4 items-center justify-center text-primary-text"
                >
                    <motion.span className="flex" {...swap}>
                        <Icon>
                            <Check />
                        </Icon>
                    </motion.span>
                </RadioPrimitive.Indicator>
            )}
        </RadioPrimitive.Root>
    );
}

export function ConnectionCard({
    form,
    connecting,
    canConnect,
    missing,
    onChange,
    onConnect,
    onPickKey,
}: ConnectionCardProps) {
    const ssh = form.transport === "ssh";
    const { slot, swap, reveal, fade } = useMotion();

    return (
        <Card
            id="connection-card-root"
            // Grid, not a flex column: a card capped by `max-h-full` has no definite
            // height, so a percentage viewport inside it sizes to its content and paints
            // the form over the footer. Resolved grid tracks are definite.
            className="
                grid max-h-full min-h-0 w-full max-w-104 grid-rows-[minmax(0,1fr)_auto] overflow-hidden rounded-xl
                bg-card shadow-sm
            "
        >
            <ScrollPane id="connection-card-scroll" className="min-h-0">
                <div className="flex flex-col gap-6 px-6 pt-6">
                    <header id="connection-card-header" className="flex flex-col gap-4">
                        <h1 id="connection-card-title" className="text-title-lg font-medium">
                            Connect to pi
                        </h1>
                        <p id="connection-card-subcopy" className="text-body-sm text-muted-foreground">
                            Pie opens the sessions of a pi that is already installed on the machine you point at.
                        </p>
                    </header>
                    <motion.fieldset
                        id="connection-card-lock"
                        disabled={connecting}
                        className={cn("flex min-w-0 flex-col gap-6", connecting && "pointer-events-none")}
                        initial={false}
                        {...fade(connecting ? 0.6 : 1)}
                    >
                        <RadioGroup
                            id="connection-card-transports"
                            value={form.transport}
                            onValueChange={(value) => onChange({ transport: value as Transport })}
                            className="flex flex-col gap-2"
                        >
                            <RadioChoice
                                id="connection-card-transport-local"
                                value="local"
                                className="rounded-lg data-checked:bg-surface-container-highest"
                            >
                                <Icon className="text-muted-foreground">
                                    <HardDrive id="connection-card-transport-local-icon" />
                                </Icon>
                                <span
                                    id="connection-card-transport-local-text"
                                    className="flex min-w-0 flex-1 flex-col ps-2 text-start"
                                >
                                    <span
                                        id="connection-card-transport-local-name"
                                        className="text-title-sm font-semibold"
                                    >
                                        Local process
                                    </span>
                                    <TruncatedText
                                        id="connection-card-transport-local-desc"
                                        className="text-body-sm text-muted-foreground"
                                        offset={{ top: 6, right: 12, bottom: 6, left: 12 }}
                                    >
                                        Spawn pi here
                                    </TruncatedText>
                                </span>
                            </RadioChoice>

                            <RadioChoice
                                id="connection-card-transport-ssh"
                                value="ssh"
                                className="rounded-lg data-checked:bg-surface-container-highest"
                            >
                                <Icon className="text-muted-foreground">
                                    <Server id="connection-card-transport-ssh-icon" />
                                </Icon>
                                <span
                                    id="connection-card-transport-ssh-text"
                                    className="flex min-w-0 flex-1 flex-col ps-2 text-start"
                                >
                                    <span
                                        id="connection-card-transport-ssh-name"
                                        className="text-title-sm font-semibold"
                                    >
                                        SSH
                                    </span>
                                    <TruncatedText
                                        id="connection-card-transport-ssh-desc"
                                        className="text-body-sm text-muted-foreground"
                                        offset={{ top: 6, right: 12, bottom: 6, left: 12 }}
                                    >
                                        Connect to a remote host
                                    </TruncatedText>
                                </span>
                            </RadioChoice>
                        </RadioGroup>

                        <AnimatePresence initial={false}>
                            {ssh && (
                                <motion.div key="ssh" className="flex flex-col gap-6 overflow-hidden" {...reveal}>
                                    <div id="connection-card-address-row" className="flex flex-col gap-2">
                                        <Label
                                            id="connection-card-address-label"
                                            htmlFor="connection-card-address"
                                            className="text-label-md text-muted-foreground"
                                        >
                                            Address
                                        </Label>
                                        <Input
                                            id="connection-card-address"
                                            value={form.address}
                                            onChange={(event) => onChange({ address: event.target.value })}
                                            onFocus={(event) =>
                                                event.currentTarget.scrollIntoView({ block: "nearest" })
                                            }
                                            placeholder="pi@192.168.1.10:22"
                                            autoCapitalize="none"
                                            autoCorrect="off"
                                            autoComplete="off"
                                            spellCheck={false}
                                            enterKeyHint="next"
                                            className="
                                                h-12 w-full border-border-strong bg-surface-container-highest px-3
                                                font-sans text-code
                                                placeholder:text-outline
                                                focus-visible:ring-0
                                            "
                                        />
                                    </div>

                                    <div id="connection-card-auth" className="flex flex-col gap-4">
                                        <div id="connection-card-auth-method" className="flex flex-col gap-2">
                                            <Label
                                                id="connection-card-auth-label"
                                                className="text-label-md text-muted-foreground"
                                            >
                                                Authentication Method
                                            </Label>
                                            <RadioGroup
                                                id="connection-card-auth-pills"
                                                value={form.auth}
                                                onValueChange={(value) => onChange({ auth: value as AuthMethod })}
                                                className="flex gap-2"
                                            >
                                                <RadioChoice
                                                    id="connection-card-auth-password"
                                                    value="password"
                                                    className="
                                                        rounded-md bg-surface-container-high text-muted-foreground
                                                        data-checked:bg-surface-container-highest
                                                        data-checked:text-foreground
                                                    "
                                                    showCheck={false}
                                                >
                                                    <span
                                                        id="connection-card-auth-password-label"
                                                        className="text-label-lg font-medium"
                                                    >
                                                        Password
                                                    </span>
                                                </RadioChoice>
                                                <RadioChoice
                                                    id="connection-card-auth-key"
                                                    value="key"
                                                    className="
                                                        rounded-md bg-surface-container-high text-muted-foreground
                                                        data-checked:bg-surface-container-highest
                                                        data-checked:text-foreground
                                                    "
                                                    showCheck={false}
                                                >
                                                    <span
                                                        id="connection-card-auth-key-label"
                                                        className="text-label-lg font-medium"
                                                    >
                                                        Private key
                                                    </span>
                                                </RadioChoice>
                                            </RadioGroup>
                                        </div>

                                        {form.auth === "password" ? (
                                            <div
                                                id="connection-card-credential-password"
                                                className="flex flex-col gap-2"
                                            >
                                                <Label
                                                    id="connection-card-credential-password-label"
                                                    htmlFor="connection-card-password"
                                                    className="text-label-md text-muted-foreground"
                                                >
                                                    Password
                                                </Label>
                                                <Input
                                                    id="connection-card-password"
                                                    type="password"
                                                    value={form.password}
                                                    onChange={(event) => onChange({ password: event.target.value })}
                                                    onFocus={(event) =>
                                                        event.currentTarget.scrollIntoView({ block: "nearest" })
                                                    }
                                                    placeholder="Enter password"
                                                    autoCapitalize="none"
                                                    autoCorrect="off"
                                                    autoComplete="current-password"
                                                    spellCheck={false}
                                                    enterKeyHint="next"
                                                    className="
                                                        h-12 w-full border-border-strong bg-surface-container-highest
                                                        px-3 font-sans text-code
                                                        placeholder:text-outline
                                                        focus-visible:ring-0
                                                    "
                                                />
                                            </div>
                                        ) : (
                                            <div id="connection-card-credential-key" className="flex flex-col gap-4">
                                                <div className="flex flex-col gap-2">
                                                    <Label
                                                        id="connection-card-key-label"
                                                        htmlFor="connection-card-key"
                                                        className="text-label-md text-muted-foreground"
                                                    >
                                                        Private key
                                                    </Label>
                                                    <Textarea
                                                        id="connection-card-key"
                                                        value={form.privateKeyMaterial}
                                                        onChange={(event) =>
                                                            onChange({ privateKeyMaterial: event.target.value })
                                                        }
                                                        onFocus={(event) =>
                                                            event.currentTarget.scrollIntoView({ block: "nearest" })
                                                        }
                                                        placeholder="Paste the key"
                                                        rows={4}
                                                        autoCapitalize="none"
                                                        autoCorrect="off"
                                                        autoComplete="off"
                                                        spellCheck={false}
                                                        enterKeyHint="enter"
                                                        className="
                                                            field-sizing-fixed w-full min-w-0 resize-none
                                                            border-border-strong bg-surface-container-highest px-3 py-2
                                                            font-mono text-code
                                                            placeholder:text-outline
                                                            focus-visible:ring-0
                                                        "
                                                    />
                                                </div>

                                                <div className="flex flex-col gap-2">
                                                    <Label
                                                        id="connection-card-passphrase-label"
                                                        htmlFor="connection-card-passphrase"
                                                        className="text-label-md text-muted-foreground"
                                                    >
                                                        Passphrase
                                                    </Label>
                                                    <Input
                                                        id="connection-card-passphrase"
                                                        type="password"
                                                        value={form.passphrase}
                                                        onChange={(event) =>
                                                            onChange({ passphrase: event.target.value })
                                                        }
                                                        onFocus={(event) =>
                                                            event.currentTarget.scrollIntoView({ block: "nearest" })
                                                        }
                                                        placeholder="Only if the key is encrypted"
                                                        autoCapitalize="none"
                                                        autoCorrect="off"
                                                        autoComplete="off"
                                                        spellCheck={false}
                                                        enterKeyHint="next"
                                                        className="
                                                            h-12 w-full border-border-strong
                                                            bg-surface-container-highest px-3 font-sans text-code
                                                            placeholder:text-outline
                                                            focus-visible:ring-0
                                                        "
                                                    />
                                                </div>

                                                <Button
                                                    id="connection-card-key-pick"
                                                    type="button"
                                                    variant="outline"
                                                    disabled={connecting}
                                                    onClick={onPickKey}
                                                    className="w-full"
                                                >
                                                    <Icon>
                                                        <FolderOpen aria-hidden />
                                                    </Icon>
                                                    <span className="text-label-lg font-medium">Choose a key file</span>
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </motion.fieldset>
                </div>
            </ScrollPane>

            <div id="connection-card-action" className="flex flex-col gap-4 p-6 pt-0">
                <AnimatePresence initial={false}>
                    {missing !== null && (
                        <motion.p
                            key="missing"
                            id="connection-card-missing"
                            className="text-body-sm text-muted-foreground"
                            {...slot}
                        >
                            {missing}
                        </motion.p>
                    )}
                </AnimatePresence>
                <Button
                    id="connection-card-connect"
                    onClick={onConnect}
                    disabled={connecting || !canConnect}
                    className="h-12 w-full cursor-default rounded-lg bg-primary px-3 hover:bg-primary/90"
                >
                    <AnimatePresence initial={false} mode="popLayout">
                        {connecting ? (
                            <motion.span key="busy" className="flex items-center gap-1.5" {...swap}>
                                <Icon className="animate-spin">
                                    <Loader2 id="connection-card-connect-spinner" />
                                </Icon>
                                <span id="connection-card-connect-busy" className="text-label-lg font-medium">
                                    Connecting
                                </span>
                            </motion.span>
                        ) : (
                            <motion.span key="idle" className="flex items-center gap-1.5" {...swap}>
                                <Icon>
                                    <Plug aria-hidden />
                                </Icon>
                                <span id="connection-card-connect-label" className="text-label-lg font-medium">
                                    Connect
                                </span>
                            </motion.span>
                        )}
                    </AnimatePresence>
                </Button>
            </div>
        </Card>
    );
}
