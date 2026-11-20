# The operator's side

This demo runs the part of Freehold an **operator** runs: `freehold proxy`, in front of an MCP server. An operator is whoever runs a service that end-users' agents call. An **end-user** is the person whose data it is, and their **terms** are their own rules for what may be done with it. The guide to the proxy, [docs/operators/proxy.md](../../docs/operators/proxy.md), explains the rest.

It is separate from the main demo in [`demo/`](../), which runs the end-user's side. The two do not talk to each other yet: the agent learns to send terms in [#146](https://github.com/freehold-earth/freehold/issues/146). Until then, `call.sh` plays the agent.

| Part | What it is |
|---|---|
| `server/` | An example MCP server with one tool, `echo`. It answers with the text it was sent and with what the operator has committed to for the call. |
| `proxy.toml` | The operator's configuration: it requires terms, says the operator is a `federated_operator` (its custody level: whose hands the data is in), and needs to keep nothing. |
| `compose.yml` | The proxy and the server. Only the proxy has a published port (`127.0.0.1:8090`). The server has none, and its network reaches nothing outside itself. |
| `call.sh` | Calls `echo` through the proxy as an agent would. Needs `curl` and `openssl`. |

## Run it

From the repository root:

```bash
# Once: make the operator's signing key. It prints the operator's identifier (did:key:...).
docker compose -f demo/operator/compose.yml run --rm --no-deps proxy key new /var/lib/freehold/operator.pem

docker compose -f demo/operator/compose.yml up
```

The proxy logs its identifier and its tolerance (the strictest terms it serves under). It also warns that the upstream is plain `http` on another machine. Here that machine is the container beside it, on a network no other container is on.

## Call it

**Under terms.** The terms say notes may go as far as a federated operator and be kept for an hour. The operator can serve under that, so the call is served:

```bash
demo/operator/call.sh
```

The answer is one long line of JSON; pipe it through `jq .` if you have it. Look for two things in the answer:

- `result._meta["earth.freehold/receipt"]`: the receipt, signed with the operator's key. It carries the retention the end-user's rule allows (`3600` seconds), not the operator's own limit.
- The second piece of `result.content`: the example server saying what commitment it was handed for the call.

**Without terms.** The operator requires them, so the call is refused and never reaches the server:

```bash
demo/operator/call.sh --without-terms
```

## Read the audit record

```bash
docker compose -f demo/operator/compose.yml cp proxy:/var/lib/freehold/audit.jsonl audit.jsonl   # git ignores this name
```

The served call has two lines, `accepted` and then `served` with the receipt. The refused call has one, `refused`, with the reason.

## Clean up

```bash
docker compose -f demo/operator/compose.yml down --volumes
```

`--volumes` removes the key and the audit record with it.
