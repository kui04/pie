/**
 * The connect form: pick a transport, enter the address and the credential,
 * connect — and while the dial is in flight none of that can be changed.
 *
 * Which transport and which credential is picked is plain form state: every
 * combination of it is reachable and none is a step in a sequence. Whether a
 * dial is running is the connection machine's business. Nothing here holds a
 * connection, and nothing here reports a failure.
 */

import { cn } from "cn";
import { AnimatePresence, motion } from "motion/react";
import { HardDrive, FolderOpen, Loader2, Plug, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { SWAP } from "@/lib/motion";

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
    onChange: (patch: Partial<ConnectionForm>) => void;
    onConnect: () => void;
    /** Opens the picker and drops whatever it brought back into the form. */
    onPickKey: () => void;
}

const INPUT_CLASS =
    "border-border-strong bg-surface-container-highest focus-visible:ring-0! h-12 w-full px-3 font-sans text-code";

const TEXTAREA_CLASS =
    "border-border-strong bg-surface-container-highest focus-visible:ring-0! field-sizing-fixed min-w-0 w-full resize-none px-3 py-2 font-mono text-code";

export function ConnectionCard({ form, connecting, canConnect, onChange, onConnect, onPickKey }: ConnectionCardProps) {
    const ssh = form.transport === "ssh";

    return (
        <Card
            id="connection-card-root"
            // `max-h-full min-h-0` rather than growing: the card is capped to the
            // panel and scrolls its own contents, so the frame the person is
            // looking at never slides away and the action row stays put. The panel
            // itself does not scroll at all.
            className="bg-card flex max-h-full min-h-0 w-full max-w-104 flex-col overflow-hidden rounded-xl shadow-sm"
        >
            {/* Plain elements rather than `CardHeader`/`CardDescription`: those
                exist to sit inside a card that has its own chrome, and this card
                has none of its own to give away. */}
            <ScrollArea id="connection-card-scroll" className="min-h-0 flex-1">
                {/* The column is named here, one layer inside the scroll area: Radix
                    scrolls through a layer of its own, so a flex container put on the
                    viewport would never see the header and the form as its children
                    and their gap would go missing. */}
                <div className="flex flex-col gap-6 px-6 pt-6">
                    <header id="connection-card-header" className="flex flex-col gap-2">
                        {/* A real heading, not a div: this card is the gate, and a screen
                    reader should be able to jump to it. */}
                        <h1 id="connection-card-title" className="text-title-lg font-medium">
                            Connect to pi
                        </h1>
                        <p id="connection-card-subcopy" className="text-body-sm text-muted-foreground">
                            One step — pick a transport, enter the address.
                        </p>
                    </header>

                    {/* Everything the person filled in goes inert together while a dial
                runs, so a credential cannot be half-rewritten under a handshake
                that already read the old one. */}
                    <fieldset
                        id="connection-card-lock"
                        disabled={connecting}
                        className={cn(
                            "flex flex-col gap-6 transition-opacity duration-200 ease-in-out",
                            connecting && "pointer-events-none opacity-60",
                        )}
                    >
                        <RadioGroup
                            id="connection-card-transports"
                            value={form.transport}
                            onValueChange={(value) => onChange({ transport: value as Transport })}
                            className="flex flex-col gap-2"
                        >
                            <RadioGroupItem id="connection-card-transport-local" value="local">
                                <HardDrive
                                    id="connection-card-transport-local-icon"
                                    className="text-muted-foreground size-4"
                                />
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
                                    <span
                                        id="connection-card-transport-local-desc"
                                        className="text-body-sm text-muted-foreground truncate"
                                    >
                                        Spawn pi here
                                    </span>
                                </span>
                            </RadioGroupItem>

                            <RadioGroupItem id="connection-card-transport-ssh" value="ssh">
                                <Server
                                    id="connection-card-transport-ssh-icon"
                                    className="text-muted-foreground size-4"
                                />
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
                                    <span
                                        id="connection-card-transport-ssh-desc"
                                        className="text-body-sm text-muted-foreground truncate"
                                    >
                                        User at host
                                    </span>
                                </span>
                            </RadioGroupItem>
                        </RadioGroup>

                        <AnimatePresence initial={false}>
                            {ssh && (
                                <motion.div
                                    key="ssh"
                                    className="flex flex-col gap-6 overflow-hidden"
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: "auto" }}
                                    exit={{ opacity: 0, height: 0 }}
                                    transition={SWAP}
                                >
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
                                            placeholder="pi@192.168.1.10:22"
                                            autoCapitalize="none"
                                            autoCorrect="off"
                                            spellCheck={false}
                                            className={INPUT_CLASS}
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
                                                <RadioGroupItem
                                                    id="connection-card-auth-password"
                                                    value="password"
                                                    variant="pill"
                                                >
                                                    <span
                                                        id="connection-card-auth-password-label"
                                                        className="text-label-lg font-medium whitespace-nowrap"
                                                    >
                                                        Password
                                                    </span>
                                                </RadioGroupItem>
                                                <RadioGroupItem
                                                    id="connection-card-auth-key"
                                                    value="key"
                                                    variant="pill"
                                                >
                                                    <span
                                                        id="connection-card-auth-key-label"
                                                        className="text-label-lg font-medium whitespace-nowrap"
                                                    >
                                                        Private key
                                                    </span>
                                                </RadioGroupItem>
                                            </RadioGroup>
                                        </div>

                                        <AnimatePresence initial={false} mode="wait">
                                            {form.auth === "password" ? (
                                                <motion.div
                                                    key="password"
                                                    id="connection-card-credential-password"
                                                    className="flex flex-col gap-2"
                                                    initial={{ opacity: 0, height: 0 }}
                                                    animate={{ opacity: 1, height: "auto" }}
                                                    exit={{ opacity: 0, height: 0 }}
                                                    transition={SWAP}
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
                                                        placeholder="Enter password"
                                                        autoCapitalize="none"
                                                        autoCorrect="off"
                                                        spellCheck={false}
                                                        className={INPUT_CLASS}
                                                    />
                                                </motion.div>
                                            ) : (
                                                <motion.div
                                                    key="key"
                                                    id="connection-card-credential-key"
                                                    className="flex flex-col gap-4"
                                                    initial={{ opacity: 0, height: 0 }}
                                                    animate={{ opacity: 1, height: "auto" }}
                                                    exit={{ opacity: 0, height: 0 }}
                                                    transition={SWAP}
                                                >
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
                                                            placeholder="Paste the key"
                                                            rows={4}
                                                            autoCapitalize="none"
                                                            autoCorrect="off"
                                                            spellCheck={false}
                                                            className={TEXTAREA_CLASS}
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
                                                            placeholder="Only if the key is encrypted"
                                                            autoCapitalize="none"
                                                            autoCorrect="off"
                                                            spellCheck={false}
                                                            className={INPUT_CLASS}
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
                                                        <FolderOpen aria-hidden className="size-4" />
                                                        <span className="text-label-lg font-medium">
                                                            Choose a key file
                                                        </span>
                                                    </Button>
                                                </motion.div>
                                            )}
                                        </AnimatePresence>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </fieldset>
                </div>
            </ScrollArea>

            <div id="connection-card-action" className="shrink-0 px-6 pt-6 pb-6">
                <Button
                    id="connection-card-connect"
                    onClick={onConnect}
                    disabled={connecting || !canConnect}
                    className="bg-primary hover:bg-primary/90 h-12 w-full cursor-default rounded-lg px-3"
                >
                    <AnimatePresence initial={false} mode="popLayout">
                        {connecting ? (
                            <motion.span
                                key="busy"
                                className="flex items-center gap-1.5"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={SWAP}
                            >
                                <Loader2 id="connection-card-connect-spinner" className="size-4 animate-spin" />
                                <span id="connection-card-connect-busy" className="text-label-lg font-medium">
                                    Connecting
                                </span>
                            </motion.span>
                        ) : (
                            <motion.span
                                key="idle"
                                className="flex items-center gap-1.5"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={SWAP}
                            >
                                <Plug aria-hidden className="size-4" />
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
