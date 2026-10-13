import { Spinner } from "@/components/ui";

export function SessionLoading({ label = "Opening the session…" }: { label?: string }) {
    return (
        <div id="session-loading" className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <Spinner className="text-muted-foreground size-5" />
            <p className="text-body-md text-muted-foreground">{label}</p>
        </div>
    );
}
