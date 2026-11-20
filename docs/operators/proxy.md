# Running the proxy

This guide is for an **operator**: someone who runs a service that other people's software calls, such as a notes service or an inference node. It covers `freehold proxy`, the piece of Freehold an operator runs.

A few words used throughout:

- An **end-user** is the person whose data it is.
- Their **agent** is the software that acts for them and calls your service.
- **MCP** (the Model Context Protocol) is the protocol the agent calls your service with.
- **Terms** are the end-user's own rules for what may be done with what the agent sends: how long it may be kept, whether it may be used for training, and so on. Terms are a list of **rules**, and each rule governs a **scope**, a named part of the end-user's data such as `notes`.
- **S-PAL** is the language terms are written in. Its specification is under [`spec/`](../../spec/).

## What the proxy does

The proxy stands in front of your MCP server. For each request an agent makes under terms, it:

1. **Checks** the terms against your **tolerance**, the strictest terms you are able to serve under.
2. **Refuses** the request if you cannot serve under those terms, or passes it on to your server.
3. **Tells your server** what you have committed to for that request.
4. **Signs a receipt** with your key and returns it with the result. The receipt is your signature on what you committed to.
5. **Writes** each step to your audit record.

Everything else passes through as plain MCP.

## What the proxy does not do

**It does not make your server keep the commitment.** The proxy refuses and signs. If it signs a receipt that says "kept no longer than an hour, never used for training", then keeping to that is your server's job. A server that ignores the commitment leaves you having signed for something you do not do.

It also does not:

- **End TLS.** It speaks plain HTTP. Put it behind whatever handles HTTPS for you (a reverse proxy or load balancer).
- **Check who is calling.** Authentication stays with your server or with whatever sits in front of the proxy.
- **Speak to a server over stdio.** The server behind must be reachable over HTTP.

## What you need

