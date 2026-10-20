/**
 * The extension status of the conversation in view: a key in the bar and the
 * lines the extensions reported behind it.
 *
 * The dot is only a hint that a status exists; the popover is where the words
 * are. The read is the same cached snapshot the session body already listens to,
 * so opening the popover adds no second subscription.
 */

import { useQuery } from "@tanstack/react-query";
import { Puzzle } from "lucide-react";
import { cn } from "cn";
import { Button, Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui";
import { Icon } from "@/components";
import { sessionQueries } from "@/lib/query";
import { COMPOSER_PANEL } from "@/routes/chat/composer/Composer";

export function SessionExtensions({ session }: { session: string }) {
    const statuses = useQuery({ ...sessionQueries.extension(session) }).data?.statuses ?? [];
    return (
        <Popover>
            <PopoverTrigger
                render={
                    <Button
                        id="session-extensions"
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Extensions"
                        className="relative"
                    />
                }
            >
                <Icon>
                    <Puzzle />
                </Icon>
                {statuses.length > 0 && (
                    <span
                        id="session-extensions-status"
                        aria-hidden
                        className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary"
                    />
                )}
            </PopoverTrigger>
            <PopoverContent
                id="session-extensions-popup"
                align="end"
                className={cn("w-64 gap-1 rounded-xl p-2 font-sans text-body-md text-foreground", COMPOSER_PANEL)}
            >
                <PopoverHeader className="gap-1 text-body-md">
                    <PopoverTitle className="text-body-md">Extensions</PopoverTitle>
                </PopoverHeader>
                {statuses.length === 0 ? (
                    <p className="text-body-md text-muted-foreground">No extension has reported a status.</p>
                ) : (
                    <ul id="session-extensions-list" className="flex flex-col gap-2">
                        {statuses.map((status) => (
                            <li key={status.key} className="flex flex-col gap-0.5">
                                <span className="text-label-md text-muted-foreground">{status.key}</span>
                                <span className="text-body-md">{status.text}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </PopoverContent>
        </Popover>
    );
}
