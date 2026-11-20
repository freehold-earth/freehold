#!/usr/bin/env bash
# Call the example server's echo tool through the proxy, as an end-user's agent would.
#
#   ./call.sh                  a call under terms the operator can serve under: served, with a receipt
#   ./call.sh --without-terms  a call with no terms: refused
#
# PROXY_URL names the proxy, and is http://127.0.0.1:8090/ if not set.
set -euo pipefail

proxy_url="${PROXY_URL:-http://127.0.0.1:8090/}"

# The end-user's terms: notes may go as far as a federated operator, and be kept an hour. Their hash is the SHA-256
# of their canonical JSON (RFC 8785), which is how they are written here.
terms='{"rules":[{"conditions":{"custody":{"operator":"federated_operator"},"retention":{"max_seconds":3600}},"context_scope":"notes"}],"version":"1.1"}'

if [ "$#" -gt 1 ]; then
  echo "usage: $0 [--without-terms]" >&2
  exit 2
fi

label=""
case "${1:-}" in
"")
  terms_hash="$(printf '%s' "$terms" | openssl dgst -sha256 -r | cut -d' ' -f1)"
  # An agent makes a new nonce for every request. Its commitment binds the request to the end-user, and only the
  # agent can open it; random bytes stand in for it here.
  nonce="$(openssl rand -hex 16)"
  commitment="$(openssl rand -hex 32)"
  label=',"earth.freehold/terms":{"terms_hash":"'"$terms_hash"'","context_scope":"notes/2026","nonce":"'"$nonce"'","commitment":"'"$commitment"'","terms":'"$terms"'}'
  ;;
--without-terms) ;;
*)
  echo "usage: $0 [--without-terms]" >&2
  exit 2
  ;;
esac

curl --silent --show-error "$proxy_url" \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json, text/event-stream' \
  --header 'MCP-Protocol-Version: 2026-07-28' \
  --header 'Mcp-Method: tools/call' \
  --header 'Mcp-Name: echo' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"text":"hi"},"_meta":{
    "io.modelcontextprotocol/protocolVersion":"2026-07-28",
    "io.modelcontextprotocol/clientInfo":{"name":"call.sh","version":"1"},
    "io.modelcontextprotocol/clientCapabilities":{"extensions":{"earth.freehold/spal":{}}}'"$label"'}}}'
echo