- **An MCP server reachable over HTTP** (MCP's "streamable HTTP" transport) **that speaks MCP 2026-07-28.** The proxy tells agents what you serve under by adding to your server's answer to `server/discover`, a request that revision introduced. A server on an older revision never gets to say it.
- **Agents that speak MCP 2026-07-28 too.** The proxy learns that an agent understands terms from what that revision has the agent send with every request. An older client counts as sending no terms.
- **The `freehold` binary.** From a checkout, `make build` writes `bin/freehold`. Or build the container image: `docker build -f cmd/freehold/Dockerfile -t freehold .`

The image runs as an unprivileged user (uid 65532) and keeps its key and audit record in `/var/lib/freehold`. [`demo/operator/compose.yml`](../../demo/operator/compose.yml) shows it running.

## 1. Make your signing key

```bash
freehold key new operator.pem
```

This writes a new signing key (Ed25519) to `operator.pem`, readable by you alone, and prints its identifier, a `did:key`:

```
did:key:z6Mk...
```

The identifier is how end-users know a receipt is yours. Give it to the people whose agents will call you.

Keep the file safe and keep a copy. Whoever holds it can sign as you, a lost key cannot be made again, and the command never writes over a file that is already there.

**The proxy will not start if anyone but the file's owner can read the key.** That matters most in a container: a key made on your machine belongs to you, not to the user the image runs as, and a secret mounted with the usual read-for-all permissions is refused. Make the key with the image, on the volume it will be read from, as the demo does, or give the file to uid 65532 with owner-only permissions.

## 2. Write the configuration

The configuration is a TOML file. A commented example is in [`cmd/freehold/testdata/proxy.toml`](../../cmd/freehold/testdata/proxy.toml).

```toml
listen = "127.0.0.1:8080"
upstream = "http://127.0.0.1:9000"
key_file = "operator.pem"
audit_file = "audit.jsonl"
terms = "required"

[tolerance]
custody = "federated_operator"
retention_min_seconds = 0
training = "forbidden"
aggregation = "forbidden"
resale = "forbidden"
```

| Key | What it says |
|---|---|
| `listen` | The address the proxy listens on. |
| `upstream` | The URL of your MCP server. `http` or `https`, with no user name or password in it. |
| `key_file` | Your signing key. |
| `audit_file` | Your audit record. It is made if it is not there, and only ever added to. |
| `terms` | `"required"`: no tool call, resource read or prompt is served without terms. `"optional"`: such a request is served as plain MCP, with no receipt. That includes a request from an older client that sent terms the proxy could not see. |
| `max_body_bytes` | Optional. The largest request, and the largest single response message, the proxy reads. 4 MiB if not set. |

A path in the file that is not absolute is taken from the directory the file is in.

### The tolerance

The tolerance is a limit on what you agree to. It can only cause a refusal. It is never what you commit to for a request: that is always what the end-user's rule says, and what their rule does not say, it does not permit. The one exception is custody: a receipt always states your own custody level.

Every key must be stated. None has a default.

| Key | What it says |
|---|---|
| `custody` | Your custody level: whose hands the data is in when it is with you. One of `device_only`, `owned_hardware`, `community_node`, `federated_operator`, `attested_enclave` or `any`. A request whose rule does not let data go as far as your level is refused. |
| `retention_min_seconds` | The shortest time you need to keep what you are sent for. `0` says you need to keep nothing. A rule that allows less time than this is refused. |
| `training`, `aggregation`, `resale` | The least a rule must permit for you to serve under it. `"forbidden"` serves whatever the rule says. |

The values each of these may take are in the S-PAL specification.

Two things about custody that may surprise you:

- **A rule that says nothing about custody lets data go no further than the end-user's own hardware.** An operator at `community_node` or beyond refuses a request under such a rule.
- **A rule that requires attestation is always refused**, whatever your level. The proxy cannot yet prove what hardware it runs on, so it does not sign for it.

### The file is read strictly

A limit you meant and that was never applied is worse than a proxy that does not start. So the proxy refuses to start on a key it does not know (most likely a misspelling), on a tolerance limit left unstated, or on a value it cannot use. It reports as many of these as it can at once, not one per run.

## 3. Run it

```bash
freehold proxy --config proxy.toml
```

Four flags stand in place of the file's values, for what tends to differ from machine to machine: `--listen`, `--upstream`, `--key-file` and `--audit-file`. A path given by a flag is taken from the directory you run the command in, as any command's is.

On starting, the proxy prints one line to standard output:

```
listening on 127.0.0.1:8080 as did:key:z6Mk...
```

It logs to standard error. The first log line gives your identifier and your tolerance, so you can see what the proxy is answering with. If the upstream is plain `http` on another machine, it warns you: what end-users send would travel to your server in the clear.

To stop it, interrupt it or send it SIGTERM. It takes no new requests, gives those in flight five seconds, then closes what is still open. A second interrupt stops it at once.

## 4. Make your server keep the commitment

On every request the proxy passes on under terms, it adds what you have committed to, in the request's `_meta`:

```json
"_meta": {
  "earth.freehold/commitment": {
    "request_id": "0195c1f2-5c1e-7a52-9d2f-3f6f6f1f7a10",
    "terms_hash": "<64 lowercase hex characters>",
    "context_scope": "notes/2026/meeting-notes",
    "custody": "federated_operator",
    "retention_seconds": 3600,
    "training": "forbidden",
    "aggregation": "forbidden",
    "resale": "forbidden"
  }
}
```

Your server reads this and holds whatever it stores, logs or learns from the request to it. `request_id` is the handle on the receipt and on your audit lines, so you can tie what your server did to what you signed.

Two rules make it safe to rely on:

- **Only the proxy writes it.** The proxy removes a commitment that a request arrives with. A request that reaches your server without one was not made under terms.
- **Only the proxy may reach your server.** Anything that can call your server directly can write a commitment of its own, and the proxy has no way to prove to your server that a request came from it. So your server must listen only where the proxy alone can connect: a private container network, or a machine nothing else runs on. A loopback address on a machine other software shares does not meet this.

[`demo/operator/server`](../../demo/operator/server/main.go) is a small MCP server, written with the official Go SDK, that shows where a tool reads the commitment.

## 5. Read your audit record

The audit record is a file of JSON lines. A file the proxy makes is readable by you alone; a file that was already there keeps the permissions it had.

A line holds the request's method, the hash of its terms, its scope, its nonce (the one-time number the agent sent with it), and what you committed to. It never holds the request's arguments or the answer.

| `outcome` | What it says |
|---|---|
| `accepted` | You took the request on, under the conditions the line gives. It is written before the request is passed on. |
| `served` | The request was answered. The line holds the receipt you signed. |
| `failed` | An accepted request ended with no result, and so with no receipt. You were still sent it, and the conditions still bind. |
| `refused` | You refused the request. The line gives the reason. |

A refused request looks like this:

```json
{"time":"2026-11-20T21:18:36.880985673Z","outcome":"refused","method":"tools/call","reason":"terms_required"}
```

One kind of request leaves no line: a request without terms from a client that does not speak the terms extension, turned away because you require terms.

**If the record cannot be written, nothing is served under terms.** The proxy writes the `accepted` line first and passes a request on only once that line is on disk. After one failed write the proxy records nothing more, and answers every request under terms with an error, **until you restart it**. Freeing disk space alone does not bring it back. Watch the disk the record is on.

## What an agent sees

To an agent, the proxy is your server.

- **What you serve under.** The answer to MCP's `server/discover` request gains an entry, `capabilities.extensions["earth.freehold/spal"]`, with your identifier, your tolerance and whether you require terms.
- **A receipt.** The result of a request made under terms carries `_meta["earth.freehold/receipt"]`.
- **A refusal.** An MCP error (a JSON-RPC error) with code `4030`, whose `data["earth.freehold/refusal"].reason` is one of:

| Reason | What it says |
|---|---|
| `terms_required` | The request carries no terms, and you serve nothing without them. |
| `cannot_honour` | You cannot keep a condition of the rule that governs the request. The refusal names the condition. |
| `condition_not_understood` | The terms ask for something the proxy does not understand. |
| `scope_not_governed` | No rule in the terms governs the data the request concerns. |
| `terms_unknown` | The request names terms by their hash, and the proxy does not hold them. The agent sends them again. |
| `terms_mismatch` | The terms sent do not have the hash the request names. |
| `terms_malformed` | What the request carries about its terms is not well formed. |

A client that does not speak the terms extension (the part of MCP that carries terms and receipts, `earth.freehold/spal`) gets MCP's own error for a missing capability (`-32021`) when you require terms.

The full protocol is in [`spec/protocols/mcp-terms-extension.md`](../../spec/protocols/mcp-terms-extension.md).

## Limits to know about

- A request body may be up to `max_body_bytes` and take up to thirty seconds to arrive.
- The proxy holds the terms it has been sent in memory, up to 1024 of them, and forgets them when it stops. An agent whose terms are no longer held is told `terms_unknown` and sends them again.
- One proxy answers for one operator, with one key and one tolerance.

## Try it

[`demo/operator`](../../demo/operator/) runs the proxy in front of the example server with Docker Compose, with a script that calls it as an agent would. See its [README](../../demo/operator/README.md).
