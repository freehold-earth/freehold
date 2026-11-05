import { useState, useEffect, useCallback, useRef } from "react";
import type {
  PersonalContext,
  SPALPolicy,
  VerificationRequest,
  RootIdentity,
} from "./types";
import { createContextStore, type ContextStoreClient } from "./context-store";
import {
  auditExport,
  deleteAuthorization,
  deleteAuthorizations,
  issueAuthorizedDid,
  listAuthorizations,
  mergeAuthorizations,
} from "./authorizations";
import {
  type ApprovalAttestation,
  attestApproval,
  type DIDKeyPair,
  generateDID,
  generateEphemeralDID,
  type SerializedAuthorizationRecord,
  serializeDIDKeyPair,
  truncateDID,
} from "@freehold-earth/identity";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8082";
const DEMO_USER_ID = "demo-user";

// The service flow (/services, /service-requests) is on by default now that
// pci-agent#17 restored the endpoints. Set VITE_ENABLE_SERVICE_FLOW=false to
// fall back to the direct business-driven verification demo.
const SERVICE_FLOW_ENABLED = import.meta.env.VITE_ENABLE_SERVICE_FLOW !== "false";

// Demo hint - shown to help testers, but user must still enter it
const DEMO_PASSWORD_HINT = "demo-password"; // pragma: allowlist secret

// FastAPI's `detail` is a string for HTTPException but an array of validation
// objects for 422s; only strings are safe to render.
function apiErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const { detail, error } = data as { detail?: unknown; error?: unknown };
    if (typeof detail === "string") return detail;
    if (typeof error === "string") return error;
  }
  return fallback;
}

type Tab = "services" | "requests" | "context" | "identity" | "policies";

type AgentVaultStatus = "unknown" | "unlocked" | "locked" | "wrong-password" | "unavailable";

/**
 * Hand the agent the vault secret so it can read the context store itself
 * when it generates a proof. The agent checks the password against a stored
 * entry before holding it, so a wrong one is refused rather than kept.
 */
