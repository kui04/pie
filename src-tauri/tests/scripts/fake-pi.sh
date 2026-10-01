#!/usr/bin/env bash
# A stand-in for `pi --mode rpc`, so the transport tests need no pi, no model and
# no network. It answers only what tests/local_pi.rs sends: one JSON record per
# LF, correlated by the `id` of the request, an event before the response for
# `bash`, and exit 0 when stdin closes.
set -uo pipefail

while IFS= read -r line; do
    id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
    case "$line" in
        *'"type":"get_state"'*)
            printf '{"id":"%s","type":"response","command":"get_state","success":true,"data":{"thinkingLevel":"high","isStreaming":false,"isCompacting":false,"steeringMode":"all","followUpMode":"all","sessionId":"fake-session","autoCompactionEnabled":true,"messageCount":0,"pendingMessageCount":0}}\n' "$id"
            ;;
        *'"type":"bash"'*)
            printf '{"type":"bash_execution_update","id":"%s","delta":"hello\\n"}\n' "$id"
            printf '{"id":"%s","type":"response","command":"bash","success":true,"data":{"output":"hello\\n","exitCode":0,"cancelled":false,"truncated":false}}\n' "$id"
            ;;
        *)
            # Answer anything unexpected, so a test that sends a new command fails
            # with this message instead of hanging until its timeout.
            printf '{"id":"%s","type":"response","command":"unknown","success":false,"error":"fake-pi.sh: unexpected command"}\n' "$id"
            ;;
    esac
done
exit 0
