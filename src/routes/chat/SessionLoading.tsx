import { Icon } from "@/components";
import { Spinner } from "@/components/ui";

export function SessionLoading({ label = "Opening the session…" }: { label?: string }) {
    return (
        <div id="session-loading" className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <Icon className="text-muted-foreground">
                <Spinner />
            </Icon>
            <p className="text-body-md text-muted-foreground">{label}</p>
        </div>
    );
}