async function unlockAgent(password: string): Promise<AgentVaultStatus> {
  try {
    const res = await fetch(`${API_URL}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: DEMO_USER_ID, password }),
    });
    if (res.ok) return "unlocked";
    if (res.status === 401) return "wrong-password";
    console.warn("Agent unlock failed:", res.status, await res.text().catch(() => ""));
    return "unavailable";
  } catch (err) {
    console.warn("Agent unreachable for unlock:", err);
    return "unavailable";
  }
}

const AGENT_VAULT_DOT: Record<AgentVaultStatus, "green" | "yellow" | "red"> = {
  unknown: "yellow",
  unlocked: "green",
  locked: "red",
  "wrong-password": "red",
  unavailable: "red",
};

const AGENT_VAULT_HINT: Record<AgentVaultStatus, string> = {
  unknown: "The agent has not been given the vault password yet",
  unlocked: "The agent can read the context store to generate proofs",
  locked: "The agent holds no vault password (restarted, or locked); unlock it to approve requests",
  "wrong-password": "The agent refused the password: it does not open the stored entries",
  unavailable: "The agent could not be reached, or could not reach the context store",
};

interface ServiceStatus {
  agent: { status: string; url: string };
  zkp: { status: string; url: string };
  cardano: { status: string; url: string; latest_block?: number | null };
}

interface ServiceRequest {
  id: string;
  user_id: string;
  user_name: string;
  business_id: string;
  service_type: string;
  service_name: string;
  // Lifecycle: pending -> verification_required (business links a
  // verification) -> verified | denied | rejected when the user responds;
  // verified -> completed via POST /service-requests/:id/complete (repeat
  // completes are 200 idempotent). "verified" only exits while a business
  // app is polling. expires_at is advisory: the agent defines no "expired"
  // state and never enforces it.
  status: "pending" | "verification_required" | "verified" | "completed" | "denied" | "rejected";
  created_at: string;
  expires_at: string;
  verification_request_id: string | null;
  completed_at: string | null;
}

// Default context for new users
const defaultContext: PersonalContext = {
  birthDate: "1990-05-15",
  fullName: "Alice Demo",
};

const initialPolicies: SPALPolicy[] = [
  {
    id: "spal:did:key:z6MkuserDemo:age-verification",
    name: "Age Verification Only",
    description: "Allow businesses to verify age without revealing birth date",
    ownerDid: "did:key:z6MkuserDemo",
    contextScope: "personal/age",
    identityLinkage: {
      ephemeralRequired: true,
      proofOfRootAllowed: false,
      zkContinuityAllowed: false,
    },
    minPayment: 0,
    maxRetentionMs: 0,
    allowedOperations: ["verify"],
    derivatives: {
      training: "forbidden",
      aggregation: "forbidden",
      resale: "forbidden",
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

// Demo services to request
const DEMO_SERVICES = [
  { id: "alcohol", name: "Purchase Alcohol", icon: "🍺", minAge: 21 },
  { id: "rental", name: "Rent a Car", icon: "🚗", minAge: 25 },
];

function App() {
  // Unlock state
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [showResetOption, setShowResetOption] = useState(false);
  const [agentVault, setAgentVault] = useState<AgentVaultStatus>("unknown");
  const contextStoreRef = useRef<ContextStoreClient | null>(null);

  // App state
  const [tab, setTab] = useState<Tab>(SERVICE_FLOW_ENABLED ? "services" : "requests");
  const [context, setContext] = useState<PersonalContext>(defaultContext);
  const [policies] = useState<SPALPolicy[]>(initialPolicies);
  const [serviceRequests, setServiceRequests] = useState<ServiceRequest[]>([]);
  const [verificationRequests, setVerificationRequests] = useState<VerificationRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A standing caveat the poll must not clear, unlike error: e.g. a DID issued with no record.
  const [notice, setNotice] = useState<string | null>(null);
  const [services, setServices] = useState<ServiceStatus | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextStoreStatus, setContextStoreStatus] = useState<"unknown" | "connected" | "error">("unknown");

  // Identity state
  const [rootIdentity, setRootIdentity] = useState<RootIdentity | null>(null);
  const [currentEphemeralDID, setCurrentEphemeralDID] = useState<string | null>(null);
  // Root-signed records of the ephemeral DIDs issued so far, newest first.
  const [authorizations, setAuthorizations] = useState<SerializedAuthorizationRecord[]>([]);
  // DIDs whose record was taken back, so a load still in flight cannot restore them.
  const undoneDidsRef = useRef(new Set<string>());

  // Handle vault unlock
  const handleUnlock = async () => {
    if (!unlockPassword) {
      setUnlockError("Please enter a password");
      return;
    }

    setUnlockError(null);
    setContextLoading(true);

    try {
      // Create context store client with user's password
      const store = createContextStore(DEMO_USER_ID, unlockPassword);
      contextStoreRef.current = store;

      // Try to load existing context
      const stored = await store.get<PersonalContext>("personal-context");
      if (stored) {
        setContext(stored.data);
        setContextStoreStatus("connected");
      } else {
        // No existing context - save the default
        await store.put("personal-context", defaultContext);
        setContextStoreStatus("connected");
      }

      // Load or generate root identity
      const storedIdentity = await store.get<RootIdentity>("root-identity");
      let identity: RootIdentity;
      if (storedIdentity) {
        identity = storedIdentity.data;
      } else {
        // Generate new root DID on first unlock
        const serialized = serializeDIDKeyPair(await generateDID());
        identity = {
          did: serialized.did,
          publicKey: serialized.publicKey,
          privateKey: serialized.privateKey,
          createdAt: serialized.createdAt,
        };
        await store.put("root-identity", identity);
      }
      setRootIdentity(identity);
      setIsUnlocked(true);

      // Records are one read and one decrypt each; load them after the
      // unlock rather than holding it. Merge rather than replace, in case a
      // record was issued while the load ran; only this root's records count.
      void listAuthorizations(store)
        .then((loaded) =>
          loaded.filter(
            (r) => r.rootDid === identity.did && !undoneDidsRef.current.has(r.ephemeralDid),
          ),
        )
        .then((loaded) => setAuthorizations((current) => mergeAuthorizations(current, loaded)))
        .catch((err) => {
          console.warn("Could not load authorization records:", err);
          setNotice("Could not load your authorization records from the vault");
        });

      // The agent reads the same store server-side when it proves a claim,
      // so it needs the secret too. The vault is usable here either way, so
      // this does not hold up the unlock; the status bar shows the outcome.
      void unlockAgent(unlockPassword).then(setAgentVault);
    } catch (err) {
      console.error("Failed to unlock:", err);

      // Check if this is a decryption error (wrong password)
      const isCryptoError = err instanceof Error && (
        err.name === "OperationError" ||  // WebCrypto decryption failure
        err.message.includes("operation failed") ||
        err.message.includes("decrypt") ||
        err.message.includes("tag doesn't match")  // GCM auth tag mismatch
      );

      if (isCryptoError) {
        setUnlockError("Wrong password - decryption failed");
        setShowResetOption(true);
        // Don't auto-unlock on wrong password - user needs to fix it
      } else if (err instanceof Error && err.message.includes("fetch")) {
        // Network error - context store not reachable
        setUnlockError("Context store unavailable - continuing with local storage");
        setContextStoreStatus("error");
        setIsUnlocked(true);
      } else {
        setUnlockError(err instanceof Error ? err.message : "Unknown error");
        setContextStoreStatus("error");
        setIsUnlocked(true);
      }
    } finally {
      setContextLoading(false);
    }
  };

  // Reset vault - clear all encrypted data and start fresh. Deleting needs
  // no password, so a client with an empty one serves; nothing is decrypted.
  const handleResetVault = async () => {
    setContextLoading(true);
    try {
      const store = createContextStore(DEMO_USER_ID, "");
      await store.delete("personal-context");
      await store.delete("root-identity");
      await deleteAuthorizations(store);
      setAuthorizations([]);
      setCurrentEphemeralDID(null);
      undoneDidsRef.current.clear();
      setUnlockError(null);
      setShowResetOption(false);
      setUnlockPassword("");
    } catch (err) {
      console.error("Failed to reset vault:", err);
      setUnlockError("Failed to reset vault - try again");
    } finally {
      setContextLoading(false);
    }
  };

  // Save context to store
  const saveContext = async (newContext: PersonalContext) => {
    setContext(newContext);

    if (contextStoreRef.current && contextStoreStatus === "connected") {
      try {
        await contextStoreRef.current.put("personal-context", newContext);
      } catch (err) {
        console.error("Failed to save context:", err);
        setError("Failed to save to encrypted store");
      }
    }
  };

  const fetchData = useCallback(async () => {
    try {
      const [verificationRes, healthRes] = await Promise.all([
        fetch(`${API_URL}/requests`),
        fetch(`${API_URL}/health`),
      ]);
      if (!verificationRes.ok) {
        throw new Error(`agent responded with ${verificationRes.status}`);
      }
      const verificationData = await verificationRes.json();
      setVerificationRequests(verificationData.requests || []);

      // The agent's own report of its vault wins over the unlock-time status:
      // a restart or a /lock shows as locked. A refused or failed unlock keeps
      // its more specific status. The password is never re-sent from here;
      // a /lock is deliberate, and undoing it is the user's call.
      if (healthRes.ok) {
        const health = (await healthRes.json()) as { vault?: "locked" | "unlocked" };
        if (health.vault === "unlocked") {
          setAgentVault("unlocked");
        } else if (health.vault === "locked") {
          setAgentVault((current) =>
            current === "unlocked" || current === "unknown" ? "locked" : current
          );
        }
      }

      if (SERVICE_FLOW_ENABLED) {
        const [serviceRes, statusRes] = await Promise.all([
          fetch(`${API_URL}/service-requests`),
          fetch(`${API_URL}/services`),
        ]);
        if (!serviceRes.ok || !statusRes.ok) {
          throw new Error("agent service endpoints unavailable");
        }
        setServiceRequests((await serviceRes.json()).requests || []);
        setServices(await statusRes.json());
      }

      setError(null);
    } catch (err) {
      setError("Failed to connect to agent");
      console.error("Fetch error:", err);
    }
  }, []);

  // Poll for updates every 2 seconds
  useEffect(() => {
    const timeoutId = setTimeout(fetchData, 0);
    const interval = setInterval(fetchData, 2000);
    return () => {
      clearTimeout(timeoutId);
      clearInterval(interval);
    };
  }, [fetchData]);

  // Escalated requests await a human decision, same as pending ones
  const pendingVerifications = verificationRequests.filter(
    (r) => r.status === "pending" || r.status === "escalated"
  );

  const handleRequestService = async (service: typeof DEMO_SERVICES[0]) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/service-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: DEMO_USER_ID,
          user_name: context.fullName || "Demo User",
          business_id: "demo-business",
          service_type: "purchase",
          service_name: service.name,
        }),
      });
      if (res.ok) {
        await fetchData();
        setTab("requests"); // Switch to requests tab to see the flow
      } else {
        const data = await res.json().catch(() => ({}));
        setError(apiErrorMessage(data, "Failed to create request"));
      }
    } catch (_err) {
      setError("Failed to connect to agent");
    }
    setLoading(false);
  };

  // The ephemeral DID for a verification, with a root-signed record kept in
  // the vault so the DID can later be proved ours. The proof is committed to
  // this DID, and its key signs the approval so the DID is shown to be ours
  // for this request; the agent then looks for the record in the vault and
  // accepts the DID only if our root issued it. Without a vault to keep the
  // record in (store offline, or no root identity loaded) a bare ephemeral
  // DID can still be issued, but the agent will refuse the approval, which
  // the notice says. Only fields we own are signed: the business's claim
  // params are not copied into the record.
  const issueEphemeralDid = async (
    request: VerificationRequest,
  ): Promise<{ did: string; keyPair: DIDKeyPair; key?: string; undo: () => Promise<void> }> => {
    const store = contextStoreRef.current;
    if (!store || !rootIdentity || contextStoreStatus !== "connected") {
      setNotice(
        "No vault connected: no authorization record can be kept for this verification's DID, so the agent will refuse the approval until the vault is back",
      );
      const ephemeral = await generateEphemeralDID();
      return { did: ephemeral.did, keyPair: ephemeral, undo: async () => {} };
    }
    const issued = await issueAuthorizedDid(
      store,
      rootIdentity,
      `${request.claim.type} verification at ${request.business_name}`,
      {
        verificationType: request.claim.type,
        metadata: {
          businessId: request.business_id,
          requestId: request.id,
          requestExpiresAt: request.expires_at,
          ...(request.policy_id ? { policyId: request.policy_id } : {}),
        },
      },
    );
    setAuthorizations((current) => [issued.record, ...current]);
    setNotice(null);
    // If the agent never acts on the request the record would only clutter
    // the audit trail, so the caller can take it back. The UI follows the
    // vault: the record leaves the list only once the vault no longer has it.
    const undo = async () => {
      try {
        await deleteAuthorization(store, issued.key);
      } catch (err) {
        console.warn("Could not remove the unused authorization record:", err);
        setNotice("An authorization record for a verification that did not go ahead could not be removed");
        return;
      }
      undoneDidsRef.current.add(issued.did);
      setAuthorizations((current) => current.filter((r) => r.ephemeralDid !== issued.did));
    };
    return { did: issued.did, keyPair: issued.keyPair, key: issued.key, undo };
  };

  // The export reads the vault, not the list on screen: another tab may have
  // written records, and the list is only as fresh as its last load.
  const handleExportAuthorizations = async () => {
    const store = contextStoreRef.current;
    if (!rootIdentity || !store) return;
    let records: SerializedAuthorizationRecord[];
    try {
      records = (await listAuthorizations(store)).filter((r) => r.rootDid === rootIdentity.did);
    } catch (err) {
      console.error("Could not read authorization records for export:", err);
      setError("Could not read your authorization records from the vault");
      return;
    }
    setAuthorizations(records);
    const data = JSON.stringify(auditExport(rootIdentity.did, records), null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `freehold-authorizations-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    // Revoking before the download has started loses it in some browsers.
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  };

  const handleApprove = async (requestId: string) => {
    const request = verificationRequests.find((r) => r.id === requestId);
    if (!request) {
      setError("This request is no longer listed; it may have been resolved or expired");
      return;
    }
    setLoading(true);
    // An ephemeral DID for this verification (shown in the Identity tab). A
    // failure here is the vault's, not the agent's, and is reported as such.
    let issued: { did: string; keyPair: DIDKeyPair; key?: string; undo: () => Promise<void> };
    try {
      issued = await issueEphemeralDid(request);
    } catch (err) {
      console.error("Failed to issue an ephemeral DID:", err);
      setError("Could not issue an ephemeral DID for this verification; nothing was approved");
      setLoading(false);
      return;
    }

    // The ephemeral DID goes to the agent signed by its own key over this
    // request, so the agent and then the business can tell the DID the
    // proof is for is ours. Signing is local; if it fails nothing was sent.
    let attestation: ApprovalAttestation;
    try {
      attestation = await attestApproval(requestId, issued.keyPair);
    } catch (err) {
      console.error("Failed to sign the approval:", err);
      setError("Could not sign the approval with the ephemeral DID's key; nothing was approved");
      await issued.undo();
      setLoading(false);
      return;
    }

    // The record is taken back only when the agent says it did not act on
    // this request (not found, already resolved or another user's, invalid,
    // a DID or signature it would not accept, or a vault it could not
    // consult). A lost response or a 500 may follow a committed approval,
    // and a retry would then be refused, so in those cases the record stays.
    let notActedOn = false;
    try {
      // No private data travels in the approve call: the agent fetches it
      // from the encrypted context store itself.
      const res = await fetch(`${API_URL}/requests/${requestId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requester_did: attestation.requesterDid,
          signature: attestation.signature,
          // Where the record is, so the agent reads one entry, not the whole scope.
          ...(issued.key ? { record_key: issued.key } : {}),
        }),
      });
      if (res.ok) {
        setCurrentEphemeralDID(issued.did);
        await fetchData();
      } else {
        notActedOn = [403, 404, 409, 422, 503].includes(res.status);
        const data = await res.json().catch(() => ({}));
        setError(apiErrorMessage(data, "Failed to approve"));
      }
    } catch (_err) {
      setError("Failed to connect to agent");
    }
    if (notActedOn) await issued.undo();
    setLoading(false);
  };

  const handleDeny = async (requestId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/requests/${requestId}/deny`, {
        method: "POST",
      });
      if (res.ok) {
        await fetchData();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(apiErrorMessage(data, "Failed to deny"));
      }
    } catch (_err) {
      setError("Failed to connect to agent");
    }
    setLoading(false);
  };

  // Show unlock screen if not unlocked
  if (!isUnlocked) {
    return (
      <div className="container">
        <h1>Freehold User App</h1>
        <p className="subtitle">Unlock your encrypted context store</p>

        <div className="card" style={{ maxWidth: "400px", margin: "2rem auto" }}>
          <h2>Unlock Vault</h2>
          <p style={{ marginBottom: "1rem", color: "#64748b" }}>
            Your data is encrypted with your password. Enter it to unlock.
          </p>

          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={unlockPassword}
              onChange={(e) => setUnlockPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
              placeholder="Enter your password"
              autoFocus
            />
          </div>

          {unlockError && (
            <div style={{ color: "#dc2626", marginBottom: "1rem" }}>
              {unlockError}
            </div>
          )}

          <button
            className="btn-primary"
            onClick={handleUnlock}
            disabled={contextLoading}
            style={{ width: "100%" }}
          >
            {contextLoading ? "Unlocking..." : "Unlock"}
          </button>

          {showResetOption && (
            <button
              onClick={handleResetVault}
              disabled={contextLoading}
              style={{
                width: "100%",
                marginTop: "0.5rem",
                padding: "0.75rem",
                background: "#fee2e2",
                border: "1px solid #fca5a5",
                borderRadius: "8px",
                color: "#b91c1c",
                cursor: "pointer",
                fontWeight: 500,
              }}
            >
              {contextLoading ? "Resetting..." : "Reset Vault (Start Fresh)"}
            </button>
          )}

          <div style={{
            marginTop: "1.5rem",
            padding: "1rem",
            background: "#f0f9ff",
            borderRadius: "8px",
            fontSize: "0.875rem"
          }}>
            <strong>Demo Tip:</strong>
            <ul style={{ margin: "0.5rem 0 0 1rem", padding: 0 }}>
              <li><strong>First time?</strong> Choose any password (e.g., <code style={{ background: "#e0f2fe", padding: "2px 6px", borderRadius: "4px" }}>{DEMO_PASSWORD_HINT}</code>)</li>
              <li><strong>Returning?</strong> Use your previous password</li>
              <li><strong>Forgot?</strong> Click "Reset Vault" above after a failed attempt</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <h1>Freehold User App</h1>
      <p className="subtitle">Request services and manage your privacy</p>

      {notice && (
        <div className="notice-banner">
          {notice}
          <button onClick={() => setNotice(null)}>×</button>
        </div>
      )}
      {error && (
        <div className="error-banner">
          {error}
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      <div className="tabs">
        <button
          className={`tab ${tab === "services" ? "active" : ""}`}
          onClick={() => setTab("services")}
        >
          Services
        </button>
        <button
          className={`tab ${tab === "requests" ? "active" : ""}`}
          onClick={() => setTab("requests")}
        >
          My Requests {pendingVerifications.length > 0 && `(${pendingVerifications.length})`}
        </button>
        <button
          className={`tab ${tab === "context" ? "active" : ""}`}
          onClick={() => setTab("context")}
        >
          My Context
        </button>
        <button
          className={`tab ${tab === "identity" ? "active" : ""}`}
          onClick={() => setTab("identity")}
        >
          Identity
        </button>
        <button
          className={`tab ${tab === "policies" ? "active" : ""}`}
          onClick={() => setTab("policies")}
        >
          Policies
        </button>
      </div>

      {tab === "services" && (
        SERVICE_FLOW_ENABLED ? (
          <ServicesTab
            services={DEMO_SERVICES}
            onRequest={handleRequestService}
            loading={loading}
          />
        ) : (
          <div className="card">
            <h2>Service Flow Disabled</h2>
            <p style={{ marginTop: "0.5rem", color: "#64748b" }}>
              Service requests are turned off (VITE_ENABLE_SERVICE_FLOW=false).
              Verification requests from businesses still appear under "My
              Requests".
            </p>
          </div>
        )
      )}

      {tab === "requests" && (
        <RequestsTab
          serviceRequests={serviceRequests}
          verificationRequests={verificationRequests}
          onApprove={handleApprove}
          onDeny={handleDeny}
          loading={loading}
          canApprove={agentVault === "unlocked"}
        />
      )}

      {tab === "context" && (
        <ContextTab
          context={context}
          onUpdate={saveContext}
          storeStatus={contextStoreStatus}
        />
      )}

      {tab === "identity" && (
        <IdentityTab
          rootIdentity={rootIdentity}
          currentEphemeralDID={currentEphemeralDID ?? authorizations[0]?.ephemeralDid ?? null}
          authorizations={authorizations}
          onExport={handleExportAuthorizations}
        />
      )}

      {tab === "policies" && <PoliciesTab policies={policies} />}

      {/* Service Status Bar */}
      <div className="status-bar">
        <div className="status-item">
          <span className={`status-dot ${contextStoreStatus === "connected" ? "green" : contextStoreStatus === "error" ? "red" : "yellow"}`} />
          Context Store
        </div>
        <div className="status-item" title={AGENT_VAULT_HINT[agentVault]}>
          <span className={`status-dot ${AGENT_VAULT_DOT[agentVault]}`} />
          Agent Vault
          {isUnlocked && agentVault !== "unlocked" && unlockPassword && (
            <button
              className="btn-link"
              style={{ marginLeft: "0.5rem" }}
              onClick={() => void unlockAgent(unlockPassword).then(setAgentVault)}
            >
              Unlock
            </button>
          )}
        </div>
        {services && (
          <>
            <div className="status-item">
              <span className={`status-dot ${services.agent.status === "healthy" ? "green" : "red"}`} />
              Agent
            </div>
            <div className="status-item">
              <span className={`status-dot ${services.zkp.status === "healthy" ? "green" : "red"}`} />
              Midnight ZKP
            </div>
            <div className="status-item">
              <span className={`status-dot ${services.cardano.status === "healthy" ? "green" : "red"}`} />
              Cardano {services.cardano.latest_block != null && `#${services.cardano.latest_block}`}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ServicesTab({
  services,
  onRequest,
  loading,
}: {
  services: typeof DEMO_SERVICES;
  onRequest: (service: typeof DEMO_SERVICES[0]) => void;
  loading: boolean;
}) {
  return (
    <div>
      <h2>Request a Service</h2>
      <p className="subtitle">
        Select a service to request. The business will ask you to verify your age.
      </p>

      <div style={{ display: "grid", gap: "1rem", marginTop: "1rem" }}>
        {services.map((service) => (
          <div key={service.id} className="card" style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <span style={{ fontSize: "2rem" }}>{service.icon}</span>
            <div style={{ flex: 1 }}>
              <strong>{service.name}</strong>
              <p style={{ fontSize: "0.875rem", color: "#64748b", marginTop: "0.25rem" }}>
                Requires age {service.minAge}+
              </p>
            </div>
            <button
              className="btn-primary"
              onClick={() => onRequest(service)}
              disabled={loading}
            >
              {loading ? "..." : "Request"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function RequestsTab({
  serviceRequests,
  verificationRequests,
  onApprove,
  onDeny,
  loading,
  canApprove,
}: {
  serviceRequests: ServiceRequest[];
  verificationRequests: VerificationRequest[];
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  loading: boolean;
  /** The agent holds the vault password, so an approval can read the data it proves. */
  canApprove: boolean;
}) {
  const pendingVerifications = verificationRequests.filter(
    (r) => r.status === "pending" || r.status === "escalated"
  );
  const resolvedVerifications = verificationRequests
    .filter((r) => r.status !== "pending" && r.status !== "escalated")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const activeServices = serviceRequests.filter((r) =>
    r.status === "pending" || r.status === "verification_required" || r.status === "verified"
  );
  const completedServices = serviceRequests
    .filter((r) => r.status === "completed" || r.status === "denied" || r.status === "rejected")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return (
    <div>
      {/* Pending verification requests - user needs to approve/deny */}
      {pendingVerifications.length > 0 && (
        <>
          <h2>Verification Required</h2>
          <p className="subtitle">A business needs to verify your information</p>
          {pendingVerifications.map((request) => (
            <div key={request.id} className="card" style={{ borderLeft: "4px solid #f59e0b" }}>
              <div className="card-header">
                <strong>{request.business_name}</strong>
                <span className="badge badge-pending">Action Required</span>
              </div>
              <div className="request-details">
                <p>
                  <strong>Request:</strong>{" "}
                  {request.claim.type === "age"
                    ? `Verify you are at least ${String(request.claim.params.minAge)} years old`
                    : `Verify your ${request.claim.type}`}
                </p>
                <div style={{
                  background: "#fef3c7",
                  padding: "1rem",
                  borderRadius: "8px",
                  marginTop: "1rem"
                }}>
                  <p style={{ fontWeight: 600 }}>Privacy Protection:</p>
                  <p style={{ marginTop: "0.5rem" }}>
                    ✓ They will receive: Only "Yes" or "No"
                  </p>
                  <p>
                    ✗ They will NOT see: Your actual birth date
                  </p>
                  <p>
                    ✓ Cost to you: nothing. {request.business_name} pays any proof fee.
                  </p>
                </div>
              </div>
              <div className="button-group" style={{ marginTop: "1rem" }}>
                <button
                  className="btn-success"
                  onClick={() => onApprove(request.id)}
                  disabled={loading || !canApprove}
                  title={canApprove ? undefined : "Unlock the agent's vault first (see the status bar)"}
                >
                  {loading ? "Processing..." : "Approve (Generate ZK Proof)"}
                </button>
                <button
                  className="btn-danger"
                  onClick={() => onDeny(request.id)}
                  disabled={loading}
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {/* Resolved verification requests */}
      {resolvedVerifications.length > 0 && (
        <>
          <h2 style={{ marginTop: pendingVerifications.length > 0 ? "2rem" : 0 }}>
            Verification History
          </h2>
          {resolvedVerifications.map((request) => (
            <div key={request.id} className="card">
              <div className="card-header">
                <strong>{request.business_name}</strong>
                <span
                  className={`badge ${
                    request.status === "approved" ? "badge-approved" : "badge-denied"
                  }`}
                >
                  {request.status}
                </span>
              </div>
              <p style={{ fontSize: "0.875rem", color: "#64748b" }}>
                {request.claim.type === "age"
                  ? `Age check (${String(request.claim.params.minAge)}+)`
                  : request.claim.type}
              </p>
              {request.response?.reason && (
                <p style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
                  {request.response.reason}
                </p>
              )}
              {request.response?.proof && request.response.requester_did !== undefined && (
                <p style={{ marginTop: "0.25rem", fontSize: "0.875rem", color: "#64748b" }}>
                  {request.response.requester_did
                    ? `Proof is for your ephemeral DID ${truncateDID(request.response.requester_did)}, which signed this approval`
                    : "Proof is for no DID"}
                </p>
              )}
              {/* An on-chain proof cost DUST, which the business sponsors to the
                  proof service (ADR-007's business-pays model); the user never
                  pays, whether or not the proof reports how much it cost. An
                  offline proof made no transaction and cost nobody. */}
              {request.response?.proof?.verificationMethod === "on-chain" && (
                <p style={{ marginTop: "0.25rem", fontSize: "0.875rem", color: "#64748b" }}>
                  No cost to you: {request.business_name} paid the proof's network fee.
                </p>
              )}
            </div>
          ))}
        </>
      )}

      {pendingVerifications.length === 0 &&
        resolvedVerifications.length === 0 &&
        !SERVICE_FLOW_ENABLED && (
          <div className="card empty-state">
            No verification requests yet
            <p style={{ fontSize: "0.875rem", marginTop: "0.5rem", color: "#64748b" }}>
              Waiting for a business to request verification...
            </p>
          </div>
        )}

      {/* Active service requests (service flow) */}
      {SERVICE_FLOW_ENABLED && (
        <>
          <h2 style={{ marginTop: "2rem" }}>
            Active Requests
          </h2>
          {activeServices.length === 0 ? (
            <div className="card empty-state">
              No active requests
              <p style={{ fontSize: "0.875rem", marginTop: "0.5rem", color: "#64748b" }}>
                Go to Services tab to request something
              </p>
            </div>
          ) : (
            activeServices.map((request) => (
              <div key={request.id} className="card">
                <div className="card-header">
                  <strong>{request.service_name}</strong>
                  <span className={`badge ${
                    request.status === "pending" ? "badge-pending" :
                    request.status === "verification_required" ? "badge-pending" :
                    "badge-approved"
                  }`}>
                    {request.status === "pending" && "Waiting for business..."}
                    {request.status === "verification_required" && "Verification needed"}
                    {request.status === "verified" && "Verified - Completing..."}
                  </span>
                </div>
                <p style={{ fontSize: "0.875rem", color: "#64748b" }}>
                  Request ID: {request.id}
                </p>
                {request.status === "pending" && (
                  <p style={{ marginTop: "0.5rem" }}>
                    Waiting for the business to respond with verification requirements...
                  </p>
                )}
                {request.status === "verification_required" && (
                  <p style={{ marginTop: "0.5rem", color: "#f59e0b" }}>
                    The business requires verification. Check above for pending verifications.
                  </p>
                )}
                {request.status === "verified" && (
                  <p style={{ marginTop: "0.5rem", color: "#16a34a" }}>
                    Your proof has been verified! The business is completing your request...
                  </p>
                )}
              </div>
            ))
          )}

          {/* History */}
          {completedServices.length > 0 && (
            <>
              <h2 style={{ marginTop: "2rem" }}>History</h2>
              {completedServices.map((request) => (
                <div key={request.id} className="card">
                  <div className="card-header">
                    <strong>{request.service_name}</strong>
                    <span
                      className={`badge ${
                        request.status === "completed"
                          ? "badge-approved"
                          : "badge-denied"
                      }`}
                    >
                      {request.status === "rejected" ? "not eligible" : request.status}
                    </span>
                  </div>
                  <p style={{ fontSize: "0.875rem", color: "#64748b" }}>
                    ID: {request.id}
                  </p>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

function ContextTab({
  context,
  onUpdate,
  storeStatus,
}: {
  context: PersonalContext;
  onUpdate: (ctx: PersonalContext) => void;
  storeStatus: "unknown" | "connected" | "error";
}) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Calculate current age
  const calculateAge = (birthDate: string | undefined): number | null => {
    if (!birthDate) return null;
    const birth = new Date(birthDate);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
      age--;
    }
    return age;
  };

  const age = calculateAge(context.birthDate);

  const handleSave = async () => {
    setSaving(true);
    await onUpdate(context);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div>
      <h2>My Personal Context</h2>
      <p className="subtitle">
        This data is encrypted with your password. Only you can access it.
      </p>

      {storeStatus === "connected" && (
        <div style={{
          background: "#dcfce7",
          padding: "0.75rem 1rem",
          borderRadius: "8px",
          marginBottom: "1rem",
          display: "flex",
          alignItems: "center",
          gap: "0.5rem"
        }}>
          <span style={{ color: "#16a34a" }}>🔐</span>
          <span>End-to-end encrypted • Stored locally • Only you have the key</span>
        </div>
      )}

      {storeStatus === "error" && (
        <div style={{
          background: "#fef2f2",
          padding: "0.75rem 1rem",
          borderRadius: "8px",
          marginBottom: "1rem",
          color: "#dc2626"
        }}>
          ⚠️ Context store unavailable - changes are local only
        </div>
      )}

      <div className="card">
        <div className="form-group">
          <label>Full Name</label>
          <input
            type="text"
            value={context.fullName || ""}
            onChange={(e) => onUpdate({ ...context, fullName: e.target.value })}
          />
        </div>
        <div className="form-group">
          <label>Birth Date</label>
          <input
            type="date"
            value={context.birthDate || ""}
            onChange={(e) =>
              onUpdate({ ...context, birthDate: e.target.value })
            }
          />
          {age !== null && (
            <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: age >= 21 ? "#16a34a" : "#dc2626" }}>
              Current age: <strong>{age}</strong> years old
              {age >= 21 ? " (eligible for 21+ services)" : " (NOT eligible for 21+ services)"}
            </p>
          )}
        </div>
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Encrypting & Saving..." : saved ? "Saved!" : "Save Changes"}
        </button>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: "1rem" }}>Context Preview (Decrypted View)</h3>
        <pre
          style={{
            background: "#f1f5f9",
            padding: "1rem",
            borderRadius: "8px",
            overflow: "auto",
          }}
        >
          {JSON.stringify(context, null, 2)}
        </pre>
        <p
          style={{ marginTop: "1rem", fontSize: "0.875rem", color: "#64748b" }}
        >
          This data is encrypted at rest. The server only stores encrypted blobs
          and cannot read your data.
        </p>
      </div>
    </div>
  );
}

function IdentityTab({
  rootIdentity,
  currentEphemeralDID,
  authorizations,
  onExport,
}: {
  rootIdentity: RootIdentity | null;
  currentEphemeralDID: string | null;
  authorizations: SerializedAuthorizationRecord[];
  onExport: () => void;
}) {
  return (
    <div>
      <h2>My Identity</h2>
      <p className="subtitle">
        Your decentralized identity for privacy-preserving verification
      </p>

      {/* Root DID Card */}
      <div className="card">
        <div className="card-header">
          <strong>Root DID</strong>
          <span className="badge badge-approved">Persistent</span>
        </div>

        {rootIdentity ? (
          <>
            <div style={{
              background: "#f1f5f9",
              padding: "1rem",
              borderRadius: "8px",
              fontFamily: "monospace",
              fontSize: "0.875rem",
              wordBreak: "break-all",
              marginTop: "1rem",
            }}>
              {rootIdentity.did}
            </div>
            <p style={{ marginTop: "1rem", fontSize: "0.875rem", color: "#64748b" }}>
              Created: {new Date(rootIdentity.createdAt).toLocaleDateString()}
            </p>
          </>
        ) : (
          <p style={{ color: "#64748b", marginTop: "1rem" }}>
            Loading identity...
          </p>
        )}

        <div style={{
          marginTop: "1rem",
          padding: "1rem",
          background: "#fef3c7",
          borderRadius: "8px",
        }}>
          <p style={{ fontWeight: 600, marginBottom: "0.5rem" }}>
            Privacy Protection
          </p>
          <p style={{ fontSize: "0.875rem" }}>
            Your root DID is <strong>never shared</strong> with businesses.
            Instead, a fresh ephemeral DID is generated for each verification,
            making your interactions unlinkable.
          </p>
        </div>
      </div>

      {/* Ephemeral DID Card */}
      <div className="card">
        <div className="card-header">
          <strong>Latest Ephemeral DID</strong>
          <span className="badge badge-pending">Per-Request</span>
        </div>

        {currentEphemeralDID ? (
          <>
            <div style={{
              background: "#f1f5f9",
              padding: "1rem",
              borderRadius: "8px",
              fontFamily: "monospace",
              fontSize: "0.875rem",
              wordBreak: "break-all",
              marginTop: "1rem",
            }}>
              {currentEphemeralDID}
            </div>
            <p style={{ marginTop: "1rem", fontSize: "0.875rem", color: "#64748b" }}>
              Used for your most recent verification request
            </p>
          </>
        ) : (
          <p style={{ color: "#64748b", marginTop: "1rem" }}>
            No verification requests yet. An ephemeral DID will be generated
            when you approve a verification request.
          </p>
        )}

        <div style={{
          marginTop: "1rem",
          padding: "1rem",
          background: "#dcfce7",
          borderRadius: "8px",
        }}>
          <p style={{ fontWeight: 600, marginBottom: "0.5rem" }}>
            How Ephemeral DIDs Work
          </p>
          <ul style={{ fontSize: "0.875rem", paddingLeft: "1.5rem", marginTop: "0.5rem" }}>
            <li>Fresh keypair generated for each verification</li>
            <li>Cryptographically unlinkable to your root DID</li>
            <li>Businesses cannot correlate your requests</li>
            <li>A record signed by your root DID stays in your vault, so you can later prove the DID was yours</li>
          </ul>
        </div>
      </div>

      {/* Authorization records: the user's own evidence, never shared */}
      <div className="card">
        <div className="card-header">
          <strong>Authorization Records</strong>
          <span className="badge badge-approved">{authorizations.length} kept</span>
        </div>
        <p style={{ fontSize: "0.875rem", color: "#64748b", marginTop: "0.5rem" }}>
          Each ephemeral DID comes with a record your root DID signed. The records
          stay encrypted in your vault and are never sent to a business. Export
          them when you need to prove a verification was yours (legal discovery,
          a dispute, an audit); the file verifies with the identity library.
          The export is not encrypted and links every ephemeral DID to your root
          DID, so treat the file as your identity.
        </p>
        {authorizations.length === 0 ? (
          <p style={{ color: "#64748b", marginTop: "1rem" }}>
            No records yet. One is kept each time you approve a verification.
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, marginTop: "1rem" }}>
            {authorizations.map((record) => (
              <li
                key={record.ephemeralDid}
                style={{
                  padding: "0.75rem 0",
                  borderTop: "1px solid #e2e8f0",
                  fontSize: "0.875rem",
                }}
              >
                <div style={{ fontFamily: "monospace" }} title={record.ephemeralDid}>
                  {truncateDID(record.ephemeralDid)}
                </div>
                <div>{record.purpose}</div>
                <div style={{ color: "#64748b" }}>
                  Issued {new Date(record.timestamp).toLocaleString()}
                  {typeof record.context?.metadata?.requestExpiresAt === "string" &&
                    ` · for a request open until ${new Date(record.context.metadata.requestExpiresAt).toLocaleString()}`}
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="button-group" style={{ marginTop: "1rem" }}>
          <button
            className="btn-secondary"
            onClick={onExport}
            disabled={!rootIdentity || authorizations.length === 0}
            title={authorizations.length === 0 ? "Nothing to export yet" : undefined}
          >
            Export for audit
          </button>
        </div>
      </div>

      {/* Future: an anchored root DID */}
      <div className="card" style={{ borderLeft: "4px solid #3b82f6" }}>
        <div className="card-header">
          <strong>Future: Anchored Identity</strong>
        </div>
        <p style={{ fontSize: "0.875rem", color: "#64748b", marginTop: "0.5rem" }}>
          Currently using <code>did:key</code> (W3C standard), or an atproto
          account bound to a local key. The planned anchor is{" "}
          <code>did:midnight</code> via Midnight Passport, with{" "}
          <code>did:prism</code> as the alternative.
        </p>
      </div>
    </div>
  );
}

function PoliciesTab({ policies }: { policies: SPALPolicy[] }) {
  return (
    <div>
      <h2>My S-PAL Policies</h2>
      <p className="subtitle">
        Define what data businesses can verify and under what conditions.
      </p>

      {policies.map((policy) => (
        <div key={policy.id} className="card">
          <div className="card-header">
            <strong>{policy.name}</strong>
            <span className="badge badge-approved">Active</span>
          </div>
          <p>{policy.description}</p>

          {/* Context Scope */}
          <div style={{
            marginTop: "1rem",
            padding: "1rem",
            background: "#f0f9ff",
            borderRadius: "8px",
          }}>
            <strong>Data Scope:</strong>
            <code style={{
              marginLeft: "0.5rem",
              background: "#e0f2fe",
              padding: "2px 8px",
              borderRadius: "4px",
            }}>
              {policy.contextScope}
            </code>
          </div>

          {/* Identity Linkage */}
          <div style={{
            marginTop: "1rem",
            padding: "1rem",
            background: "#fef3c7",
            borderRadius: "8px",
          }}>
            <strong>Privacy Controls:</strong>
            <ul style={{ marginTop: "0.5rem", paddingLeft: "1.5rem" }}>
              <li>
                Ephemeral DID required: {policy.identityLinkage.ephemeralRequired ? "Yes" : "No"}
              </li>
              <li>
                Proof of root allowed: {policy.identityLinkage.proofOfRootAllowed ? "Yes" : "No"}
              </li>
              <li>
                ZK continuity allowed: {policy.identityLinkage.zkContinuityAllowed ? "Yes" : "No"}
              </li>
            </ul>
          </div>

          {/* Operations & Retention */}
          <div style={{
            marginTop: "1rem",
            padding: "1rem",
            background: "#f8fafc",
            borderRadius: "8px",
          }}>
            <strong>Access Rules:</strong>
            <ul style={{ marginTop: "0.5rem", paddingLeft: "1.5rem" }}>
              <li>
                Operations: {policy.allowedOperations.join(", ")}
              </li>
              <li>
                Retention: {policy.maxRetentionMs === 0 ? "No retention allowed" : `${policy.maxRetentionMs / 1000}s max`}
              </li>
              <li>
                Payment: {policy.minPayment === 0 ? "Free" : `${policy.minPayment} lovelace`}
              </li>
            </ul>
          </div>

          {/* Derivatives */}
          <div style={{
            marginTop: "1rem",
            padding: "1rem",
            background: "#fef2f2",
            borderRadius: "8px",
          }}>
            <strong>Derivative Use:</strong>
            <ul style={{ marginTop: "0.5rem", paddingLeft: "1.5rem" }}>
              <li>AI Training: {policy.derivatives.training}</li>
              <li>Aggregation: {policy.derivatives.aggregation}</li>
              <li>Resale: {policy.derivatives.resale}</li>
            </ul>
          </div>

          <p style={{ marginTop: "1rem", fontSize: "0.75rem", color: "#64748b" }}>
            Policy ID: {policy.id}
          </p>
        </div>
      ))}

      <button className="btn-primary" style={{ marginTop: "1rem" }}>
        Create New Policy
      </button>
    </div>
  );
}

export default App;
